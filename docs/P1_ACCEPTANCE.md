# P1 integration acceptance

`scripts/p1-acceptance.sh` is the repeatable P1 gate for the historical and
explainability layer. It runs the backend permission/regression suite and the
frontend syntax gate on every invocation. If a healthy runtime is available,
it additionally checks the canonical HTTP surfaces with the seeded admin:

| Acceptance path | Runtime assertion |
| --- | --- |
| Line-context history | `/api/v1/lines/{id}/context` returns `resolved_context` and `versions`. |
| Verification/evidence | Line detail exposes `line_context_snapshot`, `verification_status`, and `evidence_chain`. |
| Passport dynamics | An empty historical period returns an explicit `NO_DATA`, `INSUFFICIENT_DATA`, or `INCOMPARABLE` dynamics status. |
| Situation investigation | Scoped situation detail exposes materialized projection and evidence; UI wording remains correlation-only. |
| Role × Scope/P0 truth | Backend package tests cover authorization, NO_DATA, late observations, verification immutability, and line-state semantics. |

Run from the repository root:

```sh
scripts/p1-acceptance.sh
```

Exit `0` means all available checks passed. Exit `2` means the local backend
runtime was unavailable, so HTTP acceptance is incomplete (not a product
failure); set `P1_ACCEPTANCE_BASE_URL` to a healthy deployed/compose runtime
to run that section. Exit `1` means an executed check failed.

The gate does not mutate fixtures, recompute historical verdicts, or add a
parallel truth/configuration model. It records P1 regression evidence; P2
implementation and acceptance may proceed independently, while P2 release
still requires TASK-041 acceptance.
