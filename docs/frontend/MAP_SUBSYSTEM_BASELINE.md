# Map subsystem baseline

Status: `BASELINE RECORDED`

This document freezes the current map subsystem before the frontend rebuild. It
records observed behavior and boundaries; it is not a redesign proposal. This
task changes documentation only. No runtime code, map data, coordinates, or
frontend behavior was changed.

## Runtime shape

- `web/index.html` loads the vendored Leaflet runtime and styles from
  `/static/vendor/leaflet/`. The runtime identifies itself as **Leaflet 1.9.4**.
- `web/map.js` owns one idempotent `LinkwatchMap` instance. `init()` creates
  the map, tile layer, monitoring pane, registry/monitoring layer groups,
  `zoomend` cluster rebuild, and resize invalidation. A second `init()` returns
  the existing map.
- `web/app.js` loads the registry and organization mapping once through
  `LinkwatchDataModel.createDataLoader()`, builds the frontend join model, and
  passes filtered registry rows, monitored lines, mode, and historical evidence
  to `LinkwatchMap.render()`.

## Engine and basemap

The default map configuration in `web/map.js` is:

```text
tile: https://tiles.stadiamaps.com/tiles/alidade_smooth_dark/{z}/{x}/{y}{r}.png
center: [49.95, 82.62]
zoom: 7
minZoom: 3
maxZoom: 18
fitMaxZoom: 13
clusterRadiusPixels: 44
```

Leaflet's visible attribution is configured as:

```html
&copy; <a href="https://stadiamaps.com/attribution/">Stadia Maps</a>
&copy; <a href="https://openmaptiles.org/">OpenMapTiles</a>
&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors
```

The map listens for tile errors and exposes the explicit status
`Подложка карты временно недоступна`; a later tile load clears it. The tile
URL and attribution can be overridden through `LINKWATCH_MAP_CONFIG`, but the
frozen defaults above are the production baseline.

## Registry artifact and authoritative coordinates

The production browser artifact is `web/data/vko-schools.json`, served at
`/static/data/vko-schools.json`. Its actual top-level metadata is:

```text
schema_version: 1
region: current-vko
schools: 370
```

The file has no top-level `artifact` or `provenance` object. Each of its 370
rows records:

```text
identity_source: egov-current-registry
coordinate_source: official
```

Therefore the browser baseline is 370 registry schools with 370 official
coordinates. The import record identifies the source as the official current
VKO registry/state-school data; its retained import evidence is documented in
`docs/TASK-013_VKO_IMPORT.md`. OSM was an import-time comparison source, not a
browser coordinate fallback.

`web/data-model.js` normalizes `registry_id`, official name, address, and
coordinates. `web/map.js` accepts only finite coordinates in latitude
`[-90, 90]` and longitude `[-180, 180]`. Invalid or missing coordinates do not
produce markers. No screen coordinate, seed coordinate, or generated fallback
is allowed.

The browser fetches both JSON assets concurrently and caches the resulting
promise, so each asset is loaded once per page. A failed registry or mapping
load remains explicitly unavailable; it does not create substitute schools or
silently enable demo lines.

## Organization-to-school mapping

The second production artifact is
`web/data/organization-school-map.json`, served at
`/static/data/organization-school-map.json`. Its current counters are:

| Counter | Value |
| --- | ---: |
| organizations | 3 |
| auto-mapped | 1 |
| review-required | 0 |
| unmapped | 2 |
| registry schools | 370 |
| registry-only unmonitored | 369 |

The artifact identifies `scripts/fixtures/organization-school-map/demo-organizations.json`
as the organization input, `web/data/vko-schools.json` as the registry input,
and `server/internal/admin/seed.go` as the organization source. Its disclosure
states that registry coordinates are authoritative and synthetic seed
coordinates/measurements are not official or live.

Mapping is deterministic and import-time-only. Allowed match methods are exact
identifier, exact name/locality/address, exact name/locality, and exact
name/address. Fuzzy matching is disabled; ambiguity remains
`REVIEW_REQUIRED` with no registry id, and an unknown registry id is rejected.

