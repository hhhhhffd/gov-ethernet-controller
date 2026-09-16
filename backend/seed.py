from __future__ import annotations

import argparse
import os
from datetime import datetime, timedelta, timezone
from pathlib import Path

from .app.db import get_connection, init_db
from .app.services import dt_text, hash_password, process_measurement, token_hash, utc_now


DEMO_USER_TOKENS = {
    "admin": "demo-admin-token",
    "oblast": "demo-oblast-token",
    "district": "demo-district-token",
    "provider-a": "demo-provider-a-token",
    "school-42": "demo-school-42-token",
}

DEMO_DEVICE_TOKENS = {
    "device-42-primary": "demo-device-42-primary-token",
    "device-42-reserve": "demo-device-42-reserve-token",
    "device-07-primary": "demo-device-07-primary-token",
    "device-99-primary": "demo-device-99-primary-token",
}


UTC = timezone.utc


def _insert_seed(connection, sql: str, args: tuple) -> None:
    connection.execute(sql, args)


def _clear_demo(connection) -> None:
    for table in (
        "audit_events",
        "notifications",
        "situation_members",
        "situations",
        "provider_cases",
        "incident_events",
        "incidents",
        "line_state_events",
        "line_states",
        "measurement_evaluations",
        "measurements",
        "role_scopes",
        "auth_sessions",
        "users",
        "agent_schedules",
        "devices",
        "monitoring_points",
        "threshold_policy_versions",
        "contract_versions",
        "lines",
        "providers",
        "organizations",
    ):
        connection.execute(f"DELETE FROM {table}")


