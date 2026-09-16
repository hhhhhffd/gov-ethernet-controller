from __future__ import annotations

import asyncio
import io
import os
import tempfile
import unittest
import zipfile
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

import httpx

from backend.app.main import create_app
from backend.app.transports import DeliveryError, DeliveryResult


class ApiTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.db_path = Path(self.temp_dir.name) / "test.sqlite3"
        self.app = create_app(self.db_path)
        self.client = httpx.AsyncClient(transport=httpx.ASGITransport(app=self.app), base_url="http://test")

    async def asyncTearDown(self) -> None:
        await self.client.aclose()
        self.temp_dir.cleanup()

    async def token(self, username: str = "admin") -> str:
        response = await self.client.post("/api/login", json={"username": username, "password": "demo"})
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()["token"]

    async def test_health_login_scope_and_static_ui(self) -> None:
        self.assertEqual((await self.client.get("/health")).status_code, 200)
        self.assertEqual((await self.client.get("/health/ready")).status_code, 200)
        self.assertEqual((await self.client.post("/api/login", json={"username": "admin", "password": "wrong"})).status_code, 401)
        admin = {"Authorization": f"Bearer {await self.token()}"}
        lines = await self.client.get("/api/v1/lines", headers=admin)
        self.assertEqual(lines.status_code, 200)
        self.assertGreaterEqual(len(lines.json()), 4)
        provider = {"Authorization": f"Bearer {await self.token('provider-a')}"}
        visible = await self.client.get("/api/v1/lines", headers=provider)
        self.assertEqual(visible.status_code, 200)
        self.assertTrue(visible.json())
        self.assertTrue(all(item["provider_id"] == "provider-a" for item in visible.json()))
        self.assertEqual((await self.client.get("/api/v1/lines/line-42-reserve", headers=provider)).status_code, 404)
        reserve = next(item for item in lines.json() if item["id"] == "line-42-reserve")
        self.assertEqual(reserve["status"], "NO_DATA")
        self.assertEqual(reserve["state"]["connection_state"], "UNKNOWN")
        for endpoint in ("organizations", "providers", "lines", "users", "devices", "monitoring-points"):
            response = await self.client.get(f"/api/v1/admin/{endpoint}", headers=admin)
            self.assertEqual(response.status_code, 200)
            self.assertTrue(response.json())
        schedule = await self.client.put("/api/v1/admin/schedules", json={"tests_per_day": 5, "jitter_minutes": 10}, headers=admin)
        self.assertEqual(schedule.status_code, 200, schedule.text)
        device_config = await self.client.get("/api/v1/agent/config", headers={"X-Device-ID": "device-42-primary", "X-Device-Token": "demo-device-42-primary-token"})
        self.assertEqual(device_config.json()["schedule"]["performance_tests_per_day"], 5)
        page = await self.client.get("/")
        self.assertEqual(page.status_code, 200)
        self.assertIn("LINKWATCH", page.text)

    async def test_sessions_are_independent_and_logout_revokes_only_one(self) -> None:
        first = await self.token()
        second = await self.token()
        first_headers = {"Authorization": f"Bearer {first}"}
        second_headers = {"Authorization": f"Bearer {second}"}
        self.assertEqual((await self.client.get("/api/v1/auth/me", headers=first_headers)).status_code, 200)
        self.assertEqual((await self.client.get("/api/v1/auth/me", headers=second_headers)).status_code, 200)
        logout = await self.client.post("/api/v1/auth/logout", headers=first_headers)
        self.assertEqual(logout.status_code, 200, logout.text)
        self.assertEqual((await self.client.get("/api/v1/auth/me", headers=first_headers)).status_code, 401)
        self.assertEqual((await self.client.get("/api/v1/auth/me", headers=second_headers)).status_code, 200)

    async def test_production_uses_hashed_password_and_bootstrap_admin(self) -> None:
        with tempfile.TemporaryDirectory() as directory, patch.dict(
            os.environ,
            {
                "VKO_ENV": "production",
                "VKO_AUTO_SEED": "0",
                "VKO_BOOTSTRAP_ADMIN_USERNAME": "root",
                "VKO_BOOTSTRAP_ADMIN_PASSWORD": "correct horse battery staple",
                "VKO_AUTH_DISABLED": "0",
            },
            clear=False,
        ):
            app = create_app(Path(directory) / "production.sqlite3")
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
                wrong = await client.post("/api/login", json={"username": "root", "password": "demo"})
                self.assertEqual(wrong.status_code, 401)
                login = await client.post("/api/login", json={"username": "root", "password": "correct horse battery staple"})
                self.assertEqual(login.status_code, 200, login.text)
                headers = {"Authorization": f"Bearer {login.json()['token']}"}
                self.assertEqual((await client.get("/api/v1/auth/me", headers=headers)).status_code, 200)
                self.assertEqual((await client.post("/api/v1/demo/replay", headers=headers)).status_code, 404)
                self.assertEqual((await client.post("/api/v1/admin/demo/reset", headers=headers, json={"seed_measurements": False})).status_code, 404)
    async def test_strict_payload_rejects_unknown_agent_fields(self) -> None:
        response = await self.client.post(
            "/api/v1/agent/measurements:batch",
            json={"measurements": [{**self.measurement("strict"), "typo_metric": 123}]},
            headers={"X-Device-ID": "device-42-primary", "X-Device-Token": "demo-device-42-primary-token"},
        )
        self.assertEqual(response.status_code, 422)

    async def post_measurements(self, device_id: str, device_token: str, values: list[dict]) -> list[dict]:
        headers = {"X-Device-ID": device_id, "X-Device-Token": device_token}
        response = await self.client.post("/api/v1/agent/measurements:batch", json={"measurements": values}, headers=headers)
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()["results"]

    @staticmethod
    def measurement(event_id: str, *, download: float | None = 96, upload: float | None = 95, ping: float | None = 30, connection_status: str = "OK") -> dict:
        return {
            "client_event_id": event_id,
            "observed_at": (datetime.now(timezone.utc) - timedelta(minutes=5)).replace(microsecond=0).isoformat(),
            "mode": "PERFORMANCE",
            "download": download,
            "upload": upload,
            "ping": ping,
            "jitter": 8,
            "packet_loss": 0.2,
            "availability": 100,
            "connection_status": connection_status,
        }

    async def test_idempotent_ingest_and_confirmed_contract_incident(self) -> None:
        values = [self.measurement(f"bad-{index}", download=45 - index, upload=42 - index) for index in range(3)]
        results = await self.post_measurements("device-42-primary", "demo-device-42-primary-token", values)
        self.assertEqual([item["duplicate"] for item in results], [False, False, False])
        self.assertTrue(any(item["evaluation"]["contract_state"] == "DEVIATES" for item in results))
        duplicate = await self.post_measurements("device-42-primary", "demo-device-42-primary-token", [values[0]])
        self.assertTrue(duplicate[0]["duplicate"])
        token = await self.token()
        incidents = await self.client.get("/api/v1/incidents", headers={"Authorization": f"Bearer {token}"})
        self.assertEqual(incidents.status_code, 200)
        incident = next(item for item in incidents.json() if item["line_id"] == "line-42-primary")
        self.assertEqual(incident["source"], "AUTO")
        self.assertIn("policy", incident["opening_snapshot"])
        provider_export = await self.client.get("/api/v1/exports?kind=raw&format=csv&provider=Provider%20A", headers={"Authorization": f"Bearer {token}"})
        self.assertIn("line-42-primary", provider_export.text)
        other_provider_export = await self.client.get("/api/v1/exports?kind=raw&format=csv&provider=Provider%20B", headers={"Authorization": f"Bearer {token}"})
        self.assertNotIn("line-42-primary", other_provider_export.text)

    async def test_no_internet_recovery_reopen_and_provider_case(self) -> None:
        bad = [self.measurement(f"outage-{index}", download=None, upload=None, ping=None, connection_status="NO_INTERNET") for index in range(3)]
        await self.post_measurements("device-42-reserve", "demo-device-42-reserve-token", bad)
        token = await self.token()
        headers = {"Authorization": f"Bearer {token}"}
        lines = (await self.client.get("/api/v1/lines", headers=headers)).json()
        reserve = next(item for item in lines if item["id"] == "line-42-reserve")
        self.assertEqual(reserve["state"]["connection_state"], "NO_INTERNET")
        incidents = (await self.client.get("/api/v1/incidents?line_id=line-42-reserve", headers=headers)).json()
        incident = incidents[0]
        draft = await self.client.post(f"/api/v1/incidents/{incident['id']}/provider-case/draft", json={"comment": "Пожалуйста, проверьте линию."}, headers=headers)
        self.assertEqual(draft.status_code, 201, draft.text)
        self.assertTrue(draft.json()["draft_text"])
        self.assertIn("Договорный ориентир", draft.json()["draft_text"])
        case_id = draft.json()["id"]
        unreviewed = await self.client.post(f"/api/v1/provider-cases/{case_id}/send", json={"final_text": "Попытка без проверки"}, headers=headers)
        self.assertEqual(unreviewed.status_code, 409)
        school_token = await self.token("school-42")
        school_fixed = await self.client.post(f"/api/v1/incidents/{incident['id']}/events", json={"event_type": "provider_fixed"}, headers={"Authorization": f"Bearer {school_token}"})
        self.assertEqual(school_fixed.status_code, 403)
        sent = await self.client.post(f"/api/v1/provider-cases/{case_id}/send", json={"final_text": "Проверенный текст обращения.", "reviewed": True}, headers=headers)
        self.assertEqual(sent.status_code, 200, sent.text)
        self.assertEqual(sent.json()["status"], "SENT")
        fixed = await self.client.post(f"/api/v1/incidents/{incident['id']}/events", json={"event_type": "provider_fixed"}, headers=headers)
        self.assertEqual(fixed.status_code, 200)
        self.assertEqual(fixed.json()["status"], "RESOLVED")
        good = [self.measurement(f"recovery-{index}", download=96, upload=95) for index in range(3)]
        await self.post_measurements("device-42-reserve", "demo-device-42-reserve-token", good)
        closed = (await self.client.get(f"/api/v1/incidents/{incident['id']}", headers=headers)).json()
        self.assertEqual(closed["status"], "CLOSED")
        self.assertEqual(closed["recovery_state"], "CONFIRMED")

    async def test_provider_delivery_failure_is_durable_and_retryable(self) -> None:
        bad = [self.measurement(f"delivery-outage-{index}", download=None, upload=None, ping=None, connection_status="NO_INTERNET") for index in range(3)]
        await self.post_measurements("device-42-reserve", "demo-device-42-reserve-token", bad)
        token = await self.token()
        headers = {"Authorization": f"Bearer {token}"}
        incident = (await self.client.get("/api/v1/incidents?line_id=line-42-reserve", headers=headers)).json()[0]
        draft = await self.client.post(f"/api/v1/incidents/{incident['id']}/provider-case/draft", json={}, headers=headers)
        case_id = draft.json()["id"]
        with patch("backend.app.main.deliver_provider_case", side_effect=DeliveryError("provider is offline")):
            failed = await self.client.post(f"/api/v1/provider-cases/{case_id}/send", json={"reviewed": True}, headers=headers)
        self.assertEqual(failed.status_code, 502, failed.text)
        detail = (await self.client.get(f"/api/v1/incidents/{incident['id']}", headers=headers)).json()
        failed_case = detail["provider_cases"][0]
        self.assertEqual(failed_case["status"], "FAILED")
        self.assertEqual(failed_case["delivery_attempts"], 1)
        with patch("backend.app.main.deliver_provider_case", return_value=DeliveryResult("WEBHOOK", "EXT-42")):
            retried = await self.client.post(f"/api/v1/provider-cases/{case_id}/retry", json={"reviewed": True}, headers=headers)
        self.assertEqual(retried.status_code, 200, retried.text)
        self.assertEqual(retried.json()["status"], "SENT")
        self.assertEqual(retried.json()["external_ticket_no"], "EXT-42")

    async def test_notification_delivery_failure_is_visible_for_retry(self) -> None:
        outage = [self.measurement(f"notification-outage-{index}", download=None, upload=None, ping=None, connection_status="NO_INTERNET") for index in range(3)]
        with patch("backend.app.transports.deliver_notification", side_effect=DeliveryError("notification endpoint is offline")):
            await self.post_measurements("device-42-reserve", "demo-device-42-reserve-token", outage)
        token = await self.token()
        headers = {"Authorization": f"Bearer {token}"}
        notifications = await self.client.get("/api/v1/notifications", headers=headers)
        self.assertEqual(notifications.status_code, 200)
        reserve_incident = (await self.client.get("/api/v1/incidents?line_id=line-42-reserve", headers=headers)).json()[0]
        failed = next(item for item in notifications.json() if item["source_type"] == "INCIDENT" and item["source_id"] == str(reserve_incident["id"]))
        self.assertEqual(failed["status"], "FAILED")
        with patch("backend.app.transports.deliver_notification", return_value=DeliveryResult("WEBHOOK", "MSG-1")):
            dispatched = await self.client.post(f"/api/v1/admin/notifications/{failed['id']}/dispatch", headers=headers)
        self.assertEqual(dispatched.status_code, 200, dispatched.text)
        self.assertEqual(dispatched.json()["status"], "SENT")

    async def test_monitoring_recovery_closes_without_provider_ack(self) -> None:
        outage = [self.measurement(f"no-ack-outage-{index}", download=None, upload=None, ping=None, connection_status="NO_INTERNET") for index in range(3)]
        await self.post_measurements("device-42-reserve", "demo-device-42-reserve-token", outage)
        recovery = [self.measurement(f"no-ack-recovery-{index}", download=96, upload=95) for index in range(3)]
        await self.post_measurements("device-42-reserve", "demo-device-42-reserve-token", recovery)
        token = await self.token()
        incidents = await self.client.get("/api/v1/incidents?line_id=line-42-reserve", headers={"Authorization": f"Bearer {token}"})
        self.assertEqual(incidents.status_code, 200)
        self.assertEqual(incidents.json()[0]["status"], "CLOSED")
        self.assertEqual(incidents.json()[0]["recovery_state"], "CONFIRMED")

    async def test_situation_requires_two_correlated_incidents(self) -> None:
        token = await self.token()
        headers = {"Authorization": f"Bearer {token}"}
        first = await self.client.post("/api/v1/incidents", json={"line_id": "line-07-primary", "violation_type": "NO_INTERNET"}, headers=headers)
        second = await self.client.post("/api/v1/incidents", json={"line_id": "line-07-primary", "violation_type": "NO_INTERNET"}, headers=headers)
        self.assertEqual(first.status_code, 201)
        self.assertEqual(second.status_code, 201)
        situations = await self.client.get("/api/v1/situations", headers=headers)
        self.assertEqual(situations.status_code, 200, situations.text)
        match = next(item for item in situations.json() if set(item["incident_ids"]) == {first.json()["id"], second.json()["id"]})
        self.assertEqual(match["affected_count"], 2)

    async def test_manual_incident_cannot_close_without_recovery_and_exports_are_files(self) -> None:
        token = await self.token()
        headers = {"Authorization": f"Bearer {token}"}
        created = await self.client.post("/api/v1/incidents", json={"line_id": "line-07-primary", "description": "Проверка оператором"}, headers=headers)
        self.assertEqual(created.status_code, 201, created.text)
        incident_id = created.json()["id"]
        forbidden = await self.client.post(f"/api/v1/incidents/{incident_id}/events", json={"event_type": "status", "status": "CLOSED"}, headers=headers)
        self.assertEqual(forbidden.status_code, 409)
        csv_response = await self.client.get("/api/v1/exports?kind=raw&format=csv", headers=headers)
        self.assertEqual(csv_response.status_code, 200)
        self.assertIn("text/csv", csv_response.headers["content-type"])
        self.assertIn("observed_at", csv_response.text)
        filtered_csv = await self.client.get("/api/v1/exports?kind=raw&format=csv&district=НетТакогоРайона", headers=headers)
        self.assertEqual(filtered_csv.status_code, 200)
        self.assertNotIn("line-", filtered_csv.text)
        xlsx_response = await self.client.get("/api/v1/exports?kind=aggregate&format=xlsx", headers=headers)
        self.assertEqual(xlsx_response.status_code, 200)
        with zipfile.ZipFile(io.BytesIO(xlsx_response.content)) as archive:
            self.assertIn("xl/worksheets/sheet1.xml", archive.namelist())
            self.assertIn("[Content_Types].xml", archive.namelist())
            self.assertIn('<c r="B2"><v>', archive.read("xl/worksheets/sheet1.xml").decode("utf-8"))

    async def test_temporal_policy_window_and_period_aware_passport(self) -> None:
        token = await self.token()
        headers = {"Authorization": f"Bearer {token}"}
        base = datetime.now(timezone.utc).replace(microsecond=0) - timedelta(hours=8)
        policy = await self.client.post(
            "/api/v1/admin/policies",
            json={"scope_type": "GLOBAL", "valid_from": (base - timedelta(hours=1)).isoformat(), "confirm_minutes": 60},
            headers=headers,
        )
        self.assertEqual(policy.status_code, 201, policy.text)
        values = []
        for index, observed_at in enumerate((base, base + timedelta(hours=2), base + timedelta(hours=4))):
            values.append(self.measurement(f"window-old-{index}", download=10, upload=10) | {"observed_at": observed_at.isoformat()})
        result = await self.post_measurements("device-07-primary", "demo-device-07-primary-token", values)
        self.assertFalse(result[-1]["evaluation"]["baseline_state"] == "OK")
        incidents = await self.client.get("/api/v1/incidents?line_id=line-07-primary", headers=headers)
        self.assertEqual(incidents.json(), [])
        close_window = [self.measurement(f"window-new-{index}", download=10, upload=10) | {"observed_at": (base + timedelta(hours=5, minutes=index * 10)).isoformat()} for index in range(3)]
        await self.post_measurements("device-07-primary", "demo-device-07-primary-token", close_window)
        incidents = await self.client.get("/api/v1/incidents?line_id=line-07-primary", headers=headers)
        self.assertEqual(incidents.status_code, 200)
        self.assertEqual(len(incidents.json()), 1)
        passport = await self.client.get("/api/v1/reports/quality-passport?period=week", headers=headers)
        self.assertEqual(passport.status_code, 200)
        self.assertEqual(passport.json()["measurements_expected"], 112)

    async def test_backfilled_observation_is_evidence_without_current_state_rewrite(self) -> None:
        old = (datetime.now(timezone.utc) - timedelta(days=3)).replace(microsecond=0).isoformat()
        payload = self.measurement("old-backfill", download=5, upload=5) | {"observed_at": old}
        await self.post_measurements("device-99-primary", "demo-device-99-primary-token", [payload])
        token = await self.token()
        lines = await self.client.get("/api/v1/lines", headers={"Authorization": f"Bearer {token}"})
        line = next(item for item in lines.json() if item["id"] == "line-99-primary")
        self.assertEqual(line["data_state"], "NO_DATA")
        self.assertNotEqual(line["status"], "NO_INTERNET")
        self.assertEqual(line["state"]["connection_state"], "UNKNOWN")

    async def test_device_guard_and_automatic_recovery_close(self) -> None:
        admin_token = await self.token()
        admin_headers = {"Authorization": f"Bearer {admin_token}"}
        future = self.measurement("future", download=90) | {"observed_at": (datetime.now(timezone.utc) + timedelta(hours=1)).isoformat()}
        rejected = await self.client.post("/api/v1/agent/measurements:batch", json={"measurements": [future]}, headers={"X-Device-ID": "device-42-primary", "X-Device-Token": "demo-device-42-primary-token"})
        self.assertEqual(rejected.status_code, 422)
        blocked = await self.client.post("/api/v1/admin/devices/device-99-primary/block", headers=admin_headers)
        self.assertEqual(blocked.status_code, 200)
        denied = await self.client.post("/api/v1/agent/measurements:batch", json={"measurements": [self.measurement("blocked")]}, headers={"X-Device-ID": "device-99-primary", "X-Device-Token": "demo-device-99-primary-token"})
        self.assertEqual(denied.status_code, 401)
        self.assertEqual((await self.client.post("/api/v1/admin/devices/device-99-primary/unblock", headers=admin_headers)).status_code, 200)
        outage = [self.measurement(f"auto-outage-{index}", download=None, upload=None, ping=None, connection_status="NO_INTERNET") for index in range(3)]
        await self.post_measurements("device-99-primary", "demo-device-99-primary-token", outage)
        healthy = [self.measurement(f"auto-recovery-{index}", download=96, upload=95) for index in range(3)]
        await self.post_measurements("device-99-primary", "demo-device-99-primary-token", healthy)
        incidents = await self.client.get("/api/v1/incidents?line_id=line-99-primary", headers=admin_headers)
        self.assertEqual(incidents.json()[0]["status"], "CLOSED")


if __name__ == "__main__":
    unittest.main()
