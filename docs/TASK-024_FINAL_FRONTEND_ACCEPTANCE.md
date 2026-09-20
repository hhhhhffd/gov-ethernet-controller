# TASK-024 final frontend acceptance

Date: 2026-09-20 (Asia/Oral)

Status: **BOUNDED — release is not accepted**.

The frontend implementation has strong unit/source evidence, but the current
evidence does not prove every source requirement in a populated production
runtime. This note intentionally keeps that distinction visible.

## Evidence classification

| Class | Meaning |
|---|---|
| `PASS` | The exact requirement is proven by the cited check within its stated scope. |
| `BOUNDED` | A meaningful part is proven, but fixture, empty-data, visual, or shared-runtime limits remain. |
| `EXTERNAL` | Required proof depends on an unavailable external runtime, host, browser, tile, provider, or data export. |

## Definition of Done ledger

| Requirement | Status | Current evidence and limit |
|---|---|---|
| Legacy dashboard composition removed | PASS within tested shell | `make web-test` and fixture browser shell assertions reject the old dashboard/sidebar composition. |
| Full-screen Leaflet workspace | PASS within tested shell | 1355×880 geometry and one custom tool stack pass; real populated runtime browser proof remains bounded. |
| Alidade Smooth Dark presentation | BOUNDED | Canonical URL/attribution and adapter are present; screenshot tile requests are mocked, so real raster rendering is not proven. |
| Registry identity, coordinates, search, clustering | BOUNDED | 370 official registry rows, school №32, map tests, and fixture journeys pass; fixture browser does not load the production artifact. |
| No synthetic frontend fallback or pseudo-coordinate path | PASS for source/data boundary | Boundary tests and the empty production mapping fail closed; operational readiness with a real organization export remains external. |
| Auth, logout, capabilities, RU/KK, dark/light | BOUNDED | 75 web tests and 16/16 fixture browser surfaces pass; fixture API is intercepted, so a populated live browser journey is not proven. |
| Incidents, situations, Reports, ProviderCase, notifications, admin, audit | BOUNDED | Feature/API boundaries pass and empty Reports/Incidents routes are covered; no populated real-runtime browser workflow is attached. |
| No dead or duplicate controls | PASS for automated audit | `make web-test` 75/75 and the control audit pass; this is not a substitute for every live role/scope rendering. |
| Human copy and technical-slop boundary | PASS for automated/content audit | RU/KK/content/technical-disclosure checks pass; unknown live payload variants still require runtime observation. |
| Canonical screenshot / pixel lock | BOUNDED | Fixture captures and dark/light geometry pass; 1×1 tile and empty/fixture content prevent a production visual claim. |
| Full frontend/backend regression | BOUNDED | Web/server/agent/smoke/P1 pass in scope; P0 has 31/1/3, P2 has 44/1/2, and cleanup/browser/data gates remain open. |

## 30-second operator-purpose review

The fixture shell makes the intended route discoverable without coaching:

1. schools and registry identity are visible on the map;
2. the compact search can select school №32 in the fixture journey;
3. a marker opens registry or current-state context;
4. a line context can open the detail surface;
5. Incidents and Reports are primary destinations with honest empty/error copy;
6. logout, RU/KK, and theme controls have real effects.

This is **BOUNDED** operator evidence: the production artifact currently has
370 registry-only schools and no operational organization mapping, so “which
schools need attention” cannot be accepted as a populated production workflow
until a real backend organization export and live operational data are present.

## Current verified gates

- `make web-test`: **75/75 PASS**.
- `make server-test`: **PASS**.
- `make agent-test`: **39/39 PASS**.
- `LINKWATCH_SERVER_PORT=18080 ./scripts/smoke.sh`: **PASS**.
- P1: **28 PASS, 0 FAIL, runtime available**.
- Runtime readiness: **200**; module MIME: **200 `text/javascript`** after
  `b8a18ef`.
- P0: **31 PASS, 1 FAIL, 3 SKIP**; P0-local: **11 PASS, 2 FAIL**.
- P2: **44 PASS, 1 FAIL, 2 BLOCKED_EXTERNAL**.
- Fixture browser E2E: **16 PASS, 0 FAIL, 0 BLOCKED_EXTERNAL**, but bounded by
  intercepted API/registry/tile fixtures.
- Mapping: **0 operational entries, 370 registry-only schools**; real export
  not provided.
- Cleanup: guarded dry-run **PASS with 0 targeted rows**; apply/repeat proof is
  absent.

## Open evidence required before completion

1. Resolve and rerun the failed P0/P2 rows; attach row-level output.
2. Complete the two P2 external gates in an authorized native/provider
   environment, or record an explicit release decision that excludes them.
3. Run a populated browser journey against the real `18080` runtime after the
   MIME fix, without intercepting API, registry, mapping, or tile requests.
4. Supply and verify the real organization export/mapping; do not replace it
   with `scripts/fixtures/organization-school-map/demo-organizations.json`.
5. Run controlled cleanup apply only in the approved isolated target and prove
   the repeat dry-run plus protected-data invariants.
6. Capture production-tile screenshot evidence or explicitly accept the
   external tile limitation as a release exception.

## Final decision

The evidence supports a **bounded frontend implementation PASS**, not a full
release acceptance. Do not mark TASK-024 or the frontend rebuild complete while
the failed P0/P2 rows, empty production mapping, missing populated live-browser
proof, and unverified cleanup remain open.

Audited implementation HEAD before this documentation-only reconciliation:
`1362f102a078950349b1780eb151db7fad5dd90a`. Relevant recent fixes include
`b8a18ef` (module MIME), `63d57b1` (secondary-surface geometry), `e962797`
(mapping provenance), `d34213e` (map accessibility/focus), and `1362f10`
(capability-gated handlers).
