from __future__ import annotations

import os
import queue
import re
import sqlite3
import threading
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator


DEFAULT_DB_PATH = os.getenv("VKO_DB_PATH", "vko_mvp.db")


def is_postgres_path(value: str | Path | None) -> bool:
    text = str(value or "")
    return text.startswith(("postgres://", "postgresql://"))


SCHEMA = """
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS organizations (
    id TEXT PRIMARY KEY,
    school_id TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    district TEXT NOT NULL,
    address TEXT NOT NULL DEFAULT '',
    latitude REAL,
    longitude REAL,
    contact_name TEXT NOT NULL DEFAULT '',
    contact_phone TEXT NOT NULL DEFAULT '',
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS providers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    support_contact TEXT NOT NULL DEFAULT '',
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS lines (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL REFERENCES organizations(id),
    provider_id TEXT REFERENCES providers(id),
    role TEXT NOT NULL CHECK (role IN ('PRIMARY', 'RESERVE', 'INACTIVE')),
    technology TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'ACTIVE',
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS contract_versions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    line_id TEXT NOT NULL REFERENCES lines(id),
    valid_from TEXT NOT NULL,
    valid_to TEXT,
    contract_no TEXT,
    contract_date TEXT,
    download_min REAL,
    upload_min REAL,
    ping_max REAL,
    jitter_max REAL,
    packet_loss_max REAL,
    availability_min REAL,
    created_by TEXT,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_contract_line_valid ON contract_versions(line_id, valid_from, valid_to);

CREATE TABLE IF NOT EXISTS monitoring_points (
    id TEXT PRIMARY KEY,
    line_id TEXT NOT NULL REFERENCES lines(id),
    location TEXT NOT NULL DEFAULT '',
    is_primary INTEGER NOT NULL DEFAULT 0,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS devices (
    id TEXT PRIMARY KEY,
    monitoring_point_id TEXT NOT NULL REFERENCES monitoring_points(id),
    auth_token_hash TEXT NOT NULL,
    agent_version TEXT NOT NULL DEFAULT '0.1.0',
    last_seen TEXT,
    blocked_at TEXT,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_schedules (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    tests_per_day INTEGER NOT NULL DEFAULT 4 CHECK (tests_per_day BETWEEN 3 AND 5),
    jitter_minutes INTEGER NOT NULL DEFAULT 8 CHECK (jitter_minutes BETWEEN 0 AND 240),
    light_checks_between INTEGER NOT NULL DEFAULT 0,
    updated_by TEXT,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS threshold_policy_versions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    scope_type TEXT NOT NULL DEFAULT 'GLOBAL',
    scope_id TEXT,
    valid_from TEXT NOT NULL,
    valid_to TEXT,
    version INTEGER NOT NULL,
    download_min REAL NOT NULL DEFAULT 20,
    upload_min REAL NOT NULL DEFAULT 20,
    ping_max REAL NOT NULL DEFAULT 100,
    jitter_max REAL NOT NULL DEFAULT 30,
    packet_loss_max REAL NOT NULL DEFAULT 2,
    availability_min REAL NOT NULL DEFAULT 99,
    confirm_count INTEGER NOT NULL DEFAULT 3,
    confirm_minutes INTEGER NOT NULL DEFAULT 0,
    recovery_count INTEGER NOT NULL DEFAULT 3,
    recovery_minutes INTEGER NOT NULL DEFAULT 0,
    freshness_seconds INTEGER NOT NULL DEFAULT 86400,
    created_by TEXT,
    created_at TEXT NOT NULL,
    UNIQUE(scope_type, scope_id, version)
);
CREATE INDEX IF NOT EXISTS ix_policy_effective ON threshold_policy_versions(scope_type, scope_id, valid_from, valid_to);

CREATE TABLE IF NOT EXISTS measurements (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id TEXT NOT NULL REFERENCES devices(id),
    line_id TEXT NOT NULL REFERENCES lines(id),
    monitoring_point_id TEXT NOT NULL REFERENCES monitoring_points(id),
    client_event_id TEXT NOT NULL,
    observed_at TEXT NOT NULL,
    received_at TEXT NOT NULL,
    mode TEXT NOT NULL CHECK (mode IN ('LIGHT', 'PERFORMANCE')),
    download REAL,
    upload REAL,
    ping REAL,
    jitter REAL,
    packet_loss REAL,
    availability REAL,
    connection_status TEXT NOT NULL DEFAULT 'OK',
    raw_json TEXT NOT NULL DEFAULT '{}',
    quality TEXT NOT NULL DEFAULT 'VALID',
    policy_id INTEGER REFERENCES threshold_policy_versions(id),
    contract_version_id INTEGER REFERENCES contract_versions(id),
    UNIQUE(device_id, client_event_id)
);
CREATE INDEX IF NOT EXISTS ix_measurement_line_time ON measurements(line_id, observed_at);
CREATE INDEX IF NOT EXISTS ix_measurement_device_event ON measurements(device_id, client_event_id);

CREATE TABLE IF NOT EXISTS measurement_evaluations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    measurement_id INTEGER NOT NULL UNIQUE REFERENCES measurements(id),
    baseline_state TEXT NOT NULL,
    contract_state TEXT NOT NULL,
    violations_json TEXT NOT NULL DEFAULT '[]',
    valid INTEGER NOT NULL DEFAULT 1,
    reason TEXT NOT NULL DEFAULT '',
    policy_snapshot_json TEXT NOT NULL DEFAULT '{}',
    contract_snapshot_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS line_states (
    line_id TEXT PRIMARY KEY REFERENCES lines(id),
    data_state TEXT NOT NULL DEFAULT 'NO_DATA',
    connection_state TEXT NOT NULL DEFAULT 'UNKNOWN',
    contract_state TEXT NOT NULL DEFAULT 'UNKNOWN',
    recovery_state TEXT NOT NULL DEFAULT 'NONE',
    effective_since TEXT,
    updated_at TEXT NOT NULL,
    reason TEXT NOT NULL DEFAULT '',
    evidence_ids_json TEXT NOT NULL DEFAULT '[]',
    policy_id INTEGER REFERENCES threshold_policy_versions(id)
);

CREATE TABLE IF NOT EXISTS line_state_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    line_id TEXT NOT NULL REFERENCES lines(id),
    previous_data_state TEXT,
    previous_connection_state TEXT,
    previous_contract_state TEXT,
    data_state TEXT NOT NULL,
    connection_state TEXT NOT NULL,
    contract_state TEXT NOT NULL,
    recovery_state TEXT NOT NULL DEFAULT 'NONE',
    reason TEXT NOT NULL,
    evidence_ids_json TEXT NOT NULL DEFAULT '[]',
    config_snapshot_json TEXT NOT NULL DEFAULT '{}',
    occurred_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_state_event_line_time ON line_state_events(line_id, occurred_at);

CREATE TABLE IF NOT EXISTS incidents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    incident_no TEXT NOT NULL UNIQUE,
    line_id TEXT NOT NULL REFERENCES lines(id),
    source TEXT NOT NULL CHECK (source IN ('AUTO', 'MANUAL')),
    violation_type TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'NEW',
    recovery_state TEXT NOT NULL DEFAULT 'NONE',
    started_at TEXT NOT NULL,
    confirmed_at TEXT,
    resolved_at TEXT,
    closed_at TEXT,
    duration_minutes REAL,
    assignee TEXT,
    recurrence_of INTEGER REFERENCES incidents(id),
    opening_snapshot_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_incident_line_status ON incidents(line_id, status);

CREATE TABLE IF NOT EXISTS incident_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    incident_id INTEGER NOT NULL REFERENCES incidents(id),
    event_type TEXT NOT NULL,
    actor TEXT NOT NULL,
    payload_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS provider_cases (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    incident_id INTEGER NOT NULL REFERENCES incidents(id),
    ticket_no TEXT,
    draft_text TEXT NOT NULL,
    final_text TEXT,
    status TEXT NOT NULL DEFAULT 'DRAFT',
    delivery_channel TEXT NOT NULL DEFAULT 'INTERNAL',
    delivery_status TEXT NOT NULL DEFAULT 'PENDING',
    delivery_attempts INTEGER NOT NULL DEFAULT 0,
    delivery_error TEXT,
    external_ticket_no TEXT,
    created_by TEXT NOT NULL,
    sent_by TEXT,
    sent_at TEXT,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS situations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'OPEN',
    provider_id TEXT REFERENCES providers(id),
    district TEXT,
    violation_type TEXT,
    start_at TEXT NOT NULL,
    reason_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS situation_members (
    situation_id INTEGER NOT NULL REFERENCES situations(id),
    incident_id INTEGER NOT NULL REFERENCES incidents(id),
    PRIMARY KEY (situation_id, incident_id)
);

CREATE TABLE IF NOT EXISTS notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_type TEXT NOT NULL,
    source_id TEXT NOT NULL,
    channel TEXT NOT NULL DEFAULT 'WEB',
    recipient_scope TEXT NOT NULL,
    message TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'GENERATED',
    delivery_attempts INTEGER NOT NULL DEFAULT 0,
    delivery_error TEXT,
    generated_at TEXT NOT NULL,
    sent_at TEXT,
    read_at TEXT
);

CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    role TEXT NOT NULL,
    token_hash TEXT NOT NULL,
    password_hash TEXT,
    disabled_at TEXT,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS role_scopes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL REFERENCES users(id),
    scope_type TEXT NOT NULL,
    scope_id TEXT NOT NULL,
    UNIQUE(user_id, scope_type, scope_id)
);

CREATE TABLE IF NOT EXISTS auth_sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    token_hash TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    revoked_at TEXT,
    last_seen_at TEXT,
    ip_address TEXT,
    user_agent TEXT
);
CREATE INDEX IF NOT EXISTS ix_auth_session_token ON auth_sessions(token_hash, expires_at, revoked_at);
CREATE INDEX IF NOT EXISTS ix_auth_session_user ON auth_sessions(user_id, revoked_at, expires_at);

CREATE TABLE IF NOT EXISTS audit_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    actor_type TEXT NOT NULL,
    actor_id TEXT NOT NULL,
    action TEXT NOT NULL,
    object_type TEXT NOT NULL,
    object_id TEXT NOT NULL,
    scope_type TEXT,
    scope_id TEXT,
    before_json TEXT,
    after_json TEXT,
    request_id TEXT,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_audit_object_time ON audit_events(object_type, object_id, created_at);

CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL
);
"""


