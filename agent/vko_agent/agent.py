from __future__ import annotations

import json
import os
import random
import sqlite3
import time
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable, Protocol
from urllib.error import URLError
from urllib.request import Request, urlopen


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


@dataclass(frozen=True)
class AgentConfig:
    server_url: str = "http://127.0.0.1:8000"
    device_id: str = "device-42-primary"
    school_id: str = "school-42"
    line_id: str = "line-42-primary"
    point_id: str = "point-42-primary"
    device_token: str = "demo-device-42-primary-token"
    agent_version: str = "0.1.0"
    buffer_path: Path = Path(".vko-agent/queue.sqlite3")
    tests_per_day: int = 4
    jitter_minutes: int = 8
    light_checks_between: bool = False


class Probe(Protocol):
    def measure(self, mode: str = "performance") -> dict[str, Any]: ...


class DemoProbe:
    """Deterministic fixture used by the demo and tests; no external speedtest calls."""

    def __init__(self, sequence: Iterable[dict[str, Any]] | None = None):
        self._sequence = iter(sequence or (
            {"download": 96, "upload": 94, "ping": 32, "jitter": 8, "packet_loss": 0.2, "availability": 100, "connection_status": "OK"},
            {"download": 43, "upload": 39, "ping": 48, "jitter": 12, "packet_loss": 0.8, "availability": 100, "connection_status": "OK"},
            {"download": 39, "upload": 37, "ping": 52, "jitter": 14, "packet_loss": 1.0, "availability": 100, "connection_status": "OK"},
            {"download": 41, "upload": 38, "ping": 49, "jitter": 13, "packet_loss": 0.9, "availability": 100, "connection_status": "OK"},
        ))
        self._last: dict[str, Any] | None = None

    def measure(self, mode: str = "performance") -> dict[str, Any]:
        if mode == "light":
            result = {"download": None, "upload": None, "ping": 34, "jitter": 6, "packet_loss": 0.1, "availability": 100, "connection_status": "OK"}
        else:
            try:
                result = dict(next(self._sequence))
            except StopIteration:
                result = dict(self._last or {"download": 96, "upload": 94, "ping": 32, "jitter": 8, "packet_loss": 0.2, "availability": 100, "connection_status": "OK"})
        result["mode"] = mode.upper()
        self._last = result
        return result


class OfflineBuffer:
    """SQLite WAL queue. Event IDs make replay idempotent on the server."""

    def __init__(self, path: str | Path):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.connection = sqlite3.connect(self.path)
        self.connection.execute("PRAGMA journal_mode=WAL")
        self.connection.execute("CREATE TABLE IF NOT EXISTS queue (id INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT UNIQUE NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL, sent_at TEXT)")
        self.connection.commit()

    def enqueue(self, payload: dict[str, Any], event_id: str | None = None) -> str:
        event_id = event_id or str(uuid.uuid4())
        self.connection.execute("INSERT OR IGNORE INTO queue (event_id, payload, created_at) VALUES (?, ?, ?)", (event_id, json.dumps(payload, ensure_ascii=False), utc_now()))
        self.connection.commit()
        return event_id

    def pending(self, limit: int = 100) -> list[tuple[int, str, dict[str, Any]]]:
        rows = self.connection.execute("SELECT id, event_id, payload FROM queue WHERE sent_at IS NULL ORDER BY id LIMIT ?", (limit,)).fetchall()
        return [(row[0], row[1], json.loads(row[2])) for row in rows]

    def mark_sent(self, row_id: int) -> None:
        self.connection.execute("UPDATE queue SET sent_at = ? WHERE id = ?", (utc_now(), row_id))
        self.connection.commit()

    def pending_count(self) -> int:
        return int(self.connection.execute("SELECT COUNT(*) FROM queue WHERE sent_at IS NULL").fetchone()[0])

    def close(self) -> None:
        self.connection.close()


