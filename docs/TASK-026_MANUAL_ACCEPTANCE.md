# TASK-026 manual acceptance

Date: 2026-09-19 (Asia/Oral)

Status: **bounded documented runtime acceptance**. This is a documentation-only
closure of the current evidence. TASK-026 did not run a long subprocess, rerun
the acceptance harnesses, change product code, or create manual fixtures.

The statuses below are scoped to the evidence named in each row. `PASS` means
that the referenced artifact contains executed evidence; it is not inferred
from source code or from the existence of a test. `FAIL` is an executed
negative result. `BLOCKED_EXTERNAL` means the required native/external
environment or authorized endpoint was unavailable. `NOT RUN` means that no
executed evidence is recorded for that particular check.

## Exact acceptance rows

| Row | Status | Evidence / command | Boundary and unavailable checks |
|---|---|---|---|
| Agent | `PASS` automated local evidence; `BLOCKED_EXTERNAL` native Windows | `docs/P0_ACCEPTANCE_RUNBOOK.md`: `./scripts/smoke.sh` — PASS and `make agent-test` — PASS (29 tests). `docs/TASK-024_P2_ACCEPTANCE.md`: Rust command/config/update regression — PASS (38 tests). | `docs/TASK-022_WINDOWS_ACCEPTANCE.md` records native Windows as `NOT RUN`; no Linux, WSL, Docker, or Rust-test result is treated as native Windows PASS. Native install/reboot/uninstall/purge/tray/update activation remains `BLOCKED_EXTERNAL`. |
| operational UI/browser live backend | `PASS` | `docs/TASK-017_BROWSER_ACCEPTANCE.md`: the recorded Playwright command against `http://127.0.0.1:8080` produced `BROWSER E2E BLOCKED: live browser surfaces PASS=23 FAIL=0 BLOCKED_EXTERNAL=4; demo=off`; the listed login, overview, map, line/device, history, incident, notifications, reports, exports, audit, admin, and error surfaces have live evidence. `docs/BROWSER_E2E_RUN.md` also records `BROWSER E2E PASS: admin/provider authenticated journeys`. | PASS is limited to the evidenced live surfaces. The four provider-related browser surfaces are not silently counted as PASS; they are covered by the provider gate row. No demo query or fabricated browser fixture was used. |
| incident/recovery/provider human gate | `PASS` local incident/recovery and review gate; `FAIL` TASK-018 three-run acceptance; `BLOCKED_EXTERNAL` authorized provider delivery | `docs/P0_ACCEPTANCE_RUNBOOK.md`: `scripts/p0-local-acceptance.sh` — PASS (12 local scenarios), including ingest/evaluation/incident, recovery, ProviderCase human-send gate. `docs/TASK-018_DEMO_ACCEPTANCE.md`: `bash scripts/task018-demo.sh` recorded `runs_passed=0/3 pass=0 fail=3 blocked_external=0`, with HTTP 500 `provider_case_draft_generations_provider_case_id_fkey` at reset; no downstream incident/recovery/provider/export steps ran in those three runs. `docs/TASK-021_PROVIDER_ACCEPTANCE.md`: local transport/retry/review tests PASS, but the authorized provider gate is `BLOCKED_EXTERNAL`. | The later commits `6ae95f4`, `acf9869`, `d27eced`, `f4e85a2`, and `7baa013` are fixes/regressions after the recorded TASK-018 failure; they do not constitute a new `3/3` run. No TASK-018 PASS is claimed. |
| reporting formats | `PASS` for recorded local/live report evidence; `NOT RUN` for TASK-018 downstream formats | `docs/TASK-024_P2_ACCEPTANCE.md`: evidence report and JSON export returned `200` with parsed semantic checks. `docs/P0_ACCEPTANCE_RUNBOOK.md` and `docs/BROWSER_E2E_RUN.md` record live quality-passport/report/export checks, including CSV and XLSX. `docs/TASK-018_DEMO_ACCEPTANCE.md` explicitly records that passport, CSV, and XLSX were not reached after reset failure. | The format PASS is not a claim that the failed TASK-018 run completed its own end-to-end export sequence. |
| role/scope isolation | `PASS` where executed evidence exists; `NOT RUN` for a separately recorded P1 runtime result | `docs/P0_ACCEPTANCE_RUNBOOK.md` maps the API gate to `admin`, `provider-a`, `district`, and `school-42` role/scope checks. `docs/TASK-017_BROWSER_ACCEPTANCE.md` records provider `403` admin-boundary evidence. `docs/TASK-024_P2_ACCEPTANCE.md` records live `scope_enforced=true` provider workspace evidence and passing authorization regression tests. | `docs/P1_ACCEPTANCE.md` defines the executable P1 gate but contains no run output in the current checkout; do not infer a P1 runtime PASS from the script definition alone. |

## External and interactive gates not available here

- Native Windows execution: the authoritative report is `NOT RUN` because a
  native Windows environment is unavailable. This is `BLOCKED_EXTERNAL` for
  the Agent acceptance row. Missing interactive checks include production
  topology/HTTPS readiness, clean install, service/reboot recovery, uninstall
  and purge preservation, tray IPC/diagnostics, and update activation.
- Public DNS/ACME/TLS remains `BLOCKED_EXTERNAL` per
  `docs/TASK-020_TLS_ACME_ACCEPTANCE.md`; Linux Compose topology is not public
  TLS evidence.
- Authorized provider delivery remains `BLOCKED_EXTERNAL` per
  `docs/TASK-021_PROVIDER_ACCEPTANCE.md`: no authorized endpoint or credential
  was configured or probed. The browser queue was empty, so ProviderCase
  population, AI draft, human review/send, external reference, and provider
  retry behavior were not claimed as live PASS.
- Additional non-WEB notification delivery remains `BLOCKED_EXTERNAL` per
  `docs/TASK-023_NOTIFICATION_ACCEPTANCE.md`; local `httptest` outbox evidence
  is not an external-channel delivery.
- The separate P1 runtime acceptance is `NOT RUN` as a recorded run in this
  checkout, despite the gate and its source-level test mapping being present.

This document closes TASK-026 as a bounded evidence record only. It does not
declare the repository's native, public-TLS, authorized-provider, or failed
TASK-018 end-to-end gates complete.
