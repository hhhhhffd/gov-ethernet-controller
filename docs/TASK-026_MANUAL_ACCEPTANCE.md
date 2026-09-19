# TASK-026 manual acceptance

Date: 2026-09-19 (Asia/Oral)

Status: **bounded documented runtime acceptance**. This is a documentation-only
closure of the current evidence. TASK-026 did not run a long subprocess or
rerun the acceptance harnesses; it records the latest verifier output without
changing product code or creating manual fixtures.

The statuses below are scoped to the evidence named in each row. `PASS` means
that the referenced artifact contains executed evidence; it is not inferred
from source code or from the existence of a test. `FAIL` is an executed
negative result. `BLOCKED_EXTERNAL` means the required native/external
environment or authorized endpoint was unavailable. `NOT RUN` means that no
executed evidence is recorded for that particular check.

## Exact acceptance rows

| Row | Status | Evidence / command | Boundary and unavailable checks |
|---|---|---|---|
| Agent | `PASS` automated/local evidence; `BLOCKED_EXTERNAL` native Windows gaps | `docs/P0_ACCEPTANCE_RUNBOOK.md`: `./scripts/smoke.sh` — PASS and `make agent-test` — PASS (29 tests). Latest verifier evidence: P2 clean `45 pass/0 fail/2 blockers`, P0 workaround `32 pass/0 fail/3 external skips`, and both `node --check web/app.js` and `node --check scripts/browser-e2e.mjs` exited `0`. `docs/TASK-024_P2_ACCEPTANCE.md`: Rust command/config/update regression — PASS (38 tests). | Bounded native Windows evidence covers SCM/runtime startup, service recovery, performance probe, local offline queue/resend, and config/token/queue preservation. Native reboot, clean install/uninstall/purge, tray diagnostics, and update-artifact activation remain `BLOCKED_EXTERNAL`; Linux, WSL, Docker, or Rust-test results are not treated as interactive native Windows PASS. |
| operational UI/browser live backend | `PASS` | `docs/TASK-017_BROWSER_ACCEPTANCE.md`: the recorded Playwright command against `http://127.0.0.1:8080` produced `BROWSER E2E BLOCKED: live browser surfaces PASS=23 FAIL=0 BLOCKED_EXTERNAL=4; demo=off`; the listed login, overview, map, line/device, history, incident, notifications, reports, exports, audit, admin, and error surfaces have live evidence. `docs/BROWSER_E2E_RUN.md` also records `BROWSER E2E PASS: admin/provider authenticated journeys`. | PASS is limited to the evidenced live surfaces. The four provider-related browser surfaces are not silently counted as PASS; they are covered by the provider gate row. No demo query or fabricated browser fixture was used. |
| incident/recovery/provider human gate | `PASS` bounded scripted incident/recovery/review evidence; `BLOCKED_EXTERNAL` authorized provider delivery | `docs/P0_ACCEPTANCE_RUNBOOK.md`: `scripts/p0-local-acceptance.sh` — PASS (12 local scenarios), including ingest/evaluation/incident, recovery, ProviderCase human-send gate. Latest verifier evidence from `scripts/task018-demo.sh`: `runs_passed=3/3 pass=84 fail=0 blocked_external=0`, exit `0`; all three runs used `MANUAL_FALLBACK` AI. `docs/TASK-021_PROVIDER_ACCEPTANCE.md`: local transport/retry/review tests PASS, but the authorized provider gate is `BLOCKED_EXTERNAL`. | The three-run result is bounded harness evidence: `MANUAL_FALLBACK` proves the explicit fallback and scripted human-review gate, not a live AI session or truly interactive manual acceptance. A configured authorized provider endpoint and credential remain required for external delivery; no provider PASS is inferred. |
| reporting formats | `PASS` for bounded TASK-018 and local/live report evidence | Latest verifier evidence from `scripts/task018-demo.sh` completed the quality-passport, CSV, and XLSX checks within all three runs. `docs/TASK-024_P2_ACCEPTANCE.md`, `docs/P0_ACCEPTANCE_RUNBOOK.md`, and `docs/BROWSER_E2E_RUN.md` also record report/export evidence, including parsed JSON and CSV/XLSX checks. | This is evidence that the scripted paths completed; it is not interactive manual export acceptance and does not bypass the remaining external gates. |
| role/scope isolation | `PASS` bounded executed evidence | `docs/P0_ACCEPTANCE_RUNBOOK.md` maps the API gate to `admin`, `provider-a`, `district`, and `school-42` role/scope checks. `docs/TASK-017_BROWSER_ACCEPTANCE.md` records provider `403` admin-boundary evidence. `docs/TASK-024_P2_ACCEPTANCE.md` records live `scope_enforced=true` provider workspace evidence and passing authorization regression tests. Latest verifier evidence records P1 `28 pass/0 fail`; both `node --check web/app.js` and `node --check scripts/browser-e2e.mjs` exited `0`. | P1 now has executed verifier evidence, but this bounded scripted result is not a substitute for native Windows, public TLS, authorized-provider, or other truly interactive external acceptance. |

## External and interactive gates not available here

- Native Windows: the bounded report covers SCM/runtime startup, service
  recovery, performance probing, local offline queue/resend, and preservation
  checks. Truly interactive gaps—production topology/HTTPS readiness, clean
  install, service/reboot recovery, uninstall/purge, tray IPC/diagnostics, and
  update activation—remain `BLOCKED_EXTERNAL` for the Agent acceptance row.
- Public DNS/ACME/TLS remains `BLOCKED_EXTERNAL` per
  `docs/TASK-020_TLS_ACME_ACCEPTANCE.md`; Linux Compose topology is not public
  TLS evidence.
- Authorized provider delivery remains `BLOCKED_EXTERNAL` per
  `docs/TASK-021_PROVIDER_ACCEPTANCE.md`: no authorized endpoint or credential
  was configured or probed. The latest TASK-018 verifier exercised ProviderCase
  population, the explicit human-review gate, and the `MANUAL_FALLBACK` path,
  but this does not establish provider-side delivery, external reference, or
  provider retry behavior as live PASS.
- Additional non-WEB notification delivery remains `BLOCKED_EXTERNAL` per
  `docs/TASK-023_NOTIFICATION_ACCEPTANCE.md`; local `httptest` outbox evidence
  is not an external-channel delivery.
- The latest P1 verifier recorded `28 pass/0 fail`; both `node --check
  web/app.js` and `node --check scripts/browser-e2e.mjs` exited `0`. This is
  bounded verifier evidence, not interactive manual acceptance.

This document closes TASK-026 as a bounded evidence record only. It does not
declare the repository's remaining native interactive, public-TLS,
authorized-provider, or non-WEB notification gates complete. The latest
TASK-018 `3/3` result is recorded as scripted bounded evidence, with
`MANUAL_FALLBACK` explicitly distinguished from live AI or truly interactive
manual acceptance.
