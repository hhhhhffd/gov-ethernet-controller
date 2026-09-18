# TASK-020 P0 acceptance runbook

This is the repeatable acceptance record for the source-defined P0 path. It is
not a replacement for native Windows, public TLS, or authorized provider
integration evidence.

## Local prerequisites

Use the development Compose fixture, which provides the deterministic users
`admin/demo`, `provider-a/demo`, `district/demo`, and `school-42/demo`.

```bash
docker compose up -d --build
curl http://127.0.0.1:8080/health/ready
```

Run the read-only API/capability gate:

```bash
P0_ACCEPTANCE_BASE_URL=http://127.0.0.1:8080 ./scripts/p0-acceptance.sh
```

The API gate invokes the local fixture gate by default. To run that fixture
gate independently (agent spool/resend, real ingest/evaluation/state,
unavailable Ollama persistence and review gate, concurrent PRIMARY conflict,
historical NO_DATA, and static browser shell), use:

```bash
P0_ACCEPTANCE_BASE_URL=http://127.0.0.1:8080 ./scripts/p0-local-acceptance.sh
```

Run the canonical agent/offline/idempotency path:

```bash
./scripts/smoke.sh
```

Run local suites:

```bash
make server-test
make agent-test
node --check web/app.js
```

## Source acceptance mapping

| Source requirement | Repeatable command/fixture | Evidence expected |
|---|---|---|
| Mandatory agent→ingest→evaluation→state→web path | `scripts/smoke.sh` plus Compose API gate | persisted measurement, canonical line state, web/API visibility |
| Offline spool/resend | `scripts/smoke.sh` with refused port then server URL | queue retained, resend acknowledged, queue emptied |
| Count and duration confirmation | `scripts/p0-local-acceptance.sh` plus `make server-test` | three real ingested evaluations reach canonical state/incident evidence; persisted closed incident has positive duration; unit coverage covers duration-only policy |
| NO_DATA/completeness/period | API gate plus `reports/quality-passport`, report fixture | availability, completeness and NO_DATA remain distinct |
| Notification | API gate `/api/v1/notifications`; outbox worker runtime | server-scoped entry survives reload and links to evidence |
| Incident/ProviderCase/AI/human send | `scripts/p0-local-acceptance.sh` with unavailable local Ollama | durable failed generation, editable `DRAFT|PENDING` case and explicit 409 review/send gate |
| History/report/export | API gate, browser report flow, `/api/v1/exports` raw/aggregate CSV/XLSX | same filtered canonical dataset and historical snapshots |
| Active PRIMARY invariant | concurrent point deactivation in `scripts/p0-local-acceptance.sh` | both requests return 409 and one active point remains |
| Role×Scope | API gate users `admin`, `provider-a`, `district`, `school-42` | list/read/mutation/export/notification/admin isolation |
| 401/403/404/409 | API gate plus stale/concurrent mutation fixture | exact status contracts and canonical refresh |
| Worker regression | Compose restart/retry run | durable outbox/freshness/situation behavior |
| Windows P0-A01/I08 | native PowerShell scripts and supported Windows target | service, reboot, tray, offline, reinstall evidence |
| TLS P0-I04 | `scripts/production-tls-smoke.sh` | real DNS/ACME redirect/certificate/protected endpoint |
| Provider P0-I09 | configured authorized test webhook | auth/signing/retry/idempotency/external reference/failure visibility |

## Current run record

The following commands were executed in the current environment:

- `make agent-test` — **PASS**, 27 tests; one existing unused-variable warning.
- `make server-test` (escalated Compose-capable run) — **PASS**, all Go packages.
- `make smoke` (escalated Compose-capable run) — **PASS**,
  `LINKWATCH E2E smoke: PASS (http://127.0.0.1:8080)`.
- `node --check web/app.js` — **PASS**.
- `scripts/p0-local-acceptance.sh` — **PASS**, 12 local scenarios.
- `scripts/p0-acceptance.sh` — **PASS**, 32 API/local checks, 0 failures, 3
  external skips; exits 2 only because Windows/TLS/provider evidence is not
  available in this environment.

## External evidence still required

P0 cannot be declared accepted until the following artifacts are attached:

1. TASK-018 native Windows service/tray matrix on a supported Windows target.
2. TASK-017 public DNS/ACME run using `scripts/production-tls-smoke.sh`.
3. TASK-019 authorized provider test endpoint run, including retry and
   permanent failure output.
4. Native/browser visual evidence beyond the static browser shell check, if the
   release gate requires a headed Playwright capture.

No P1 dependency release is authorized from this partial run. P1 may start
only after the three external evidence gates are produced and the complete
TASK-020 matrix has no failures or unexplained skips.
