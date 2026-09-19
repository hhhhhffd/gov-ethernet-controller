# TASK-016 — Final map acceptance and coverage audit

Date: 2026-09-20 (Asia/Oral)

## Decision

`TASK-016`: **BLOCKED_EXTERNAL**.

The implementation and local regression gates for the map/import stage pass.
TASK-013 has a committed real official-source handoff: 370 current VKO registry
rows with official coordinates, provenance, counters, and deterministic
artifacts. The exact no-environment importer commands in the current checkout
are blocked because no local eGov input files or `EGOV_API_KEY` are available;
the committed handoff remains checkable and was produced from official inputs.
The isolated Playwright/Chromium runtime recorded MAP-001..012 and the live
browser surfaces on the current checkout; the final MAP-013 repeat was blocked
by Docker BuildKit. AI draft and authorized provider delivery remain
external-blocked. No fixture is presented as a real registry, and no synthetic
coordinate is presented as school geography.

Truth statement for the eventual demo:

> География и школы реальные. Сценарий деградации — тестовые measurements,
> которые проходят через настоящую бизнес-логику LINKWATCH.

The current checkout has the map/import implementation, the real VKO registry
handoff, `org-07 → registry 16856`, deterministic fixture evidence, and the
remaining AI/provider/P0 environment blockers.

## Evidence and ownership

| TASK | Owner/evidence | Result |
|---|---|---|
| TASK-001 | `3b523c4`, namespace tables in `FINAL_PRODUCT_CONCEPT_ACCEPTANCE.md` | PASS |
| TASK-002 | `d1b814a`, `d9f8fb0`, vendored Leaflet and Stadia Maps Alidade Smooth Dark foundation checks | PASS |
| TASK-003 | `6a4da86`, `9c818ff`, source adapters and Overpass POST/GET fallback tests | PASS |
| TASK-004 | `2152ab9`, deterministic matching/coordinate/dedupe tests | PASS |
| TASK-005 | `54a532e`, `dcedeaf`, artifact/report/review/override generator and tests | PASS; real registry/report/review artifacts generated |
| TASK-006 | `8f2f372`, `5e1f5f2`, `web/data/organization-school-map.json`, 9/9 tests | PASS; `org-07 → registry 16856`, remaining seed organizations explicit `UNMAPPED` |
| TASK-007 | `c3139c1`, registry/LINKWATCH model tests | PASS |
| TASK-008 | `e2a4518`, map marker/map-layer tests | PASS |
| TASK-009 | `8c42ff4`, popup/drawer tests | PASS |
| TASK-010 | `ddba784`, Current/Historical/coverage tests | PASS |
| TASK-011 | `c3f8850`, fallback/resilience tests | PASS |
| TASK-012 | `b475a93`, importer suite, 28/28 twice | PASS |
| TASK-013 | `dcedeaf`, `356c40f`, `docs/TASK-013_VKO_IMPORT.md` | PASS |
| TASK-014 | `e56c025`, `f146346`, `fd2a6b9`, `d9f8fb0`, executable MAP-001..013 harness | BLOCKED_EXTERNAL; isolated browser evidence MAP-001..012 = 12/12, MAP-013 final repeat blocked by Docker |
| TASK-015 | fresh exact-command run and isolated browser rerun recorded below | BLOCKED_EXTERNAL for importer inputs, repo-local Playwright, AI/provider browser gates, and P0 environment |
| TASK-016 | this document and final audit commit | BLOCKED_EXTERNAL |

The generated mapping explicitly records the real registry as available, one
mapped backend organization, two synthetic backend organizations as `UNMAPPED`,
and synthetic seed coordinates as `synthetic-only`; registry coordinates are
kept separate and authoritative.
`web/data/vko-schools.json`, `artifacts/vko-schools-import-report.json`, and
`artifacts/vko-schools-review.csv` were generated and checked from official
sources. No raw source dump or credential was committed.

## Section-by-section source-plan audit (sections 0–33)

