"""Bounded outbound adapters for provider cases and notifications.

The core workflow writes an immutable audit trail first and then asks one of
these adapters to deliver a message.  ``internal`` is an explicit staging
adapter that records the hand-off in the local database; production defaults
to ``webhook`` and fails closed when no endpoint is configured.
"""

from __future__ import annotations

import json
import os
import smtplib
from dataclasses import dataclass
from email.message import EmailMessage
from typing import Any, Protocol
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse
from urllib.request import Request, urlopen


class DeliveryError(RuntimeError):
    """A delivery attempt did not complete and may be retried."""

    def __init__(self, message: str, *, retryable: bool = True) -> None:
        super().__init__(message)
        self.retryable = retryable


@dataclass(frozen=True)
class DeliveryResult:
    channel: str
    external_id: str | None = None
    detail: str = ""


def _value(record: Any, key: str, default: Any = None) -> Any:
    if record is None:
        return default
    try:
        return record[key]
    except (KeyError, IndexError, TypeError):
        return getattr(record, key, default)


class ProviderTransport(Protocol):
    def send(self, case: Any, incident: Any, provider: Any | None) -> DeliveryResult: ...


class NotificationTransport(Protocol):
    def send(self, notification: Any) -> DeliveryResult: ...


def _endpoint_allowed(endpoint: str) -> bool:
    parsed = urlparse(endpoint)
    if parsed.scheme == "https" and parsed.netloc:
        return True
    # Local development may intentionally use an HTTP webhook. It is never
    # accepted in production unless the operator opts in explicitly.
    return parsed.scheme == "http" and bool(parsed.netloc) and os.getenv("VKO_ALLOW_INSECURE_WEBHOOK") == "1" and os.getenv("VKO_ENV", "development").lower() != "production"


