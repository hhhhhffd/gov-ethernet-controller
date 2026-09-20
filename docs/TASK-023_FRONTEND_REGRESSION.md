# TASK-023 frontend regression record

Date: 2026-09-20 (Asia/Oral)

This record supersedes the earlier 56-test / unavailable-Docker snapshot. It
does not convert bounded or failed acceptance rows into a release PASS.

## Evidence classification

| Class | Meaning |
|---|---|
| `PASS` | The command or observation completed successfully within its stated boundary. |
| `BOUNDED` | The result is useful evidence, but a known fixture, shared-runtime, or incomplete-gate boundary remains. |
| `EXTERNAL` | The row requires a host/runtime/provider capability that is not yet evidenced. |

## Current regression ledger

| Check | Status | Latest result | Boundary / interpretation |
|---|---|---|---|
| `make web-test` | PASS | **75 passed, 0 failed** | Directly rerun during this documentation reconciliation. |
| Frontend syntax | PASS | **31/31 JavaScript files** | Syntax-only; does not prove a populated browser workflow. |
| `scripts/browser-e2e.mjs` | BOUNDED | **16 PASS, 0 FAIL, 0 BLOCKED_EXTERNAL**, `demo=off`; three consecutive runs were reported stable | The harness intercepts API, registry/mapping, and tile requests; it uses 3 fixture schools, 1 fixture line, and a 1×1 tile. |
| `make server-test` | PASS | Go server regression passed | Latest runtime/code regression report; no frontend release claim by itself. |
| `make agent-test` | PASS | **39 passed, 0 failed** | Existing non-fatal `attempt_count` dead-code warning remains. |
| `LINKWATCH_SERVER_PORT=18080 ./scripts/smoke.sh` | PASS | Canonical agent/offline queue, resend, persistence, and idempotency smoke passed | This is the successful port-isolated runtime run. A default `make smoke` attempt is not used as evidence where host port 8080 was occupied. |
| Runtime readiness | PASS | Docker **29.6.2**; PostgreSQL and server `healthy`; `/health/ready` **200** | Direct HTTP observation at `http://127.0.0.1:18080`. |
| Module asset MIME | PASS | `GET /static/core/api.mjs` **200**, `Content-Type: text/javascript; charset=utf-8` | This closes the previously observed `.mjs` MIME defect at the HTTP asset boundary; populated browser replay remains separate. |
| P0 acceptance | BOUNDED | **31 PASS, 1 FAIL, 3 SKIP** | The browser/static contract row is not green; P0-local additionally reported **11 PASS, 2 FAIL**. P0 is not a release PASS. |
| P1 acceptance | PASS | **28 PASS, 0 FAIL, runtime=available** | Runtime-dependent P1 checks passed on `18080`. |
| P2 acceptance | BOUNDED | **44 PASS, 1 FAIL, 2 BLOCKED_EXTERNAL** | One executed P2 check remains failed and two external gates remain unavailable; no P2 release PASS. |
| Synthetic cleanup `--dry-run` | BOUNDED | Exit **0**, targeted rows **0** | No `--apply` run and no post-apply repeat proof; safe dry-run is not proof of cleanup completion. |

## Runtime and data boundaries

The MIME fix is committed in `b8a18ef` (`fix(server): serve module assets with
JavaScript MIME`). The current application/runtime chain therefore has direct
HTTP evidence for readiness and module delivery. The browser E2E result above
still uses a route fixture and must not be described as a live backend/browser
acceptance.

The committed production mapping artifact is intentionally fail-closed:

```text
entries: 0
registry schools: 370
registry-only unmonitored: 370
operational_mapping_status: NOT_PROVIDED
organizations_input: not-provided
```

The 370 official registry rows and school №32 identity/coordinates are
preserved. A real organization export is absent, so operational line-to-school
joins are not production-ready. This is a `BOUNDED`/`EXTERNAL` data-readiness
state, not permission to use the demo fixture or invent coordinates.

## Regression decision

Frontend unit/source checks, server/agent suites, runtime readiness, MIME
delivery, smoke, and P1 are green within their declared boundaries. P0 still
has a failure, P2 still has a failure plus two external blockers, cleanup
completion is not proven, and a populated real-runtime browser journey is not
recorded after the MIME fix. TASK-023 therefore remains **BOUNDED**, not
release-complete.
