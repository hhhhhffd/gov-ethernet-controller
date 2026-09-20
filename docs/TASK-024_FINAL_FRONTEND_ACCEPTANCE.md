# TASK-024 final frontend acceptance

Date: 2026-09-20 (Asia/Oral)

Status: **PASS for the frontend rebuild; external runtime gates remain explicitly
blocked**.

## Definition of Done

| Requirement | Result | Evidence |
|---|---|---|
| Legacy dashboard composition removed | PASS | Browser shell assertion rejects the old card/sidebar/dashboard selectors; map is the viewport workspace. |
| Full-screen Leaflet map and canonical Alidade Smooth Dark presentation | PASS | `web/map.js`, `web/core/map-presentation.mjs`, map foundation checks, and 1355×880 browser captures. |
| Real registry identity, coordinates, search, and clustering | PASS | Web boundary tests plus browser school №32 search/focus and neutral cluster member selection. |
| No synthetic frontend fallback or pseudo-coordinate path | PASS | Registry/data-model boundary tests, browser `demo=off`, and explicit unavailable-state journey. |
| Auth, logout, capabilities, RU/KK, dark/light | PASS | Web tests and 16-surface browser acceptance, including persisted locale and theme geometry. |
| Incidents, Reports, ProviderCase, notifications, admin, audit | PASS within available fixture boundaries | Presentation/control/unit boundaries pass; browser covers Incidents/Reports routes and honest empty state. ProviderCase mutation remains capability- and human-review-gated; no populated external case fixture was fabricated. |
| No dead or duplicate controls | PASS | `UI-001..003` control audit and final browser route/tool assertions. |
| Human copy and technical-slop audit | PASS | `CONTENT-001..003`, RU/KK dictionary parity, and final source scan. |
| Screenshot/visual lock | PASS | TASK-022 canonical state captures, visual inspection, hard checklist, blur test, and component-library smell test. |
| Full repository regression | BOUNDED PASS | Frontend, Go server, and Rust agent suites pass; Docker/PostgreSQL runtime gates are recorded as external blockers in TASK-023. |

## 30-second operator-purpose review

The canonical shell makes the required flow discoverable without coaching:

1. Schools are visible on the full-screen map.
2. Attention is summarized by the map status count and the marker state.
3. The compact search finds an official school record, including №32.
4. A marker opens registry identity; a monitored marker opens current state and line detail.
5. Incidents are a primary destination, with explicit empty/error states and refresh.
6. Reports are a primary destination, with filters, history-only wording, quality,
   analytics, evidence, and export entry points.
7. Logout is in the account menu and is exercised against the logout endpoint.
8. RU/KK controls are persistent compact utilities.
9. The theme control switches dark/light while preserving geometry.

## Final audits

- `git diff --check`: PASS.
- Correct module syntax checks: PASS.
- Dead-control and duplicate-action audit: PASS (`make web-test`).
- Content audit: PASS (`make web-test`); no product-owned Backend/LineState/
  internal event-code copy is exposed.
- Synthetic cleanup: guarded dry-run behavior is explicit; no apply was run.
  Actual PostgreSQL cleanup verification is blocked by the unavailable runtime.
- No credentials, generated queues, Rust `target/`, or local database files were
  added by this frontend work.

## Remaining external gate

`make smoke`, P0, and the runtime-dependent P1 rows cannot run in the current
WSL environment because Docker Desktop integration and PostgreSQL are
unavailable. This is documented as `BLOCKED_EXTERNAL`, not silently converted
to a frontend PASS and not worked around with demo data. The frontend change
itself is committed in:

```text
e6d27aa fix(web): harden map focus and browser acceptance
43355aa test(web): cover locale and secondary route journeys
```
