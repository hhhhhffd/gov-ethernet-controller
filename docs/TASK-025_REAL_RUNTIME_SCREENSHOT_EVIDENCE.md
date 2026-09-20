# Task 025 — real-runtime screenshot evidence

Status: captured and inspected. This is acceptance evidence for the current
runtime, not a replacement for the pixel-lock or the repository's broader test
suites.

Capture date: 2026-09-20 (Asia/Oral)

## Runtime and command

The capture used the already-running Docker stack at
`http://127.0.0.1:18080`. The server and PostgreSQL containers were healthy,
and `/health/ready` returned `200` before the browser run. The run used a local
runtime account supplied through environment variables; the credential values
are intentionally not recorded here.

Exact command:

```sh
node --check scripts/runtime-screenshot-evidence.mjs && \
RUNTIME_EVIDENCE_BASE_URL=http://127.0.0.1:18080 \
RUNTIME_EVIDENCE_LOGIN="$LINKWATCH_EVIDENCE_LOGIN" \
RUNTIME_EVIDENCE_PASSWORD="$LINKWATCH_EVIDENCE_PASSWORD" \
PLAYWRIGHT_MODULE=/tmp/gov-ethernet-playwright/node_modules/playwright/index.mjs \
BROWSER_E2E_CHROMIUM=/home/amblackrust/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome \
node scripts/runtime-screenshot-evidence.mjs
```

Result: `node --check` passed and the evidence runner exited `0`. No new broad
test suite was started at the checkpoint; this was the targeted runtime
browser-evidence command only.

The browser context was exactly `1355x880`. The runner records the exact
network and UI assertions in
[`task025-runtime-evidence.json`](../artifacts/task025-runtime-evidence.json).

## Fixture boundary

This run is real-runtime evidence:

- Playwright did not install `page.route` handlers and did not intercept or
  replace API, registry, mapping, or tile responses.
- The browser received `200` responses from the runtime API, including login,
  auth, lines, incidents, incident detail, line detail, and reports endpoints.
- The browser received the actual static registry and mapping assets with
  `200` responses: 370 registry schools and the current mapping asset.
- The map loaded actual Stadia Maps
  `alidade_smooth_dark` raster tiles. The captured response set contains 95
  successful tile responses, including zoom 7, cluster zoom 12, and school
  №32 zoom 14 tiles.
- The only deterministic browser setup is the local theme preference used to
  start the first map capture in dark mode. It is not a data fixture.
- Leaflet cancelled some old/out-of-viewport tile requests while moving from
  the country view to the cluster and school views (`net::ERR_ABORTED`). This
  is expected request cancellation during viewport changes; successful tiles
  rendered in each captured state. Final page errors were empty.

## Runtime facts and findings

| State | Evidence | Result |
| --- | --- | --- |
| Login | Actual login form, login request, and authenticated shell | Captured |
| Default dark map | Full-screen map, Alidade Smooth Dark tiles, 370 registry schools, 4 lines, 0 monitoring markers | Captured |
| Light map | Same viewport geometry and registry state with light UI preference | Captured; the current map style remains the requested dark raster |
| Cluster expansion | A real registry cluster expanded from zoom 7 to zoom 12; popup reported 12 schools | Captured; the current long member list is visibly taller than the viewport and is not changed by this evidence task |
| School №32 | Exact registry result selected; registry ID `18383`, official coordinates `49.988825, 82.575407`, official registry identity | Captured; popup truthfully says `Не подключена к мониторингу` |
| Incidents | Actual incidents list and incident `#INC-000168` detail | Captured |
| Line detail | Actual `line-99-primary` detail reached from the incident flow | Captured |
| Reports | Actual aggregate, analytics, and quality-passport requests and populated reports surface | Captured |

The registry/mapping boundary is important: the mapping asset currently has
`0` operational entries, `370` registry-only schools, and status
`NOT_PROVIDED`. The browser therefore rendered `0` monitoring markers even
though the API returned 4 authoritative lines. This evidence does not claim a
populated school-to-line map; it records the current runtime's honest
`mapping-incomplete` state.

## Captures

All images below were inspected after the run. Each is `1355x880`.

- [login](../artifacts/task025-runtime-login-1355x880.png)
- [dark map](../artifacts/task025-runtime-map-dark-1355x880.png)
- [light map](../artifacts/task025-runtime-map-light-1355x880.png)
- [expanded cluster](../artifacts/task025-runtime-cluster-expanded-1355x880.png)
- [school №32](../artifacts/task025-runtime-school32-1355x880.png)
- [incidents list](../artifacts/task025-runtime-incidents-list-1355x880.png)
- [incident detail](../artifacts/task025-runtime-incident-detail-1355x880.png)
- [line detail](../artifacts/task025-runtime-line-detail-1355x880.png)
- [reports](../artifacts/task025-runtime-reports-1355x880.png)

## Pre-rebuild visual evidence

No authoritative pre-rebuild screenshot is included. Historical source
revisions such as `17ad322` and `de0331e` are available, but they are old
dashboard implementations with a different shell and dependency/data
boundary. The current Docker runtime cannot reproduce those revisions' exact
historical API/data/tile state, and no canonical pre-rebuild image or
historical runtime fixture is present in the evidence scope. Capturing an old
source snapshot against today's runtime would therefore be misleading, so it
was not presented as a before/after comparison.

## Scope and blockers

Only new acceptance-evidence artifacts and the runner were added. Existing
changes in `web/app.js`, `web/features/secondary-presentation.mjs`,
`web/secondary-presentation.test.cjs`, and the pre-existing task PNGs were not
edited or staged.

There is no browser/runtime blocker for the captured states. The remaining
data blocker is upstream of this evidence task: operational school-to-line
mapping is absent (`0` entries / `NOT_PROVIDED`), so a populated monitoring
marker view cannot truthfully be claimed until that mapping exists.
