# TASK-021 frontend E2E acceptance

Date: 2026-09-20 (Asia/Oral)

Status: **PASS** for the rebuilt frontend scaffold and map workflow.

## Command

```text
PLAYWRIGHT_MODULE=/tmp/gov-ethernet-playwright/node_modules/playwright/index.mjs \
BROWSER_E2E_CHROMIUM=/home/amblackrust/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome \
BROWSER_E2E_BASE_URL=http://127.0.0.1:8080 \
node scripts/browser-e2e.mjs
```

Result:

```text
BROWSER E2E PASS: live scaffold surfaces PASS=16 FAIL=0 BLOCKED_EXTERNAL=0; demo=off
```

The run used a test-only Playwright route fixture for registry, mapping, API,
and tile requests. The fixture is isolated to `scripts/browser-e2e.mjs`; it is
not a production fallback and the URL contains no demo query parameter.

## Covered journeys

- authenticated shell, `/auth/me` reload, capability-gated navigation, and real logout;
- full-screen Leaflet map with one tool stack and 1355×880 geometry;
- reports and incidents routes with real filters and honest empty-state copy;
- RU/KK locale switching and browser-storage persistence;
- registry-only school neutrality and monitored-school LineState presentation;
- contextual line detail with preserved line identity;
- official school search, including school №32 (`registry_id=18383`), map focus,
  zero-result state, district/provider/status/coverage filters, and filtered counts;
- historical mode boundary and neutral registry clustering with member selection;
- backend unavailable, invalid login, invalid stored token, and logout failure paths;
- dark/light theme transition with unchanged canonical geometry.

The browser run also confirms that school focus cancels a pending map movement
before applying the single-school zoom and that clusters are rebuilt against the
viewport established by each render.