def _post_json(
    endpoint: str,
    payload: dict[str, Any],
    *,
    token: str | None = None,
    idempotency_key: str | None = None,
    timeout: float = 10.0,
) -> tuple[int, dict[str, Any]]:
    if not _endpoint_allowed(endpoint):
        raise DeliveryError("webhook endpoint must use HTTPS")
    headers = {"Content-Type": "application/json", "Accept": "application/json", "User-Agent": "vko-linkwatch/1"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    if idempotency_key:
        headers["Idempotency-Key"] = idempotency_key
    request = Request(endpoint, data=json.dumps(payload, ensure_ascii=False).encode("utf-8"), method="POST", headers=headers)
    try:
        with urlopen(request, timeout=max(1.0, min(timeout, 30.0))) as response:
            raw = response.read(64 * 1024)
            status = int(response.status)
    except HTTPError as exc:
        retryable = exc.code == 429 or exc.code >= 500
        raise DeliveryError(f"webhook returned HTTP {exc.code}", retryable=retryable) from exc
    except (OSError, URLError, ValueError) as exc:
        raise DeliveryError(f"webhook request failed: {exc}") from exc
    if status < 200 or status >= 300:
        raise DeliveryError(f"webhook returned HTTP {status}", retryable=status >= 500)
    if not raw:
        return status, {}
    try:
        decoded = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        decoded = {}
    return status, decoded if isinstance(decoded, dict) else {}


class InternalProviderTransport:
    def send(self, case: Any, incident: Any, provider: Any | None) -> DeliveryResult:
        return DeliveryResult("INTERNAL", detail="recorded in VKO LINKWATCH")


class WebhookProviderTransport:
    def __init__(self, endpoint: str | None = None, *, token: str | None = None) -> None:
        self.endpoint = endpoint
        self.token = token

    def send(self, case: Any, incident: Any, provider: Any | None) -> DeliveryResult:
        provider_endpoint = _value(provider, "support_contact")
        endpoint = self.endpoint or (provider_endpoint if isinstance(provider_endpoint, str) and provider_endpoint.startswith(("http://", "https://")) else None)
        if not endpoint:
            raise DeliveryError("provider webhook endpoint is not configured")
        payload = {
            "event": "provider_case.created",
            "case": {"id": _value(case, "id"), "ticket_no": _value(case, "ticket_no"), "text": _value(case, "final_text") or _value(case, "draft_text"), "created_at": _value(case, "created_at")},
            "incident": {"id": _value(incident, "id"), "number": _value(incident, "number"), "line_id": _value(incident, "line_id"), "violation_type": _value(incident, "violation_type"), "started_at": _value(incident, "started_at"), "opening_snapshot": _value(incident, "opening_snapshot", {})},
            "provider": {"id": _value(provider, "id"), "name": _value(provider, "name")} if provider else None,
        }
        _, response = _post_json(
            endpoint,
            payload,
            token=self.token or os.getenv("VKO_PROVIDER_WEBHOOK_TOKEN"),
            idempotency_key=f"vko-provider-case-{_value(case, 'id')}",
        )
        external_id = response.get("ticket_no") or response.get("ticket_number") or response.get("id")
        return DeliveryResult("WEBHOOK", str(external_id) if external_id is not None else None, detail=endpoint)


class SmtpProviderTransport:
    def send(self, case: Any, incident: Any, provider: Any | None) -> DeliveryResult:
        recipient = _value(provider, "support_contact")
        host = os.getenv("VKO_SMTP_HOST")
        sender = os.getenv("VKO_SMTP_FROM")
        if not host or not sender or not recipient or "@" not in str(recipient):
            raise DeliveryError("SMTP provider delivery requires VKO_SMTP_HOST, VKO_SMTP_FROM and provider email")
        if os.getenv("VKO_ENV", "development").lower() == "production" and os.getenv("VKO_SMTP_STARTTLS", "1") != "1":
            raise DeliveryError("SMTP STARTTLS is required in production", retryable=False)
        message = EmailMessage()
        message["From"] = sender
        message["To"] = str(recipient)
        message["Subject"] = f"VKO LINKWATCH: обращение по линии {_value(incident, 'line_id', '—')}"
        message["Message-ID"] = f"<vko-provider-case-{_value(case, 'id', 'unknown')}@linkwatch.local>"
        message.set_content(_value(case, "final_text") or _value(case, "draft_text") or "")
        try:
            port = int(os.getenv("VKO_SMTP_PORT", "587"))
            with smtplib.SMTP(host, port, timeout=10) as smtp:
                if os.getenv("VKO_SMTP_STARTTLS", "1") != "0":
                    smtp.starttls()
                username = os.getenv("VKO_SMTP_USER")
                password = os.getenv("VKO_SMTP_PASSWORD")
                if username:
                    smtp.login(username, password or "")
                smtp.send_message(message)
        except (OSError, smtplib.SMTPException, ValueError) as exc:
            raise DeliveryError(f"SMTP delivery failed: {exc}") from exc
        return DeliveryResult("SMTP", detail=str(recipient))


class ConfiguredProviderTransport:
    def __init__(self) -> None:
        mode = os.getenv("VKO_PROVIDER_TRANSPORT", "webhook" if os.getenv("VKO_ENV", "development").lower() == "production" else "internal").strip().lower()
        if mode == "internal" and os.getenv("VKO_ENV", "development").lower() == "production":
            raise DeliveryError("internal provider transport is disabled in production", retryable=False)
        if mode == "webhook":
            self._transport: ProviderTransport = WebhookProviderTransport(os.getenv("VKO_PROVIDER_WEBHOOK_URL"))
        elif mode == "smtp":
            self._transport = SmtpProviderTransport()
        elif mode == "internal":
            self._transport = InternalProviderTransport()
        else:
            raise DeliveryError("VKO_PROVIDER_TRANSPORT must be internal, webhook or smtp", retryable=False)

    def send(self, case: Any, incident: Any, provider: Any | None) -> DeliveryResult:
        return self._transport.send(case, incident, provider)


def deliver_provider_case(case: Any, incident: Any, provider: Any | None = None) -> DeliveryResult:
    return ConfiguredProviderTransport().send(case, incident, provider)


class InternalNotificationTransport:
    def send(self, notification: Any) -> DeliveryResult:
        return DeliveryResult("WEB", detail="available in the VKO web inbox")


class WebhookNotificationTransport:
    def __init__(self, endpoint: str | None = None, *, token: str | None = None) -> None:
        self.endpoint = endpoint or os.getenv("VKO_NOTIFICATION_WEBHOOK_URL")
        self.token = token or os.getenv("VKO_NOTIFICATION_WEBHOOK_TOKEN")

    def send(self, notification: Any) -> DeliveryResult:
        if not self.endpoint:
            raise DeliveryError("notification webhook endpoint is not configured")
        _, response = _post_json(
            self.endpoint,
            {"event": "notification.created", "notification": dict(notification)},
            token=self.token,
            idempotency_key=f"vko-notification-{_value(notification, 'id')}",
        )
        external_id = response.get("id") or response.get("message_id")
        return DeliveryResult("WEBHOOK", str(external_id) if external_id is not None else None, detail=self.endpoint)


class ConfiguredNotificationTransport:
    def __init__(self) -> None:
        mode = os.getenv("VKO_NOTIFICATION_TRANSPORT", "webhook" if os.getenv("VKO_ENV", "development").lower() == "production" else "internal").strip().lower()
        if mode in {"internal", "web"} and os.getenv("VKO_ENV", "development").lower() == "production":
            raise DeliveryError("internal notification transport is disabled in production", retryable=False)
        if mode == "webhook":
            self._transport: NotificationTransport = WebhookNotificationTransport()
        elif mode in {"internal", "web"}:
            self._transport = InternalNotificationTransport()
        else:
            raise DeliveryError("VKO_NOTIFICATION_TRANSPORT must be internal or webhook", retryable=False)

    def send(self, notification: Any) -> DeliveryResult:
        return self._transport.send(notification)


def deliver_notification(notification: Any) -> DeliveryResult:
    return ConfiguredNotificationTransport().send(notification)