class MonitoringAgent:
    def __init__(self, config: AgentConfig, probe: Probe | None = None, buffer: OfflineBuffer | None = None):
        self.config = config
        self.probe = probe or DemoProbe()
        self.buffer = buffer or OfflineBuffer(config.buffer_path)

    def make_event(self, mode: str = "performance", observed_at: str | None = None) -> dict[str, Any]:
        result = self.probe.measure(mode)
        return {"client_event_id": str(uuid.uuid4()), "device_id": self.config.device_id, "school_id": self.config.school_id, "line_id": self.config.line_id, "monitoring_point_id": self.config.point_id, "agent_version": self.config.agent_version, "observed_at": observed_at or utc_now(), **result}

    def collect(self, mode: str = "performance") -> str:
        return self.buffer.enqueue(self.make_event(mode))

    def flush(self) -> int:
        sent = 0
        for row_id, _, payload in self.buffer.pending():
            body = json.dumps({"measurements": [payload]}, ensure_ascii=False).encode("utf-8")
            request = Request(
                f"{self.config.server_url.rstrip('/')}/api/v1/agent/measurements:batch",
                data=body,
                method="POST",
                headers={
                    "Content-Type": "application/json",
                    "Authorization": f"Device {self.config.device_token}",
                    "X-Device-ID": self.config.device_id,
                    "X-Device-Token": self.config.device_token,
                },
            )
            try:
                with urlopen(request, timeout=8) as response:
                    if response.status >= 300:
                        raise URLError(f"HTTP {response.status}")
            except (OSError, URLError):
                break
            self.buffer.mark_sent(row_id)
            sent += 1
        return sent

    def run_once(self, mode: str = "performance") -> dict[str, Any]:
        event_id = self.collect(mode)
        sent = self.flush()
        return {"event_id": event_id, "sent": sent, "pending": self.buffer.pending_count()}

    def schedule_delays(self) -> list[int]:
        count = max(3, min(5, int(self.config.tests_per_day)))
        base = 24 * 60 * 60 // count
        rng = random.Random(self.config.device_id)
        jitter = min(abs(int(self.config.jitter_minutes)) * 60, max(0, base - 60))
        # Apply balanced pairwise offsets. Every interval stays within the
        # configured window and the offsets sum to zero, so one cycle remains
        # exactly one calendar day rather than pushing the final test outside
        # the requested jitter window.
        delays = [base] * count
        for index in range(count // 2):
            delta = rng.randint(-jitter, jitter)
            delays[index] += delta
            delays[-index - 1] -= delta
        return [max(60, delay) for delay in delays]

    def run_forever(self) -> None:
        while True:
            for delay in self.schedule_delays():
                self.run_once("performance")
                if self.config.light_checks_between:
                    midpoint = max(60, delay // 2)
                    time.sleep(midpoint)
                    self.run_once("light")
                    time.sleep(max(60, delay - midpoint))
                else:
                    time.sleep(delay)


def config_from_env() -> AgentConfig:
    def integer(name: str, default: int) -> int:
        try:
            return int(os.getenv(name, str(default)))
        except ValueError:
            return default

    def boolean(name: str, default: bool) -> bool:
        value = os.getenv(name)
        if value is None:
            return default
        return value.strip().lower() in {"1", "true", "yes", "on"}

    return AgentConfig(
        server_url=os.getenv("VKO_SERVER_URL", AgentConfig.server_url),
        device_id=os.getenv("VKO_DEVICE_ID", AgentConfig.device_id),
        school_id=os.getenv("VKO_SCHOOL_ID", AgentConfig.school_id),
        line_id=os.getenv("VKO_LINE_ID", AgentConfig.line_id),
        point_id=os.getenv("VKO_POINT_ID", AgentConfig.point_id),
        device_token=os.getenv("VKO_DEVICE_TOKEN", AgentConfig.device_token),
        agent_version=os.getenv("VKO_AGENT_VERSION", AgentConfig.agent_version),
        buffer_path=Path(os.getenv("VKO_BUFFER_PATH", str(AgentConfig.buffer_path))),
        tests_per_day=integer("VKO_TESTS_PER_DAY", AgentConfig.tests_per_day),
        jitter_minutes=integer("VKO_JITTER_MINUTES", AgentConfig.jitter_minutes),
        light_checks_between=boolean("VKO_LIGHT_CHECKS_BETWEEN", AgentConfig.light_checks_between),
    )
