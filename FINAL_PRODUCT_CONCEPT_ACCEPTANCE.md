# Final Product Concept Acceptance

Date: 2026-09-19 (Asia/Oral)

## Decision

`TASK-027`: **PASS** for bounded acceptance and traceability closure.

This is a bounded evidence decision, not an assertion of full production
release acceptance. The product concept is supported by the recorded local
runtime, regression, browser, build, and deterministic demo evidence. The
remaining native and external gates are explicitly retained as
`BLOCKED_EXTERNAL`; no interactive or native `PASS` is inferred from Linux,
WSL, Docker, source inspection, or local test transports.

The plan attachment was not present as a file in this checkout. The matrix
therefore uses the current acceptance documents, the recorded verifier output,
the requested commit set, and the repository's explicit invariants. An item
without current executable evidence is not promoted to `PASS`.

## Evidence ledger

| Evidence | Recorded result | Traceability use |
|---|---|---|
| `d27eced` | Persisted incident duration is positive and matches `started_at` → `closed_at` | BUG-001, incident lifecycle, hackathon minimum |
| `6ae95f4` | Demo reset clears dependent draft-generation rows before provider cases | BUG-002, TASK-018 reset path |
| `acf9869` | Demo seed creates effective line-context versions | BUG-003, TASK-018 historical context |
| `4c4d971` | Incident evidence shape and observation IDs are validated | BUG-004, evidence chain |
| `f4e85a2` | Recovery state survives contract lifecycle and provider-sent recovery can reopen | BUG-005, recovery invariant |
| `7baa013` | Evidence reports declare historical-only output | BUG-006, P1/P2 reporting |
| `61adaac` | TASK-026 records bounded current evidence and external boundaries | TASK-026, TASK-027 decision |
| TASK-018 verifier record | `runs_passed=3/3`, `pass=84`, `fail=0`, `blocked_external=0`, exit `0`; all runs used explicit `MANUAL_FALLBACK` | TASK-018 and hackathon minimum |
| P0 workaround verifier | `32/0/3` = PASS/FAIL/BLOCKED_EXTERNAL; local fixture `13/13` | P0 release traceability |
| P1 verifier | `28/0` = PASS/FAIL | P1 traceability |
| P2 verifier | `45/0/2` = PASS/FAIL/BLOCKED_EXTERNAL | P2 traceability |
| Recorded server checks | `make server-test` PASS; all Go packages recorded as passing | Server/runtime regression |
| Recorded agent checks | `make agent-test` PASS (39/39 tests); TASK-024 Rust command/config/update regression PASS (38 tests) | Agent/runtime regression |
| Recorded E2E/build checks | `./scripts/smoke.sh` PASS; server build PASS; Windows artifact build is present; `node --check web/app.js` and `node --check scripts/browser-e2e.mjs` exit `0` | Runtime, build, and frontend syntax |
| Browser verifier | `PASS=23`, `FAIL=0`, `BLOCKED_EXTERNAL=4`, demo off | Live local browser surfaces; provider rows remain external |

The historical pre-fix text in `docs/TASK-018_DEMO_ACCEPTANCE.md` records the
earlier reset failure (`0/3`). It is not used to override the later verifier
record above: the reset and evidence defects are addressed by the supplied
commit chain. The current TASK-018 result remains bounded scripted evidence;
`MANUAL_FALLBACK` is not live AI or interactive manual acceptance.

## Traceability matrix: TASK-001..027

