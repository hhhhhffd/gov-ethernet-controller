# TASK-022 pixel-locked screenshot QA

Date: 2026-09-20 (Asia/Oral)

Status: **PASS** for the applicable reference geometry and visual system.

## Canonical captures

The browser harness captured the authenticated map at exactly 1355×880:

- [dark canonical capture](../artifacts/task022-dark-1355x880.png)
- [light canonical capture](../artifacts/task022-light-1355x880.png)
- [shell regression capture](../artifacts/task006-shell-1355x880.png)
- [selected registry school №32](../artifacts/task022-selected-school-1355x880.png)
- [monitored-school popup](../artifacts/task022-monitoring-school-1355x880.png)
- [line detail drawer](../artifacts/task022-line-detail-1355x880.png)
- [Incidents empty state](../artifacts/task022-incidents-1355x880.png)
- [Reports empty/history state](../artifacts/task022-reports-1355x880.png)
- [Login](../artifacts/task022-login-1355x880.png)

The captures were visually inspected after the passing browser run. The map
tile request is deliberately a one-pixel test tile, so these images verify shell
geometry and contrast hierarchy; they do not claim external tile-rendering
evidence. The canonical Stadia Alidade Smooth Dark URL and attribution are
covered by the web map checks.

The selected-school, detail-drawer, Incidents, Reports, and Login captures are
also produced by the same 1355×880 browser run, so they use the same shell
geometry rather than a separate screenshot harness.

## Automated geometry evidence

`scripts/browser-e2e.mjs` records bounding boxes for the map workspace, shell,
primary navigation, search input, and right-edge map tools in dark mode, then
repeats the snapshot in light mode. The snapshots are equal, and the run
reported:

```text
PASS full-screen map shell: ... one map tool stack is visible, and dark/light geometry matches
```

## Hard checklist

| Area | Result | Evidence |
|---|---|---|
| Top-left logo/nav islands | PASS | Standalone logo; independent 37px nav surfaces; no common wrapper or underline. |
| Top-center context island | Product override | The map workflow has no legitimate previous/context/next object; no fake control was added. |
| Top-right utilities | PASS | Compact locale, theme, refresh, and account utilities remain detached islands. |
| Workspace | PASS | Map reaches the viewport; no header strip, classic sidebar, or dashboard grid. |
| Persistent left object | PASS | Search/filter island remains compact and progressively discloses filters. |
| Right edge | PASS | Exactly three compact square map tools with no visible rail wrapper. |
| Bottom/context dock | Product override | No independent bottom action exists in the real map contract; status metadata stays quiet at the edge. |
| Palette/type/radii | PASS | Neutral dark canvas, subtle borders, restrained shadows, compact sans-serif controls, and locked radii. |
| Blur/component-library smell tests | PASS | Broad silhouette is a sparse workspace with small islands, not a header/sidebar/card dashboard. |
| No visual slop | PASS | No gradient chrome, glass, glow, fake telemetry, decorative KPI block, or monospace UI copy. |

Light mode intentionally keeps the canonical dark map presentation through the
explicit `preserve-canonical-dark-basemap` adapter state; only application
chrome changes theme tokens, and geometry remains locked.