# The MVP keeps timestamps and JSON as text so the same domain/service layer can
# run against SQLite and PostgreSQL. PostgreSQL only needs identity columns and
# native numeric types adjusted; query differences are handled by the adapter
# below. Keeping this as a derived schema avoids two drifting table definitions.
POSTGRES_SCHEMA = re.sub(r"\bREAL\b", "DOUBLE PRECISION", re.sub(r"INTEGER PRIMARY KEY AUTOINCREMENT", "BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY", SCHEMA)).replace("PRAGMA foreign_keys = ON;", "")


def resolve_db_path(db_path: str | Path | None = None) -> str:
    configured = db_path or os.getenv("VKO_DATABASE_URL") or os.getenv("DATABASE_URL") or DEFAULT_DB_PATH
    return str(configured)


def _postgres_sql(query: str) -> str:
    """Translate the small SQLite SQL dialect used by the MVP to psycopg."""
    query = query.replace("(julianday(?) - julianday(started_at)) * 1440", "(EXTRACT(EPOCH FROM (?::timestamptz - started_at::timestamptz)) / 60)")
    query = query.replace("scope_id IS ?", "scope_id IS NOT DISTINCT FROM ?")
    insert_ignore = re.match(r"^\s*INSERT\s+OR\s+IGNORE\s+INTO\s+", query, flags=re.IGNORECASE)
    if insert_ignore:
        query = re.sub(r"^\s*INSERT\s+OR\s+IGNORE\s+INTO\s+", "INSERT INTO ", query, count=1, flags=re.IGNORECASE).rstrip().rstrip(";")
        query += " ON CONFLICT DO NOTHING"
    return query.replace("?", "%s")