| ID | Scope / acceptance claim | Status | Verified evidence | Exact boundary or remaining note |
|---|---|---|---|---|
| TASK-001 | Go server, PostgreSQL source of truth, Rust native agent, static web runtime | PASS | `README.md`, `docs/PRODUCTION_RUN_REPORT.md`, recorded server/agent/smoke checks | Runtime architecture is locally evidenced; deployment environment remains outside this checkout. |
| TASK-002 | Stable agent CLI (`run`, `once`, `probe`, `version`), network/demo probe boundary, filesystem spool | PASS | `README.md`, recorded `make agent-test`, `./scripts/smoke.sh` | Native Windows execution is tracked separately under TASK-022. |
| TASK-003 | Agent→ingest path, batch idempotency, heartbeat, config aliases | PASS | Smoke evidence and recorded server/agent regression; `VKO_*` aliases retained in runtime contract | No external deployment claim is made. |
| TASK-004 | Effective policy/contract evaluation, line state, confirmation and recovery lifecycle | PASS | P0 local verifier `13/13`; `d27eced`, `f4e85a2`; recorded server tests | Evidence is bounded to the recorded local runtime and tests. |
| TASK-005 | Historical snapshots, backfill evidence, NO_DATA/completeness and period semantics | PASS | P1 `28/0`; P2 `45/0/2`; `7baa013`; P1/P2 acceptance docs | Historical behavior is evidenced; external deployment is not implied. |
| TASK-006 | Authentication, role×scope isolation, API aliases and web field contract | PASS | P0 `32/0/3`; P1 `28/0`; browser live alias and authorization evidence | Provider-related browser rows remain separately bounded. |
| TASK-007 | Production-like startup/readiness and public topology boundary | BLOCKED_EXTERNAL | Production topology/config validation is recorded PASS; native/public readiness evidence is absent | Native Windows production startup, DNS/TLS and public HTTPS readiness require the external environment. |
| TASK-008 | Windows service, tray, install/uninstall, queue/config preservation and restart behavior | BLOCKED_EXTERNAL | Linux/recorded build and bounded documentation only | Native reboot, clean install/uninstall/purge, tray diagnostics, and update activation have no authoritative native proof. |
| TASK-009 | Server-scoped notification center and durable WEB outbox workflow | PASS | P0/P2 local outbox evidence; notification acceptance tests record persistence, retry, permanent-failure and redaction paths | This PASS is for the bounded local/WEB workflow, not an external channel delivery. |
| TASK-010 | ProviderCase transport state machine, human review gate and retry persistence | PASS | TASK-016/TASK-021 local `httptest` and PostgreSQL regression rows; P0 local human-send gate | Local transport evidence does not establish an authorized provider PASS; see TASK-019/021. |
| TASK-011 | Reports, quality passport, CSV/XLSX and export consistency | PASS | TASK-018 `3/3` completed passport/CSV/XLSX checks; P0/P2/browser report evidence | Scripted report evidence is not interactive manual export acceptance. |
| TASK-012 | Operational web dashboard, line/device/history/incident/report/admin surfaces | PASS | Browser verifier `23/0/4`; `node --check` checks; P0/P1 live surface evidence | Four provider workflow surfaces are intentionally not counted here as PASS. |
| TASK-013 | Admin catalog, policy/contract governance and device administration | PASS | P0/P1 authorization and admin matrix evidence; recorded server tests | No unrecorded manual administration claim is made. |
| TASK-014 | Role/scope administrative matrix and mutation conflict semantics | PASS | P0 role matrix, provider `403`, stale/concurrent `409` evidence; TASK-014 matrix test history | Bounded API evidence only. |
| TASK-015 | Audit, evidence chain, immutable historical projection and report provenance | PASS | P1/P2 evidence tests; `4c4d971`; `7baa013`; recorded browser/audit evidence | No source-only PASS is used; rows refer to executed checks recorded in acceptance docs. |
| TASK-016 | AI ProviderCase draft, redaction, failed generation persistence and reviewed send | BLOCKED_EXTERNAL | Local fail-safe/manual fallback, redaction, review gate and test transport PASS; live Ollama and authorized provider unavailable | No live model `SUCCEEDED` draft or authorized external delivery is claimed. |
| TASK-017 | Authenticated browser acceptance against live backend | PASS | Browser verifier recorded `PASS=23`, `FAIL=0`, `BLOCKED_EXTERNAL=4`, demo off | ProviderCase, AI draft, human review and provider send remain `BLOCKED_EXTERNAL`, not hidden as PASS. |
| TASK-018 | Deterministic three-run hackathon demo minimum | PASS | `3/3`, `84/0/0`, exit `0`; explicit `MANUAL_FALLBACK`; fixes in `d27eced`, `6ae95f4`, `acf9869`, `4c4d971`, `f4e85a2` | Bounded scripted completion only; no live AI, native Windows, or interactive manual PASS is inferred. |
| TASK-019 | Authorized provider integration, external reference and provider-side retry/reconciliation | BLOCKED_EXTERNAL | Local provider transport tests PASS; no authorized endpoint or credentials configured | Real provider auth/signing, delivery, external reference, retry and audit confirmation remain unavailable. |
| TASK-020 | Public DNS, ACME issuance, HTTPS redirect, protected endpoint and restart persistence | BLOCKED_EXTERNAL | Local Caddy/config/localhost checks PASS; public probe could not resolve the placeholder host | Public ACME certificate and public HTTPS evidence are absent. |
| TASK-021 | Authorized provider acceptance gate | BLOCKED_EXTERNAL | `docs/TASK-021_PROVIDER_ACCEPTANCE.md`; local loopback transport rows PASS | No authorized sandbox URL/token was configured or probed. |
| TASK-022 | Native Windows acceptance | BLOCKED_EXTERNAL | Bounded documentation covers selected SCM/runtime, local queue/resend and preservation checks | Native Windows topology, reboot, clean install/uninstall/purge, tray and update activation proof remains absent. |
| TASK-023 | External non-WEB notification channel acceptance | BLOCKED_EXTERNAL | Local WEB outbox success/retry/permanent-failure/redaction tests PASS | No authorized non-WEB endpoint or credentials; no external delivery was attempted. |
| TASK-024 | P2 situation, evidence, config, export, provider workspace and agent update gate | BLOCKED_EXTERNAL | P2 `45/0/2`; all non-external rows PASS in the acceptance record | The two remaining rows are native post-restart `AGENT_UPDATE` and external non-WEB notification delivery. |
| TASK-025 | Plan-defined acceptance aggregate and current checkout acceptance evidence | BLOCKED_EXTERNAL | Exact aggregate after the workaround completed with no internal failures: P0 `32/0/3`, P1 `28/0`, P2 `45/0/2`; server build workaround PASS; both node checks exit `0`; this matrix and the verifier ledger provide the current evidence | Remaining `BLOCKED_EXTERNAL` results are environment-boundary skips (native Windows, public TLS/ACME, authorized provider/non-WEB delivery, and any unavailable plan attachment), not internal test failures. |
| TASK-026 | Bounded manual/runtime evidence closure | BLOCKED_EXTERNAL | `docs/TASK-026_MANUAL_ACCEPTANCE.md`; P0/P1/P2/TASK-018 records | Bounded scripted rows pass, but native Windows, public TLS, authorized provider and non-WEB gates remain external. |
| TASK-027 | Final product concept acceptance and complete traceability matrix | PASS | This matrix; requested commit set; recorded verifier ledger; all rows and blockers enumerated | Closure is bounded. Full production release remains gated by the `BLOCKED_EXTERNAL` rows above. |

