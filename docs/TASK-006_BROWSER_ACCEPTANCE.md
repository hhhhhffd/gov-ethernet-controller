# TASK-006 browser acceptance

Date: 2026-09-20. Scope: full-screen map shell, compact primary navigation,
map filter island, and the single custom map tool stack.

## Static and map regression checks

```text
node --check web/app.js                         PASS
node --check scripts/browser-e2e.mjs            PASS
./scripts/web-foundation-check.sh               PASS
```

The foundation script also passed the existing Leaflet marker, data-model, and
popup context tests. `git diff --check` passed.

## Browser result

```text
BROWSER E2E BLOCKED: live scaffold surfaces PASS=0 FAIL=0 BLOCKED_EXTERNAL=1; demo=off
BLOCKED_EXTERNAL browser harness: Playwright unavailable: Cannot find package 'playwright'
```

The canonical 1355×880 screenshot was not captured because the browser runner
cannot load its Playwright dependency. The connected browser fallback was also
unavailable: Chromium was not present at `/opt/google/chrome/chrome`.

The harness now contains the live assertions for viewport-sized map geometry,
legacy-surface absence, three capability-aware primary destinations, one zoom
and fit/reset stack, route/hash effect, and screenshot path
`artifacts/task006-shell-1355x880.png`; no screenshot is claimed from the
blocked run.
