from __future__ import annotations

import csv
import io
import math
import os
import secrets
import uuid
import zipfile
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, Iterator
from xml.sax.saxutils import escape as xml_escape

from fastapi import Body, Depends, FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, Response

from .db import PostgresConnectionPool, connect, get_connection, init_db, is_postgres_path, resolve_db_path
from .schemas import (
    AgentBatchIn,
    ContractIn,
    DeviceRegisterIn,
    DemoResetIn,
    HeartbeatIn,
    IncidentEventIn,
    LineAdminIn,
    ManualIncidentIn,
    MonitoringPointIn,
    OrganizationIn,
    PolicyIn,
    ProviderIn,
    ProviderDraftIn,
    ProviderSendIn,
    ScheduleIn,
    UserAdminIn,
)
from .services import (
    Principal,
    add_audit,
    add_incident_event,
    as_utc,
    contract_snapshot,
    dispatch_notification,
    dt_text,
    effective_contract,
    effective_policy,
    incident_snapshot,
    line_allowed,
    line_row,
    line_scope_sql,
    mark_data_freshness,
    policy_snapshot,
    principal_for_token,
    process_measurement,
    provider_draft,
    revoke_token,
    issue_session,
    hash_password,
    verify_password,
    refresh_situations,
    token_hash,
    utc_now,
)
from .transports import DeliveryError, deliver_provider_case


def _bool(value: Any) -> bool:
    if isinstance(value, str):
        return value.strip().lower() in {"1", "true", "yes", "on"}
    return bool(value)


def _session_ttl_seconds() -> int:
    try:
        return int(os.getenv("VKO_SESSION_TTL_SECONDS", str(8 * 60 * 60)))
    except ValueError as exc:
        raise HTTPException(status_code=500, detail="invalid VKO_SESSION_TTL_SECONDS configuration") from exc


def _state_dict(row: Any | None) -> dict[str, Any]:
    if not row:
        return {
            "data_state": "NO_DATA",
            "connection_state": "UNKNOWN",
            "contract_state": "UNKNOWN",
            "recovery_state": "NONE",
            "effective_since": None,
            "updated_at": None,
            "reason": "No observations yet",
            "evidence_ids": [],
        }
    result = dict(row)
    result["evidence_ids"] = _json(result.pop("evidence_ids_json", "[]"), [])
    if "config_snapshot_json" in result:
        result["config_snapshot"] = _json(result.pop("config_snapshot_json"), {})
    return result


def _json(value: str | None, default: Any) -> Any:
    import json

    try:
        return json.loads(value or "")
    except (TypeError, ValueError):
        return default


def _measurement_dict(row: Any) -> dict[str, Any]:
    result = dict(row)
    result["raw"] = _json(result.pop("raw_json", "{}"), {})
    result["violations"] = _json(result.pop("violations_json", "[]"), [])
    result["policy_snapshot"] = _json(result.pop("policy_snapshot_json", "{}"), {})
    result["contract_snapshot"] = _json(result.pop("contract_snapshot_json", "{}"), {})
    if "evaluation_valid" in result:
        result["valid"] = bool(result["evaluation_valid"])
    return result


def _require_admin(principal: Principal) -> None:
    if principal.role != "ADMIN":
        raise HTTPException(status_code=403, detail="administrator role required")


def _require_workflow_role(principal: Principal, action: str) -> None:
    """Keep operational transitions behind a server-side role allowlist."""
    allowed = {
        "provider_fixed": {"ADMIN", "OBLAST", "DISTRICT", "PROVIDER"},
        "send_to_provider": {"ADMIN", "OBLAST", "DISTRICT", "PROVIDER"},
        "status": {"ADMIN", "OBLAST", "DISTRICT", "PROVIDER"},
        "assign": {"ADMIN", "OBLAST", "DISTRICT"},
        "provider_send": {"ADMIN", "OBLAST", "DISTRICT", "PROVIDER"},
    }.get(action, {"ADMIN", "OBLAST", "DISTRICT", "PROVIDER", "SCHOOL"})
    if principal.role not in allowed:
        raise HTTPException(status_code=403, detail=f"role cannot perform {action}")


def _parse_time(value: str | None, default: datetime | None = None) -> str | None:
    if value is None:
        return dt_text(default) if default else None
    try:
        return dt_text(value)
    except (TypeError, ValueError) as exc:
        raise HTTPException(status_code=422, detail=f"invalid datetime: {value}") from exc


def _period_bounds(
    period: str | None,
    from_time: str | None,
    to_time: str | None,
    *,
    default_days: int = 1,
) -> tuple[datetime, datetime]:
    """Resolve a report period while retaining explicit UTC bounds."""
    end = as_utc(_parse_time(to_time)) if to_time else utc_now()
    if from_time:
        start = as_utc(_parse_time(from_time))
    else:
        days = {"day": 1, "week": 7, "month": 30}.get((period or "").lower(), default_days)
        start = end - timedelta(days=days)
    if start >= end:
        raise HTTPException(status_code=422, detail="from must be earlier than to")
    return start, end


def _validate_device_time(value: datetime, *, field: str) -> str:
    """Apply server-side clock-skew bounds while allowing bounded backfill."""
    current = utc_now()
    parsed = as_utc(value)
    if parsed is None:
        raise HTTPException(status_code=422, detail=f"{field} is required")
    if parsed > current + timedelta(minutes=10):
        raise HTTPException(status_code=422, detail=f"{field} is too far in the future")
    configured_backfill = os.getenv("VKO_MAX_BACKFILL_DAYS")
    if configured_backfill and configured_backfill.strip():
        try:
            max_backfill_days = int(configured_backfill)
        except ValueError as exc:
            raise HTTPException(status_code=500, detail="invalid VKO_MAX_BACKFILL_DAYS configuration") from exc
        if max_backfill_days < 0 or parsed < current - timedelta(days=max_backfill_days):
            raise HTTPException(status_code=422, detail=f"{field} is older than the allowed backfill window")
    return dt_text(parsed) or ""


def _line_or_404(connection: Any, principal: Principal, line_id: str) -> Any:
    line = line_row(connection, line_id)
    if not line or not line_allowed(connection, principal, line_id):
        raise HTTPException(status_code=404, detail="line not found")
    return line


def _line_payload(connection: Any, line: Any) -> dict[str, Any]:
    state = mark_data_freshness(connection, line["id"])
    current_policy = effective_policy(connection, line["id"], dt_text(utc_now()))
    current_contract = effective_contract(connection, line["id"], dt_text(utc_now()))
    contracts = [
        dict(row)
        for row in connection.execute("SELECT * FROM contract_versions WHERE line_id = ? ORDER BY valid_from DESC", (line["id"],)).fetchall()
    ]
    points = []
    primary_device: dict[str, Any] | None = None
    for point in connection.execute("SELECT * FROM monitoring_points WHERE line_id = ? ORDER BY is_primary DESC, id", (line["id"],)).fetchall():
        point_data = dict(point)
        point_data["devices"] = [
            dict(device)
            for device in connection.execute("SELECT id, agent_version, last_seen, blocked_at, created_at FROM devices WHERE monitoring_point_id = ? ORDER BY id", (point["id"],)).fetchall()
        ]
        if primary_device is None and point_data["devices"]:
            primary_device = point_data["devices"][0]
        points.append(point_data)
    measurements = connection.execute(
        "SELECT m.*, e.baseline_state, e.contract_state, e.violations_json, e.valid AS evaluation_valid, e.reason, "
        "e.policy_snapshot_json, e.contract_snapshot_json FROM measurements m JOIN measurement_evaluations e ON e.measurement_id = m.id "
        "WHERE m.line_id = ? ORDER BY m.observed_at DESC, m.id DESC LIMIT 50",
        (line["id"],),
    ).fetchall()
    incidents = [incident_snapshot(connection, row["id"]) for row in connection.execute("SELECT id FROM incidents WHERE line_id = ? ORDER BY id DESC", (line["id"],)).fetchall()]
    latest = _measurement_dict(measurements[0]) if measurements else {}
    return {
        "id": line["id"],
        "organization_id": line["organization_id"],
        "school_id": line["school_id"],
        "organization_name": line["organization_name"],
        "district": line["district"],
        "address": line["address"],
        "contact_name": line["contact_name"],
        "contact_phone": line["contact_phone"],
        "latitude": line["latitude"],
        "longitude": line["longitude"],
        "provider_id": line["provider_id"],
        "provider_name": line["provider_name"],
        "support_contact": line["support_contact"],
        "role": line["role"],
        "technology": line["technology"],
        "line_status": line["status"],
        "status": "NO_DATA" if state and state["data_state"] == "NO_DATA" else (state["connection_state"] if state else "UNKNOWN"),
        "state": _state_dict(state),
        "policy": policy_snapshot(current_policy),
        "contract": contract_snapshot(current_contract),
        "device_id": primary_device["id"] if primary_device else None,
        "agent_version": primary_device["agent_version"] if primary_device else None,
        "last_seen": primary_device["last_seen"] if primary_device else None,
        "contracts": contracts,
        "monitoring_points": points,
        "latest": latest,
        "measurements": [_measurement_dict(row) for row in measurements],
        "incidents": incidents,
    }


def _line_query(connection: Any, principal: Principal, filters: dict[str, Any] | None = None) -> list[Any]:
    filters = filters or {}
    params: list[Any] = []
    where = [line_scope_sql(principal, params), "l.status != 'DELETED'"]
    if filters.get("district"):
        where.append("o.district = ?")
        params.append(filters["district"])
    if filters.get("provider_id"):
        where.append("l.provider_id = ?")
        params.append(filters["provider_id"])
    if filters.get("role"):
        where.append("l.role = ?")
        params.append(filters["role"])
    if filters.get("line_status"):
        where.append("l.status = ?")
        params.append(filters["line_status"])
    return connection.execute(
        "SELECT l.*, o.school_id, o.name AS organization_name, o.district, o.address, o.contact_name, o.contact_phone, o.latitude, o.longitude, "
        "p.name AS provider_name, p.support_contact FROM lines l JOIN organizations o ON o.id = l.organization_id "
        "LEFT JOIN providers p ON p.id = l.provider_id WHERE " + " AND ".join(where) + " ORDER BY o.district, o.name, l.role",
        params,
    ).fetchall()


def _latest_for_line(connection: Any, line_id: str) -> dict[str, Any]:
    row = connection.execute(
        "SELECT m.* FROM measurements m WHERE m.line_id = ? ORDER BY m.observed_at DESC, m.id DESC LIMIT 1",
        (line_id,),
    ).fetchone()
    if not row:
        return {}
    result = dict(row)
    result["loss"] = result.get("packet_loss")
    result["at"] = result.get("observed_at")
    return result


def _report_rows(
    connection: Any,
    principal: Principal,
    from_time: str,
    to_time: str,
    line_id: str | None = None,
    *,
    district: str | None = None,
    provider: str | None = None,
    device_id: str | None = None,
    status: str | None = None,
    role: str | None = None,
    technology: str | None = None,
    organization_id: str | None = None,
) -> list[Any]:
    if status:
        # Status is a materialized, freshness-aware line verdict. Refresh only
        # the candidate lines before applying the status predicate so a stale
        # device cannot leak into a current-status export/report.
        for candidate_id in _report_line_ids(
            connection,
            principal,
            line_id,
            district=district,
            provider=provider,
            device_id=device_id,
            role=role,
            technology=technology,
            organization_id=organization_id,
        ):
            mark_data_freshness(connection, candidate_id)
    params: list[Any] = []
    scope = line_scope_sql(principal, params)
    where = [scope, "m.observed_at >= ?", "m.observed_at < ?"]
    params.extend([from_time, to_time])
    if line_id:
        where.append("m.line_id = ?")
        params.append(line_id)
    if district:
        where.append("o.district = ?")
        params.append(district)
    if provider:
        where.append("(l.provider_id = ? OR p.name = ?)")
        params.extend([provider, provider])
    if device_id:
        where.append("m.device_id = ?")
        params.append(device_id)
    if organization_id:
        where.append("l.organization_id = ?")
        params.append(organization_id)
    if role:
        where.append("l.role = ?")
        params.append(role)
    if technology:
        where.append("l.technology = ?")
        params.append(technology)
    if status:
        normalized_status = {"UNSTABLE": "DEGRADED", "CRITICAL": "NO_INTERNET"}.get(status.upper(), status.upper())
        if normalized_status in {"ACTIVE", "INACTIVE", "DELETED"}:
            where.append("l.status = ?")
            params.append(normalized_status)
        else:
            where.append("(CASE WHEN COALESCE(ls.data_state, 'NO_DATA') = 'NO_DATA' THEN 'NO_DATA' ELSE COALESCE(ls.connection_state, 'UNKNOWN') END) = ?")
            params.append(normalized_status)
    return connection.execute(
        "SELECT m.*, o.school_id, o.name AS organization_name, o.district, p.name AS provider_name, "
        "e.baseline_state, e.contract_state, e.violations_json, e.reason FROM measurements m "
        "JOIN lines l ON l.id = m.line_id JOIN organizations o ON o.id = l.organization_id "
        "LEFT JOIN providers p ON p.id = l.provider_id LEFT JOIN line_states ls ON ls.line_id = l.id "
        "JOIN measurement_evaluations e ON e.measurement_id = m.id "
        "WHERE " + " AND ".join(where) + " ORDER BY m.observed_at",
        params,
    ).fetchall()