class _PostgresCursor:
    def __init__(self, cursor: Any, connection: "_PostgresConnection") -> None:
        self._cursor = cursor
        self._connection = connection

    def fetchone(self) -> Any:
        return self._cursor.fetchone()

    def fetchall(self) -> list[Any]:
        return self._cursor.fetchall()

    @property
    def rowcount(self) -> int:
        return int(getattr(self._cursor, "rowcount", 0))

    @property
    def lastrowid(self) -> int | None:
        # The service layer requests this immediately after INSERT. Every such
        # table uses an identity sequence, so LASTVAL() is equivalent to the
        # sqlite3 cursor.lastrowid contract without changing every INSERT.
        row = self._connection.execute("SELECT LASTVAL() AS id").fetchone()
        return int(row["id"]) if row else None


class _PostgresConnection:
    """Small DB-API compatibility wrapper for the existing synchronous code.

    ``release`` is supplied by :class:`PostgresConnectionPool` when a request
    borrows a pooled connection.  Keeping the wrapper here means the existing
    service layer keeps its tiny SQLite-like API while production requests do
    not open a fresh TCP connection for every call.
    """

    is_postgres = True

    def __init__(self, dsn: str | None = None, *, raw_connection: Any | None = None, release: Any | None = None) -> None:
        try:
            import psycopg
            from psycopg.rows import dict_row
        except ImportError as exc:  # pragma: no cover - exercised only in a misconfigured deployment
            raise RuntimeError("PostgreSQL support requires psycopg[binary]") from exc
        self._psycopg = psycopg
        self._release = release
        self._closed = False
        self._connection = raw_connection if raw_connection is not None else psycopg.connect(dsn, row_factory=dict_row)

    def execute(self, query: str, params: Any = ()) -> _PostgresCursor:
        try:
            cursor = self._connection.execute(_postgres_sql(query), params or None)
        except self._psycopg.IntegrityError as exc:
            # Preserve the existing race-safe duplicate handling path.
            raise sqlite3.IntegrityError(str(exc)) from exc
        return _PostgresCursor(cursor, self)

    def executemany(self, query: str, params_seq: Any) -> _PostgresCursor:
        try:
            cursor = self._connection.executemany(_postgres_sql(query), params_seq)
        except self._psycopg.IntegrityError as exc:
            raise sqlite3.IntegrityError(str(exc)) from exc
        return _PostgresCursor(cursor, self)

    def executescript(self, script: str) -> None:
        # The schema contains plain DDL statements and no procedural blocks.
        for statement in script.split(";"):
            if statement.strip():
                self.execute(statement)

    def commit(self) -> None:
        self._connection.commit()

    def rollback(self) -> None:
        self._connection.rollback()

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        if self._release:
            self._release(self._connection)
        else:
            self._connection.close()