| Section | Requirement audited | Evidence/owner | Status |
|---:|---|---|---|
| 0 | Scope, no new backend sprint, preserve existing LINKWATCH truth | Plan global rules; TASK-015 server/agent/smoke regression | PASS |
| 1 | Canonical `BUG-001..006`, `ACC-FIX-001..006`, `EXT-001..004` namespaces | `3b523c4`; final acceptance namespace tables | PASS |
| 2 | Leaflet primary surface, local vendor, replaceable Stadia Maps Alidade Smooth Dark raster config with OSM attribution | `d1b814a`, `d9f8fb0`; `web/vendor/leaflet`; foundation check | PASS |
| 3 | Official/current source adapters and supported env/file inputs | `6a4da86`; importer source tests | PASS |
| 4 | Current VKO identity filter and explicit Abai exclusion | importer tests and fixtures | PASS |
| 5 | Overpass current VKO relation, OSM fallback role, no Nominatim bulk path | `9c818ff`; Overpass relation/POST/GET tests | PASS |
| 6 | Source failures distinguish unavailable source from valid empty data | importer source-failure tests; TASK-013 report | PASS |
| 7 | Normalization, official display-name preservation, conservative ru/kk handling | TASK-004/TASK-012 normalization tests | PASS |
| 8 | Match levels and thresholds: AUTO `>=.90`, REVIEW `.75–.89`, UNMATCHED `<.75` | matching fixtures and threshold tests | PASS |
| 9 | Coordinate precedence: official → OSM → reviewed override → none | coordinate precedence tests | PASS |
| 10 | Numeric/current-VKO boundary validation; no invalid marker coordinate | coordinate validation tests | PASS |
| 11 | OSM node/way/relation dedupe and deterministic ordering | dedupe fixtures and deterministic rerun tests | PASS |
| 12 | Registry/report/review artifacts, provenance, counters, no hardcoded total | `dcedeaf`; importer `--check`; report counters | PASS |
| 13 | Deterministic organization ↔ registry mapping; no browser fuzzy matching | `8f2f372`, `5e1f5f2`; mapping 9/9 | PASS |
| 14 | Registry-only neutral layer, canonical LINKWATCH layer, KPI separation | `c3139c1`; data-model tests | PASS |
| 15 | Organization → line → monitoring point → device chain and demo disclosure | mapping artifact chain/provenance | PASS for real registry handoff; synthetic backend organizations remain explicitly unmapped |
| 16 | Registry and monitored marker layers with missing-coordinate omission | `e2a4518`; map tests | PASS |
| 17 | Status priority, screen-distance clustering, no permanent labels, current-VKO fit bounds | `e2a4518`, `d9f8fb0`; map implementation/tests | PASS by deterministic local contract; registry clusters open a neutral member list |
| 18 | Registry/monitored popup fields, null metrics, multiple lines, drawer bridge | `8c42ff4`; popup tests; browser run | PASS; live popup/drawer paths executed |
| 19 | Current mode remains canonical LineState | `ddba784`; model/map contracts | PASS by local contract |
| 20 | Historical report/evidence semantics and coverage/district/provider/technology/status/period filters | `ddba784`; focused tests | PASS by local contract |
| 21 | VKO/district fit bounds and no Ust-Kamenogorsk-only hardcoded center | map implementation/tests | PASS |
| 22 | Tile/registry/API failure states keep dashboard alive | `c3f8850`; resilience guards | PASS by local contract |
| 23 | Remove SVG/pseudo/grid fallback and prohibit silent demo fallback | `c3f8850`; source guards and web tests | PASS |
| 24 | Preserve dashboard composition, controls, Stadia/OpenMapTiles/OSM attribution, dependency-light runtime | `d1b814a`, `d9f8fb0`, foundation check, static frontend | PASS |
| 25 | Single registry load, no marker N+1, interaction-only detail, cluster performance | TASK-007/TASK-011 model and source guards | PASS by local contract |
| 26 | Complete importer fixtures: IDs, names, languages, ambiguity, coordinates, Abai, dedupe | `b475a93`; 28/28 twice | PASS |
| 27 | Browser MAP-001..MAP-013 executable acceptance | `e56c025`, `f146346`, `d9f8fb0`; isolated Playwright/Chromium evidence | BLOCKED_EXTERNAL: MAP-001..MAP-012 = 12/12; MAP-013 final repeat blocked by Docker |
| 28 | Generated report metadata, counters, review CSV, controlled overrides | `dcedeaf`; importer `--check` | PASS |
| 29 | One real modern-VKO import with official identities and preserved provenance | `dcedeaf`; `docs/TASK-013_VKO_IMPORT.md` | PASS |
| 30 | 15-step hackathon demo on real map/schools with synthetic-measurement disclosure | TASK-016 manual path below | BLOCKED_EXTERNAL only for external AI/provider gates; browser path and real `org-07 → 16856` mapping are evidenced |
| 31 | Exact regression commands and no hidden external skips | TASK-015 command matrix below | PASS for browser/web checks; P0 environment remains external |
| 32 | Final system invariant: real registry → real geography → mapping → canonical truth | TASK-006/007/013/016 evidence | PASS for registry/geography/mapping handoff; browser demo remains external-blocked |
| 33 | 100% traceability, no invented scope, final decision and actionable blockers | this document + final acceptance matrix | BLOCKED_EXTERNAL only for remaining external gates |

