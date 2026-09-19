# TASK-023 external notification channel acceptance

## Result

`BLOCKED_EXTERNAL`

The existing `WEBHOOK` notification channel was selected because it is already
implemented and is a non-`WEB` channel. No Telegram channel, endpoint, token,
or other credentials were added or invented.

## Local deterministic evidence

`server/internal/measurements/notification_outbox_acceptance_test.go` exercises
the real PostgreSQL outbox claim/finish path against a local `httptest` server:

- successful `WEBHOOK` delivery persists `SENT`, `delivery_channel=WEBHOOK`,
  `delivery_attempts=1`, and non-null `sent_at`;
- a `502` is persisted as `FAILED`, retryable, with `next_attempt_at`, and the
  next eligible attempt succeeds with the same idempotency key;
- a `401` is persisted as `FAILED`, non-retryable, with no retry schedule;
- transport response bodies, endpoint URLs, and configured bearer tokens are
  absent from persisted delivery errors.

Run the focused acceptance test with the repository's PostgreSQL test database:

```text
GOCACHE=/tmp/linkwatch-go-cache GOPATH=/tmp/linkwatch-gopath \
  LINKWATCH_TEST_DATABASE_URL="${LINKWATCH_TEST_DATABASE_URL:?set a local PostgreSQL test DSN}" \
  go test ./internal/measurements -run '^TestNotificationOutboxAcceptance$' -count=1
```

Verification completed on 2026-09-19:

- focused acceptance test: `PASS`;
- focused acceptance test with `-race`: `PASS`;
- full `./internal/measurements` package with the PostgreSQL test database:
  `PASS`;
- existing `./internal/providers` package: `PASS`;
- post-test database cleanup: `0` rows with `source_type='TASK-023'`.

## External gate

No real delivery was attempted because no authorized non-`WEB` endpoint is
configured in the current environment:

- the host environment has no notification transport, webhook URL, webhook
  token, SMTP destination, or Telegram destination variables;
- the running development server has no notification transport configuration;
- the running production-shaped `linkwatch-task020` server has
  `LINKWATCH_NOTIFICATION_TRANSPORT=webhook`, but its
  `LINKWATCH_NOTIFICATION_WEBHOOK_URL` and
  `LINKWATCH_NOTIFICATION_WEBHOOK_TOKEN` are empty.

Without an agreed endpoint and credentials, a live request would require
guessing an external target and would violate the acceptance gate. Therefore
the local durable outbox/retry/permanent-failure checks are complete, while the
required real external delivery remains `BLOCKED_EXTERNAL`.
