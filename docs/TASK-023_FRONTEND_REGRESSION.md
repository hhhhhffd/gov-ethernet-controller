# TASK-023 frontend regression record

Date: 2026-09-20 (Asia/Oral)

## Executed checks

| Check | Result | Evidence |
|---|---|---|
| `make web-test` | PASS | 56 tests passed, 0 failed; map marker, popup, accessibility, responsive, content, control, auth, capability, localization, theme, incidents, reports, ProviderCase, notifications, admin, audit, search, filters, and registry boundaries passed. |
| Frontend syntax | PASS | `node --input-type=module --check < web/app.js`, `web/map.js`, `web/integration/map-integration.mjs`; `node --check scripts/browser-e2e.mjs`. |
| `scripts/browser-e2e.mjs` | PASS | 16/16 surfaces passed; 0 failures; 0 external blockers; `demo=off`. |
| `make server-test` | PASS | Go server packages completed successfully. |
| `make agent-test` | PASS | 39 Rust tests passed, 0 failed. One existing dead-code warning for `attempt_count` remains non-fatal. |
| `make smoke` | BLOCKED_EXTERNAL | Docker Desktop is not integrated with this WSL2 distribution; `docker --version` reports that Docker cannot be found in the distro. No runtime smoke claim is made. |
| `scripts/p0-acceptance.sh` | BLOCKED_EXTERNAL | `/health/ready` was unavailable at the static browser server (`404`); no backend runtime was present. |
| `scripts/p1-acceptance.sh` | BLOCKED_EXTERNAL | `pass=4 fail=2 runtime=blocked`; the two integration failures were PostgreSQL connection refusals on `127.0.0.1:5432`, while the runtime health check was unavailable. |

The smoke/P0/P1 results are environment gates, not frontend test failures. The
required backend runtime must be started in a Docker-enabled environment before
those integration rows can be promoted to PASS.

## Synthetic-data boundary

The frontend browser fixture is test-only and explicitly reported as such. The
production path still has no silent demo fallback, no pseudo-coordinates, and
no generated school records. `make web-test` passed the registry, mapping,
invalid-coordinate, no-fuzzy-match, and registry-failure boundary tests.

The guarded cleanup command was inspected with `--help`; a read-only dry run
was attempted without a PostgreSQL runtime and reported the expected explicit
block:

```text
cleanup blocked: PostgreSQL unavailable: ... dial tcp 127.0.0.1:5432: connect: connection refused
```

No cleanup apply operation was attempted.