class PostgresConnectionPool:
    """A small bounded synchronous pool for the I/O-bound API.

    The application routes are synchronous at the database boundary, so a
    lightweight queue-based pool is sufficient and avoids adding another
    runtime dependency solely for connection management. Connections are
    created lazily up to ``max_size`` and rolled back before being returned to
    the pool, which also clears an aborted PostgreSQL transaction.
    """

    def __init__(self, dsn: str, *, min_size: int = 1, max_size: int = 10) -> None:
        if min_size < 0 or max_size < 1 or min_size > max_size:
            raise ValueError("pool sizes must satisfy 0 <= min_size <= max_size")
        self.dsn = dsn
        self.min_size = min_size
        self.max_size = max_size
        self._available: queue.LifoQueue[Any] = queue.LifoQueue(maxsize=max_size)
        self._lock = threading.Lock()
        self._total = 0
        self._closed = False
        for _ in range(min_size):
            raw = self._new_connection()
            self._total += 1
            self._available.put_nowait(raw)

    def _new_connection(self) -> Any:
        try:
            import psycopg
            from psycopg.rows import dict_row
        except ImportError as exc:  # pragma: no cover - deployment configuration error
            raise RuntimeError("PostgreSQL support requires psycopg[binary]") from exc
        return psycopg.connect(self.dsn, row_factory=dict_row)

    def acquire(self) -> _PostgresConnection:
        if self._closed:
            raise RuntimeError("PostgreSQL connection pool is closed")
        try:
            raw = self._available.get_nowait()
        except queue.Empty:
            with self._lock:
                can_create = self._total < self.max_size
                # Reserve the slot while holding the lock. This prevents two
                # request threads from both observing capacity and exceeding
                # max_size during simultaneous connection creation.
                if can_create:
                    raw = self._new_connection()
                    self._total += 1
                else:
                    raw = None
            if raw is None:
                raw = self._available.get(timeout=30)
        return _PostgresConnection(raw_connection=raw, release=self.release)

    def release(self, raw: Any) -> None:
        if self._closed:
            try:
                raw.close()
            finally:
                with self._lock:
                    self._total = max(0, self._total - 1)
            return
        try:
            raw.rollback()
            self._available.put_nowait(raw)
        except Exception:
            try:
                raw.close()
            finally:
                with self._lock:
                    self._total = max(0, self._total - 1)

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        while True:
            try:
                raw = self._available.get_nowait()
            except queue.Empty:
                break
            try:
                raw.close()
            finally:
                with self._lock:
                    self._total = max(0, self._total - 1)

    @property
    def size(self) -> int:
        with self._lock:
            return self._total

    @property
    def available(self) -> int:
        return self._available.qsize()


def connect(db_path: str | Path | None = None) -> Any:
    path = resolve_db_path(db_path)
    if is_postgres_path(path):
        return _PostgresConnection(path)
    is_uri = path.startswith("file:")
    if path != ":memory:" and not is_uri:
        Path(path).parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(path, timeout=30, check_same_thread=False, uri=is_uri)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    connection.execute("PRAGMA busy_timeout = 30000")
    return connection


