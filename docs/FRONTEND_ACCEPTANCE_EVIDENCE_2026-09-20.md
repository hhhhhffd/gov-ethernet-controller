# Frontend acceptance evidence reconciliation

Date: 2026-09-20 (Asia/Oral)

Scope: documentation-only reconciliation for TASK-021 through TASK-024,
`docs/frontend/CAPABILITY_MATRIX.md`, and
`docs/frontend/MAP_SUBSYSTEM_BASELINE.md`. No production code was changed.

Audited implementation HEAD: `1362f102a078950349b1780eb151db7fad5dd90a`

## Evidence vocabulary

- `PASS` means the exact check passed inside the boundary stated beside it.
- `BOUNDED` means the result is useful but cannot prove the broader release
  requirement because of a fixture, empty data set, shared runtime, or missing
  follow-up evidence.
- `EXTERNAL` means the proof requires an unavailable host, browser, provider,
  tile service, or real organization export.

## Current ledger

| Area | Status | Latest evidence | Boundary |
|---|---|---|---|
| Frontend checks | PASS | `make web-test`: **75 passed, 0 failed** | Directly rerun during this reconciliation. |
| Frontend syntax | PASS | Latest regression report: **31/31** JavaScript files | Syntax does not prove a populated browser workflow. |
| Server tests | PASS | `make server-test` passed | Backend unit/integration suite is not release evidence for the live frontend by itself. |
| Agent tests | PASS | `make agent-test`: **39 passed, 0 failed** | Existing non-fatal `attempt_count` warning remains. |
| Runtime containers | PASS | Docker **29.6.2**; PostgreSQL and server `healthy` | Directly observed on the port-isolated Compose runtime. |
| Runtime readiness | PASS | `GET http://127.0.0.1:18080/health/ready` → **200** | Readiness only. |
| Module MIME | PASS | `GET /static/core/api.mjs` → **200**, `text/javascript; charset=utf-8` | HTTP asset boundary after `b8a18ef`; browser replay is separate. |
| Agent/runtime smoke | PASS | `LINKWATCH_SERVER_PORT=18080 ./scripts/smoke.sh` → **PASS** | Successful port-isolated run; default port 8080 collision is not used as evidence. |
| P0 acceptance | BOUNDED | **31 PASS, 1 FAIL, 3 SKIP**; P0-local **11 PASS, 2 FAIL** | P0 is not green and remains open. |
| P1 acceptance | PASS | **28 PASS, 0 FAIL, runtime=available** | Latest runtime report on `18080`. |
| P2 acceptance | BOUNDED | **44 PASS, 1 FAIL, 2 BLOCKED_EXTERNAL** | One executed row is still failed; two native/provider gates are external. |
| Fixture browser E2E | BOUNDED | **16 PASS, 0 FAIL, 0 BLOCKED_EXTERNAL**, `demo=off`; three consecutive runs reported stable | All `/api/**`, registry/mapping assets, and Stadia tiles are intercepted; fixture has 3 schools, 1 line, and a 1×1 tile. |
| Real-runtime browser | EXTERNAL | No post-MIME-fix populated browser replay is recorded in this scope | Fixture E2E must not be promoted to live API/registry proof. |
| Production mapping | BOUNDED / EXTERNAL | `entries=0`, `registry schools=370`, `registry-only unmonitored=370`, `operational_mapping_status=NOT_PROVIDED` | A real backend organization export is absent; demo mapping is not an acceptable replacement. |
| Cleanup | BOUNDED | Guarded `--dry-run` exit **0**, targeted rows **0** | `--apply` and repeat-after-apply proof were not run. |
| Screenshot QA | BOUNDED | 1355×880 fixture captures and dark/light geometry equality | Tiles are mocked; real Stadia raster and populated runtime states are not visually proven. |

## Specific corrections made

- Removed the previous broad `PASS` wording from TASK-021, TASK-022, and
  TASK-024. Those documents now state bounded status and list the exact limits.
- Replaced the obsolete 56-test and Docker-unavailable regression snapshot with
  the current 75-test, MIME, smoke, P1, and P2 evidence.
- Recorded the `.mjs` MIME correction from `b8a18ef` without claiming that an
  HTTP success is equivalent to a real browser journey.
- Reconciled the map baseline with the current 370-school registry, the empty
  production mapping, the 44-pixel registry clustering boundary, and the
  fixture-only browser/tile evidence.
- Removed stale capability-matrix claims that current admin device actions lack
  confirmation or that the UI exposes unsupported “save as draft”/history
  controls. Unsupported backend capabilities that genuinely remain (unread
  state, persisted viewport, PDF endpoint) stay documented as unsupported.

## Release decision

The evidence supports a bounded frontend implementation result, not a complete
release acceptance. Do not close TASK-024 while the failed P0/P2 rows, missing
production organization mapping, absent populated real-runtime browser proof,
unverified cleanup apply/repeat, and external gates remain open.
