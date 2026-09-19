# TASK-016 AI ProviderCase draft and human gate acceptance

Run date: 2026-09-19 (Asia/Oral)

Overall status: `BLOCKED_EXTERNAL`

The local Ollama/model happy path was not claimed. No Ollama binary or process
was available, and both loopback probes failed:

```text
command -v ollama
# no output

curl --silent --show-error --max-time 4 http://127.0.0.1:11434/api/tags
curl: (7) Failed to connect to 127.0.0.1 port 11434 after 0 ms: Could not connect to server

curl --silent --show-error --max-time 4 http://localhost:11434/api/tags
curl: (7) Failed to connect to localhost port 11434 after 0 ms: Could not connect to server
```

No fake AI response was inserted and no `SUCCEEDED` AI generation was inferred.

## Owned implementation

- Incident-rooted ProviderCases now persist the canonical incident
  `evidence_measurement_ids`, so the provider workspace and AI path retain the
  same historical evidence chain.
- AI input redacts credential-like values in policy/contract/observation JSON
  and operator free text before any generator sees it. Technical values that
  are not sensitive remain in the prompt.
- The existing local Ollama adapter still accepts only loopback HTTP and
  persists failed generation metadata without changing the ProviderCase.
- The acceptance test uses `measurements.Service.Process` for three real
  PostgreSQL observations, creates the incident and ProviderCase through the
  API, and uses only an `httptest` provider transport for the permitted local
  send check.

## Runtime evidence

Command:

```bash
cd server
LINKWATCH_TEST_DATABASE_URL='postgres://linkwatch:linkwatch-dev-password@127.0.0.1:5432/linkwatch?sslmode=disable' \
  GOPATH=/tmp/linkwatch-gopath GOCACHE=/tmp/linkwatch-go-cache \
  go test ./internal/api \
    -run 'TestProviderAIFailSafeManualFallbackThroughIncidentServicePath' \
    -count=1 -v
```

Observed result from the live Compose PostgreSQL database:

```text
service path created incident=237 evidence_measurement_ids=[829 828 827] canonical_violation=BASELINE_UPLOAD
manual fallback ProviderCase id=201 status=DRAFT draft_bytes=5354
real Ollama adapter outage status=502 persisted generation_status=FAILED failure_category=transport evidence_digest_present=true
human gate status=409 transport_calls=0 persisted_state=DRAFT/PENDING
reviewed manual send status=200 transport_calls=1 persisted_state=SENT/SENT attempts=1 edited_text=true
PASS
```

The test also asserted that:

- the three measurements were accepted by the production `measurements.Service`
  and the incident was `BASELINE_UPLOAD`;
- evidence IDs remained linked in the API detail and PostgreSQL after send;
- the fallback was an editable `DRAFT`, and the final text was changed before
  send;
- the failed Ollama generation stored `FAILED/transport` and an evidence
  digest, while leaving the case `DRAFT/PENDING`;
- `reviewed=false` returned `409` and made zero provider calls;
- `reviewed=true` sent exactly once through the test webhook and persisted
  `SENT/SENT`, one attempt, and the reviewed audit record;
- the canonical incident violation and opening evidence snapshot were unchanged
  by AI/manual provider workflow;
- cleanup left zero `task016-ai-*` organizations, providers, lines, devices, or
  users in PostgreSQL.

The prompt redaction regression is covered by
`TestProviderDraftPromptRedactsCredentialValues`; it passed in the targeted
API test run. It checks credential values in structured snapshots and operator
text without removing non-sensitive technical facts.

Repository regression completed for this provider/runtime change:

```text
make server-test       PASS (all Go packages)
make agent-test        PASS (38/38; existing unused-field warning only)
./scripts/smoke.sh     PASS (LINKWATCH E2E smoke)
go test ./internal/providers -count=1  PASS
```

## Exact acceptance rows

| Row | Status | Evidence / limitation |
| --- | --- | --- |
| Real local Ollama/model generation and persisted `SUCCEEDED` draft | `BLOCKED_EXTERNAL` | No local Ollama binary/process or `/api/tags` endpoint was available; no AI output was fabricated. |
| Production DB/service incident and evidence chain | `PASS` | Three `measurements.Service.Process` observations produced incident `237`, canonical `BASELINE_UPLOAD`, and IDs `[829, 828, 827]` in the run above. |
| Editable draft/manual fallback | `PASS` | ProviderCase `201` was `DRAFT`; deterministic fallback was redacted and a different operator final text was accepted. |
| Failed-generation persistence | `PASS` | Real Ollama adapter returned HTTP `502`; PostgreSQL recorded `FAILED`, category `transport`, and a non-empty evidence digest. |
| Human review gate | `PASS` | `reviewed=false` returned `409`, made zero transport calls, and preserved `DRAFT/PENDING`. |
| Explicit reviewed send with local test transport | `PASS` | `reviewed=true` returned `200`; one call, edited text, external reference, `SENT/SENT`, and one attempt were persisted. |
| Authorized external provider endpoint | `BLOCKED_EXTERNAL` | No authorized external webhook URL/credential was configured or probed; local `httptest` evidence is not external-provider acceptance. |

The two `BLOCKED_EXTERNAL` rows remain blockers for the real AI/external
acceptance claims. The local fail-safe, redaction, manual edit, review gate,
evidence linkage, and test-transport send claims are backed by the runtime test
above and do not depend on fake AI output.
