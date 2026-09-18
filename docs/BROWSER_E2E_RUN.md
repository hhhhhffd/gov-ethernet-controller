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

## Browser blocker

Playwright package is available only outside this repository and was invoked
against the system Chromium (`/usr/sbin/chromium`). Chromium exits before
creating a page with:

```text
ERROR: third_party/crashpad/crashpad/util/linux/socket.cc:45:
setsockopt: Operation not permitted
process did exit ... signal=SIGTRAP
```

The same failure occurs with headless Chromium and `--no-sandbox
--disable-crash-reporter`. Consequently no authenticated DOM, screenshot,
keyboard, or visual assertions are claimed. No Playwright dependency or
parallel frontend harness was added; rerun the browser matrix in an
environment with a working Chromium sandbox/crashpad runtime.

## Not claimed

Native Windows, public TLS/ACME, and authorized external provider delivery
remain external acceptance gates. API/static checks above do not substitute for
those browser or integration journeys.