At runtime, `buildFrontendModel()` indexes mapping entries by
`organization_id`, resolves `registry_id` against the registry, and attaches
the resolved school and its registry coordinate to each backend line. A line's
operational status remains sourced from `backend.line_state`. A missing,
invalid, or unavailable join stays explicit and has no coordinate. Registry-
only schools are neutral `NOT_MONITORED` rows with no operational status.

## Marker identity and layers

Registry markers are created from registry rows with valid official coordinates.
Their identity is the source `registry_id` (with the legacy `id` aliases used
by the normalizer), and the complete normalized school is retained in the
marker context. Registry markers use the neutral registry icon and have no
operational lines.

Monitoring rows are grouped by joined `registryId`. One monitoring marker
represents one school and retains every line joined to that school. Its status
is aggregated in this priority order:

```text
NO_INTERNET > DEGRADED > NO_DATA > OK > UNKNOWN
```

The monitoring marker context retains the school, all lines, mode, aggregate
status, and per-line evidence. A line without a registry id or registry
coordinate is excluded from the monitoring layer. Legacy `map_x`/`map_y`
values are intentionally ignored.

Registry and monitoring markers are separate layers. When both occupy the same
coordinate, the registry marker remains visible but its DOM target has pointer
events disabled so the canonical monitoring target owns the interaction.

## Screen-distance clustering and member expansion

Only registry markers enter `clusterGroups()`. Each valid registry coordinate is
projected at the current Leaflet zoom and joined when its Euclidean projected
distance is at most **44 pixels**. This is screen-distance clustering, not a
fixed-degree geographic grid. Groups are rebuilt on `zoomend`.

- A singleton remains its registry marker.
- A multi-school group becomes a neutral registry-cluster marker showing its
  count.
- The cluster context contains `count` and neutral `members`; it contains no
  operational lines or status.
- Clicking a cluster fits its member coordinates up to `maxZoom: 18`.
- If a cluster is near a monitoring marker, its display point may be displaced
  in projected space to preserve visual separation. This does not mutate any
  official coordinate or identity.

The application popup renders a cluster as a neutral member list. Each member
is selectable by `data-popup-registry-id` and opens that school's neutral
registry card. Cluster expansion never invents current or historical status.

## Fit, bounds, and reset behavior

Every render fits the valid registry and monitoring coordinates actually passed
to the map. `fitToCoordinates()`:

- ignores invalid coordinates;
- uses `setView()` for one point, capped by `maxZoom`;
- uses `fitBounds()` for multiple points with `[24, 24]` padding and
  `fitMaxZoom` (13 by default); and
- returns false without a map or valid points.

`resetView()` restores `[49.95, 82.62]` at zoom 7. Resize observation calls
Leaflet `invalidateSize({ pan: false })` after layout changes.

## Current and historical modes

Current mode passes monitored rows with their normalized backend
`linkwatchStatus`. The map footer identifies `latest LineState`, and current
marker status is never calculated from local metrics.

Historical mode first requests `/api/reports/aggregate` and
`/api/reports/analytics` (with `/api/v1` aliases). The resulting summaries are
passed as `historicalByLine`. A historical marker uses only its summary:
missing or zero measurements become `NO_DATA`; otherwise the analytics state
or summary status is normalized and aggregated. Current line state is not used
as historical evidence. Missing analytics leaves aggregate evidence visible and
unknown rather than creating a client verdict.

The UI keeps the mode boundary visible: current says `Текущее состояние из
latest LineState`; historical says `Historical evidence` and
`current LineState не используется`. Registry-only rows remain neutral in both
modes.

## Popup and interaction contract

Marker activation supports mouse click and Enter/Space keyboard activation,
stores the marker context, emits `linkwatch:map-marker`, and routes through
`openMapPopupForContext()`.

- Registry-only popup: official registry facts, coordinate source, provenance,
  and `Не подключена к мониторингу`; no current status or metrics.
- Registry cluster popup: member count and selectable school list; no
  operational state.