def seed_demo(db_path: str | Path | None = None, *, reset: bool = False, seed_measurements: bool = False) -> None:
    if os.getenv("VKO_ENV", "development").lower() == "production" and os.getenv("VKO_ALLOW_DEMO_SEED") != "1":
        raise RuntimeError("demo seed is disabled in production; use an explicit staging profile")
    init_db(db_path)
    with get_connection(db_path) as connection:
        # Multiple Uvicorn workers can bootstrap a fresh PostgreSQL database at
        # the same time. Keep the existing idempotent inserts, but serialize
        # the first seed transaction so unique policy rows cannot race.
        if getattr(connection, "is_postgres", False):
            connection.execute("SELECT pg_advisory_xact_lock(742032)")
        if reset:
            _clear_demo(connection)
        now = dt_text(utc_now())
        organizations = [
            ("org-42", "school-42", "Школа №42", "Алтай", "ул. Центральная, 42", 50.35, 82.62, "Елена Соколова", "+7 700 000 42 42"),
            ("org-07", "school-07", "Школа №7", "Усть-Каменогорск", "пр. Абая, 7", 49.95, 82.61, "Аскар Нуров", "+7 700 000 07 07"),
            ("org-99", "school-99", "Школа №99", "Алтай", "ул. Школьная, 1", 50.31, 82.59, "Мария Ильина", "+7 700 000 99 99"),
        ]
        for row in organizations:
            _insert_seed(
                connection,
                "INSERT OR IGNORE INTO organizations(id, school_id, name, district, address, latitude, longitude, contact_name, contact_phone, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (*row, now),
            )
        providers = [
            ("provider-a", "Provider A", "support@provider-a.example"),
            ("provider-b", "Provider B", "support@provider-b.example"),
        ]
        for row in providers:
            _insert_seed(connection, "INSERT OR IGNORE INTO providers(id, name, support_contact, created_at) VALUES (?, ?, ?, ?)", (*row, now))
        lines = [
            ("line-42-primary", "org-42", "provider-a", "PRIMARY", "FIBER"),
            ("line-42-reserve", "org-42", "provider-b", "RESERVE", "STARLINK"),
            ("line-07-primary", "org-07", "provider-a", "PRIMARY", "FIBER"),
            ("line-99-primary", "org-99", "provider-a", "PRIMARY", "LTE"),
        ]
        for row in lines:
            _insert_seed(connection, "INSERT OR IGNORE INTO lines(id, organization_id, provider_id, role, technology, status, created_at) VALUES (?, ?, ?, ?, ?, 'ACTIVE', ?)", (*row, now))
        contract_defaults = {
            "line-42-primary": (100, 100),
            "line-42-reserve": (40, 10),
            "line-07-primary": (50, 50),
            "line-99-primary": (20, 10),
        }
        for line_id, (download, upload) in contract_defaults.items():
            if not connection.execute("SELECT 1 FROM contract_versions WHERE line_id = ?", (line_id,)).fetchone():
                _insert_seed(
                    connection,
                    "INSERT INTO contract_versions(line_id, valid_from, contract_no, contract_date, download_min, upload_min, ping_max, jitter_max, packet_loss_max, availability_min, created_by, created_at) VALUES (?, '2020-01-01T00:00:00+00:00', ?, '2020-01-01T00:00:00+00:00', ?, ?, 100, 30, 2, 99, 'seed', ?)",
                    (line_id, f"CONTRACT-{line_id}", download, upload, now),
                )
        points = [
            ("point-42-primary", "line-42-primary", "серверная, Ethernet", 1),
            ("point-42-reserve", "line-42-reserve", "серверная, резервный шлюз", 1),
            ("point-07-primary", "line-07-primary", "серверная, Ethernet", 1),
            ("point-99-primary", "line-99-primary", "кабинет связи, Ethernet", 1),
        ]
        for row in points:
            _insert_seed(connection, "INSERT OR IGNORE INTO monitoring_points(id, line_id, location, is_primary, created_at) VALUES (?, ?, ?, ?, ?)", (*row, now))
        devices = [
            ("device-42-primary", "point-42-primary", DEMO_DEVICE_TOKENS["device-42-primary"]),
            ("device-42-reserve", "point-42-reserve", DEMO_DEVICE_TOKENS["device-42-reserve"]),
            ("device-07-primary", "point-07-primary", DEMO_DEVICE_TOKENS["device-07-primary"]),
            ("device-99-primary", "point-99-primary", DEMO_DEVICE_TOKENS["device-99-primary"]),
        ]
        for device_id, point_id, token in devices:
            _insert_seed(connection, "INSERT OR IGNORE INTO devices(id, monitoring_point_id, auth_token_hash, agent_version, created_at) VALUES (?, ?, ?, '0.1.0', ?)", (device_id, point_id, token_hash(token), now))
        if not connection.execute("SELECT 1 FROM threshold_policy_versions LIMIT 1").fetchone():
            _insert_seed(
                connection,
                "INSERT INTO threshold_policy_versions(scope_type, valid_from, version, download_min, upload_min, ping_max, jitter_max, packet_loss_max, availability_min, confirm_count, recovery_count, freshness_seconds, created_by, created_at) VALUES ('GLOBAL', '2020-01-01T00:00:00+00:00', 1, 20, 20, 100, 30, 2, 99, 3, 3, 86400, 'seed', ?)",
                (now,),
            )
        users = [
            ("user-admin", "admin", "ADMIN"),
            ("user-oblast", "oblast", "OBLAST"),
            ("user-district", "district", "DISTRICT"),
            ("user-provider-a", "provider-a", "PROVIDER"),
            ("user-school-42", "school-42", "SCHOOL"),
        ]
        demo_password_hash = hash_password("demo")
        for user_id, username, role in users:
            _insert_seed(connection, "INSERT OR IGNORE INTO users(id, username, role, token_hash, password_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)", (user_id, username, role, token_hash(DEMO_USER_TOKENS[username]), demo_password_hash, now))
            # Upgrade a database seeded by an older MVP without changing an
            # operator-managed password hash that is already present.
            connection.execute("UPDATE users SET password_hash = ? WHERE id = ? AND (password_hash IS NULL OR password_hash = '')", (demo_password_hash, user_id))
        scopes = [
            ("user-district", "DISTRICT", "Алтай"),
            ("user-provider-a", "PROVIDER", "provider-a"),
            ("user-school-42", "ORGANIZATION", "org-42"),
        ]
        for row in scopes:
            _insert_seed(connection, "INSERT OR IGNORE INTO role_scopes(user_id, scope_type, scope_id) VALUES (?, ?, ?)", row)
        if seed_measurements and not connection.execute("SELECT 1 FROM measurements LIMIT 1").fetchone():
            base = utc_now() - timedelta(hours=2)
            for index, values in enumerate(((96, 96, 22, 4, 0.2), (95, 95, 23, 5, 0.3), (97, 96, 21, 4, 0.1))):
                device = connection.execute("SELECT d.*, mp.line_id, mp.id AS point_id FROM devices d JOIN monitoring_points mp ON mp.id = d.monitoring_point_id WHERE d.id = 'device-42-primary'").fetchone()
                process_measurement(
                    connection,
                    device,
                    {
                        "client_event_id": f"seed-normal-{index}",
                        "observed_at": base + timedelta(minutes=index * 20),
                        "mode": "PERFORMANCE",
                        "download": values[0],
                        "upload": values[1],
                        "ping": values[2],
                        "jitter": values[3],
                        "packet_loss": values[4],
                        "availability": 100,
                        "connection_status": "OK",
                        "quality": "VALID",
                        "raw": {"source": "seed"},
                    },
                )


def main() -> None:
    parser = argparse.ArgumentParser(description="Seed VKO MVP demo data")
    parser.add_argument("--db", default=None)
    parser.add_argument("--reset", action="store_true")
    parser.add_argument("--measurements", action="store_true")
    args = parser.parse_args()
    seed_demo(args.db, reset=args.reset, seed_measurements=args.measurements)
    print(f"Seeded VKO demo database at {args.db or 'vko_mvp.db'}")


if __name__ == "__main__":
    main()
