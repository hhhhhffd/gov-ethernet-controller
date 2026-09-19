# TASK-021 authorized provider integration acceptance

Run date: 2026-09-19 (Asia/Oral)

Status: `BLOCKED_EXTERNAL` (`EXT-003`)

The authorized external provider portion is not available in this environment.
No provider endpoint or credential was invented or probed.

## Current transport and persistence inventory

- `server/internal/providers/delivery.go` is the single ProviderCase webhook
  transport. It sends a bearer token from `LINKWATCH_PROVIDER_WEBHOOK_TOKEN`
  (or the legacy `VKO_*` alias) and the stable
  `linkwatch-provider-case-<case id>` `Idempotency-Key`.
- `server/internal/api/incident_handlers.go` claims a case atomically by
  changing `PENDING|FAILED` to `DELIVERING` and incrementing
  `delivery_attempts` before calling the transport.
- Transport failures are persisted to PostgreSQL as `FAILED` with
  `delivery_error`, `delivery_retryable`, and retry `next_attempt_at` before
  the HTTP error is returned. Retryable attempts use bounded exponential
  backoff; permanent failures do not get a retry timestamp.
- Success persists `SENT`, `delivery_channel`, `external_ticket_no`, and
  clears retry metadata. A repeated send of an already sent case returns the
  persisted state without another transport call.
- The human review gate returns `409` before the transport when
  `reviewed=false`.

## Existing acceptance entry points

- `scripts/p0-acceptance.sh` is a read-only API gate. It does not send a
  ProviderCase; its provider row is an explicit `SKIP` unless deployment
  supplies an authorized test webhook.
- `scripts/p0-local-acceptance.sh` covers the local incident/ProviderCase
  fixture and the human review gate, but deliberately does not use a live
  provider transport.
- `docs/T019_PROVIDER_DELIVERY.md` is the existing transport contract and
  external-gate note. This artifact records the TASK-021 run against the
  current code and keeps the external result separate from local evidence.

## Deterministic local evidence

The following checks use only loopback `httptest` transports and the local
PostgreSQL Compose database; they do not represent provider-side acceptance.

| Coverage | Evidence | Result |
| --- | --- | --- |
| Auth token, idempotency key, external reference | `TestSendProviderCaseSetsAuthIdempotencyAndPersistsReference` | PASS |
| 401/403 permanent classification; 429/5xx retryable classification | `TestPostJSONClassifiesAuthAndTransientResponses` | PASS |
| Canceled/timeout transport is retryable and endpoint/secret-safe | `TestPostJSONTimeoutIsRetryableAndDoesNotLeakEndpoint` | PASS |
| Malformed and `null` success bodies are rejected | `TestPostJSONRejectsMalformedSuccessfulResponse`, `TestPostJSONRejectsNullSuccessfulResponse` | PASS |
| Duplicate attempts carry one stable idempotency key | `TestPostJSONDuplicateAttemptsCarrySameIdempotencyKey` | PASS |
| Accepted request with lost response can be retried with the same key and reconciled by a deterministic mock | `TestPostJSONReusesIdempotencyKeyAfterAcceptedResponseLoss` | PASS |
| Human review gate, failure persistence, retry/backoff, success/reference persistence, no duplicate sent call, secret redaction | `TestProviderWorkspaceHTTPStateEvidenceAndRedaction` | PASS |
| Permanent 401 failure is persisted as non-retryable without a backoff timestamp | `TestProviderCasePermanentFailurePersistsWithoutRetry` | PASS |
| Concurrent send claim and retry after failure; at most one external call per claimed attempt | `TestProviderCaseConcurrentSendClaimsSingleExternalDelivery`, `TestProviderCaseConcurrentFailureKeepsRetryAvailable` | PASS |

Commands and results:

```text
GOPATH=/tmp/linkwatch-gopath GOCACHE=/tmp/linkwatch-go-cache go test ./internal/providers -count=1
ok   linkwatch/server/internal/providers

# LINKWATCH_TEST_DATABASE_URL is set to the local Compose PostgreSQL DSN at runtime;
# its value is intentionally omitted from the evidence artifact.
GOPATH=/tmp/linkwatch-gopath GOCACHE=/tmp/linkwatch-go-cache \
  go test ./internal/api -run 'TestProviderCaseWorkspaceDetailTimeline|TestProviderWorkspaceHTTPStateEvidenceAndRedaction|TestProviderCasePermanentFailurePersistsWithoutRetry|TestProviderCaseConcurrent' -count=1
ok   linkwatch/server/internal/api
```

The broad `scripts/p0-acceptance.sh` run was not used as TASK-021 proof: it
reported the expected provider external `SKIP` and also an unrelated
`authenticated organizations` HTTP 500 in the current runtime. No provider
claim is inferred from that broader result.

## External gate

`LINKWATCH_PROVIDER_TRANSPORT`, `LINKWATCH_PROVIDER_WEBHOOK_URL`, and
`LINKWATCH_PROVIDER_WEBHOOK_TOKEN` were unset in the running Compose service.
The database provider contacts were `support@provider-a.example` and
`support@provider-b.example`, not HTTP endpoints. Therefore the following
items are `BLOCKED_EXTERNAL`, not local PASS claims:

- authentication/signing against an authorized provider sandbox;
- provider-side idempotency/deduplication and returned external reference;
- real successful ProviderCase send and persisted reference inspection;
- real timeout/accepted-but-lost-response reconciliation;
- real provider 401/403/429/5xx behavior and retry-after semantics;
- live provider audit/history confirmation.

To close this gate, deployment must supply an explicitly authorized sandbox
URL and credentials through the secret mechanism, set
`LINKWATCH_PROVIDER_TRANSPORT=webhook`, perform the existing human-reviewed
send and same-case retry, and inspect PostgreSQL `external_ticket_no`, attempt
state, and audit/history. Secret values must not be printed or committed.