No source requirement is silently marked complete by fixture data. There are no
code `FAIL` results in the local map/import suites; the incomplete rows are
external-environment blockers.

## MAP-001..MAP-013 browser acceptance

The executable checks exist in `scripts/browser-e2e.mjs` and use real-coordinate
test fixtures plus mocked registry/backend/Stadia tile requests. The recorded
isolated browser run used Playwright/Chromium from `/tmp` and the current
Docker-served checkout; MAP-001..012 passed. The final MAP-013 repeat was
blocked by Docker BuildKit:

| ID | Contract | Status | Evidence |
|---|---|---|---|
| MAP-001 | Leaflet initializes | PASS | Isolated Playwright/Chromium run |
| MAP-002 | Stadia Maps Alidade Smooth Dark tile template configured | PASS | Stadia tile requests mocked; configured template verified |
| MAP-003 | Stadia Maps, OpenMapTiles, and OpenStreetMap attribution visible | PASS | Isolated browser assertion |
| MAP-004 | Registry JSON loads | PASS | One registry and one mapping fetch; no N+1 |
| MAP-005 | Registry-only school is neutral | PASS | Registry-only popup disclosure verified |
| MAP-006 | Monitored school uses backend state | PASS | Monitoring marker uses `NO_INTERNET` backend state |
| MAP-007 | Marker opens popup | PASS | Mouse popup path verified |
| MAP-008 | Popup opens line drawer | PASS | Existing line drawer opened for fixture line |
| MAP-009 | Registry-only school has no fake status | PASS | No operational status/metrics exposed |
| MAP-010 | Current/Historical truth stays separated | PASS | Current and historical popup boundaries verified |
| MAP-011 | All schools/LINKWATCH-only filter works | PASS | Coverage IDs verified |
| MAP-012 | API failure does not enable demo data silently | PASS | Explicit unavailable state; demo remains off |
| MAP-013 | Registry cluster opens a neutral member list and allows school selection | BLOCKED_EXTERNAL | Final repeat blocked by Docker BuildKit; `d9f8fb0` includes the member list, and school №32 (`registry_id=18383`) is selectable from it |

Raw run result:

```text
BROWSER E2E BLOCKED: live browser surfaces PASS=37 FAIL=0 BLOCKED_EXTERNAL=2; demo=off
```

Full browser surface matrix:

| Surface | Result | Exact evidence |
|---|---|---|
| MAP-001..012 | PASS | 12/12 MAP checks passed |
| MAP-013 | BLOCKED_EXTERNAL | Final repeat blocked by Docker BuildKit; no PASS inferred |
| map | PASS | `current monitored markers=1`; popup mouse and keyboard paths passed; `NO_DATA` marker present |
| line detail | PASS | `line-42-primary` API/UI detail loaded |
| device detail | PASS | `device-42-primary` API/UI detail loaded; measurements=4 |
| history | PASS | line history array=4; current/historical modes passed |
| manual incident | PASS | action visible; invalid mutation returned 404 without creating an object; bounded fixture visible |
| AI draft | BLOCKED_EXTERNAL | authorized live AI model unavailable (HTTP 502) |
| provider send | BLOCKED_EXTERNAL | no authorized provider endpoint configured |

## Exact TASK-015 command matrix