def _column_names(connection: Any, table: str) -> set[str]:
    """Return columns for a table without relying on a database-specific ORM."""
    if getattr(connection, "is_postgres", False):
        rows = connection.execute(
            "SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = ?",
            (table,),
        ).fetchall()
        return {str(row["column_name"]) for row in rows}
    return {str(row["name"]) for row in connection.execute(f"PRAGMA table_info({table})").fetchall()}


def _ensure_column(connection: Any, table: str, column: str, definition: str) -> None:
    # Table/column names and definitions are internal constants from the
    # migration list below; values supplied by users never reach this helper.
    if column not in _column_names(connection, table):
        connection.execute(f"ALTER TABLE {table} ADD COLUMN {column} {definition}")


def _run_migrations(connection: Any) -> None:
    """Apply additive, versioned schema changes to databases created by older MVPs.

    The initial schema remains executable from a clean checkout, while these
    migrations make an existing SQLite/PostgreSQL volume safe to upgrade in
    place. Each version is recorded only after its statements succeed.
    """
    applied = {
        int(row["version"])
        for row in connection.execute("SELECT version FROM schema_migrations ORDER BY version").fetchall()
    }
    migrations = {
        1: lambda: (
            _ensure_column(connection, "users", "password_hash", "TEXT"),
            connection.execute(
                "CREATE TABLE IF NOT EXISTS auth_sessions ("
                "id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), "
                "token_hash TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, "
                "revoked_at TEXT, last_seen_at TEXT, ip_address TEXT, user_agent TEXT)"
            ),
            connection.execute("CREATE INDEX IF NOT EXISTS ix_auth_session_token ON auth_sessions(token_hash, expires_at, revoked_at)"),
            connection.execute("CREATE INDEX IF NOT EXISTS ix_auth_session_user ON auth_sessions(user_id, revoked_at, expires_at)"),
        ),
        2: lambda: (
            _ensure_column(connection, "provider_cases", "delivery_channel", "TEXT NOT NULL DEFAULT 'INTERNAL'"),
            _ensure_column(connection, "provider_cases", "delivery_status", "TEXT NOT NULL DEFAULT 'PENDING'"),
            _ensure_column(connection, "provider_cases", "delivery_attempts", "INTEGER NOT NULL DEFAULT 0"),
            _ensure_column(connection, "provider_cases", "delivery_error", "TEXT"),
            _ensure_column(connection, "provider_cases", "external_ticket_no", "TEXT"),
            _ensure_column(connection, "notifications", "delivery_attempts", "INTEGER NOT NULL DEFAULT 0"),
            _ensure_column(connection, "notifications", "delivery_error", "TEXT"),
        ),
    }
    now = _migration_timestamp()
    for version in sorted(migrations):
        if version in applied:
            continue
        migrations[version]()
        connection.execute("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)", (version, now))


def _migration_timestamp() -> str:
    from datetime import datetime, timezone

    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def init_db(db_path: str | Path | None = None) -> None:
    connection = connect(db_path)
    try:
        is_postgres = getattr(connection, "is_postgres", False)
        advisory_locked = False
        if is_postgres:
            # Multiple Uvicorn workers import the app concurrently. Serialize
            # first-run DDL so two workers cannot race on PostgreSQL catalogs.
            connection.execute("SELECT pg_advisory_lock(742031)")
            advisory_locked = True
        try:
            connection.executescript(POSTGRES_SCHEMA if is_postgres else SCHEMA)
            _run_migrations(connection)
            connection.commit()
        except Exception:
            connection.rollback()
            raise
        finally:
            if is_postgres and advisory_locked:
                # A failed DDL transaction is aborted in PostgreSQL, so roll
                # it back before releasing the session-level advisory lock.
                try:
                    connection.execute("SELECT pg_advisory_unlock(742031)")
                    connection.commit()
                except Exception:
                    # Closing the connection below also releases the lock. Do
                    # not hide the original migration failure with cleanup.
                    connection.rollback()
    finally:
        connection.close()


@contextmanager
def get_connection(db_path: str | Path | None = None, *, pool: PostgresConnectionPool | None = None) -> Iterator[Any]:
    connection = pool.acquire() if pool is not None else connect(db_path)
    try:
        yield connection
        connection.commit()
    except Exception:
        connection.rollback()
        raise
    finally:
        connection.close()
