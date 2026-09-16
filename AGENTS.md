# LINKWATCH engineering rules

## Runtime boundaries

- Production runtime is `server/` (Go) plus PostgreSQL. Do not add Python to the
  Docker image, Compose health checks, release scripts, or service units.
- `agent/` is a Rust 2021 native binary. Keep the CLI commands `run`, `once`,
  `probe`, and `version` stable; preserve `VKO_*` configuration aliases while
  migrating to `LINKWATCH_*`.
- PostgreSQL is the source of truth. SQLite files and in-memory stores are not
  supported by the production path.

## Data and workflow invariants

- Every observation carries a `client_event_id`; ingest must be idempotent per
  device and event.
- Store effective policy and contract snapshots with each evaluation.
- Backfilled observations are evidence only and must not rewrite the current
  line state. Incidents close only after confirmed recovery evidence.
- Provider and notification transports must persist attempts, failures, and
  retryable status before returning an error.

## Change and verification rules

- Keep `/api` and `/api/v1` aliases and the existing `web/` field contract.
- Use additive, versioned migrations under `server/internal/database/migrations`.
- Run `make server-test`, `make agent-test`, and `./scripts/smoke.sh` before a
  runtime or schema change is considered complete.
- Do not commit credentials, generated queues, Rust `target/`, or local database
  files. Keep the Windows release artifact only at
  `dist/linkwatch-agent-windows-amd64.exe`.
