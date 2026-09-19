# TASK-018 deterministic hackathon demo

Status: `BLOCKED_INTERNAL` — no successful run is claimed.

The executable harness uses the development seed/reset API and the real
authenticated measurement, evaluation, incident, ProviderCase, recovery,
passport, and export paths. It does not write PostgreSQL directly, use
`?demo=1`, or replace business logic with a demo state machine.

## Intended clean run

```bash
./scripts/task018-demo.sh
```

Each of the three runs is required to:

1. Log in with the seeded development administrator.
2. Call `POST /api/v1/admin/demo/reset`.
3. Log in again because reset recreates users and sessions.
4. Verify School 42 / `line-42-primary` and submit a normal measurement.
5. Submit three contract-degrading measurements through the authenticated
   agent batch endpoint, proving no incident before confirmation and proving
   baseline `OK` versus contract `DEVIATES` evidence.
6. Verify the automatic incident, evidence chain, and timeline.
7. Create and read back a ProviderCase, including its evidence and timeline.
8. Obtain either a real local AI draft or an explicitly labelled manual
   fallback, then require human review before sending.
9. Submit recovery evidence, return the violation to prove reopen, and submit
   stable healthy observations until the incident is `CLOSED` with
   `recovery_state=CONFIRMED`.
10. Fetch the quality passport and validate real CSV and XLSX response bodies.

All evaluation, confirmation, incident, recovery, provider gate, and export
behavior is executed by the server. The measurements are deterministic and
carry `raw.probe=demo` only as provenance for this acceptance run.

## Actual execution evidence

Command executed on 2026-09-19:

```text
bash scripts/task018-demo.sh
```

Result:

```text
FAIL run 1 clean demo reset: HTTP 500 {"detail":"clear provider_cases: ERROR: update or delete on table \"provider_cases\" violates foreign key constraint \"provider_case_draft_generations_provider_case_id_fkey\" on table \"provider_case_draft_generations\" (SQLSTATE 23503)"...}
RUN 1 FAIL
FAIL run 2 clean demo reset: HTTP 500 {"detail":"clear provider_cases: ERROR: update or delete on table \"provider_cases\" violates foreign key constraint \"provider_case_draft_generations_provider_case_id_fkey\" on table \"provider_case_draft_generations\" (SQLSTATE 23503)"...}
RUN 2 FAIL
FAIL run 3 clean demo reset: HTTP 500 {"detail":"clear provider_cases: ERROR: update or delete on table \"provider_cases\" violates foreign key constraint \"provider_case_draft_generations_provider_case_id_fkey\" on table \"provider_case_draft_generations\" (SQLSTATE 23503)"...}
RUN 3 FAIL
TASK-018 SUMMARY: runs_passed=0/3 pass=0 fail=3 blocked_external=0
```

The harness exited with status `2`, as required for an incomplete acceptance.

| Run | Result | First failed step | Evidence |
|---:|---|---|---|
| 1 | `BLOCKED_INTERNAL` | clean demo reset | HTTP 500, `provider_case_draft_generations_provider_case_id_fkey` |
| 2 | `BLOCKED_INTERNAL` | clean demo reset | HTTP 500, same FK violation |
| 3 | `BLOCKED_INTERNAL` | clean demo reset | HTTP 500, same FK violation |

No run reached measurements, incident creation, ProviderCase delivery,
recovery, passport, or exports. Therefore this artifact does not claim three
successful demos, provider success, or any downstream PASS.

## Blocker diagnosis

The failure is an internal reset-path defect, not an external provider or TLS
blocker. The supported reset implementation deletes `provider_cases` but does
not clear its dependent `provider_case_draft_generations` rows. Migration
`012_provider_case_draft_generations.sql` defines the foreign key without a
cascade, so PostgreSQL correctly rejects the delete with SQLSTATE `23503`.

The harness did not bypass this with SQL or manual database surgery. Fixing the
reset implementation (including its cleanup ordering/transaction behavior) is
outside this demo-only change and is required before TASK-018 can be rerun.

## Harness verification

- `bash -n scripts/task018-demo.sh` — PASS.
- The harness now counts completed runs explicitly and cannot derive a PASS
  count from the number of individual assertions.
- The harness checks temporal confirmation, two-axis evidence, ProviderCase
  evidence/timeline, editable AI draft shape, human review, export content
  types, and XLSX ZIP signature.
- Because reset fails before the scenario starts, those downstream checks were
  not runtime-verified in this execution.

## Completion gate

TASK-018 remains open. After the reset-path defect is fixed, rerun the same
command and require `runs_passed=3/3`, `fail=0`, and successful downstream
evidence for every row in the intended clean-run sequence above.
