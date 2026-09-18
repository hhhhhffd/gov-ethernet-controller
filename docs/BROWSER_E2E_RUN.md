# Browser E2E acceptance run

Дата прогона: 2026-09-18. Runtime: local Docker Compose (`linkwatch-server` и
`postgres` healthy), base URL `http://127.0.0.1:8080`.

## Что прошло

- `P0_ACCEPTANCE_BASE_URL=http://127.0.0.1:8080 ./scripts/p0-acceptance.sh`:
  32 API/local checks passed, 0 failures.
- `scripts/p0-local-acceptance.sh`: 12 local scenarios passed, включая ingest →
  evaluation → incident, NO_DATA, ProviderCase human-send gate и static web
  shell contract.
- `node --check web/app.js`: passed.
- Static browser contract: `/`, `/static/app.js`, `/static/styles.css` — HTTP
  200; canonical `NO_DATA`/notifications vocabulary present.

Run the authenticated browser runner in an environment that provides
Playwright:

```bash
PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs \
BROWSER_E2E_BASE_URL=http://127.0.0.1:8080 \
node scripts/browser-e2e.mjs
```

## Browser E2E result

After rerunning with the required escalated local-runtime permission,
Playwright executed `scripts/browser-e2e.mjs` against system Chromium
(`/usr/sbin/chromium`) successfully:

```text
BROWSER E2E PASS: admin/provider authenticated journeys
```

The runner covers authenticated admin and provider login, line/history/report
surfaces, notifications/audit, export download, ProviderCase review gate and
provider workspace visibility/scope, provider admin `403`, plus a mobile
viewport shell check. It uses the existing Playwright installation supplied by
the execution environment through `PLAYWRIGHT_MODULE`; no frontend dependency
was added to the repository.

An un-escalated launch still fails with the environment's crashpad permission
error (`setsockopt: Operation not permitted`, `SIGTRAP`); the passing run used
the required escalated runtime permission.

## Not claimed

Native Windows, public TLS/ACME, and authorized external provider delivery
remain external acceptance gates. API/static checks above do not substitute for
those browser or integration journeys.
