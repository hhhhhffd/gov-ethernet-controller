# TASK-021 frontend E2E acceptance

Date: 2026-09-20 (Asia/Oral)

Status: **BOUNDED**. The fixture browser suite passes, but it is not
production-runtime acceptance.

## Evidence classification

| Class | Meaning in this record |
|---|---|
| `PASS` | The stated check ran and passed within its declared boundary. |
| `BOUNDED` | The check passes, but its fixture, surface, or environment boundary prevents a release-wide claim. |
| `EXTERNAL` | The required evidence needs a runtime, browser, provider, or host capability not captured here. |

## Recorded fixture run

Command:

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

The result is **PASS within the fixture boundary** and therefore **BOUNDED**
for release acceptance. `scripts/browser-e2e.mjs` intercepts every `/api/**`
request, the registry and organization-mapping assets, and Stadia tile
requests. Its fixture contains three schools, one fixture line, and a 1×1 PNG
tile; the `№32` row uses a fixture copy of the identity and coordinates. It
does not load the production 370-row registry or a live operational mapping.
The interception is test-only and is not a production fallback; `demo=off`
confirms that the explicit demo path was not used.

## Journeys proved inside that boundary

- authenticated shell, `/auth/me` reload, capability-gated navigation, and
  logout/local cleanup;
- full-screen Leaflet map with one custom tool stack and 1355×880 geometry;
- reports and incidents routes with real controls and honest empty-state copy;
- RU/KK locale switching and browser-storage persistence;
- registry-only neutrality and monitored-school LineState presentation;
- contextual line detail with preserved fixture line identity;
- search, keyboard combobox selection, zero-result state, district/provider/
  status/coverage filters, and filtered counts;
- historical/current separation and neutral cluster member selection;
- unavailable backend/registry, invalid login, invalid stored token, and
  logout-failure paths;
- dark/light theme transition with unchanged canonical geometry;
- browser Back/Forward route restoration, zoom controls, and the compact
  narrow-width navigation boundary.

## Production-runtime boundary

The current runtime has separate direct HTTP evidence recorded in
`docs/FRONTEND_ACCEPTANCE_EVIDENCE_2026-09-20.md`: Docker/PostgreSQL/server
are healthy, `/health/ready` returns `200`, and `.mjs` is served as
`text/javascript`. Those checks prove the server asset boundary, not a
populated authenticated browser journey.

No post-MIME-fix browser run against the real runtime with the production
370-school asset and live API is recorded in this task. The fixture run must
therefore not be promoted to `MAP-002`, `DATA-001`, or release-level auth and
workflow proof. A real populated browser replay remains `EXTERNAL` evidence.

The full 370-school identity and school №32 coordinate are separately covered
by map/data tests and the frozen map baseline; that is stronger than a fixture
claim for data integrity, but it is not a substitute for real-runtime browser
evidence.