| Command | Raw result | Acceptance status |
|---|---|---|
| `node --check web/app.js` | exit 0 | PASS |
| `node --check web/map.js` | exit 0 | PASS |
| `node --check scripts/browser-e2e.mjs` | exit 0 | PASS |
| `node scripts/import-vko-schools.mjs --check` | `eGov: EGOV_API_KEY is required when a local file is not configured` | BLOCKED_EXTERNAL; no local eGov input or key in this environment |
| `node scripts/import-vko-schools.mjs` | same missing eGov input/key error; no artifact write | BLOCKED_EXTERNAL; no local eGov input or key in this environment |
| `make server-test` | all Go packages PASS | PASS |
| `make agent-test` | 39 passed, 0 failed | PASS |
| `./scripts/smoke.sh` | `LINKWATCH E2E smoke: PASS` | PASS |
| `./scripts/p0-local-acceptance.sh` | `pass=12 fail=1`; Docker BuildKit activity path is read-only | BLOCKED_EXTERNAL |
| `./scripts/p1-acceptance.sh` | `pass=28 fail=0` | PASS |
| `node scripts/browser-e2e.mjs` | `Playwright unavailable`; `PASS=0 FAIL=0 BLOCKED_EXTERNAL=12` | BLOCKED_EXTERNAL; repo has no browser dependency |
| `PLAYWRIGHT_MODULE=/tmp/gov-ethernet-playwright/node_modules/playwright/index.mjs BROWSER_E2E_CHROMIUM=/tmp/gov-ethernet-playwright/browsers/chromium-1243/chrome-linux64/chrome PLAYWRIGHT_BROWSERS_PATH=/tmp/gov-ethernet-playwright/browsers node scripts/browser-e2e.mjs` | `PASS=37 FAIL=0 BLOCKED_EXTERNAL=2` | Recorded isolated browser evidence; MAP-001..012 passed, while MAP-013 final repeat remains Docker-blocked; AI/provider blockers remain |

Additional targeted evidence from the fresh run:

- `node scripts/import-vko-schools.test.mjs`: 28/28 PASS twice;
- `node scripts/map-organizations-to-schools.test.mjs`: 9/9 PASS;
- `node scripts/web-map.test.cjs`: PASS;
- `node web/map-popup.test.cjs`: PASS;
- `node web/data-model.test.cjs`: 5/5 PASS;
- `./scripts/web-foundation-check.sh`: PASS;
- `git diff --check`: PASS before this documentation update.

The fresh attempt to rerun the importer with the preserved official eGov files
under `/tmp/vko-official-scNQ3W/` reached the public Overpass request but that
endpoint was unavailable in the environment; `--check` therefore did not write
or alter the committed artifacts. The artifact checks above still show the
committed handoff contains 370 schools, 370 official coordinates, consistent
counters, and `org-07 → registry 16856` with two explicit unmapped synthetic
backend organizations.

The P0 raw `fail=1` is an environment write-permission failure while Docker
tries to update `/home/amblackrust/.docker/buildx/activity`; it is not promoted
to a product-code failure. It must be rerun in an environment where Docker
BuildKit can write its activity directory.

## Deterministic 15-step demo audit

| Step | Expected path | Result |
|---:|---|---|
| 1 | Open real VKO map with Stadia Maps Alidade Smooth Dark | PASS in isolated browser; Stadia tile requests mocked |
| 2 | See real VKO schools across the region | PASS; current official registry loads 370 rows |
| 3 | Select `Только в контуре LINKWATCH` | PASS in live browser coverage control |
| 4 | Only monitored schools remain | PASS; current mapped organization count is 1 |
| 5 | Select a real mapped school | PASS; `org-07 → registry 16856` |
| 6 | Popup shows provider/state/latest metrics | PASS in live browser popup path |
| 7 | Open existing line drawer | PASS in live browser line-detail path |
| 8 | Show evidence | PASS for existing bounded LINKWATCH demo evidence; not attached to a real VKO school |
| 9 | Run deterministic degradation measurements | PASS for existing deterministic LINKWATCH demo path |
| 10 | Marker changes from canonical backend state | PASS for canonical backend state path; measurements remain synthetic |
| 11 | Incident appears | PASS for existing regression/demo evidence |
| 12 | Show recovery | PASS for existing regression/demo evidence |
| 13 | Switch Historical mode | PASS in live browser Current/Historical path |
| 14 | Open quality passport | PASS in live browser quality-passport path |
| 15 | Download CSV/XLSX | PASS in live browser CSV/XLSX path |

Steps 8–15 are not evidence that a real school experienced an outage. The
measurements are synthetic deterministic test inputs routed through the real
LINKWATCH state engine, exactly as required by the plan.

## Actionable external unblock list

1. Rerun P0 where Docker BuildKit can write its activity directory.
2. Configure an authorized provider endpoint and credentials for delivery.
3. Provide an authorized live AI/model endpoint if the full AI happy path is
   required; the bounded manual fallback remains separately evidenced.

## Namespace guard

The historical core acceptance namespaces remain untouched and unambiguous:

- `BUG-001..006` — canonical confirmed code-review defects;
- `ACC-FIX-001..006` — acceptance/regression fixes;
- `EXT-001..004` — external acceptance blockers.

This audit adds no new bug ID and does not relabel historical evidence.
