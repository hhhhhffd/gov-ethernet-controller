from __future__ import annotations

import json
import os
import random
import re
import sqlite3
import shutil
import socket
import statistics
import subprocess
import time
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable, Protocol
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse
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
    probe_type: str = "demo"
    probe_targets: tuple[str, ...] = ("https://www.google.com/generate_204",)
    probe_host: str = "1.1.1.1"
    probe_port: int = 443
    throughput_url: str = "https://speed.cloudflare.com/__down?bytes=1000000"
    upload_url: str | None = None
    probe_timeout_seconds: float = 5.0


class Probe(Protocol):
    def measure(self, mode: str = "performance") -> dict[str, Any]: ...


class NetworkProbe:
    """Dependency-free network telemetry probe for an installed agent.

    The probe deliberately uses bounded standard-library operations: HTTP
    reachability, TCP connection timing, optional system ``ping`` samples and
    a capped HTTP range download/upload. It does not execute a shell command
    and never trusts a URL as a command argument. Deployments should point the
    throughput endpoints at infrastructure they control; the public defaults
    are only a convenient smoke fallback.
    """

    def __init__(
        self,
        *,
        targets: Iterable[str] | None = None,
        ping_host: str = "1.1.1.1",
        ping_port: int = 443,
        throughput_url: str | None = None,
        upload_url: str | None = None,
        timeout_seconds: float = 5.0,
        ping_count: int = 3,
        download_bytes: int = 1_000_000,
        upload_bytes: int = 256_000,
    ) -> None:
        self.targets = tuple(targets or ("https://www.google.com/generate_204",))
        self.ping_host = ping_host
        self.ping_port = int(ping_port)
        self.throughput_url = throughput_url
        self.upload_url = upload_url
        self.timeout_seconds = max(0.25, min(float(timeout_seconds), 30.0))
        self.ping_count = max(1, min(int(ping_count), 10))
        self.download_bytes = max(16_384, min(int(download_bytes), 10_000_000))
        self.upload_bytes = max(4_096, min(int(upload_bytes), 2_000_000))
        if not self.targets:
            raise ValueError("at least one reachability target is required")
        for target in self.targets:
            parsed = urlparse(target)
            if parsed.scheme not in {"http", "https"} or not parsed.netloc:
                raise ValueError(f"invalid probe target: {target}")

    @classmethod
    def from_config(cls, config: AgentConfig) -> "NetworkProbe":
        return cls(
            targets=config.probe_targets,
            ping_host=config.probe_host,
            ping_port=config.probe_port,
            throughput_url=config.throughput_url,
            upload_url=config.upload_url,
            timeout_seconds=config.probe_timeout_seconds,
        )

    @staticmethod
    def _http_reachability(url: str, timeout: float) -> tuple[bool, float, str | None]:
        started = time.perf_counter()
        try:
            request = Request(url, method="HEAD", headers={"User-Agent": "vko-linkwatch-agent/1"})
            with urlopen(request, timeout=timeout) as response:
                # Any 2xx/3xx response proves the endpoint is reachable. A
                # captive portal (HTML 200) is still retained in raw evidence.
                ok = 200 <= int(response.status) < 400
                return ok, (time.perf_counter() - started) * 1000, None if ok else f"HTTP {response.status}"
        except HTTPError as exc:
            # A 405/501 to HEAD does not imply the network is down; retrying a
            # tiny GET keeps the probe compatible with simple endpoints.
            if exc.code in {405, 501}:
                try:
                    request = Request(url, method="GET", headers={"Range": "bytes=0-0", "User-Agent": "vko-linkwatch-agent/1"})
                    with urlopen(request, timeout=timeout) as response:
                        ok = 200 <= int(response.status) < 400
                        response.read(1)
                        return ok, (time.perf_counter() - started) * 1000, None if ok else f"HTTP {response.status}"
                except (OSError, URLError) as retry_error:
                    return False, (time.perf_counter() - started) * 1000, str(retry_error)
            return False, (time.perf_counter() - started) * 1000, f"HTTP {exc.code}"
        except (OSError, URLError, ValueError) as exc:
            return False, (time.perf_counter() - started) * 1000, str(exc)

    def _tcp_samples(self) -> tuple[list[float], int, list[str]]:
        samples: list[float] = []
        errors: list[str] = []
        failures = 0
        for _ in range(self.ping_count):
            started = time.perf_counter()
            try:
                with socket.create_connection((self.ping_host, self.ping_port), timeout=self.timeout_seconds):
                    samples.append((time.perf_counter() - started) * 1000)
            except OSError as exc:
                failures += 1
                errors.append(str(exc))
        return samples, failures, errors

    def _ping_samples(self) -> tuple[list[float], int, list[str], str]:
        ping = shutil.which("ping")
        if not ping:
            samples, failures, errors = self._tcp_samples()
            return samples, failures, errors, "tcp"
        if os.name == "nt":
            command = [ping, "-n", str(self.ping_count), "-w", str(max(1, int(self.timeout_seconds * 1000))), self.ping_host]
        else:
            command = [ping, "-c", str(self.ping_count), "-W", str(max(1, int(self.timeout_seconds))), self.ping_host]
        try:
            completed = subprocess.run(command, check=False, capture_output=True, text=True, timeout=self.timeout_seconds * (self.ping_count + 1))
            output = (completed.stdout or "") + "\n" + (completed.stderr or "")
            samples = [float(value.replace(",", ".")) for value in re.findall(r"time[=<]([0-9]+(?:[.,][0-9]+)?)\s*ms", output, re.IGNORECASE)]
            loss_match = re.search(r"([0-9]+(?:[.,][0-9]+)?)%\s*(?:packet )?(?:loss|lost)", output, re.IGNORECASE)
            if loss_match:
                reported_loss = float(loss_match.group(1).replace(",", "."))
                failures = max(0, round(self.ping_count * reported_loss / 100) - (self.ping_count - len(samples)))
            failures = max(failures, self.ping_count - len(samples))
            return samples, failures, [] if completed.returncode == 0 else [output.strip()[-500:] or f"ping exit {completed.returncode}"], "ping"
        except (OSError, subprocess.SubprocessError) as exc:
            samples, failures, errors = self._tcp_samples()
            return samples, failures, [str(exc), *errors], "tcp"

    def _download(self) -> tuple[float | None, float | None, str | None]:
        if not self.throughput_url:
            return None, None, "throughput URL is not configured"
        parsed = urlparse(self.throughput_url)
        if parsed.scheme not in {"http", "https"} or not parsed.netloc:
            return None, None, "invalid throughput URL"
        started = time.perf_counter()
        try:
            request = Request(self.throughput_url, headers={"Range": f"bytes=0-{self.download_bytes - 1}", "User-Agent": "vko-linkwatch-agent/1"})
            received = 0
            with urlopen(request, timeout=self.timeout_seconds) as response:
                while received < self.download_bytes:
                    chunk = response.read(min(64 * 1024, self.download_bytes - received))
                    if not chunk:
                        break
                    received += len(chunk)
            elapsed = max(time.perf_counter() - started, 0.001)
            if not received:
                return None, elapsed * 1000, "download returned no bytes"
            return received * 8 / elapsed / 1_000_000, elapsed * 1000, None
        except (OSError, URLError, ValueError) as exc:
            return None, (time.perf_counter() - started) * 1000, str(exc)

    def _upload(self) -> tuple[float | None, float | None, str | None]:
        if not self.upload_url:
            return None, None, "upload URL is not configured"
        parsed = urlparse(self.upload_url)
        if parsed.scheme not in {"http", "https"} or not parsed.netloc:
            return None, None, "invalid upload URL"
        started = time.perf_counter()
        try:
            request = Request(self.upload_url, data=os.urandom(self.upload_bytes), method="POST", headers={"Content-Type": "application/octet-stream", "User-Agent": "vko-linkwatch-agent/1"})
            with urlopen(request, timeout=self.timeout_seconds) as response:
                if not 200 <= int(response.status) < 400:
                    return None, (time.perf_counter() - started) * 1000, f"HTTP {response.status}"
            elapsed = max(time.perf_counter() - started, 0.001)
            return self.upload_bytes * 8 / elapsed / 1_000_000, elapsed * 1000, None
        except (OSError, URLError, ValueError) as exc:
            return None, (time.perf_counter() - started) * 1000, str(exc)

    def measure(self, mode: str = "performance") -> dict[str, Any]:
        mode = mode.lower()
        if mode not in {"light", "performance"}:
            raise ValueError("mode must be light or performance")
        reachability: list[dict[str, Any]] = []
        for target in self.targets:
            ok, latency, error = self._http_reachability(target, self.timeout_seconds)
            reachability.append({"target": target, "ok": ok, "latency_ms": round(latency, 2), **({"error": error} if error else {})})
        ping_samples, ping_failures, ping_errors, ping_method = self._ping_samples()
        successful_targets = sum(1 for result in reachability if result["ok"])
        attempts = len(reachability) + self.ping_count
        successes = successful_targets + len(ping_samples)
        availability = round(successes / attempts * 100, 2) if attempts else 0.0
        connection_status = "OK" if successful_targets or ping_samples else "NO_INTERNET"
        jitter = statistics.mean([abs(right - left) for left, right in zip(ping_samples, ping_samples[1:])]) if len(ping_samples) > 1 else None
        result: dict[str, Any] = {
            "download": None,
            "upload": None,
            "ping": round(statistics.mean(ping_samples), 2) if ping_samples else None,
            "jitter": round(jitter, 2) if jitter is not None else None,
            "packet_loss": round(ping_failures / self.ping_count * 100, 2),
            "availability": availability,
            "connection_status": connection_status,
            "raw": {"probe": "network", "ping_method": ping_method, "ping_errors": ping_errors[-3:], "reachability": reachability},
        }
        if mode == "performance" and connection_status == "OK":
            download, download_latency, download_error = self._download()
            upload, upload_latency, upload_error = self._upload()
            result["download"] = round(download, 3) if download is not None else None
            result["upload"] = round(upload, 3) if upload is not None else None
            result["raw"].update({"download_latency_ms": round(download_latency, 2) if download_latency is not None else None, "upload_latency_ms": round(upload_latency, 2) if upload_latency is not None else None})
            for key, error in (("download_error", download_error), ("upload_error", upload_error)):
                if error and not (key == "upload_error" and error == "upload URL is not configured"):
                    result["raw"][key] = error
        result["mode"] = mode.upper()
        return result