## Traceability matrix: BUG-001..006

| ID | Defect / acceptance claim | Status | Evidence | Exact note |
|---|---|---|---|---|
| BUG-001 | Closed incident duration is persisted as a positive `started_at`→`closed_at` value | PASS | `d27eced`; lifecycle integration assertion; P0/TASK-018 evidence | No negative/zero duration is accepted by the recorded regression. |
| BUG-002 | Demo reset removes dependent provider draft generations before provider cases | PASS | `6ae95f4`; reset integration test; TASK-018 `3/3` verifier result | The prior FK reset failure is covered by the fix and current bounded result. |
| BUG-003 | Demo lines have effective line-context versions for historical resolution | PASS | `acf9869`; reset/seed integration test | Historical context resolution is asserted for the seeded demo line. |
| BUG-004 | Incident evidence chain exposes available status, confirmation and observation IDs | PASS | `4c4d971`; evidence-chain tests; TASK-018 verifier | Evidence shape is validated rather than accepted from a non-empty response alone. |
| BUG-005 | Recovery state survives contract lifecycle and a returning violation reopens a provider-sent incident | PASS | `f4e85a2`; measurement integration tests | Recovery remains observed/confirmed only from qualifying evidence. |
| BUG-006 | Evidence report is explicitly historical-only | PASS | `7baa013`; report regression test; P1/P2 report checks | Current configuration is not presented as historical evidence. |

## Release-profile traceability

