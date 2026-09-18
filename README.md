# VKO LINKWATCH

LINKWATCH — контур доказательного мониторинга интернет-линий организаций
образования ВКО. Runtime состоит из Go-сервера, PostgreSQL и нативного Rust
агента; браузерный интерфейс остаётся статическим `web/` и использует прежние
`/api` и `/api/v1` контракты.

> Rust at the edge. Go in the control plane. PostgreSQL as the source of truth.

```text
Windows/Linux device → linkwatch-agent (Rust) → HTTPS REST/JSON →
linkwatch-server (Go) → PostgreSQL
```

## Requirements

Нужны Docker Compose, Go 1.23+ и Rust stable (для локальной сборки агента).
Для production используйте PostgreSQL 16+ через `docker-compose.prod.yml`.

## Quick Start / Docker startup

```bash
docker compose up -d --build
curl http://127.0.0.1:8080/health/ready
```

В development Compose создаёт PostgreSQL-схему и deterministic demo fixture.
Откройте <http://127.0.0.1:8080/> и войдите:

| username | password | область |
| --- | --- | --- |
| `admin` | `demo` | вся область |
| `provider-a` | `demo` | Provider A |
| `district` | `demo` | район Алтай |
| `school-42` | `demo` | Школа №42 |

Одна end-to-end проверка сервера, PostgreSQL и Rust-агента:

```bash
./scripts/smoke.sh
```

## Architecture

- `server/` — Go HTTP API и state engine; PostgreSQL является единственным
  source of truth. Все effective policy/contract snapshots сохраняются рядом с
  observation, а `client_event_id` обеспечивает идемпотентный ingest.
- `agent/` — Rust CLI `run`, `once`, `probe`, `version` и Windows background/tray
  режим. Очередь — crash-safe
  filesystem spool: файл удаляется только после подтверждения сервера; run
  хранит cursor расписания и регулярно flush-ит backlog/heartbeat/config.
- `migrations/001_initial.sql`, `migrations/002_runtime_hardening.sql`,
  `migrations/003_provider_delivery_retry.sql`,
  `migrations/004_schema_invariants.sql`,
  `migrations/005_policy_scope_integrity.sql`,
  `migrations/006_situation_integrity.sql`,
  `migrations/007_agent_telemetry.sql`, `migrations/008_agent_boot_order.sql`,
  `migrations/009_device_hostname.sql` и embedded
  `server/internal/database/migrations/*.sql` — versioned schema.
- `web/` — существующий frontend; API выдаёт совместимые поля `status`,
  `state`, `latest`, `policy`, `contract`, `incidents`, отчёты CSV/XLSX.

Состояния качества, договора и свежести разделены. Нарушение становится
подтверждённым только после последовательных observations по effective policy;
backfill сохраняет evidence и не переписывает текущий state. Закрытие инцидента
требует подтверждённого восстановления. Outbound provider/notification
transport сохраняет попытку до сетевого вызова, `PENDING/DELIVERING/SENT/FAILED`,
retryable-флаг и backoff; notification доставляется через PostgreSQL outbox
после commit и повторяется worker или admin API.

## Configuration and API

Основные маршруты: `/health`, `/health/ready`, `/api/v1/auth/login`,
`/api/v1/agent/measurements:batch`, `/api/v1/agent/heartbeat`,
`/api/v1/agent/config`, `/api/v1/agent/probe/download`,
`/api/v1/agent/probe/upload`, `/api/v1/lines`, `/api/v1/incidents`,
`/api/v1/situations`, `/api/v1/reports/aggregate`,
`/api/v1/reports/quality-passport`, `/api/v1/exports` и `/api/v1/admin/*`.
Администратор может перевыпустить секрет устройства через
`POST /api/v1/admin/devices/{device_id}/rotate-token`; новый `device_token`
возвращается только в ответе этой операции и должен быть сразу сохранён в
секретном хранилище агента.

Heartbeat агента сохраняет на устройстве текущий session `boot_id`, время
старта сессии, monotonic uptime, глубину локальной очереди и статус последней
пробы. Эти поля
диагностические: authoritative `last_seen` по-прежнему вычисляется временем
получения запроса сервером. При rollout сначала применяйте migration 007 и
008 и обновляйте server handler: строгий JSON-декодер старой версии сервера не
принимает новые поля heartbeat.

Локальные параметры находятся в `.env.example`; production-шаблон —
`.env.prod.example`. Секреты не должны попадать в git. Для production задайте
`LINKWATCH_ENV=production`, PostgreSQL credentials, bootstrap admin (пароль не
короче 12 символов), `LINKWATCH_PUBLIC_HOST`, `LINKWATCH_TLS_EMAIL`, HTTPS CORS
origins и webhook transport.

В production TLS завершается единственным reverse proxy Caddy из
`deployment/Caddyfile`: внешний клиент → `80/443` → Caddy → внутренняя
Compose-сеть → `linkwatch-server:8080`. Go listener не публикуется на host;
Caddy сам выполняет HTTP→HTTPS redirect и хранит ACME-состояние в named volume.
После DNS/ACME настройки выполните `LINKWATCH_PUBLIC_URL=https://...`
`./scripts/production-tls-smoke.sh`: он проверяет redirect, certificate
validation, readiness и отказ unauthenticated protected endpoint.

Агент принимает `LINKWATCH_*`; старые `VKO_*` имена поддерживаются для плавной
миграции. Приоритет локальной конфигурации: defaults → JSON-файл → environment.
Если задать `LINKWATCH_USE_SERVER_CONFIG=1`, расписание из
`/api/v1/agent/config` применяется после локальных значений и обновляется во
время run; при недоступности сервера агент продолжает работу с локальной
конфигурацией и очередью. Batch endpoint возвращает per-item results, поэтому
частично принятый пакет безопасно повторять. Пример:

```bash
LINKWATCH_SERVER_URL=http://127.0.0.1:8080 \
LINKWATCH_DEVICE_ID=device-42-primary \
LINKWATCH_DEVICE_TOKEN=demo-device-42-primary-token \
LINKWATCH_PROBE=demo \
cargo run --release --manifest-path agent/Cargo.toml -- once
```

## Development and Tests

```bash
make server-test
make agent-test
make smoke
```

Для PowerShell используйте `scripts/windows/start-vko-prod.ps1` и
`scripts/windows/stop-vko-prod.ps1`; они запускают Go image из
`docker-compose.prod.yml`. Windows binary агента собирается
`scripts/build-agent.ps1` в `dist/linkwatch-agent-windows-amd64.exe`.
На Windows запуск этого единственного бинаря без аргументов выполняет
первоначальную регистрацию service/tray и переносит runtime data в
`C:\ProgramData\LINKWATCH`; постоянный terminal не нужен. `uninstall` удаляет
службу и бинарь, сохраняя queue/config, а `uninstall --purge-data` удаляет данные
явно.
После сборки доступны обычные native-команды:

```powershell
.\dist\linkwatch-agent-windows-amd64.exe version
.\dist\linkwatch-agent-windows-amd64.exe probe
.\dist\linkwatch-agent-windows-amd64.exe once
```

На нативной Windows можно также выполнить `cargo build --release
--manifest-path agent/Cargo.toml`; результатом будет
`agent\target\release\linkwatch-agent.exe`. В WSL/Linux для кросс-сборки
передайте скрипту `-Target x86_64-pc-windows-gnu` и установите соответствующий
linker.

Для разработки без Compose можно собрать сервер и агент командами `make
build-server` и `make build-agent`; полный набор проверок — `make test-server`,
`make test-agent` и `make smoke`.