- One current monitoring line: registry facts plus provider, technology, role,
  current status, latest Download/Upload/Ping, and latest observation, with an
  action to open the existing line drawer.
- Multiple current lines at one school: registry facts and a line selector.
- Historical monitoring: historical evidence and measurement count only; it
  does not reuse current-state fields.

Closing the popup restores the triggering marker's `aria-expanded` state and
focus when available.

## Automated evidence

The focused non-browser checks run for this baseline passed:

```text
node scripts/web-map.test.cjs       -> web map marker checks: PASS
node web/map-popup.test.cjs         -> web popup context checks: PASS
node --test web/data-model.test.cjs -> 5 tests passed, 0 failed
```

`scripts/web-map.test.cjs` covers tile failure status, invalid-coordinate
rejection, monitoring aggregation, screen-distance clustering, neutral cluster
members, cluster fit, historical non-fallback, no synthetic coordinates, and
Leaflet-only map assumptions. `web/map-popup.test.cjs` covers marker click and
keyboard routing, line membership, and historical evidence. The data-model
tests cover neutral registry-only rows, line deduplication, explicit mapping
failure, cached asset loading, and coverage modes.

The repository's `scripts/browser-e2e.mjs` is a separate live-browser harness.
Its authoritative map surfaces are `MAP-001` through `MAP-013`, but its map
fixture is synthetic and its Stadia requests are mocked; it does not validate
the real 370-row registry artifact. This task did **not** run that harness, in
accordance with the explicit no-browser/no-network instruction.

Exact unavailable-browser evidence for this baseline:

```text
/usr/sbin/chromium        absent
/opt/google/chrome/chrome absent
node_modules/playwright   absent
```

The harness's launch contract is a headless Playwright Chromium process using
`BROWSER_E2E_CHROMIUM` or `/usr/sbin/chromium`. If launch/import fails, the
harness records every `MAP-001` … `MAP-013` surface as `BLOCKED_EXTERNAL` with
the exact evidence template `Playwright unavailable: <load-or-launch-error>`
and reports `demo=off`. No browser output, screenshot, or live tile evidence is
claimed here because the harness was not run.

## Frozen invariants and rebuild boundary

A future frontend rebuild may move containers or split modules, but it must
preserve these invariants:

1. Leaflet remains the map engine; the Leaflet 1.9.4 runtime, default Stadia
   Alidade Smooth Dark tile, and visible attribution remain unchanged unless a
   separately approved provider migration is made.
2. `vko-schools.json` remains the authoritative 370-school identity set with
   370 official coordinates, its load path, and its import provenance. No
   synthetic or legacy screen coordinate may supplement it in the browser.
3. `organization-school-map.json` remains deterministic and import-time-only.
   Browser fuzzy matching, pseudo-schools, unknown registry joins, and
   pseudo-coordinates remain forbidden.
4. Registry identity is `registry_id`; monitoring identity is the joined
   registry school; multiple lines remain available under one monitoring
   marker; backend `LineState` remains the current operational truth.
5. Registry markers and monitoring markers remain separate. Screen-distance
   clustering remains 44 pixels by default, rebuilds on zoom, keeps neutral
   member lists, preserves cluster fit, and maintains monitoring-aware display
   separation.
6. Fit, bounds padding, max-zoom behavior, default reset view, resize
   invalidation, and explicit tile-unavailable state remain intact.
7. Current and historical modes remain separate; historical rendering cannot
   backfill from current state or turn missing evidence into a client verdict.
8. Registry-only and cluster popups remain neutral. Monitoring popups retain
   line choice, current/latest fields, historical evidence disclosure, and
   access to the existing line drawer.
9. The focused map, popup, and data-model checks remain passing. Any deliberate
   change to a frozen invariant requires new regression evidence and a separate
   approved change.

This document is the freeze boundary: subsequent frontend work may rebuild the
shell around these contracts, but it must not silently redefine map identity,
coordinate authority, mapping semantics, clustering, evidence mode, or popup
disclosure.