| Profile | Status | Recorded evidence | Boundary |
|---|---|---|---|
| P0 workaround | BLOCKED_EXTERNAL | `32/0/3` PASS/FAIL/BLOCKED_EXTERNAL; local fixture `13/13` | Three external skips remain: native Windows remainder, public TLS/ACME, authorized provider. |
| P1 | PASS | `28/0`; frontend syntax checks exit `0`; P1 historical/authorization evidence | Bounded verifier result, not external deployment acceptance. |
| P2 | BLOCKED_EXTERNAL | `45/0/2`; no failed checks | Native post-restart update and external non-WEB notification remain unavailable. |
| Hackathon minimum | PASS | TASK-018 `3/3`, `84/0/0`, exit `0` | All runs used explicit `MANUAL_FALLBACK`; no live AI or interactive manual PASS is claimed. |
| Server regression | PASS | Recorded `make server-test` and all-Go-package PASS | Not rerun for this documentation-only closure. |
| Agent regression | PASS | Recorded `make agent-test` PASS (39/39); TASK-024 Rust regression PASS (38) | Not rerun for this documentation-only closure. |
| Smoke | PASS | Recorded `./scripts/smoke.sh` PASS | Not rerun; no long suite launched for TASK-027. |
| Build | PASS | Recorded server build PASS and checked-in Windows artifact build evidence | Artifact execution on native Windows remains `BLOCKED_EXTERNAL`. |
| Node checks | PASS | `node --check web/app.js` and `node --check scripts/browser-e2e.mjs` exit `0` | Syntax checks do not replace interactive browser or native acceptance. |

## Global invariants

| Invariant | Status | Evidence / traceability | Exact boundary |
|---|---|---|---|
| PostgreSQL is the production source of truth; no SQLite/in-memory production path | PASS | README, migrations, recorded Compose/server/smoke evidence | Local runtime evidence; deployment operations remain external. |
| Every observation carries `client_event_id`; ingest is idempotent per device/event | PASS | README, smoke and P0 local acceptance | Bounded runtime proof. |
| Effective policy and contract snapshots are stored with each evaluation | PASS | README, evaluation regression and P1/P2 evidence | No historical snapshot claim is made without the recorded evidence path. |
| Backfill is evidence only and cannot rewrite current line state | PASS | P1/P2 historical tests and report provenance checks | Source-of-truth behavior is locally/regression verified. |
| Incidents close only after confirmed recovery evidence | PASS | `f4e85a2`, lifecycle integration, TASK-018 and P0 evidence | Native/external deployment is not part of this invariant proof. |
| Provider and notification attempts/failures/retryability persist before error return | PASS | TASK-021/TASK-023 local PostgreSQL and loopback transport tests | External provider/channel delivery remains `BLOCKED_EXTERNAL`. |
| `/api` and `/api/v1` aliases and existing `web/` field contract remain intact | PASS | Browser alias probes, P0/P1/browser evidence, node checks | Bounded local backend only. |
| Schema changes are additive and versioned under embedded migrations | PASS | Migration inventory and recorded server tests | No new migration was made by TASK-027. |
| Production boundary is Go + PostgreSQL with no Python runtime addition | PASS | Dockerfile, production report and repository rules | No production deployment is claimed. |
| Secrets are supplied through environment/secret mechanisms and are not committed | PASS | README, acceptance docs, clean-tree check; no credential evidence in matrix | External secret provisioning is still required for provider/TLS gates. |
| Generated server binary is not retained in the worktree | PASS | Addressable removal of untracked `server/linkwatch-server` before commit | The tracked Windows release artifact remains only at `dist/linkwatch-agent-windows-amd64.exe`. |

## Remaining blockers

The bounded decision does not close these external gates:

1. Native Windows proof for production topology/HTTPS readiness, reboot,
   clean install/uninstall/purge, tray diagnostics, and update activation.
2. Public DNS/ACME/TLS issuance, redirect, protected endpoint, and restart
   persistence on an approved hostname.
3. Authorized provider sandbox delivery, authentication/signing, external
   reference, retry/reconciliation, and provider-side audit confirmation.
4. Authorized non-WEB notification delivery.
5. Live local Ollama/model `SUCCEEDED` draft evidence, if required by the full
   AI acceptance rather than the bounded fallback path.
No long suite was run for this closure. The only worktree mutation is this
matrix plus removal of the untracked generated `server/linkwatch-server`.