def _report_line_ids(
    connection: Any,
    principal: Principal,
    line_id: str | None = None,
    *,
    district: str | None = None,
    provider: str | None = None,
    device_id: str | None = None,
    status: str | None = None,
    role: str | None = None,
    technology: str | None = None,
    organization_id: str | None = None,
) -> set[str]:
    if status:
        for candidate_id in _report_line_ids(
            connection,
            principal,
            line_id,
            district=district,
            provider=provider,
            device_id=device_id,
            role=role,
            technology=technology,
            organization_id=organization_id,
        ):
            mark_data_freshness(connection, candidate_id)
    params: list[Any] = []
    where = [line_scope_sql(principal, params), "l.status != 'DELETED'"]
    if line_id:
        where.append("l.id = ?")
        params.append(line_id)
    if district:
        where.append("o.district = ?")
        params.append(district)
    if provider:
        where.append("(l.provider_id = ? OR p.name = ?)")
        params.extend([provider, provider])
    if device_id:
        where.append("d.id = ?")
        params.append(device_id)
    if organization_id:
        where.append("l.organization_id = ?")
        params.append(organization_id)
    if role:
        where.append("l.role = ?")
        params.append(role)
    if technology:
        where.append("l.technology = ?")
        params.append(technology)
    if status:
        normalized_status = {"UNSTABLE": "DEGRADED", "CRITICAL": "NO_INTERNET"}.get(status.upper(), status.upper())
        if normalized_status in {"ACTIVE", "INACTIVE", "DELETED"}:
            where.append("l.status = ?")
            params.append(normalized_status)
        else:
            where.append("(CASE WHEN COALESCE(ls.data_state, 'NO_DATA') = 'NO_DATA' THEN 'NO_DATA' ELSE COALESCE(ls.connection_state, 'UNKNOWN') END) = ?")
            params.append(normalized_status)
    rows = connection.execute(
        "SELECT DISTINCT l.id FROM lines l JOIN organizations o ON o.id = l.organization_id "
        "LEFT JOIN providers p ON p.id = l.provider_id LEFT JOIN line_states ls ON ls.line_id = l.id "
        "LEFT JOIN monitoring_points mp ON mp.line_id = l.id LEFT JOIN devices d ON d.monitoring_point_id = mp.id "
        "WHERE " + " AND ".join(where),
        params,
    ).fetchall()
    return {str(row["id"]) for row in rows}


