# Synthetic operational database cleanup

`scripts/cleanup-synthetic-db.sh` is a standalone, auditable cleanup tool for
old LINKWATCH demo and repository-test operational rows. It does not add an
HTTP endpoint and does not touch the frontend or registry artifacts.

## Safe default

The default mode is a read-only dry run:

```sh
LINKWATCH_DATABASE_URL='postgres://...' ./scripts/cleanup-synthetic-db.sh --dry-run
```

The report identifies the current PostgreSQL database, total rows, targeted
rows, the exact rule, and the dependency/order note for every inspected table.
It also prints protected categories. Temporary target tables are rolled back
with the dry-run transaction.

## Deterministic selection

The tool selects only:

- the exact IDs seeded by `server/internal/admin/seed.go`: `org-07`, `org-42`,
  `org-99`, `provider-a`, `provider-b`, their four lines, four monitoring
  points, and four devices;
- the explicitly allowlisted repository fixture prefixes
  `measurement-core-`, `provider-send-concurrency-`,
  `provider-workspace-regression-`, `task014-admin-`, `task016-ai-`, and
  `verification-api-`;
- `TASK-018-RESET-*` / `PROVIDER-SEND-CONCURRENCY-*` incident numbers,
  `task018-reset-test` provider-case actor rows, and the exact `TASK-023`
  notification source tag (`task-023-*` plus `task-023-scope` recipient).

Dependent rows are materialized from actual foreign-key roots before deletion:
live verification results, measurement verifications/evaluations and
measurements; situation relations/events/members; provider draft generations
and cases; incident events/incidents; line-state rows; agent command/update
rows and device config state; notifications; then contracts/context/policies,
devices, points, lines, providers, and organizations. Parent rows are guarded
against remaining non-target dependents.

There is no generic `test%`/`demo%` blanket match, `DROP SCHEMA`, or
`TRUNCATE ... CASCADE`. Rows not proven synthetic remain untouched.

## Apply guard

Apply requires all of the following:

```sh
LINKWATCH_DATABASE_URL='postgres://...' \
  ./scripts/cleanup-synthetic-db.sh \
  --apply \
  --environment test \
  --confirm-target linkwatch_test \
  --confirm-apply
```

`--confirm-target` must exactly match `current_database()`. The environment
must be an explicitly allowed non-production value, and database names that
look like production/live targets are rejected. The tool never runs migrations.
Do not run `--apply` against a production or live database.

All deletes occur in one serializable transaction protected by an advisory
lock. A committed cleanup can be safely followed by another dry run or apply;
the targeted operational counts become zero where no protected dependent row
prevented parent deletion. Users, role scopes, sessions, audit history,
schema/migrations, catalog/configuration/release metadata, registry JSON,
coordinates, and import artifacts are always protected.

## Tests and PostgreSQL blocker behavior

Static unit tests cover deterministic rule allowlists, guard behavior,
dependency order, and protected categories. The optional PostgreSQL
integration test is enabled only with `LINKWATCH_TEST_DATABASE_URL` and uses
a controlled test fixture; it is skipped otherwise. A connection failure is
reported verbatim by the command as `cleanup blocked: PostgreSQL unavailable:
...`, and no apply is attempted.
