# TASK-022 Native Windows acceptance (`EXT-002`)

Статус текущего checkout: **NOT RUN — native Windows environment unavailable**.
Этот документ подготовлен как authoritative execution record для TASK-022.
Ни один native Windows PASS здесь не заявляется по результатам Linux/WSL или
Docker-only проверок.

## TASK-007 production startup readiness (`BUG-006`)

### Preconditions

- Windows host with Docker Desktop and Docker Compose v2;
- DNS for `LINKWATCH_PUBLIC_HOST` points to the host and inbound `80/443` are
  available, or an explicitly configured Caddy HTTPS test surface is used;
- production credentials are supplied through the PowerShell environment or a
  secret manager; no populated `.env` or credentials belong in git;
- the host has the checked-out repository and the required Docker build access.

### Native commands

Set the required environment values from the approved secret source, then run:

```powershell
$env:LINKWATCH_ENV = "production"
$env:LINKWATCH_POSTGRES_DB = "linkwatch"
$env:LINKWATCH_POSTGRES_USER = "linkwatch"
$env:LINKWATCH_POSTGRES_PASSWORD = "<secret-from-approved-source>"
$env:LINKWATCH_BOOTSTRAP_ADMIN_USERNAME = "<admin-name>"
$env:LINKWATCH_BOOTSTRAP_ADMIN_PASSWORD = "<12-plus-character-secret>"
$env:LINKWATCH_PUBLIC_HOST = "monitoring.example"
$env:LINKWATCH_PUBLIC_URL = "https://monitoring.example"
$env:LINKWATCH_TLS_EMAIL = "ops@example.com"

.\scripts\windows\test-vko-prod.ps1
.\scripts\windows\start-vko-prod.ps1 -ReadinessTimeoutSec 180
$exitCode = $LASTEXITCODE
```

Expected result:

- topology check exits `0` and reports backend `expose: 8080` only plus Caddy
  `80/443`;
- startup exits `0` only after `https://monitoring.example/health/ready` returns
  HTTP 200;
- a timeout or failed Compose command exits non-zero and prints Compose status
  plus Caddy/server/PostgreSQL logs;
- no host probe targets `127.0.0.1:8000`, and no backend `ports` mapping is added.

Stop the production-like stack after the run:

```powershell
.\scripts\windows\stop-vko-prod.ps1
```

### Execution record

| Check | Expected evidence | Actual result | Status |
|---|---|---|---|
| Production topology script | `test-vko-prod.ps1` reports PASS | Not executed on Windows | NOT RUN |
| Caddy HTTPS readiness | startup returns `0`, public `/health/ready` is HTTP 200 | Not executed on Windows | NOT RUN |
| Failure diagnostics | forced/unavailable readiness returns non-zero with service logs | Not executed on Windows | NOT RUN |
| Backend boundary | no `linkwatch-server` host `ports`, Caddy remains public boundary | Linux Compose inspection only; not native evidence | NOT RUN |

## Remaining TASK-022 native matrix

The following rows still require an actual Windows run and exact binary
identity/hash in this report before they can be marked PASS:

| Row | Status |
|---|---|
| Clean install and service registration | NOT RUN |
| Auto-start, restart recovery and reboot recovery | NOT RUN |
| Uninstall, purge and reinstall preservation semantics | NOT RUN |
| Tray IPC and diagnostics | NOT RUN |
| Update replacement and activation (installed artifact != running version before activation) | NOT RUN |

This TASK-007 change does not modify the agent updater, Windows installer,
service lifecycle, tray IPC or update activation code. Those rows must be tested
separately on native Windows; a successful Linux build, unit test, WSL run or
Docker startup must not be recorded as native PASS.