def _xlsx_bytes(headers: list[str], rows: list[list[Any]]) -> bytes:
    """Write a small standards-compliant XLSX without making openpyxl mandatory."""
    all_rows = [headers, *rows]
    sheet_rows = []
    for row_index, values in enumerate(all_rows, 1):
        cells = []
        for col_index, value in enumerate(values, 1):
            column = ""
            number = col_index
            while number:
                number, remainder = divmod(number - 1, 26)
                column = chr(65 + remainder) + column
            if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value):
                # Keep metrics and counts numeric in the generated workbook so
                # consumers can sort and aggregate them without re-parsing text.
                cells.append(f'<c r="{column}{row_index}"><v>{value}</v></c>')
            else:
                text = "" if value is None else str(value)
                cells.append(f'<c r="{column}{row_index}" t="inlineStr"><is><t>{xml_escape(text)}</t></is></c>')
        sheet_rows.append(f'<row r="{row_index}">' + "".join(cells) + "</row>")
    sheet = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
             '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>'
             + "".join(sheet_rows) + "</sheetData></worksheet>")
    content_types = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
                     '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
                     '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
                     '<Default Extension="xml" ContentType="application/xml"/>'
                     '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
                     '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
                     '</Types>')
    rels = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
            '</Relationships>')
    workbook = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
                '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
                'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
                '<sheets><sheet name="VKO" sheetId="1" r:id="rId1"/></sheets></workbook>')
    workbook_rels = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
                     '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
                     '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>'
                     '</Relationships>')
    result = io.BytesIO()
    with zipfile.ZipFile(result, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("[Content_Types].xml", content_types)
        archive.writestr("_rels/.rels", rels)
        archive.writestr("xl/workbook.xml", workbook)
        archive.writestr("xl/_rels/workbook.xml.rels", workbook_rels)
        archive.writestr("xl/worksheets/sheet1.xml", sheet)
    return result.getvalue()


def _csv_cell(value: Any) -> Any:
    """Neutralise spreadsheet formula prefixes in text fields.

    Numeric metrics remain numeric for CSV writers; only user-controlled text
    beginning with a formula character receives a leading apostrophe.
    """
    if isinstance(value, str) and value.lstrip()[:1] in {"=", "+", "-", "@"}:
        return "'" + value
    return value


def create_app(db_path: str | Path | None = None) -> FastAPI:
    memory_anchor = None
    if str(db_path) == ":memory:":
        # SQLite's plain :memory: database is scoped to one connection. Use a
        # private shared-cache URI plus an anchor connection so each request
        # connection sees the same schema/data while the app is alive.
        database_path = f"file:vko_{uuid.uuid4().hex}?mode=memory&cache=shared"
        memory_anchor = connect(database_path)
    else:
        database_path = resolve_db_path(db_path)
    init_db(database_path)
    app = FastAPI(title="VKO Internet Line Monitoring API", version="0.1.0")
    app.state.db_path = database_path
    db_pool: PostgresConnectionPool | None = None
    if is_postgres_path(database_path) and _bool(os.getenv("VKO_DB_POOL", "1")):
        try:
            min_size = max(0, int(os.getenv("VKO_DB_POOL_MIN", "1")))
            max_size = max(1, int(os.getenv("VKO_DB_POOL_MAX", "10")))
        except ValueError as exc:
            raise RuntimeError("VKO_DB_POOL_MIN and VKO_DB_POOL_MAX must be integers") from exc
        if min_size > max_size:
            raise RuntimeError("VKO_DB_POOL_MIN cannot exceed VKO_DB_POOL_MAX")
        db_pool = PostgresConnectionPool(database_path, min_size=min_size, max_size=max_size)
        app.state.db_pool = db_pool

        @app.on_event("shutdown")
        async def close_db_pool() -> None:
            db_pool.close()
    if memory_anchor is not None:
        app.state.memory_anchor = memory_anchor

        @app.on_event("shutdown")
        async def close_memory_anchor() -> None:
            memory_anchor.close()
    configured_origins = os.getenv("VKO_CORS_ORIGINS")
    cors_origins = [origin.strip() for origin in configured_origins.split(",") if origin.strip()] if configured_origins else ["http://127.0.0.1:8000", "http://localhost:8000"]
    app.add_middleware(
        CORSMiddleware,
        allow_origins=cors_origins,
        allow_credentials=False,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    web_dir = Path(__file__).resolve().parents[2] / "web"
    if web_dir.is_dir():
        @app.get("/", include_in_schema=False)
        async def web_index() -> HTMLResponse:
            return HTMLResponse((web_dir / "index.html").read_text(encoding="utf-8"))

        @app.get("/static/{asset_path:path}", include_in_schema=False)
        async def web_asset(asset_path: str) -> Response:
            candidate = (web_dir / asset_path).resolve()
            if web_dir not in candidate.parents or not candidate.is_file():
                raise HTTPException(status_code=404, detail="asset not found")
            media = {".css": "text/css", ".js": "text/javascript", ".html": "text/html"}.get(candidate.suffix, "application/octet-stream")
            return Response(candidate.read_bytes(), media_type=media)

    async def db_dependency() -> Iterator[Any]:
        with get_connection(database_path, pool=db_pool) as connection:
            yield connection

    # A fresh checkout should be useful immediately. Explicit `backend.seed` still
    # remains the source of truth for repeatable resets; this bootstrap only runs
    # when the configured database has no users yet.
    environment = os.getenv("VKO_ENV", "development").lower()
    auth_mode = os.getenv("VKO_AUTH_MODE", "password").lower()
    with get_connection(database_path, pool=db_pool) as bootstrap_connection:
        has_users = bootstrap_connection.execute("SELECT 1 FROM users LIMIT 1").fetchone()
    if not has_users and environment == "production":
        bootstrap_username = os.getenv("VKO_BOOTSTRAP_ADMIN_USERNAME", "").strip()
        bootstrap_password = os.getenv("VKO_BOOTSTRAP_ADMIN_PASSWORD", "")
        if bootstrap_username or bootstrap_password:
            if not bootstrap_username or len(bootstrap_password) < 12:
                raise RuntimeError("VKO_BOOTSTRAP_ADMIN_USERNAME and a 12+ character VKO_BOOTSTRAP_ADMIN_PASSWORD are required")
            now = dt_text(utc_now())
            bootstrap_token_hash = token_hash(secrets.token_urlsafe(32))
            with get_connection(database_path, pool=db_pool) as bootstrap_connection:
                if getattr(bootstrap_connection, "is_postgres", False):
                    bootstrap_connection.execute("SELECT pg_advisory_xact_lock(742033)")
                if not bootstrap_connection.execute("SELECT 1 FROM users LIMIT 1").fetchone():
                    bootstrap_connection.execute(
                        "INSERT INTO users(id, username, role, token_hash, password_hash, created_at) VALUES (?, ?, 'ADMIN', ?, ?, ?)",
                        (f"bootstrap-{uuid.uuid4().hex[:12]}", bootstrap_username, bootstrap_token_hash, hash_password(bootstrap_password), now),
                    )
        elif auth_mode == "password":
            raise RuntimeError("an empty production database requires VKO_BOOTSTRAP_ADMIN_USERNAME and VKO_BOOTSTRAP_ADMIN_PASSWORD")
    if not has_users and os.getenv("VKO_AUTO_SEED", "1") != "0" and environment != "production":
        from ..seed import seed_demo

        seed_demo(database_path, seed_measurements=True)

    async def principal_dependency(request: Request, connection: Any = Depends(db_dependency)) -> Principal:
        if _bool(os.getenv("VKO_AUTH_DISABLED")):
            if os.getenv("VKO_ENV", "development").lower() == "production":
                raise HTTPException(status_code=503, detail="authentication bypass is disabled in production")
            return Principal("local-admin", "local-admin", "ADMIN", ())
        authorization = request.headers.get("Authorization", "")
        if not authorization.startswith("Bearer "):
            raise HTTPException(status_code=401, detail="Bearer token required")
        principal = principal_for_token(connection, authorization[7:].strip())
        if not principal:
            raise HTTPException(status_code=401, detail="invalid or disabled token")
        return principal

    async def device_dependency(request: Request, connection: Any = Depends(db_dependency)) -> Any:
        from .services import device_for_token

        device_id = request.headers.get("X-Device-ID")
        token = request.headers.get("X-Device-Token")
        if not device_id or not token:
            raise HTTPException(status_code=401, detail="X-Device-ID and X-Device-Token required")
        device = device_for_token(connection, device_id, token)
        if not device:
            raise HTTPException(status_code=401, detail="invalid or blocked device")
        return device

    @app.get("/health")
    async def health() -> dict[str, str]:
        return {"status": "ok", "service": "vko-backend"}

    @app.get("/health/ready")
    async def readiness() -> dict[str, str]:
        try:
            with get_connection(database_path, pool=db_pool) as connection:
                connection.execute("SELECT 1").fetchone()
        except Exception as exc:  # pragma: no cover - exercised by deployment failures
            raise HTTPException(status_code=503, detail="database is not ready") from exc
        return {"status": "ready", "service": "vko-backend"}

    @app.post("/api/login")
    @app.post("/api/auth/login")
    @app.post("/api/v1/auth/login")
    @app.post("/api/v1/login")
    async def login(request: Request, payload: dict[str, Any] = Body(default={}), connection: Any = Depends(db_dependency)) -> dict[str, Any]:
        username = str(payload.get("username") or payload.get("login") or "").strip()
        password = str(payload.get("password") or "")
        if not username or not password:
            raise HTTPException(status_code=401, detail="invalid credentials")
        user = connection.execute("SELECT * FROM users WHERE username = ? AND disabled_at IS NULL", (username,)).fetchone()
        if not user:
            raise HTTPException(status_code=401, detail="invalid credentials")
        environment = os.getenv("VKO_ENV", "development").lower()
        auth_mode = os.getenv("VKO_AUTH_MODE", "password").lower()
        if auth_mode in {"oidc", "external"}:
            raise HTTPException(status_code=503, detail="external identity provider integration is not configured in this service")
        valid_password = verify_password(password, user["password_hash"])
        # Databases created before password_hash was introduced can still be
        # used in an explicitly non-production demo profile. Production never
        # falls back to the shared demo password.
        if not valid_password and environment != "production" and password == "demo" and not user["password_hash"]:
            valid_password = True
        if not valid_password:
            raise HTTPException(status_code=401, detail="invalid credentials")
        token, expires_at = issue_session(
            connection,
            user["id"],
            ttl_seconds=_session_ttl_seconds(),
            ip_address=request.client.host if request.client else None,
            user_agent=request.headers.get("User-Agent"),
        )
        add_audit(connection, "USER", user["id"], "auth.login", "user", user["id"], request_id=request.headers.get("X-Request-ID"))
        return {"token": token, "token_type": "Bearer", "expires_at": expires_at, "user": {"id": user["id"], "username": user["username"], "role": user["role"], "role_label": {"ADMIN": "Администратор", "OBLAST": "Областной уровень", "DISTRICT": "Районный уровень", "PROVIDER": "Провайдер", "SCHOOL": "Школа"}.get(user["role"], user["role"])}}

    @app.get("/api/auth/me")
    @app.get("/api/v1/auth/me")
    async def auth_me(principal: Principal = Depends(principal_dependency)) -> dict[str, Any]:
        return {"id": principal.id, "username": principal.username, "role": principal.role, "scopes": [{"type": kind, "id": value} for kind, value in principal.scopes]}

    @app.post("/api/v1/auth/logout")
    @app.post("/api/auth/logout")
    async def logout(request: Request, principal: Principal = Depends(principal_dependency), connection: Any = Depends(db_dependency)) -> dict[str, Any]:
        authorization = request.headers.get("Authorization", "")
        token = authorization[7:].strip() if authorization.startswith("Bearer ") else ""
        revoked = revoke_token(connection, token) if token else False
        add_audit(connection, "USER", principal.id, "auth.logout", "user", principal.id, after={"revoked": revoked}, request_id=request.headers.get("X-Request-ID"))
        return {"status": "ok", "revoked": revoked}

    @app.post("/api/admin/devices/register", status_code=201)
    @app.post("/api/v1/admin/devices/register", status_code=201)
    @app.post("/api/v1/agent/register", status_code=201)
    async def register_device(payload: DeviceRegisterIn, request: Request, principal: Principal = Depends(principal_dependency), connection: Any = Depends(db_dependency)) -> dict[str, Any]:
        _require_admin(principal)
        point = connection.execute("SELECT * FROM monitoring_points WHERE id = ? AND active = 1", (payload.monitoring_point_id,)).fetchone()
        if not point:
            raise HTTPException(status_code=404, detail="active monitoring point not found")
        if connection.execute("SELECT 1 FROM devices WHERE id = ?", (payload.device_id,)).fetchone():
            raise HTTPException(status_code=409, detail="device id already registered")
        token = secrets.token_urlsafe(32)
        now = dt_text(utc_now())
        connection.execute("INSERT INTO devices(id, monitoring_point_id, auth_token_hash, agent_version, created_at) VALUES (?, ?, ?, ?, ?)", (payload.device_id, payload.monitoring_point_id, token_hash(token), payload.agent_version, now))
        add_audit(connection, "USER", principal.id, "device.registered", "device", payload.device_id, scope_type="LINE", scope_id=point["line_id"], after={"monitoring_point_id": payload.monitoring_point_id, "agent_version": payload.agent_version}, request_id=request.headers.get("X-Request-ID"))
        return {"device_id": payload.device_id, "monitoring_point_id": payload.monitoring_point_id, "line_id": point["line_id"], "agent_version": payload.agent_version, "device_token": token}

    @app.post("/api/agent/heartbeat")
    @app.post("/api/v1/agent/heartbeat")
    async def agent_heartbeat(payload: HeartbeatIn, device: Any = Depends(device_dependency), connection: Any = Depends(db_dependency)) -> dict[str, Any]:
        seen_at = _validate_device_time(payload.seen_at or utc_now(), field="seen_at")
        connection.execute("UPDATE devices SET last_seen = ?, agent_version = ? WHERE id = ?", (seen_at, payload.agent_version, device["id"]))
        return {"device_id": device["id"], "line_id": device["line_id"], "last_seen": seen_at, "agent_version": payload.agent_version}

    @app.post("/api/agent/measurements:batch")
    @app.post("/api/v1/agent/measurements:batch")
    async def agent_measurements(payload: AgentBatchIn, device: Any = Depends(device_dependency), connection: Any = Depends(db_dependency)) -> dict[str, Any]:
        measurements = []
        for item in payload.measurements:
            data = item.model_dump()
            data["observed_at"] = _validate_device_time(item.observed_at, field="observed_at")
            measurements.append(data)
        results = [process_measurement(connection, device, item) for item in measurements]
        return {"device_id": device["id"], "line_id": device["line_id"], "results": results, "accepted": sum(1 for item in results if item["accepted"]), "duplicates": sum(1 for item in results if item["duplicate"])}

    @app.get("/api/agent/config")
    @app.get("/api/v1/agent/config")
    async def agent_config(device: Any = Depends(device_dependency), connection: Any = Depends(db_dependency)) -> dict[str, Any]:
        policy = effective_policy(connection, device["line_id"], dt_text(utc_now()))
        schedule = connection.execute("SELECT tests_per_day, jitter_minutes, light_checks_between FROM agent_schedules WHERE id = 1").fetchone()
        schedule_payload = dict(schedule) if schedule else {"tests_per_day": 4, "jitter_minutes": 8, "light_checks_between": False}
        if schedule:
            schedule_payload["light_checks_between"] = bool(schedule_payload["light_checks_between"])
        schedule_payload["performance_tests_per_day"] = schedule_payload.pop("tests_per_day")
        return {"device_id": device["id"], "line_id": device["line_id"], "schedule": schedule_payload, "policy": dict(policy) if policy else {}}

    @app.post("/api/demo/replay")
    @app.post("/api/v1/demo/replay")
    async def demo_replay(payload: dict[str, Any] = Body(default={}), principal: Principal = Depends(principal_dependency), connection: Any = Depends(db_dependency)) -> dict[str, Any]:
        """Replay one deterministic degradation through the real ingestion/state path."""
        if os.getenv("VKO_ENV", "development").lower() == "production":
            raise HTTPException(status_code=404, detail="demo replay is disabled in production")
        scenario = str(payload.get("scenario") or "school-42")
        if scenario != "school-42":
            raise HTTPException(status_code=422, detail="only school-42 demo scenario is available")
        device = connection.execute(
            "SELECT d.*, mp.line_id, mp.id AS point_id FROM devices d JOIN monitoring_points mp ON mp.id = d.monitoring_point_id WHERE d.id = 'device-42-primary' AND d.blocked_at IS NULL"
        ).fetchone()
        if not device:
            raise HTTPException(status_code=404, detail="demo device not found")
        if not line_allowed(connection, principal, device["line_id"]):
            raise HTTPException(status_code=404, detail="demo line not found")
        start = utc_now() - timedelta(minutes=3)
        results = []
        for index, download in enumerate((42, 39, 41)):
            results.append(
                process_measurement(
                    connection,
                    device,
                    {
                        "client_event_id": f"demo-replay-{uuid.uuid4().hex}",
                        "observed_at": start + timedelta(minutes=index),
                        "mode": "PERFORMANCE",
                        "download": download,
                        "upload": 44,
                        "ping": 22,
                        "jitter": 7,
                        "packet_loss": 0.4,
                        "availability": 100,
                        "connection_status": "OK",
                        "quality": "VALID",
                        "raw": {"source": "demo-replay", "scenario": scenario},
                    },
                )
            )
        return {"scenario": scenario, "line_id": device["line_id"], "results": results}

    @app.get("/api/overview")
    @app.get("/api/v1/overview")
    async def overview(principal: Principal = Depends(principal_dependency), connection: Any = Depends(db_dependency)) -> dict[str, Any]:
        lines = _line_query(connection, principal)
        line_ids = [row["id"] for row in lines]
        if not line_ids:
            return {"counts": {"schools": 0, "lines": 0, "devices": 0, "active_devices": 0, "fresh_measurements": 0, "problem_lines": 0}, "averages": {"download": None, "upload": None, "ping": None}, "completeness": 0.0}
        placeholders = ",".join("?" for _ in line_ids)
        now = utc_now()
        devices = connection.execute(f"SELECT d.* FROM devices d JOIN monitoring_points mp ON mp.id = d.monitoring_point_id WHERE mp.line_id IN ({placeholders})", line_ids).fetchall()
        fresh_measurements = connection.execute(f"SELECT COUNT(*) AS count FROM measurements WHERE line_id IN ({placeholders}) AND observed_at >= ?", (*line_ids, dt_text(now - timedelta(hours=24)))).fetchone()["count"]
        averages = connection.execute(f"SELECT AVG(download) download, AVG(upload) upload, AVG(ping) ping FROM measurements WHERE line_id IN ({placeholders}) AND observed_at >= ?", (*line_ids, dt_text(now - timedelta(hours=24)))).fetchone()
        problem_lines = 0
        for line in lines:
            state = mark_data_freshness(connection, line["id"], now)
            if state and (state["connection_state"] in {"DEGRADED", "NO_INTERNET"} or state["contract_state"] == "DEVIATES"):
                problem_lines += 1
        schedule_row = connection.execute("SELECT tests_per_day FROM agent_schedules WHERE id = 1").fetchone()
        tests_per_day = int(schedule_row["tests_per_day"]) if schedule_row else 4
        expected_measurements = max(1, len(line_ids) * tests_per_day)
        completeness = round(min(100, fresh_measurements / expected_measurements * 100), 1)
        return {"counts": {"schools": len({row['organization_id'] for row in lines}), "lines": len(lines), "devices": len(devices), "active_devices": sum(1 for device in devices if device["last_seen"] and as_utc(device["last_seen"]) >= now - timedelta(hours=24)), "fresh_measurements": fresh_measurements, "problem_lines": problem_lines}, "averages": dict(averages), "completeness": completeness, "data_completeness": completeness}

    @app.get("/api/map/points")
    @app.get("/api/v1/map/points")
    async def map_points(principal: Principal = Depends(principal_dependency), connection: Any = Depends(db_dependency)) -> list[dict[str, Any]]:
        points = []
        for line in _line_query(connection, principal):
            state = mark_data_freshness(connection, line["id"])
            points.append({"line_id": line["id"], "school_id": line["school_id"], "organization_name": line["organization_name"], "district": line["district"], "latitude": line["latitude"], "longitude": line["longitude"], "provider_id": line["provider_id"], "provider_name": line["provider_name"], "role": line["role"], "technology": line["technology"], "state": _state_dict(state)})
        return points

    @app.get("/api/organizations")
    @app.get("/api/v1/organizations")
    async def organizations(principal: Principal = Depends(principal_dependency), connection: Any = Depends(db_dependency)) -> list[dict[str, Any]]:
        params: list[Any] = []
        scope = line_scope_sql(principal, params)
        return [{**dict(row), "active": bool(row["active"])} for row in connection.execute("SELECT DISTINCT o.* FROM organizations o JOIN lines l ON l.organization_id = o.id WHERE " + scope + " ORDER BY o.district, o.name", params).fetchall()]

    @app.get("/api/providers")
    @app.get("/api/v1/providers")
    async def providers(principal: Principal = Depends(principal_dependency), connection: Any = Depends(db_dependency)) -> list[dict[str, Any]]:
        params: list[Any] = []
        scope = line_scope_sql(principal, params)
        return [dict(row) for row in connection.execute("SELECT DISTINCT p.* FROM providers p JOIN lines l ON l.provider_id = p.id JOIN organizations o ON o.id = l.organization_id WHERE " + scope + " ORDER BY p.name", params).fetchall()]

    @app.get("/api/lines")
    @app.get("/api/v1/lines")
    async def lines(
        district: str | None = None,
        provider_id: str | None = None,
        role: str | None = None,
        line_status: str | None = None,
        principal: Principal = Depends(principal_dependency),
        connection: Any = Depends(db_dependency),
    ) -> list[dict[str, Any]]:
        result = []
        for line in _line_query(connection, principal, {"district": district, "provider_id": provider_id, "role": role, "line_status": line_status}):
            state = mark_data_freshness(connection, line["id"])
            state_payload = _state_dict(state)
            visible_status = "NO_DATA" if state_payload["data_state"] == "NO_DATA" else state_payload["connection_state"]
            result.append({**dict(line), "line_status": line["status"], "status": visible_status, "data_state": state_payload["data_state"], "quality_state": state_payload["connection_state"], "contract_state": state_payload["contract_state"], "state": state_payload, "latest": _latest_for_line(connection, line["id"])})
        return result

    @app.get("/api/devices/{device_id}")
    @app.get("/api/v1/devices/{device_id}")
    async def device_detail(device_id: str, principal: Principal = Depends(principal_dependency), connection: Any = Depends(db_dependency)) -> dict[str, Any]:
        device = connection.execute(
            "SELECT d.*, mp.line_id, mp.location AS monitoring_point_location, mp.is_primary AS monitoring_point_primary, "
            "mp.active AS monitoring_point_active, l.organization_id, l.provider_id, l.role, l.technology, l.status AS line_status, "
            "o.school_id, o.name AS organization_name, o.district, o.address, o.contact_name, o.contact_phone, p.name AS provider_name "
            "FROM devices d JOIN monitoring_points mp ON mp.id = d.monitoring_point_id "
            "JOIN lines l ON l.id = mp.line_id JOIN organizations o ON o.id = l.organization_id "
            "LEFT JOIN providers p ON p.id = l.provider_id WHERE d.id = ?",
            (device_id,),
        ).fetchone()
        if not device or not line_allowed(connection, principal, device["line_id"]):
            raise HTTPException(status_code=404, detail="device not found")
        state = mark_data_freshness(connection, device["line_id"])
        measurements = connection.execute(
            "SELECT m.*, e.baseline_state, e.contract_state, e.violations_json, e.valid AS evaluation_valid, e.reason, "
            "e.policy_snapshot_json, e.contract_snapshot_json FROM measurements m "
            "JOIN measurement_evaluations e ON e.measurement_id = m.id "
            "WHERE m.device_id = ? ORDER BY m.observed_at DESC, m.id DESC LIMIT 100",
            (device_id,),
        ).fetchall()
        result = dict(device)
        # Device credentials are write-only secrets; never expose even their
        # hashes through an operational card or a scoped API response.
        result.pop("auth_token_hash", None)
        result["blocked"] = bool(result["blocked_at"])
        result["monitoring_point_primary"] = bool(result["monitoring_point_primary"])
        result["monitoring_point_active"] = bool(result["monitoring_point_active"])
        result["state"] = _state_dict(state)
        result["measurements"] = [_measurement_dict(row) for row in measurements]
        return result

    @app.get("/api/lines/{line_id}")
    @app.get("/api/v1/lines/{line_id}")
    async def line_detail(line_id: str, principal: Principal = Depends(principal_dependency), connection: Any = Depends(db_dependency)) -> dict[str, Any]:
        return _line_payload(connection, _line_or_404(connection, principal, line_id))

    @app.get("/api/lines/{line_id}/measurements")
    @app.get("/api/v1/lines/{line_id}/measurements")
    async def line_measurements(line_id: str, from_time: str | None = Query(default=None, alias="from"), to_time: str | None = Query(default=None, alias="to"), principal: Principal = Depends(principal_dependency), connection: Any = Depends(db_dependency)) -> list[dict[str, Any]]:
        _line_or_404(connection, principal, line_id)
        params: list[Any] = [line_id]
        where = ["m.line_id = ?"]
        if from_time:
            where.append("m.observed_at >= ?")
            params.append(_parse_time(from_time))
        if to_time:
            where.append("m.observed_at < ?")
            params.append(_parse_time(to_time))
        rows = connection.execute("SELECT m.*, e.baseline_state, e.contract_state, e.violations_json, e.valid AS evaluation_valid, e.reason, e.policy_snapshot_json, e.contract_snapshot_json FROM measurements m JOIN measurement_evaluations e ON e.measurement_id = m.id WHERE " + " AND ".join(where) + " ORDER BY m.observed_at DESC, m.id DESC", params).fetchall()
        return [_measurement_dict(row) for row in rows]

    @app.get("/api/lines/{line_id}/states")
    @app.get("/api/v1/lines/{line_id}/states")
    async def line_states(line_id: str, principal: Principal = Depends(principal_dependency), connection: Any = Depends(db_dependency)) -> list[dict[str, Any]]:
        _line_or_404(connection, principal, line_id)
        return [_state_dict(row) for row in connection.execute("SELECT * FROM line_state_events WHERE line_id = ? ORDER BY occurred_at DESC, id DESC", (line_id,)).fetchall()]

    @app.get("/api/reports/aggregate")
    @app.get("/api/v1/reports/aggregate")
    async def report_aggregate(from_time: str | None = Query(default=None, alias="from"), to_time: str | None = Query(default=None, alias="to"), period: str | None = None, line_id: str | None = None, district: str | None = None, provider: str | None = None, device_id: str | None = None, status: str | None = None, role: str | None = None, technology: str | None = None, organization_id: str | None = None, principal: Principal = Depends(principal_dependency), connection: Any = Depends(db_dependency)) -> dict[str, Any]:
        start, end = _period_bounds(period, from_time, to_time, default_days=1)
        rows = _report_rows(connection, principal, dt_text(start), dt_text(end), line_id, district=district, provider=provider, device_id=device_id, status=status, role=role, technology=technology, organization_id=organization_id)
        metrics = {name: [row[name] for row in rows if row[name] is not None] for name in ("download", "upload", "ping", "jitter", "packet_loss", "availability")}
        aggregate = {name: {"average": sum(values) / len(values) if values else None, "min": min(values) if values else None, "max": max(values) if values else None} for name, values in metrics.items()}
        def grouped(key: str) -> dict[str, Any]:
            result: dict[str, list[Any]] = {}
            for row in rows:
                group = str(row[key] or "UNKNOWN")
                result.setdefault(group, []).append(row)
            return {
                group: {
                    "measurement_count": len(items),
                    "average_download": sum(item["download"] for item in items if item["download"] is not None) / len([item for item in items if item["download"] is not None]) if any(item["download"] is not None for item in items) else None,
                    "average_upload": sum(item["upload"] for item in items if item["upload"] is not None) / len([item for item in items if item["upload"] is not None]) if any(item["upload"] is not None for item in items) else None,
                    "average_ping": sum(item["ping"] for item in items if item["ping"] is not None) / len([item for item in items if item["ping"] is not None]) if any(item["ping"] is not None for item in items) else None,
                    "average_availability": sum(item["availability"] for item in items if item["availability"] is not None) / len([item for item in items if item["availability"] is not None]) if any(item["availability"] is not None for item in items) else None,
                    "problem_measurement_count": sum(1 for item in items if item["baseline_state"] == "VIOLATION" or item["contract_state"] == "DEVIATES"),
                }
                for group, items in result.items()
            }
        return {"from": dt_text(start), "to": dt_text(end), "measurement_count": len(rows), "problem_measurement_count": sum(1 for row in rows if row["baseline_state"] == "VIOLATION" or row["contract_state"] == "DEVIATES"), "aggregate": aggregate, "by_line": grouped("line_id"), "by_district": grouped("district"), "by_provider": grouped("provider_name")}

    @app.get("/api/reports/quality-passport")
    @app.get("/api/v1/reports/quality-passport")
    async def quality_passport(from_time: str | None = Query(default=None, alias="from"), to_time: str | None = Query(default=None, alias="to"), period: str | None = None, line_id: str | None = None, district: str | None = None, provider: str | None = None, device_id: str | None = None, status: str | None = None, role: str | None = None, technology: str | None = None, organization_id: str | None = None, principal: Principal = Depends(principal_dependency), connection: Any = Depends(db_dependency)) -> dict[str, Any]:
        start, end = _period_bounds(period, from_time, to_time, default_days=30)
        rows = _report_rows(connection, principal, dt_text(start), dt_text(end), line_id, district=district, provider=provider, device_id=device_id, status=status, role=role, technology=technology, organization_id=organization_id)
        visible_line_ids = _report_line_ids(connection, principal, line_id, district=district, provider=provider, device_id=device_id, status=status, role=role, technology=technology, organization_id=organization_id)
        visible_lines = len(visible_line_ids)
        schedule_row = connection.execute("SELECT tests_per_day FROM agent_schedules WHERE id = 1").fetchone()
        tests_per_day = int(schedule_row["tests_per_day"]) if schedule_row else 4
        expected = ((end - start).total_seconds() / 86400) * tests_per_day * visible_lines
        incidents_params: list[Any] = []
        scope = line_scope_sql(principal, incidents_params)
        scope_param_count = len(incidents_params)
        incident_filters = [scope, "i.started_at < ?", "(i.closed_at IS NULL OR i.closed_at >= ?)"]
        incidents_params.extend([dt_text(end), dt_text(start)])
        if visible_line_ids:
            line_placeholders = ",".join("?" for _ in visible_line_ids)
            incident_filters.insert(1, f"i.line_id IN ({line_placeholders})")
            # Scope parameters precede the line IDs and period parameters in
            # the generated SQL.
            incidents_params[scope_param_count:scope_param_count] = list(sorted(visible_line_ids))
        else:
            incidents = []
            incident_filters = []
        if incident_filters:
            incidents = connection.execute("SELECT i.* FROM incidents i JOIN lines l ON l.id = i.line_id JOIN organizations o ON o.id = l.organization_id WHERE " + " AND ".join(incident_filters), incidents_params).fetchall()
        baseline_ok = sum(1 for row in rows if row["baseline_state"] == "OK")
        contract_ok = sum(1 for row in rows if row["contract_state"] == "MEETS")
        baseline_known = sum(1 for row in rows if row["baseline_state"] in {"OK", "VIOLATION"})
        contract_known = sum(1 for row in rows if row["contract_state"] in {"MEETS", "DEVIATES"})
        total_duration = 0.0
        for incident in incidents:
            incident_start = max(start, as_utc(incident["started_at"]))
            incident_end = min(end, as_utc(incident["closed_at"] or dt_text(end)))
            total_duration += max(0.0, (incident_end - incident_start).total_seconds() / 60)
        data_completeness = round(min(100, len(rows) / expected * 100), 1) if expected else 0.0
        return {"from": dt_text(start), "to": dt_text(end), "line_id": line_id, "measurements_received": len(rows), "measurements_expected": round(expected), "data_completeness": data_completeness, "baseline_compliance": round(baseline_ok / baseline_known * 100, 1) if baseline_known else None, "contract_compliance": round(contract_ok / contract_known * 100, 1) if contract_known else None, "incidents": {"count": len(incidents), "total_duration_minutes": round(total_duration, 1)}, "sufficient_data": bool(expected and len(rows) >= expected * 0.8)}

    @app.get("/api/incidents")
    @app.get("/api/v1/incidents")
    async def incidents(status: str | None = None, line_id: str | None = None, principal: Principal = Depends(principal_dependency), connection: Any = Depends(db_dependency)) -> list[dict[str, Any]]:
        params: list[Any] = []
        where = [line_scope_sql(principal, params)]
        if status:
            where.append("i.status = ?")
            params.append(status)
        if line_id:
            _line_or_404(connection, principal, line_id)
            where.append("i.line_id = ?")
            params.append(line_id)
        rows = connection.execute("SELECT i.id FROM incidents i JOIN lines l ON l.id = i.line_id JOIN organizations o ON o.id = l.organization_id WHERE " + " AND ".join(where) + " ORDER BY i.id DESC", params).fetchall()
        return [incident_snapshot(connection, row["id"]) for row in rows]

    @app.post("/api/incidents", status_code=201)
    @app.post("/api/v1/incidents", status_code=201)
    async def create_manual_incident(payload: ManualIncidentIn, request: Request, principal: Principal = Depends(principal_dependency), connection: Any = Depends(db_dependency)) -> dict[str, Any]:
        line = _line_or_404(connection, principal, payload.line_id)
        now = dt_text(utc_now())
        snapshot = {"line_id": payload.line_id, "manual_description": payload.description, "evidence_measurement_ids": [], "manual": True}
        cursor = connection.execute("INSERT INTO incidents(incident_no, line_id, source, violation_type, status, started_at, assignee, opening_snapshot_json, created_at) VALUES ('PENDING', ?, 'MANUAL', ?, 'NEW', ?, ?, ?, ?)", (payload.line_id, payload.violation_type, now, payload.assignee, __import__("json").dumps(snapshot, ensure_ascii=False), now))
        incident_id = int(cursor.lastrowid)
        connection.execute("UPDATE incidents SET incident_no = ? WHERE id = ?", (f"INC-{incident_id:06d}", incident_id))
        add_incident_event(connection, incident_id, "MANUAL_CREATED", principal.username, {"description": payload.description})
        add_audit(connection, "USER", principal.id, "incident.created_manual", "incident", str(incident_id), scope_type="LINE", scope_id=line["id"], after=snapshot, request_id=request.headers.get("X-Request-ID"))
        return incident_snapshot(connection, incident_id) or {}

    @app.get("/api/incidents/{incident_id}")
    @app.get("/api/v1/incidents/{incident_id}")
    async def incident_detail(incident_id: int, principal: Principal = Depends(principal_dependency), connection: Any = Depends(db_dependency)) -> dict[str, Any]:
        incident = incident_snapshot(connection, incident_id)
        if not incident or not line_allowed(connection, principal, incident["line_id"]):
            raise HTTPException(status_code=404, detail="incident not found")
        return incident

    @app.post("/api/incidents/{incident_id}/events")
    @app.post("/api/v1/incidents/{incident_id}/events")
    async def incident_event(incident_id: int, payload: IncidentEventIn, request: Request, principal: Principal = Depends(principal_dependency), connection: Any = Depends(db_dependency)) -> dict[str, Any]:
        incident = incident_snapshot(connection, incident_id)
        if not incident or not line_allowed(connection, principal, incident["line_id"]):
            raise HTTPException(status_code=404, detail="incident not found")
        now = dt_text(utc_now())
        event_payload = {"note": payload.note}
        if payload.event_type == "provider_fixed":
            _require_workflow_role(principal, "provider_fixed")
            if incident["status"] == "CLOSED":
                raise HTTPException(status_code=409, detail="closed incident cannot be marked resolved")
            connection.execute("UPDATE incidents SET status = 'RESOLVED', recovery_state = 'OBSERVED', resolved_at = ? WHERE id = ?", (now, incident_id))
            event_type = "PROVIDER_REPORTED_FIXED"
        elif payload.event_type == "send_to_provider":
            _require_workflow_role(principal, "send_to_provider")
            connection.execute("UPDATE incidents SET status = 'SENT_TO_PROVIDER' WHERE id = ?", (incident_id,))
            event_type = "SENT_TO_PROVIDER"
        elif payload.event_type == "assign":
            _require_workflow_role(principal, "assign")
            if not payload.note:
                raise HTTPException(status_code=422, detail="note must contain assignee")
            connection.execute("UPDATE incidents SET assignee = ? WHERE id = ?", (payload.note, incident_id))
            event_type = "ASSIGNED"
        elif payload.event_type == "status":
            _require_workflow_role(principal, "status")
            if payload.status not in {"NEW", "SENT_TO_PROVIDER", "IN_PROGRESS", "WAITING_INFO", "RESOLVED", "CLOSED"}:
                raise HTTPException(status_code=422, detail="unsupported incident status")
            if payload.status == "CLOSED":
                raise HTTPException(status_code=409, detail="close requires monitoring recovery evidence")
            connection.execute("UPDATE incidents SET status = ? WHERE id = ?", (payload.status, incident_id))
            event_type = "STATUS_CHANGED"
            event_payload["status"] = payload.status
        else:
            event_type = "COMMENT"
        add_incident_event(connection, incident_id, event_type, principal.username, event_payload)
        add_audit(connection, "USER", principal.id, f"incident.{event_type.lower()}", "incident", str(incident_id), request_id=request.headers.get("X-Request-ID"))
        return incident_snapshot(connection, incident_id) or {}

    @app.post("/api/incidents/{incident_id}/provider-case/draft", status_code=201)
    @app.post("/api/v1/incidents/{incident_id}/provider-case/draft", status_code=201)
    async def create_provider_case(incident_id: int, payload: ProviderDraftIn, request: Request, principal: Principal = Depends(principal_dependency), connection: Any = Depends(db_dependency)) -> dict[str, Any]:
        incident = incident_snapshot(connection, incident_id)
        if not incident or not line_allowed(connection, principal, incident["line_id"]):
            raise HTTPException(status_code=404, detail="incident not found")
        draft = provider_draft(connection, incident_id, payload.comment)
        now = dt_text(utc_now())
        cursor = connection.execute("INSERT INTO provider_cases(incident_id, draft_text, status, created_by, created_at) VALUES (?, ?, 'DRAFT', ?, ?)", (incident_id, draft, principal.username, now))
        case_id = int(cursor.lastrowid)
        add_incident_event(connection, incident_id, "PROVIDER_DRAFT_CREATED", principal.username, {"provider_case_id": case_id})
        add_audit(connection, "USER", principal.id, "provider_case.draft", "provider_case", str(case_id), request_id=request.headers.get("X-Request-ID"))
        return {"id": case_id, "incident_id": incident_id, "status": "DRAFT", "draft_text": draft, "created_at": now}

    @app.post("/api/provider-cases/{case_id}/send")
    @app.post("/api/v1/provider-cases/{case_id}/send")
    @app.post("/api/provider-cases/{case_id}/retry")
    @app.post("/api/v1/provider-cases/{case_id}/retry")
    async def send_provider_case(case_id: int, payload: ProviderSendIn, request: Request, principal: Principal = Depends(principal_dependency), connection: Any = Depends(db_dependency)) -> dict[str, Any]:
        case = connection.execute("SELECT * FROM provider_cases WHERE id = ?", (case_id,)).fetchone()
        if not case:
            raise HTTPException(status_code=404, detail="provider case not found")
        incident = incident_snapshot(connection, case["incident_id"])
        if not incident or not line_allowed(connection, principal, incident["line_id"]):
            raise HTTPException(status_code=404, detail="provider case not found")
        _require_workflow_role(principal, "provider_send")
        if case["status"] == "SENT":
            # A retried browser request must be idempotent and must not create a
            # second ticket at the provider.
            return {**dict(case), "incident_id": incident["id"]}
        if not payload.reviewed:
            raise HTTPException(status_code=409, detail="human review confirmation required before sending")
        final_text = payload.final_text or payload.text or case["draft_text"]
        if not final_text.strip():
            raise HTTPException(status_code=422, detail="final_text cannot be empty")
        now = dt_text(utc_now())
        attempts = int(case["delivery_attempts"] or 0) + 1
        connection.execute("UPDATE provider_cases SET final_text = ?, delivery_attempts = ?, delivery_error = NULL WHERE id = ?", (final_text, attempts, case_id))
        line = line_row(connection, incident["line_id"])
        provider = connection.execute("SELECT * FROM providers WHERE id = ?", (line["provider_id"],)).fetchone() if line and line["provider_id"] else None
        case_for_delivery = {**dict(case), "id": case_id, "final_text": final_text}
        try:
            delivery = deliver_provider_case(case_for_delivery, incident, provider)
        except DeliveryError as exc:
            connection.execute("UPDATE provider_cases SET status = 'FAILED', delivery_status = 'FAILED', delivery_error = ? WHERE id = ?", (str(exc)[:2000], case_id))
            add_incident_event(connection, incident["id"], "PROVIDER_CASE_DELIVERY_FAILED", principal.username, {"provider_case_id": case_id, "error": str(exc), "retryable": exc.retryable})
            add_audit(connection, "USER", principal.id, "provider_case.delivery_failed", "provider_case", str(case_id), after={"status": "FAILED", "attempts": attempts, "error": str(exc)}, request_id=request.headers.get("X-Request-ID"))
            # Preserve the failed attempt in the durable transaction before
            # telling the caller to retry or fix transport configuration.
            connection.commit()
            raise HTTPException(status_code=502, detail="provider delivery failed; the case remains retryable") from exc
        ticket_no = payload.ticket_no or delivery.external_id or f"PROVIDER-{case_id:06d}"
        connection.execute("UPDATE provider_cases SET ticket_no = ?, external_ticket_no = ?, status = 'SENT', delivery_channel = ?, delivery_status = 'SENT', delivery_error = NULL, sent_by = ?, sent_at = ? WHERE id = ?", (ticket_no, delivery.external_id, delivery.channel, principal.username, now, case_id))
        current = connection.execute("SELECT status FROM incidents WHERE id = ?", (incident["id"],)).fetchone()["status"]
        if current == "NEW":
            connection.execute("UPDATE incidents SET status = 'SENT_TO_PROVIDER' WHERE id = ?", (incident["id"],))
        add_incident_event(connection, incident["id"], "PROVIDER_CASE_SENT", principal.username, {"provider_case_id": case_id, "ticket_no": ticket_no})
        add_audit(connection, "USER", principal.id, "provider_case.sent", "provider_case", str(case_id), after={"ticket_no": ticket_no, "external_ticket_no": delivery.external_id, "delivery_channel": delivery.channel, "status": "SENT", "reviewed": True, "reviewed_by": principal.username}, request_id=request.headers.get("X-Request-ID"))
        return {**dict(connection.execute("SELECT * FROM provider_cases WHERE id = ?", (case_id,)).fetchone()), "incident_id": incident["id"]}

    @app.get("/api/situations")
    @app.get("/api/v1/situations")
    async def situations(principal: Principal = Depends(principal_dependency), connection: Any = Depends(db_dependency)) -> list[dict[str, Any]]:
        refresh_situations(connection)
        rows = connection.execute("SELECT s.* FROM situations s WHERE s.status = 'OPEN' ORDER BY s.start_at DESC").fetchall()
        result = []
        for row in rows:
            members = connection.execute("SELECT incident_id FROM situation_members WHERE situation_id = ?", (row["id"],)).fetchall()
            visible = all(line_allowed(connection, principal, incident["line_id"]) for member in members if (incident := incident_snapshot(connection, member["incident_id"])))
            if visible:
                item = dict(row)
                item["reason"] = _json(item.pop("reason_json"), {})
                item["incident_ids"] = [member["incident_id"] for member in members]
                item["affected_count"] = len(members)
                item["provider"] = item["reason"].get("provider") or item.get("provider_id")
                item["severity"] = "CRITICAL" if item.get("violation_type") == "NO_INTERNET" else "ATTENTION"
                result.append(item)
        return result

    @app.get("/api/situations/{situation_id}")
    @app.get("/api/v1/situations/{situation_id}")
    async def situation_detail(situation_id: int, principal: Principal = Depends(principal_dependency), connection: Any = Depends(db_dependency)) -> dict[str, Any]:
        row = connection.execute("SELECT * FROM situations WHERE id = ?", (situation_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="situation not found")
        members = connection.execute("SELECT incident_id FROM situation_members WHERE situation_id = ? ORDER BY incident_id", (situation_id,)).fetchall()
        incidents = [incident_snapshot(connection, member["incident_id"]) for member in members]
        visible_incidents = [incident for incident in incidents if incident and line_allowed(connection, principal, incident["line_id"])]
        if len(visible_incidents) != len(incidents):
            raise HTTPException(status_code=404, detail="situation not found")
        result = dict(row)
        result["reason"] = _json(result.pop("reason_json"), {})
        result["incidents"] = visible_incidents
        result["incident_ids"] = [incident["id"] for incident in visible_incidents]
        return result

    @app.get("/api/notifications")
    @app.get("/api/v1/notifications")
    async def notifications(principal: Principal = Depends(principal_dependency), connection: Any = Depends(db_dependency)) -> list[dict[str, Any]]:
        if principal.is_admin:
            rows = connection.execute("SELECT * FROM notifications ORDER BY generated_at DESC LIMIT 200").fetchall()
        else:
            params: list[Any] = []
            scope = line_scope_sql(principal, params)
            rows = connection.execute("SELECT n.* FROM notifications n JOIN incidents i ON n.source_type = 'INCIDENT' AND n.source_id = CAST(i.id AS TEXT) JOIN lines l ON l.id = i.line_id JOIN organizations o ON o.id = l.organization_id WHERE " + scope + " ORDER BY n.generated_at DESC LIMIT 200", params).fetchall()
        return [dict(row) for row in rows]

    @app.post("/api/admin/notifications/{notification_id}/dispatch")
    @app.post("/api/v1/admin/notifications/{notification_id}/dispatch")
    async def dispatch_notification_endpoint(notification_id: int, request: Request, principal: Principal = Depends(principal_dependency), connection: Any = Depends(db_dependency)) -> dict[str, Any]:
        _require_admin(principal)
        result = dispatch_notification(connection, notification_id)
        if not result:
            raise HTTPException(status_code=404, detail="notification not found")
        add_audit(connection, "USER", principal.id, "notification.dispatch", "notification", str(notification_id), after={"status": result.get("status"), "delivery_attempts": result.get("delivery_attempts")}, request_id=request.headers.get("X-Request-ID"))
        return result

    @app.get("/api/exports")
    @app.post("/api/exports")
    @app.get("/api/v1/exports")
    @app.post("/api/v1/exports")
    async def export_data(kind: str = "raw", format: str = "csv", from_time: str | None = Query(default=None, alias="from"), to_time: str | None = Query(default=None, alias="to"), period: str | None = None, line_id: str | None = None, district: str | None = None, provider: str | None = None, device_id: str | None = None, status: str | None = None, role: str | None = None, technology: str | None = None, organization_id: str | None = None, payload: dict[str, Any] | None = Body(default=None), principal: Principal = Depends(principal_dependency), connection: Any = Depends(db_dependency)) -> Response:
        # Accept the same filter contract over GET query parameters and the
        # documented bounded POST export request. Query values win when both
        # representations are present.
        if payload:
            kind = str(kind if kind != "raw" else payload.get("kind", payload.get("type", kind)))
            format = str(format if format != "csv" else payload.get("format", format))
            period = period or payload.get("period")
            line_id = line_id or payload.get("line_id")
            district = district or payload.get("district")
            provider = provider or payload.get("provider")
            device_id = device_id or payload.get("device_id")
            status = status or payload.get("status")
            role = role or payload.get("role")
            technology = technology or payload.get("technology")
            organization_id = organization_id or payload.get("organization_id")
            from_time = from_time or payload.get("from")
            to_time = to_time or payload.get("to")
        if kind not in {"raw", "aggregate"} or format not in {"csv", "xlsx"}:
            raise HTTPException(status_code=422, detail="kind must be raw/aggregate and format csv/xlsx")
        start, end = _period_bounds(period, from_time, to_time, default_days=1)
        rows = _report_rows(connection, principal, dt_text(start), dt_text(end), line_id, district=district, provider=provider, device_id=device_id, status=status, role=role, technology=technology, organization_id=organization_id)
        if kind == "raw":
            headers = ["school_id", "organization_name", "district", "line_id", "device_id", "observed_at", "download", "upload", "ping", "jitter", "packet_loss", "availability", "connection_status", "baseline_state", "contract_state"]
            data = [[row.get(header) for header in headers] for row in map(dict, rows)]
        else:
            headers = ["line_id", "measurement_count", "average_download", "min_download", "max_download", "average_upload", "average_ping", "average_availability", "problem_measurement_count"]
            groups: dict[str, list[Any]] = {}
            for row in rows:
                groups.setdefault(row["line_id"], []).append(row)
            data = []
            for grouped_line, grouped in groups.items():
                downloads = [row["download"] for row in grouped if row["download"] is not None]
                uploads = [row["upload"] for row in grouped if row["upload"] is not None]
                pings = [row["ping"] for row in grouped if row["ping"] is not None]
                availabilities = [row["availability"] for row in grouped if row["availability"] is not None]
                data.append([grouped_line, len(grouped), sum(downloads) / len(downloads) if downloads else None, min(downloads) if downloads else None, max(downloads) if downloads else None, sum(uploads) / len(uploads) if uploads else None, sum(pings) / len(pings) if pings else None, sum(availabilities) / len(availabilities) if availabilities else None, sum(1 for row in grouped if row["baseline_state"] == "VIOLATION" or row["contract_state"] == "DEVIATES")])
        if format == "csv":
            stream = io.StringIO()
            writer = csv.writer(stream)
            writer.writerow(headers)
            writer.writerows([[_csv_cell(value) for value in row] for row in data])
            return Response(stream.getvalue().encode("utf-8-sig"), media_type="text/csv; charset=utf-8", headers={"Content-Disposition": f'attachment; filename="vko-{kind}.csv"'})
        return Response(_xlsx_bytes(headers, data), media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", headers={"Content-Disposition": f'attachment; filename="vko-{kind}.xlsx"'})

    @app.get("/api/v1/audit")
    @app.get("/api/audit")
    @app.get("/api/v1/admin/audit")
    async def audit(limit: int = Query(default=200, ge=1, le=1000), principal: Principal = Depends(principal_dependency), connection: Any = Depends(db_dependency)) -> list[dict[str, Any]]:
        _require_admin(principal)
        return [{**dict(row), "before": _json(row["before_json"], None), "after": _json(row["after_json"], None)} for row in connection.execute("SELECT * FROM audit_events ORDER BY id DESC LIMIT ?", (limit,)).fetchall()]

    @app.get("/api/admin/organizations")
    @app.get("/api/v1/admin/organizations")
    async def admin_organizations(principal: Principal = Depends(principal_dependency), connection: Any = Depends(db_dependency)) -> list[dict[str, Any]]:
        _require_admin(principal)
        return [{**dict(row), "active": bool(row["active"])} for row in connection.execute("SELECT * FROM organizations ORDER BY district, name").fetchall()]

    @app.post("/api/admin/organizations", status_code=201)
    @app.post("/api/v1/admin/organizations", status_code=201)
    async def create_organization(payload: OrganizationIn, request: Request, principal: Principal = Depends(principal_dependency), connection: Any = Depends(db_dependency)) -> dict[str, Any]:
        _require_admin(principal)
        if connection.execute("SELECT 1 FROM organizations WHERE id = ? OR school_id = ?", (payload.id, payload.school_id)).fetchone():
            raise HTTPException(status_code=409, detail="organization id or school_id already exists")
        values = payload.model_dump()
        now = dt_text(utc_now())
        connection.execute("INSERT INTO organizations(id, school_id, name, district, address, latitude, longitude, contact_name, contact_phone, active, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", (values["id"], values["school_id"], values["name"], values["district"], values["address"], values["latitude"], values["longitude"], values["contact_name"], values["contact_phone"], int(values["active"]), now))
        add_audit(connection, "USER", principal.id, "organization.created", "organization", payload.id, after=values, request_id=request.headers.get("X-Request-ID"))
        return {**values, "created_at": now}

    @app.put("/api/admin/organizations/{organization_id}")
    @app.put("/api/v1/admin/organizations/{organization_id}")
    async def update_organization(organization_id: str, payload: OrganizationIn, request: Request, principal: Principal = Depends(principal_dependency), connection: Any = Depends(db_dependency)) -> dict[str, Any]:
        _require_admin(principal)
        current = connection.execute("SELECT * FROM organizations WHERE id = ?", (organization_id,)).fetchone()
        if not current:
            raise HTTPException(status_code=404, detail="organization not found")
        if payload.id != organization_id:
            raise HTTPException(status_code=409, detail="organization id is immutable")
        values = payload.model_dump()
        if connection.execute("SELECT 1 FROM organizations WHERE school_id = ? AND id != ?", (values["school_id"], organization_id)).fetchone():
            raise HTTPException(status_code=409, detail="school_id already exists")
        connection.execute("UPDATE organizations SET id = ?, school_id = ?, name = ?, district = ?, address = ?, latitude = ?, longitude = ?, contact_name = ?, contact_phone = ?, active = ? WHERE id = ?", (values["id"], values["school_id"], values["name"], values["district"], values["address"], values["latitude"], values["longitude"], values["contact_name"], values["contact_phone"], int(values["active"]), organization_id))
        add_audit(connection, "USER", principal.id, "organization.updated", "organization", values["id"], before=dict(current), after=values, request_id=request.headers.get("X-Request-ID"))
        row = connection.execute("SELECT * FROM organizations WHERE id = ?", (values["id"],)).fetchone()
        return {**dict(row), "active": bool(row["active"])}

    @app.get("/api/admin/providers")
    @app.get("/api/v1/admin/providers")
    async def admin_providers(principal: Principal = Depends(principal_dependency), connection: Any = Depends(db_dependency)) -> list[dict[str, Any]]:
        _require_admin(principal)
        return [{**dict(row), "active": bool(row["active"])} for row in connection.execute("SELECT * FROM providers ORDER BY name").fetchall()]

    @app.post("/api/admin/providers", status_code=201)
    @app.post("/api/v1/admin/providers", status_code=201)
    async def create_provider(payload: ProviderIn, request: Request, principal: Principal = Depends(principal_dependency), connection: Any = Depends(db_dependency)) -> dict[str, Any]:
        _require_admin(principal)
        if connection.execute("SELECT 1 FROM providers WHERE id = ? OR name = ?", (payload.id, payload.name)).fetchone():
            raise HTTPException(status_code=409, detail="provider id or name already exists")
        values = payload.model_dump()
        now = dt_text(utc_now())
        connection.execute("INSERT INTO providers(id, name, support_contact, active, created_at) VALUES (?, ?, ?, ?, ?)", (values["id"], values["name"], values["support_contact"], int(values["active"]), now))
        add_audit(connection, "USER", principal.id, "provider.created", "provider", payload.id, after=values, request_id=request.headers.get("X-Request-ID"))
        return {**values, "created_at": now}

    @app.put("/api/admin/providers/{provider_id}")
    @app.put("/api/v1/admin/providers/{provider_id}")
    async def update_provider(provider_id: str, payload: ProviderIn, request: Request, principal: Principal = Depends(principal_dependency), connection: Any = Depends(db_dependency)) -> dict[str, Any]:
        _require_admin(principal)
        current = connection.execute("SELECT * FROM providers WHERE id = ?", (provider_id,)).fetchone()
        if not current:
            raise HTTPException(status_code=404, detail="provider not found")
        values = payload.model_dump()
        if values["id"] != provider_id:
            raise HTTPException(status_code=409, detail="provider id is immutable")
        duplicate = connection.execute("SELECT 1 FROM providers WHERE (id = ? OR name = ?) AND id != ?", (values["id"], values["name"], provider_id)).fetchone()
        if duplicate:
            raise HTTPException(status_code=409, detail="provider id or name already exists")
        connection.execute("UPDATE providers SET id = ?, name = ?, support_contact = ?, active = ? WHERE id = ?", (values["id"], values["name"], values["support_contact"], int(values["active"]), provider_id))
        add_audit(connection, "USER", principal.id, "provider.updated", "provider", values["id"], before=dict(current), after=values, request_id=request.headers.get("X-Request-ID"))
        row = connection.execute("SELECT * FROM providers WHERE id = ?", (values["id"],)).fetchone()
        return {**dict(row), "active": bool(row["active"])}

    @app.get("/api/admin/lines")
    @app.get("/api/v1/admin/lines")
    async def admin_lines(principal: Principal = Depends(principal_dependency), connection: Any = Depends(db_dependency)) -> list[dict[str, Any]]:
        _require_admin(principal)
        return [dict(row) for row in connection.execute("SELECT l.*, o.school_id, o.name AS organization_name, p.name AS provider_name FROM lines l JOIN organizations o ON o.id = l.organization_id LEFT JOIN providers p ON p.id = l.provider_id ORDER BY o.district, o.name, l.role").fetchall()]

    @app.post("/api/admin/lines", status_code=201)
    @app.post("/api/v1/admin/lines", status_code=201)
    async def create_line(payload: LineAdminIn, request: Request, principal: Principal = Depends(principal_dependency), connection: Any = Depends(db_dependency)) -> dict[str, Any]:
        _require_admin(principal)
        if not connection.execute("SELECT 1 FROM organizations WHERE id = ?", (payload.organization_id,)).fetchone():
            raise HTTPException(status_code=422, detail="organization not found")
        if payload.provider_id and not connection.execute("SELECT 1 FROM providers WHERE id = ?", (payload.provider_id,)).fetchone():
            raise HTTPException(status_code=422, detail="provider not found")
        if connection.execute("SELECT 1 FROM lines WHERE id = ?", (payload.id,)).fetchone():
            raise HTTPException(status_code=409, detail="line already exists")
        values = payload.model_dump()
        now = dt_text(utc_now())
        connection.execute("INSERT INTO lines(id, organization_id, provider_id, role, technology, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)", (values["id"], values["organization_id"], values["provider_id"], values["role"], values["technology"], values["status"], now))
        add_audit(connection, "USER", principal.id, "line.created", "line", payload.id, after=values, request_id=request.headers.get("X-Request-ID"))
        return {**values, "created_at": now}

    @app.put("/api/admin/lines/{line_id}")
    @app.put("/api/v1/admin/lines/{line_id}")
    async def update_line(line_id: str, payload: LineAdminIn, request: Request, principal: Principal = Depends(principal_dependency), connection: Any = Depends(db_dependency)) -> dict[str, Any]:
        _require_admin(principal)
        current = connection.execute("SELECT * FROM lines WHERE id = ?", (line_id,)).fetchone()
        if not current:
            raise HTTPException(status_code=404, detail="line not found")
        if not connection.execute("SELECT 1 FROM organizations WHERE id = ?", (payload.organization_id,)).fetchone():
            raise HTTPException(status_code=422, detail="organization not found")
        if payload.provider_id and not connection.execute("SELECT 1 FROM providers WHERE id = ?", (payload.provider_id,)).fetchone():
            raise HTTPException(status_code=422, detail="provider not found")
        values = payload.model_dump()
        if values["id"] != line_id:
            raise HTTPException(status_code=409, detail="line id is immutable")
        connection.execute("UPDATE lines SET id = ?, organization_id = ?, provider_id = ?, role = ?, technology = ?, status = ? WHERE id = ?", (values["id"], values["organization_id"], values["provider_id"], values["role"], values["technology"], values["status"], line_id))
        add_audit(connection, "USER", principal.id, "line.updated", "line", values["id"], before=dict(current), after=values, request_id=request.headers.get("X-Request-ID"))
        row = connection.execute("SELECT * FROM lines WHERE id = ?", (values["id"],)).fetchone()
        return dict(row)

    @app.get("/api/admin/monitoring-points")
    @app.get("/api/v1/admin/monitoring-points")
    async def admin_monitoring_points(principal: Principal = Depends(principal_dependency), connection: Any = Depends(db_dependency)) -> list[dict[str, Any]]:
        _require_admin(principal)
        return [{**dict(row), "is_primary": bool(row["is_primary"]), "active": bool(row["active"])} for row in connection.execute("SELECT * FROM monitoring_points ORDER BY line_id, is_primary DESC, id").fetchall()]

    @app.post("/api/admin/monitoring-points", status_code=201)
    @app.post("/api/v1/admin/monitoring-points", status_code=201)
    async def create_monitoring_point(payload: MonitoringPointIn, request: Request, principal: Principal = Depends(principal_dependency), connection: Any = Depends(db_dependency)) -> dict[str, Any]:
        _require_admin(principal)
        if not connection.execute("SELECT 1 FROM lines WHERE id = ?", (payload.line_id,)).fetchone():
            raise HTTPException(status_code=422, detail="line not found")
        if connection.execute("SELECT 1 FROM monitoring_points WHERE id = ?", (payload.id,)).fetchone():
            raise HTTPException(status_code=409, detail="monitoring point already exists")
        values = payload.model_dump()
        now = dt_text(utc_now())
        if values["is_primary"]:
            connection.execute("UPDATE monitoring_points SET is_primary = 0 WHERE line_id = ?", (values["line_id"],))
        connection.execute("INSERT INTO monitoring_points(id, line_id, location, is_primary, active, created_at) VALUES (?, ?, ?, ?, ?, ?)", (values["id"], values["line_id"], values["location"], int(values["is_primary"]), int(values["active"]), now))
        add_audit(connection, "USER", principal.id, "monitoring_point.created", "monitoring_point", payload.id, after=values, request_id=request.headers.get("X-Request-ID"))
        return {**values, "created_at": now}

    @app.get("/api/admin/devices")
    @app.get("/api/v1/admin/devices")
    async def admin_devices(principal: Principal = Depends(principal_dependency), connection: Any = Depends(db_dependency)) -> list[dict[str, Any]]:
        _require_admin(principal)
        return [dict(row) for row in connection.execute("SELECT d.id, d.monitoring_point_id, d.agent_version, d.last_seen, d.blocked_at, d.created_at, mp.line_id, l.organization_id, o.school_id, o.name AS organization_name FROM devices d JOIN monitoring_points mp ON mp.id = d.monitoring_point_id JOIN lines l ON l.id = mp.line_id JOIN organizations o ON o.id = l.organization_id ORDER BY o.district, o.name, d.id").fetchall()]

    @app.put("/api/admin/monitoring-points/{point_id}")
    @app.put("/api/v1/admin/monitoring-points/{point_id}")
    async def update_monitoring_point(point_id: str, payload: MonitoringPointIn, request: Request, principal: Principal = Depends(principal_dependency), connection: Any = Depends(db_dependency)) -> dict[str, Any]:
        _require_admin(principal)
        current = connection.execute("SELECT * FROM monitoring_points WHERE id = ?", (point_id,)).fetchone()
        if not current:
            raise HTTPException(status_code=404, detail="monitoring point not found")
        if payload.id != point_id:
            raise HTTPException(status_code=409, detail="monitoring point id is immutable")
        if not connection.execute("SELECT 1 FROM lines WHERE id = ?", (payload.line_id,)).fetchone():
            raise HTTPException(status_code=422, detail="line not found")
        values = payload.model_dump()
        if values["is_primary"]:
            connection.execute("UPDATE monitoring_points SET is_primary = 0 WHERE line_id = ? AND id != ?", (values["line_id"], point_id))
        connection.execute("UPDATE monitoring_points SET line_id = ?, location = ?, is_primary = ?, active = ? WHERE id = ?", (values["line_id"], values["location"], int(values["is_primary"]), int(values["active"]), point_id))
        add_audit(connection, "USER", principal.id, "monitoring_point.updated", "monitoring_point", point_id, before=dict(current), after=values, request_id=request.headers.get("X-Request-ID"))
        row = connection.execute("SELECT * FROM monitoring_points WHERE id = ?", (point_id,)).fetchone()
        return {**dict(row), "is_primary": bool(row["is_primary"]), "active": bool(row["active"])}

    @app.get("/api/admin/users")
    @app.get("/api/v1/admin/users")
    async def admin_users(principal: Principal = Depends(principal_dependency), connection: Any = Depends(db_dependency)) -> list[dict[str, Any]]:
        _require_admin(principal)
        result = []
        for row in connection.execute("SELECT id, username, role, disabled_at, created_at FROM users ORDER BY username").fetchall():
            item = dict(row)
            item["disabled"] = bool(item.pop("disabled_at"))
            item["scopes"] = [{"scope_type": scope["scope_type"], "scope_id": scope["scope_id"]} for scope in connection.execute("SELECT scope_type, scope_id FROM role_scopes WHERE user_id = ? ORDER BY scope_type, scope_id", (row["id"],)).fetchall()]
            result.append(item)
        return result

    @app.post("/api/admin/users", status_code=201)
    @app.post("/api/v1/admin/users", status_code=201)
    async def create_user(payload: UserAdminIn, request: Request, principal: Principal = Depends(principal_dependency), connection: Any = Depends(db_dependency)) -> dict[str, Any]:
        _require_admin(principal)
        if connection.execute("SELECT 1 FROM users WHERE id = ? OR username = ?", (payload.id, payload.username)).fetchone():
            raise HTTPException(status_code=409, detail="user id or username already exists")
        environment = os.getenv("VKO_ENV", "development").lower()
        if environment == "production" and (not payload.password or len(payload.password) < 12):
            raise HTTPException(status_code=422, detail="a 12+ character password is required in production")
        now = dt_text(utc_now())
        token = secrets.token_urlsafe(32)
        password_hash = hash_password(payload.password) if payload.password else None
        connection.execute("INSERT INTO users(id, username, role, token_hash, password_hash, disabled_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)", (payload.id, payload.username, payload.role, token_hash(token), password_hash, now if payload.disabled else None, now))
        if not payload.disabled:
            # The one-time bearer token remains useful to API clients that
            # provision users before they have a password-based login flow.
            issue_session(connection, payload.id, token=token, ttl_seconds=_session_ttl_seconds())
        for scope in payload.scopes:
            connection.execute("INSERT INTO role_scopes(user_id, scope_type, scope_id) VALUES (?, ?, ?)", (payload.id, scope.scope_type, scope.scope_id))
        values = payload.model_dump(exclude={"scopes", "password"})
        add_audit(connection, "USER", principal.id, "user.created", "user", payload.id, after={**values, "scope_count": len(payload.scopes)}, request_id=request.headers.get("X-Request-ID"))
        return {"id": payload.id, "username": payload.username, "role": payload.role, "disabled": payload.disabled, "scopes": [scope.model_dump() for scope in payload.scopes], "token": token, "created_at": now}

    @app.put("/api/admin/users/{user_id}")
    @app.put("/api/v1/admin/users/{user_id}")
    async def update_user(user_id: str, payload: UserAdminIn, request: Request, principal: Principal = Depends(principal_dependency), connection: Any = Depends(db_dependency)) -> dict[str, Any]:
        _require_admin(principal)
        current = connection.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
        if not current:
            raise HTTPException(status_code=404, detail="user not found")
        if payload.id != user_id:
            raise HTTPException(status_code=409, detail="user id is immutable")
        duplicate = connection.execute("SELECT 1 FROM users WHERE username = ? AND id != ?", (payload.username, user_id)).fetchone()
        if duplicate:
            raise HTTPException(status_code=409, detail="username already exists")
        disabled_at = dt_text(utc_now()) if payload.disabled else None
        password_clause = ""
        password_params: list[Any] = []
        if payload.password:
            if os.getenv("VKO_ENV", "development").lower() == "production" and len(payload.password) < 12:
                raise HTTPException(status_code=422, detail="a 12+ character password is required in production")
            password_clause = ", password_hash = ?"
            password_params.append(hash_password(payload.password))
        connection.execute("UPDATE users SET id = ?, username = ?, role = ?, disabled_at = ?" + password_clause + " WHERE id = ?", (payload.id, payload.username, payload.role, disabled_at, *password_params, user_id))
        if payload.disabled or payload.password:
            connection.execute("UPDATE auth_sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL", (dt_text(utc_now()), user_id))
        if payload.disabled or payload.password:
            # Also invalidate the compatibility token stored by pre-session
            # databases; otherwise changing a password or disabling/re-enabling
            # a user would leave an older bearer credential usable in
            # development/staging.
            connection.execute("UPDATE users SET token_hash = ? WHERE id = ?", (token_hash(secrets.token_urlsafe(32)), payload.id))
        connection.execute("DELETE FROM role_scopes WHERE user_id = ?", (user_id,))
        for scope in payload.scopes:
            connection.execute("INSERT INTO role_scopes(user_id, scope_type, scope_id) VALUES (?, ?, ?)", (payload.id, scope.scope_type, scope.scope_id))
        add_audit(connection, "USER", principal.id, "user.updated", "user", payload.id, before={"id": current["id"], "username": current["username"], "role": current["role"], "disabled": bool(current["disabled_at"])}, after={"id": payload.id, "username": payload.username, "role": payload.role, "disabled": payload.disabled, "password_changed": bool(payload.password), "scope_count": len(payload.scopes)}, request_id=request.headers.get("X-Request-ID"))
        return {"id": payload.id, "username": payload.username, "role": payload.role, "disabled": payload.disabled, "scopes": [scope.model_dump() for scope in payload.scopes]}

    @app.post("/api/admin/devices/{device_id}/unblock")
    @app.post("/api/v1/admin/devices/{device_id}/unblock")
    async def unblock_device(device_id: str, request: Request, principal: Principal = Depends(principal_dependency), connection: Any = Depends(db_dependency)) -> dict[str, Any]:
        _require_admin(principal)
        device = connection.execute("SELECT * FROM devices WHERE id = ?", (device_id,)).fetchone()
        if not device:
            raise HTTPException(status_code=404, detail="device not found")
        connection.execute("UPDATE devices SET blocked_at = NULL WHERE id = ?", (device_id,))
        add_audit(connection, "USER", principal.id, "device.unblocked", "device", device_id, before={"blocked_at": device["blocked_at"]}, after={"blocked_at": None}, request_id=request.headers.get("X-Request-ID"))
        return {"device_id": device_id, "blocked_at": None}

    @app.get("/api/admin/schedules")
    @app.get("/api/v1/admin/schedules")
    async def admin_schedule(principal: Principal = Depends(principal_dependency), connection: Any = Depends(db_dependency)) -> dict[str, Any]:
        _require_admin(principal)
        row = connection.execute("SELECT tests_per_day, jitter_minutes, light_checks_between, updated_by, updated_at FROM agent_schedules WHERE id = 1").fetchone()
        if not row:
            return {"tests_per_day": 4, "jitter_minutes": 8, "light_checks_between": False, "updated_by": None, "updated_at": None}
        result = dict(row)
        result["light_checks_between"] = bool(result["light_checks_between"])
        return result

    @app.put("/api/admin/schedules")
    @app.put("/api/v1/admin/schedules")
    async def update_schedule(payload: ScheduleIn, request: Request, principal: Principal = Depends(principal_dependency), connection: Any = Depends(db_dependency)) -> dict[str, Any]:
        _require_admin(principal)
        before = connection.execute("SELECT * FROM agent_schedules WHERE id = 1").fetchone()
        now = dt_text(utc_now())
        values = payload.model_dump()
        connection.execute("INSERT INTO agent_schedules(id, tests_per_day, jitter_minutes, light_checks_between, updated_by, updated_at) VALUES (1, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET tests_per_day = excluded.tests_per_day, jitter_minutes = excluded.jitter_minutes, light_checks_between = excluded.light_checks_between, updated_by = excluded.updated_by, updated_at = excluded.updated_at", (values["tests_per_day"], values["jitter_minutes"], int(values["light_checks_between"]), principal.username, now))
        add_audit(connection, "USER", principal.id, "schedule.updated", "agent_schedule", "1", before=dict(before) if before else None, after={**values, "updated_by": principal.username, "updated_at": now}, request_id=request.headers.get("X-Request-ID"))
        return {**values, "updated_by": principal.username, "updated_at": now}

    @app.get("/api/admin/policies")
    @app.get("/api/v1/admin/policies")
    async def policies(principal: Principal = Depends(principal_dependency), connection: Any = Depends(db_dependency)) -> list[dict[str, Any]]:
        _require_admin(principal)
        return [dict(row) for row in connection.execute("SELECT * FROM threshold_policy_versions ORDER BY valid_from DESC, version DESC").fetchall()]

    @app.post("/api/admin/policies", status_code=201)
    @app.post("/api/v1/admin/policies", status_code=201)
    async def create_policy(payload: PolicyIn, request: Request, principal: Principal = Depends(principal_dependency), connection: Any = Depends(db_dependency)) -> dict[str, Any]:
        _require_admin(principal)
        if payload.scope_type == "LINE" and (not payload.scope_id or not line_row(connection, payload.scope_id)):
            raise HTTPException(status_code=422, detail="LINE policy requires an existing scope_id")
        now = dt_text(utc_now())
        valid_from = dt_text(payload.valid_from or utc_now())
        valid_to = dt_text(payload.valid_to)
        if valid_to and as_utc(valid_to) <= as_utc(valid_from):
            raise HTTPException(status_code=422, detail="valid_to must be later than valid_from")
        overlap = connection.execute(
            "SELECT * FROM threshold_policy_versions WHERE scope_type = ? AND scope_id IS ? "
            "AND valid_from < COALESCE(?, '9999-12-31T00:00:00+00:00') "
            "AND COALESCE(valid_to, '9999-12-31T00:00:00+00:00') > ? ORDER BY valid_from DESC LIMIT 1",
            (payload.scope_type, payload.scope_id, valid_to, valid_from),
        ).fetchone()
        if overlap:
            # An open-ended current version is closed at the new effective
            # boundary. This is a version transition, not a retroactive edit;
            # already stored evaluations retain their snapshots.
            if overlap["valid_to"] is None and as_utc(valid_from) > as_utc(overlap["valid_from"]):
                connection.execute("UPDATE threshold_policy_versions SET valid_to = ? WHERE id = ?", (valid_from, overlap["id"]))
                add_audit(connection, "USER", principal.id, "policy.version_closed", "threshold_policy", str(overlap["id"]), before=dict(overlap), after={"valid_to": valid_from}, request_id=request.headers.get("X-Request-ID"))
            else:
                raise HTTPException(status_code=409, detail="policy validity interval overlaps existing version")
        latest = connection.execute("SELECT COALESCE(MAX(version), 0) AS version FROM threshold_policy_versions WHERE scope_type = ? AND scope_id IS ?", (payload.scope_type, payload.scope_id)).fetchone()["version"]
        values = payload.model_dump()
        cursor = connection.execute("INSERT INTO threshold_policy_versions(scope_type, scope_id, valid_from, valid_to, version, download_min, upload_min, ping_max, jitter_max, packet_loss_max, availability_min, confirm_count, confirm_minutes, recovery_count, recovery_minutes, freshness_seconds, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", (payload.scope_type, payload.scope_id, valid_from, valid_to, latest + 1, values["download_min"], values["upload_min"], values["ping_max"], values["jitter_max"], values["packet_loss_max"], values["availability_min"], values["confirm_count"], values["confirm_minutes"], values["recovery_count"], values["recovery_minutes"], values["freshness_seconds"], principal.username, now))
        policy = connection.execute("SELECT * FROM threshold_policy_versions WHERE id = ?", (cursor.lastrowid,)).fetchone()
        add_audit(connection, "USER", principal.id, "policy.created", "threshold_policy", str(cursor.lastrowid), scope_type=payload.scope_type, scope_id=payload.scope_id, after=dict(policy), request_id=request.headers.get("X-Request-ID"))
        return dict(policy)

    @app.post("/api/admin/contracts", status_code=201)
    @app.post("/api/v1/admin/contracts", status_code=201)
    async def create_contract(payload: ContractIn, request: Request, principal: Principal = Depends(principal_dependency), connection: Any = Depends(db_dependency)) -> dict[str, Any]:
        _require_admin(principal)
        line = line_row(connection, payload.line_id)
        if not line:
            raise HTTPException(status_code=404, detail="line not found")
        valid_from = dt_text(payload.valid_from)
        valid_to = dt_text(payload.valid_to)
        if valid_to and as_utc(valid_to) <= as_utc(valid_from):
            raise HTTPException(status_code=422, detail="valid_to must be later than valid_from")
        overlap = connection.execute("SELECT * FROM contract_versions WHERE line_id = ? AND valid_from < COALESCE(?, '9999-12-31T00:00:00+00:00') AND COALESCE(valid_to, '9999-12-31T00:00:00+00:00') > ? ORDER BY valid_from DESC LIMIT 1", (payload.line_id, valid_to, valid_from)).fetchone()
        if overlap:
            if overlap["valid_to"] is None and as_utc(valid_from) > as_utc(overlap["valid_from"]):
                connection.execute("UPDATE contract_versions SET valid_to = ? WHERE id = ?", (valid_from, overlap["id"]))
                add_audit(connection, "USER", principal.id, "contract.version_closed", "contract_version", str(overlap["id"]), before=dict(overlap), after={"valid_to": valid_from}, request_id=request.headers.get("X-Request-ID"))
            else:
                raise HTTPException(status_code=409, detail="contract validity interval overlaps existing version")
        now = dt_text(utc_now())
        values = payload.model_dump()
        cursor = connection.execute("INSERT INTO contract_versions(line_id, valid_from, valid_to, contract_no, contract_date, download_min, upload_min, ping_max, jitter_max, packet_loss_max, availability_min, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", (payload.line_id, valid_from, valid_to, values["contract_no"], dt_text(payload.contract_date), values["download_min"], values["upload_min"], values["ping_max"], values["jitter_max"], values["packet_loss_max"], values["availability_min"], principal.username, now))
        contract = connection.execute("SELECT * FROM contract_versions WHERE id = ?", (cursor.lastrowid,)).fetchone()
        add_audit(connection, "USER", principal.id, "contract.created", "contract_version", str(cursor.lastrowid), scope_type="LINE", scope_id=payload.line_id, after=dict(contract), request_id=request.headers.get("X-Request-ID"))
        return dict(contract)

    @app.post("/api/admin/devices/{device_id}/block")
    @app.post("/api/v1/admin/devices/{device_id}/block")
    async def block_device(device_id: str, request: Request, principal: Principal = Depends(principal_dependency), connection: Any = Depends(db_dependency)) -> dict[str, Any]:
        _require_admin(principal)
        device = connection.execute("SELECT * FROM devices WHERE id = ?", (device_id,)).fetchone()
        if not device:
            raise HTTPException(status_code=404, detail="device not found")
        now = dt_text(utc_now())
        connection.execute("UPDATE devices SET blocked_at = ? WHERE id = ?", (now, device_id))
        add_audit(connection, "USER", principal.id, "device.blocked", "device", device_id, before=dict(device), after={"blocked_at": now}, request_id=request.headers.get("X-Request-ID"))
        return {"device_id": device_id, "blocked_at": now}

    @app.post("/api/admin/demo/reset")
    @app.post("/api/v1/admin/demo/reset")
    async def demo_reset(payload: DemoResetIn, principal: Principal = Depends(principal_dependency), connection: Any = Depends(db_dependency)) -> dict[str, Any]:
        if os.getenv("VKO_ENV", "development").lower() == "production":
            raise HTTPException(status_code=404, detail="demo reset is disabled in production")
        _require_admin(principal)
        # Keep the reset implementation in seed.py so CLI and API use one fixture.
        from ..seed import _clear_demo, seed_demo

        _clear_demo(connection)
        connection.commit()
        seed_demo(database_path, reset=False, seed_measurements=payload.seed_measurements)
        return {"status": "reset", "seed_measurements": payload.seed_measurements}

    return app


app = create_app()
