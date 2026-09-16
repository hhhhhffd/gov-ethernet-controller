"""Black-box smoke test for the production-like HTTP stack.

The scenario is safe to rerun against the persistent staging volume: each run
uses fresh event IDs and timestamps newer than the current reserve-line evidence.
"""

from __future__ import annotations

import argparse
import asyncio
import os
import uuid
from datetime import datetime, timedelta, timezone

import httpx


def measurement(event_id: str, observed_at: datetime, *, download: float | None, upload: float | None, connection_status: str = "OK") -> dict:
    online = connection_status == "OK"
    return {
        "client_event_id": event_id,
        "observed_at": observed_at.isoformat(),
        "mode": "PERFORMANCE",
        "download": download,
        "upload": upload,
        "ping": 30 if online else None,
        "jitter": 8 if online else None,
        "packet_loss": 0.2 if online else None,
        "availability": 100 if online else None,
        "connection_status": connection_status,
    }


async def main(base_url: str, device_token: str, primary_token: str) -> None:
    async with httpx.AsyncClient(base_url=base_url.rstrip("/"), timeout=20) as client:
        health = await client.get("/health")
        assert health.status_code == 200, health.text

        login = await client.post("/api/login", json={"username": "admin", "password": os.getenv("VKO_DEMO_PASSWORD", "demo")})
        assert login.status_code == 200, login.text
        admin = {"Authorization": f"Bearer {login.json()['token']}"}

        lines = await client.get("/api/v1/lines", headers=admin)
        assert lines.status_code == 200 and len(lines.json()) >= 4, lines.text
        provider_login = await client.post("/api/login", json={"username": "provider-a", "password": os.getenv("VKO_DEMO_PASSWORD", "demo")})
        assert provider_login.status_code == 200, provider_login.text
        provider = {"Authorization": f"Bearer {provider_login.json()['token']}"}
        provider_lines = await client.get("/api/v1/lines", headers=provider)
        assert provider_lines.status_code == 200 and provider_lines.json(), provider_lines.text
        assert all(item["provider_id"] == "provider-a" for item in provider_lines.json())
        assert (await client.get("/api/v1/lines/line-42-reserve", headers=provider)).status_code == 404

        # Keep observations newer than the current line evidence so the smoke
        # can be rerun against a persistent named volume. The domain layer
        # intentionally stores late observations without rewriting state.
        reserve_detail = await client.get("/api/v1/lines/line-42-reserve", headers=admin)
        assert reserve_detail.status_code == 200, reserve_detail.text
        now = datetime.now(timezone.utc).replace(microsecond=0)
        latest_observed = (reserve_detail.json().get("latest") or {}).get("observed_at")
        if latest_observed:
            now = max(now, datetime.fromisoformat(latest_observed.replace("Z", "+00:00")) + timedelta(seconds=1))
        run_id = uuid.uuid4().hex[:12]
        reserve_headers = {"X-Device-ID": "device-42-reserve", "X-Device-Token": device_token}
        outage = [measurement(f"{run_id}-outage-{index}", now + timedelta(seconds=index), download=None, upload=None, connection_status="NO_INTERNET") for index in range(3)]
        response = await client.post("/api/v1/agent/measurements:batch", headers=reserve_headers, json={"measurements": outage})
        assert response.status_code == 200, response.text
        reserve = (await client.get("/api/v1/lines/line-42-reserve", headers=admin)).json()
        assert reserve["state"]["connection_state"] == "NO_INTERNET", reserve

        recovery = [measurement(f"{run_id}-recovery-{index}", now + timedelta(seconds=3 + index), download=96, upload=95) for index in range(3)]
        response = await client.post("/api/v1/agent/measurements:batch", headers=reserve_headers, json={"measurements": recovery})
        assert response.status_code == 200, response.text
        reserve = (await client.get("/api/v1/lines/line-42-reserve", headers=admin)).json()
        assert reserve["state"]["connection_state"] == "OK", reserve
        reserve_incidents = (await client.get("/api/v1/incidents?line_id=line-42-reserve", headers=admin)).json()
        assert reserve_incidents and reserve_incidents[0]["status"] == "CLOSED", reserve_incidents

        primary_headers = {"X-Device-ID": "device-42-primary", "X-Device-Token": primary_token}
        contract_bad = [measurement(f"{run_id}-contract-{index}", now + timedelta(seconds=6 + index), download=45, upload=42) for index in range(3)]
        response = await client.post("/api/v1/agent/measurements:batch", headers=primary_headers, json={"measurements": contract_bad})
        assert response.status_code == 200, response.text
        primary_incidents = (await client.get("/api/v1/incidents?line_id=line-42-primary", headers=admin)).json()
        incident = next(item for item in primary_incidents if item["source"] == "AUTO")
        draft = await client.post(f"/api/v1/incidents/{incident['id']}/provider-case/draft", headers=admin, json={"comment": "Live PostgreSQL smoke"})
        assert draft.status_code == 201, draft.text
        case_id = draft.json()["id"]
        assert (await client.post(f"/api/v1/provider-cases/{case_id}/send", headers=admin, json={"final_text": "blocked"})).status_code == 409
        sent = await client.post(f"/api/v1/provider-cases/{case_id}/send", headers=admin, json={"final_text": "Проверенный live smoke текст.", "reviewed": True})
        assert sent.status_code == 200 and sent.json()["status"] == "SENT", sent.text

        passport = await client.get("/api/v1/reports/quality-passport?period=week", headers=admin)
        assert passport.status_code == 200 and passport.json()["measurements_received"] >= 6, passport.text
        raw = await client.get("/api/v1/exports?kind=raw&format=csv&period=week", headers=admin)
        assert raw.status_code == 200 and "observed_at" in raw.text, raw.text[:500]
        aggregate = await client.get("/api/v1/exports?kind=aggregate&format=xlsx&period=week", headers=admin)
        assert aggregate.status_code == 200 and aggregate.content[:2] == b"PK", aggregate.text[:200]
        device = await client.get("/api/v1/devices/device-42-primary", headers=admin)
        assert device.status_code == 200 and "auth_token_hash" not in device.json(), device.text
        audit = await client.get("/api/v1/audit?limit=20", headers=admin)
        assert audit.status_code == 200 and audit.json(), audit.text

    print("POSTGRES_LIVE_SMOKE=PASS")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--base-url", default=os.getenv("VKO_SERVER_URL", "http://127.0.0.1:8000"))
    parser.add_argument("--device-token", default=os.getenv("VKO_DEVICE_TOKEN", ""))
    parser.add_argument("--primary-token", default=os.getenv("VKO_PRIMARY_DEVICE_TOKEN", ""))
    args = parser.parse_args()
    if not args.device_token or not args.primary_token:
        raise SystemExit("Set VKO_DEVICE_TOKEN and VKO_PRIMARY_DEVICE_TOKEN for the seeded devices.")
    asyncio.run(main(args.base_url, args.device_token, args.primary_token))