RealProbe = NetworkProbe


def build_probe(config: AgentConfig) -> Probe:
    probe_type = config.probe_type.strip().lower()
    if probe_type in {"network", "real", "production"}:
        return NetworkProbe.from_config(config)
    if probe_type in {"demo", "fixture"}:
        if os.getenv("VKO_ENV", "development").lower() == "production" and os.getenv("VKO_ALLOW_DEMO_PROBE") != "1":
            raise ValueError("demo probe is disabled in production; set VKO_PROBE=network")
        return DemoProbe()
    raise ValueError("VKO_PROBE must be demo or network")


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
        self.probe = probe or build_probe(config)
        self.buffer = buffer or OfflineBuffer(config.buffer_path)

    def make_event(self, mode: str = "performance", observed_at: str | None = None) -> dict[str, Any]:
        result = self.probe.measure(mode)
        return {"client_event_id": str(uuid.uuid4()), "device_id": self.config.device_id, "school_id": self.config.school_id, "line_id": self.config.line_id, "monitoring_point_id": self.config.point_id, "agent_version": self.config.agent_version, "observed_at": observed_at or utc_now(), **result}

    def collect(self, mode: str = "performance") -> str:
        return self.buffer.enqueue(self.make_event(mode))

    def flush(self) -> int:
        server_url = self.config.server_url.rstrip("/")
        parsed_server = urlparse(server_url)
        if not parsed_server.netloc or parsed_server.scheme not in {"http", "https"}:
            raise ValueError("VKO_SERVER_URL must be an absolute HTTP(S) URL")
        if os.getenv("VKO_ENV", "development").lower() == "production" and parsed_server.scheme != "https":
            raise ValueError("VKO_SERVER_URL must use HTTPS in production")
        sent = 0
        for row_id, _, payload in self.buffer.pending():
            body = json.dumps({"measurements": [payload]}, ensure_ascii=False).encode("utf-8")
            request = Request(
                f"{server_url}/api/v1/agent/measurements:batch",
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

    def floating(name: str, default: float) -> float:
        try:
            return float(os.getenv(name, str(default)))
        except ValueError:
            return default

    targets = tuple(item.strip() for item in os.getenv("VKO_PROBE_TARGETS", AgentConfig.probe_targets[0]).split(",") if item.strip())
    probe_type = os.getenv("VKO_PROBE", "demo")
    if os.getenv("VKO_ENV", "").lower() == "production" and "VKO_PROBE" not in os.environ:
        probe_type = "network"

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
        probe_type=probe_type,
        probe_targets=targets,
        probe_host=os.getenv("VKO_PROBE_HOST", AgentConfig.probe_host),
        probe_port=integer("VKO_PROBE_PORT", AgentConfig.probe_port),
        throughput_url=os.getenv("VKO_THROUGHPUT_URL", AgentConfig.throughput_url),
        upload_url=os.getenv("VKO_UPLOAD_URL") or None,
        probe_timeout_seconds=floating("VKO_PROBE_TIMEOUT_SECONDS", AgentConfig.probe_timeout_seconds),
    )
