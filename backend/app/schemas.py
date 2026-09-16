from __future__ import annotations

import math
from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator


class StrictModel(BaseModel):
    # Evidence and workflow APIs should reject misspelled fields instead of
    # silently dropping them. Fields intentionally sent by the agent/UI are
    # declared explicitly below, so strictness remains compatible with the
    # documented clients.
    model_config = ConfigDict(extra="forbid")


class AgentMeasurementIn(StrictModel):
    client_event_id: str = Field(min_length=1, max_length=128)
    # These are diagnostic fields from the agent payload. The server resolves
    # the authoritative binding from the authenticated device and never trusts
    # these values for authorization or persistence.
    device_id: str | None = Field(default=None, max_length=128)
    school_id: str | None = Field(default=None, max_length=128)
    line_id: str | None = Field(default=None, max_length=128)
    monitoring_point_id: str | None = Field(default=None, max_length=128)
    agent_version: str | None = Field(default=None, max_length=64)
    observed_at: datetime
    mode: Literal["LIGHT", "PERFORMANCE"] = "PERFORMANCE"
    download: float | None = Field(default=None, ge=0)
    upload: float | None = Field(default=None, ge=0)
    ping: float | None = Field(default=None, ge=0)
    jitter: float | None = Field(default=None, ge=0)
    packet_loss: float | None = Field(default=None, ge=0)
    availability: float | None = Field(default=None, ge=0, le=100)
    connection_status: Literal["OK", "NO_INTERNET"] = "OK"
    quality: Literal["VALID", "SUSPECT", "INVALID"] = "VALID"
    raw: dict[str, Any] = Field(default_factory=dict)

    @model_validator(mode="after")
    def has_observation(self) -> "AgentMeasurementIn":
        for field_name in ("download", "upload", "ping", "jitter", "packet_loss", "availability"):
            value = getattr(self, field_name)
            if value is not None and not math.isfinite(value):
                raise ValueError(f"{field_name} must be finite")
        if self.connection_status == "OK" and all(
            value is None
            for value in (
                self.download,
                self.upload,
                self.ping,
                self.jitter,
                self.packet_loss,
                self.availability,
            )
        ):
            raise ValueError("an online measurement needs at least one metric")
        return self


class AgentBatchIn(StrictModel):
    measurements: list[AgentMeasurementIn] = Field(min_length=1, max_length=500)


class HeartbeatIn(StrictModel):
    agent_version: str = Field(default="0.1.0", max_length=64)
    seen_at: datetime | None = None


class DeviceRegisterIn(StrictModel):
    device_id: str = Field(min_length=1, max_length=128)
    monitoring_point_id: str = Field(min_length=1, max_length=128)
    agent_version: str = Field(default="0.1.0", max_length=64)


class OrganizationIn(StrictModel):
    id: str = Field(min_length=1, max_length=128)
    school_id: str = Field(min_length=1, max_length=128)
    name: str = Field(min_length=1, max_length=256)
    district: str = Field(min_length=1, max_length=256)
    address: str = Field(default="", max_length=512)
    latitude: float | None = None
    longitude: float | None = None
    contact_name: str = Field(default="", max_length=256)
    contact_phone: str = Field(default="", max_length=64)
    active: bool = True


class ProviderIn(StrictModel):
    id: str = Field(min_length=1, max_length=128)
    name: str = Field(min_length=1, max_length=256)
    support_contact: str = Field(default="", max_length=256)
    active: bool = True


class LineAdminIn(StrictModel):
    id: str = Field(min_length=1, max_length=128)
    organization_id: str = Field(min_length=1, max_length=128)
    provider_id: str | None = None
    role: Literal["PRIMARY", "RESERVE", "INACTIVE"] = "PRIMARY"
    technology: str = Field(default="", max_length=128)
    status: Literal["ACTIVE", "INACTIVE", "DELETED"] = "ACTIVE"


class MonitoringPointIn(StrictModel):
    id: str = Field(min_length=1, max_length=128)
    line_id: str = Field(min_length=1, max_length=128)
    location: str = Field(default="", max_length=512)
    is_primary: bool = False
    active: bool = True


class ScopeIn(StrictModel):
    scope_type: Literal["DISTRICT", "ORGANIZATION", "PROVIDER", "LINE"]
    scope_id: str = Field(min_length=1, max_length=256)


class UserAdminIn(StrictModel):
    id: str = Field(min_length=1, max_length=128)
    username: str = Field(min_length=1, max_length=128)
    role: Literal["ADMIN", "OBLAST", "DISTRICT", "PROVIDER", "SCHOOL"]
    password: str | None = Field(default=None, min_length=8, max_length=1024)
    disabled: bool = False
    scopes: list[ScopeIn] = Field(default_factory=list, max_length=100)


class ScheduleIn(StrictModel):
    tests_per_day: int = Field(default=4, ge=3, le=5)
    jitter_minutes: int = Field(default=8, ge=0, le=240)
    light_checks_between: bool = False


class IncidentEventIn(StrictModel):
    event_type: Literal[
        "provider_fixed",
        "send_to_provider",
        "assign",
        "comment",
        "status",
    ]
    note: str = Field(default="", max_length=4000)
    status: str | None = None


class ManualIncidentIn(StrictModel):
    line_id: str
    violation_type: str = Field(default="MANUAL_REVIEW", max_length=128)
    description: str = Field(default="", max_length=4000)
    assignee: str | None = None
    source: Literal["MANUAL"] = "MANUAL"


class ProviderDraftIn(StrictModel):
    comment: str = Field(default="", max_length=4000)


class ProviderSendIn(StrictModel):
    final_text: str | None = Field(default=None, max_length=12000)
    ticket_no: str | None = Field(default=None, max_length=128)
    reviewed: bool = False
    # Compatibility aliases used by the vanilla UI; the route still takes the
    # case ID from its path and does not trust incident_id for authorization.
    incident_id: int | None = None
    text: str | None = Field(default=None, max_length=12000)


class PolicyIn(StrictModel):
    scope_type: Literal["GLOBAL", "LINE"] = "GLOBAL"
    scope_id: str | None = None
    valid_from: datetime | None = None
    valid_to: datetime | None = None
    download_min: float = Field(default=20, ge=0)
    upload_min: float = Field(default=20, ge=0)
    ping_max: float = Field(default=100, ge=0)
    jitter_max: float = Field(default=30, ge=0)
    packet_loss_max: float = Field(default=2, ge=0, le=100)
    availability_min: float = Field(default=99, ge=0, le=100)
    confirm_count: int = Field(default=3, ge=1, le=100)
    confirm_minutes: int = Field(default=0, ge=0, le=10080)
    recovery_count: int = Field(default=3, ge=1, le=100)
    recovery_minutes: int = Field(default=0, ge=0, le=10080)
    freshness_seconds: int = Field(default=86400, ge=1, le=604800)


class ContractIn(StrictModel):
    line_id: str
    valid_from: datetime
    valid_to: datetime | None = None
    contract_no: str | None = None
    contract_date: datetime | None = None
    download_min: float | None = Field(default=None, ge=0)
    upload_min: float | None = Field(default=None, ge=0)
    ping_max: float | None = Field(default=None, ge=0)
    jitter_max: float | None = Field(default=None, ge=0)
    packet_loss_max: float | None = Field(default=None, ge=0, le=100)
    availability_min: float | None = Field(default=None, ge=0, le=100)


class DemoResetIn(StrictModel):
    seed_measurements: bool = False
