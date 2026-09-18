# Notification channel configuration

Email and Telegram use the existing PostgreSQL `notifications` outbox and
worker. A notification is persisted before delivery; delivery attempts and
retryability remain in the existing row. A channel failure never changes line,
incident, or situation truth.

Set `LINKWATCH_NOTIFICATION_TRANSPORT` to `email` or `telegram` (the `smtp`
and `tg` spellings are accepted). Every `LINKWATCH_*` setting has the matching
legacy `VKO_*` alias. Secrets are read only from the process environment or
secret manager injection; they are never returned by the API or logged.

Email (STARTTLS on port 587, or implicit TLS on port 465):

```text
LINKWATCH_NOTIFICATION_EMAIL_SMTP_HOST=smtp.example.org
LINKWATCH_NOTIFICATION_EMAIL_SMTP_PORT=587
LINKWATCH_NOTIFICATION_EMAIL_FROM=alerts@example.org
LINKWATCH_NOTIFICATION_EMAIL_TO=operations@example.org
LINKWATCH_NOTIFICATION_EMAIL_USERNAME=alerts@example.org   # optional
LINKWATCH_NOTIFICATION_EMAIL_PASSWORD=<secret>             # optional
```

Telegram requires a bot token and configured chat destination. For production,
the default Telegram API URL is HTTPS. `LINKWATCH_NOTIFICATION_TELEGRAM_URL`
is intended for an approved HTTPS gateway or test endpoint; insecure HTTP is
accepted only outside production when `LINKWATCH_ALLOW_INSECURE_WEBHOOK=1`.

```text
LINKWATCH_NOTIFICATION_TELEGRAM_BOT_TOKEN=<secret>
LINKWATCH_NOTIFICATION_TELEGRAM_CHAT_ID=<configured-chat-id>
```

`LINKWATCH_NOTIFICATION_RATE_LIMIT_MS` optionally inserts a bounded minimum
interval between sends per channel (0/unset disables the local limiter).
HTTP 429 and 5xx responses are retryable; malformed destinations and auth or
other 4xx responses are permanent failures. Retries reuse the stable
`linkwatch-notification-{id}` idempotency key where the channel supports it.
