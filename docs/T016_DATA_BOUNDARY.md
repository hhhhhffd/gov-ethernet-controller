# T016 data boundary and scale acceptance

## Minimal PII boundary

The product may use existing operational identifiers and contact fields only:

- identifiers: organization/school, line, device, monitoring point, provider,
  incident and measurement IDs;
- operational context: school name/district/address, provider and monitoring
  location, agent version and observation timestamps/metrics;
- work contact: responsible person's name, work phone, role and work email;
- security audit context: actor ID, request ID and bounded client/network key
  needed for authentication-rate-limit investigation.

No unrelated personal data is collected or added to reporting. Export columns
are allow-listed and exclude contact fields, authentication material, raw
measurement payloads, password hashes, session/device tokens and provider
credentials. AI draft input is limited to selected line evidence, effective
policy/contract snapshots, measurement IDs/observations and the operator
comment; it does not include contacts or credentials.

Audit snapshots are redacted before persistence and again on read. Keys whose
names contain `token`, `password`, `secret`, `credential` or `private_key` are
stored as `[REDACTED]`. Device token rotation returns a token only in the
one-time mutation response; the audit event stores identifiers and timestamp,
never the token or hash.

## Scale/index evidence

The repeatable read-only probe is:

```sh
docker compose exec -T postgres psql -U linkwatch -d linkwatch \
  -v ON_ERROR_STOP=1 -c "SELECT current_database(), version();" \
  -c "SELECT indexname, indexdef FROM pg_indexes WHERE schemaname='public';"
```

Representative query plans can be collected with `EXPLAIN (ANALYZE, BUFFERS)`
for the measurement line history, device history, incident list, notification
outbox and report/export period query. The T016 migration adds only indexes
matching existing hot paths:

- `measurements(device_id, observed_at DESC, id DESC)` for the existing
  device-history pagination query;
- `measurements(observed_at, id)` for period report/export scans and ordering.

The initial probe observed the seeded demo dataset (126 measurements, 4 lines,
3 organizations), not a representative large fixture; the prescribed smoke
run subsequently added four measurements. Plans on the small baseline completed
in under 1 ms for the history/incident/notification probes and under 1 ms for
the export join, but PostgreSQL correctly chose sequential scans at that size.
Large-period export throughput, memory behavior at the 100,000-row application
guard, and plans after migration on production-scale data remain unverified.
Acceptance requires rerunning the same probes against a representative
PostgreSQL fixture and recording execution time, buffers, row counts and peak
application memory; no fabricated capacity claim is made.
