# T019 provider delivery verification

## Local contract evidence

The existing `providers.SendProviderCase` webhook transport remains the single
delivery path. It sends JSON over HTTPS (HTTP is allowed only in non-production
tests when `LINKWATCH_ALLOW_INSECURE_WEBHOOK=1`) with:

- `Authorization: Bearer <LINKWATCH_PROVIDER_WEBHOOK_TOKEN>` when configured;
- stable `Idempotency-Key: linkwatch-provider-case-<case id>`;
- a bounded response body and a JSON-object response containing a provider
  reference (`ticket_no`, `ticket_number`, `external_ticket_no`, `message_id`
  or `id`).

Missing external reference is now a permanent delivery failure; LINKWATCH does
not fabricate a provider ticket for a webhook response that cannot be
reconciled. HTTP 401/403 are permanent failures, 429/5xx and transport
timeouts are retryable, and malformed JSON is rejected rather than treated as
success. Error messages do not include endpoint URLs, response bodies or
credential material.

The local mock integration suite covers authorization and idempotency headers,
external reference persistence at the transport boundary, 401/403 and 429/5xx
classification, timeout handling, duplicate idempotency keys, malformed/null
responses and secret/error non-leakage. The existing ProviderCase handler
continues to persist `DELIVERING`/attempt state before transport, persist
failure/retryability after transport failure, and require explicit human
review before send.

## External verification gate

The current environment has no `LINKWATCH_PROVIDER_TRANSPORT`,
`LINKWATCH_PROVIDER_WEBHOOK_URL`, `LINKWATCH_PROVIDER_WEBHOOK_TOKEN` or legacy
`VKO_*` provider transport variables, and the database contains no configured
HTTP provider contact. No unknown endpoint was probed and no production call
was made. Consequently, external authentication/signing, provider-side
deduplication, accepted-but-lost-response reconciliation, and durable
reference/history inspection against a real sandbox remain blocked.

To complete the live gate, deployment must provide an agreed provider sandbox
URL and credentials through the secret mechanism, set
`LINKWATCH_PROVIDER_TRANSPORT=webhook`, run the existing human-reviewed
ProviderCase send flow once, retry the same case, and inspect the persisted
`external_ticket_no`, delivery attempt/status fields and audit/history. The
secret values must not be committed or printed.
