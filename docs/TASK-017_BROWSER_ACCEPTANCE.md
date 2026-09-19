# TASK-017 live backend browser acceptance

Date: 2026-09-19

Scope: `scripts/browser-e2e.mjs` and this acceptance artifact only. No changes were
made to `web/app.js`, `web/index.html`, styles, or the Go backend.

## Auth regression result

The reported overview `401` was reproduced as the unauthenticated boot request,
not as a failed post-login session. The old harness treated the initial `401`
state (and its zero-line rendering) as readiness and could continue before the
login flow had established a session.

The harness now requires all of the following before it exercises live surfaces:

- the auth modal is hidden;
- `localStorage.vko_token` exists;
- authenticated `/api/v1/auth/me` returns `200`;
- authenticated `/api/v1/lines` returns `200`;
- the rendered live line count matches the authenticated API response;
- the URL has no `?demo=1`.

Current live alias probe, using the configured backend at
`http://127.0.0.1:8080`, returned:

```text
/api/login             200, token present
/api/v1/auth/login     200
/api/auth/me           200
/api/v1/auth/me        200
/api/overview          200
/api/v1/overview       200
/api/lines             200
/api/v1/lines          200
```

The UI login used `admin` / `demo`, persisted the token, and rendered the live
overview values (`Download=73.36363636363636`, `Upload=73.54545454545455`,
`Ping=27.90909090909091`) with four live lines. This confirms the provider
regression is a harness readiness race; no auth/API implementation change was
necessary.

## Verification commands

Local syntax checks:

```text
node --check web/app.js                         PASS (product file inspected only)
node --check scripts/browser-e2e.mjs            PASS
git diff --check -- scripts/browser-e2e.mjs     PASS
```

Live browser command:

```text
PLAYWRIGHT_MODULE=/home/amblackrust/projects/new-front-dales-main/frontend/node_modules/playwright/index.mjs \
BROWSER_E2E_CHROMIUM=/home/amblackrust/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome \
BROWSER_E2E_BASE_URL=http://127.0.0.1:8080 \
node scripts/browser-e2e.mjs
```

The run used the real backend and no demo query parameter. Final result:

```text
BROWSER E2E BLOCKED: live browser surfaces PASS=23 FAIL=0 BLOCKED_EXTERNAL=4; demo=off
```

## Surface evidence

Passing live browser surfaces: login, overview, current map and popup keyboard
path, school grouping, line detail, device detail, history modes, incident
list/detail, manual incident, notifications, situations, quality passport,
analytics, export preview, CSV, XLSX, audit, agent version view, admin,
contract admin, error states, backend-unavailable state, and authentication
error states.

The run verified 401 unauthenticated API access, invalid-login UI, provider
403 admin boundary, missing-line 404, invalid manual mutation 404, and
contract-overlap rejection 409. Aborted API requests rendered an explicit
unavailable state with zero live lines and no sample rows.

The following surfaces are `BLOCKED_EXTERNAL`, not PASS or FAIL: ProviderCase,
AI draft, human review, and provider send. The live `/api/v1/provider-cases`
queue returned HTTP 200 with no cases. No fake case, demo data, or mutating
fixture was introduced, so populated provider workflow evidence requires an
authorized live ProviderCase fixture outside this harness-only change.

