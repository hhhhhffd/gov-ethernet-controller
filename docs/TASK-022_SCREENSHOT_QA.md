# TASK-022 pixel-locked screenshot QA

Date: 2026-09-20 (Asia/Oral)

Status: **BOUNDED**. The shell geometry and visual rules are evidenced by
fixture captures; production tile rendering and populated runtime states are
not evidenced here.

## Evidence classification

| Class | Meaning |
|---|---|
| `PASS` | The visual assertion is directly supported by the captured fixture or automated geometry check. |
| `BOUNDED` | The assertion is valid only for the declared fixture/state and cannot stand for production visual acceptance. |
| `EXTERNAL` | Real Stadia tiles or a populated production browser render still require an environment not captured by this record. |

## Canonical captures

The browser harness captured the authenticated shell at exactly 1355×880:

- [dark canonical capture](../artifacts/task022-dark-1355x880.png)
- [light canonical capture](../artifacts/task022-light-1355x880.png)
- [shell regression capture](../artifacts/task006-shell-1355x880.png)
- [selected registry school №32](../artifacts/task022-selected-school-1355x880.png)
- [monitored-school popup](../artifacts/task022-monitoring-school-1355x880.png)
- [line detail drawer](../artifacts/task022-line-detail-1355x880.png)
- [Incidents empty state](../artifacts/task022-incidents-1355x880.png)
- [Reports empty/history state](../artifacts/task022-reports-1355x880.png)
- [Login](../artifacts/task022-login-1355x880.png)

These captures come from the fixture E2E run described in TASK-021. The tile
request is deliberately fulfilled with a one-pixel test PNG, and the registry,
mapping, API responses, and populated line are fixture data. The images prove
shell geometry, contrast hierarchy, and empty-state composition only; they do
not prove Stadia raster rendering, the real 370-school distribution, or a live
operational mapping. The current reconciliation commit does not alter or stage
the existing screenshot artifacts.

## Automated geometry evidence

`scripts/browser-e2e.mjs` records bounding boxes for the map workspace, shell,
primary navigation, search input, and right-edge map tools in dark mode, then
repeats the snapshot in light mode. The snapshots are equal in the recorded
fixture run:

```text
PASS full-screen map shell: map fills 1355×880, shell is isolated, nav is
capability-aware, one map tool stack is visible, and dark/light geometry matches
```

The current `make web-test` run also passes the theme geometry and secondary
surface checks. These are `PASS` for the tested code/fixture boundary, not a
release-wide production screenshot claim.

## Hard checklist

| Area | Result | Evidence / limit |
|---|---|---|
| Top-left logo/nav islands | PASS | Fixture capture and geometry assertions show standalone logo and independent 37px nav surfaces without a common wrapper or underline. |
| Top-center context island | PASS by product override | The map workflow has no legitimate previous/context/next object; no fake control was added. |
| Top-right utilities | PASS | Compact locale, theme, refresh, notification, and account utilities remain detached islands in the captured shell. |
| Workspace | PASS within fixture | Map reaches the viewport; no header strip, classic sidebar, or dashboard grid is present in the shell. |
| Persistent left object | PASS within fixture | Search/filter island is compact and progressively discloses filters. |
| Right edge | PASS within fixture | Exactly three compact square map tools are visible; native Leaflet zoom controls are absent. |
| Bottom/context dock | PASS by product override | No independent bottom action exists in the real map contract; no fake dock was added. |
| Palette/type/radii | PASS within fixture | Neutral canvas, subtle borders, restrained shadows, compact sans-serif controls, and locked radii are present. |
| Blur/component-library smell tests | BOUNDED | The fixture silhouette is sparse and not a dashboard, but no populated production render was reviewed. |
| No visual slop | PASS for source/content checks | Current web tests find no gradient chrome, glass, glow, fake telemetry, decorative KPI block, or monospace UI copy. |
| Real Alidade Smooth Dark raster | EXTERNAL | The canonical URL and attribution are present in map code; the E2E tile was intentionally mocked, so raster output was not visually verified. |

Light mode intentionally keeps the canonical dark map presentation through the
explicit `preserve-canonical-dark-basemap` adapter state. Application chrome
changes theme tokens while geometry remains equal; this is an intentional
product-specific override, not evidence that a separate light tile set was
rendered.

## Acceptance decision

TASK-022 is not a release-complete `PASS`. It is `BOUNDED` until a real-runtime
browser capture with the production registry/API and an available Stadia tile
path is recorded, or the external tile limitation is explicitly accepted by a
separate release decision.
