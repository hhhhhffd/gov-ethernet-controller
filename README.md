# VKO LINKWATCH

LINKWATCH — контур доказательного мониторинга интернет-линий организаций
образования ВКО. Runtime состоит из Go-сервера, PostgreSQL и нативного Rust
агента; браузерный интерфейс остаётся статическим `web/` и использует прежние
`/api` и `/api/v1` контракты.

## Быстрый запуск

Нужны Docker Compose, Go 1.23+ и Rust stable (для локального запуска агента).

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

## Компоненты и инварианты

- `server/` — Go HTTP API и state engine; PostgreSQL является единственным
  source of truth. Все effective policy/contract snapshots сохраняются рядом с
  observation, а `client_event_id` обеспечивает идемпотентный ingest.
- `agent/` — Rust CLI `run`, `once`, `probe`, `version`. Очередь — crash-safe
  filesystem spool: файл удаляется только после подтверждения сервера.
- `migrations/001_initial.sql` и embedded
  `server/internal/database/migrations/001_initial.sql` — versioned schema.
- `web/` — существующий frontend; API выдаёт совместимые поля `status`,
  `state`, `latest`, `policy`, `contract`, `incidents`, отчёты CSV/XLSX.

Состояния качества, договора и свежести разделены. Нарушение становится
подтверждённым только после последовательных observations по effective policy;
backfill сохраняет evidence и не переписывает текущий state. Закрытие инцидента
требует подтверждённого восстановления. Outbound provider/notification
transport сохраняет `FAILED`, число попыток и ошибку; повтор выполняется через
admin API.

## API и конфигурация

Основные маршруты: `/health`, `/health/ready`, `/api/v1/auth/login`,
`/api/v1/agent/measurements:batch`, `/api/v1/agent/heartbeat`,
`/api/v1/agent/config`, `/api/v1/lines`, `/api/v1/incidents`,
`/api/v1/situations`, `/api/v1/reports/aggregate`,
`/api/v1/reports/quality-passport`, `/api/v1/exports` и `/api/v1/admin/*`.

Локальные параметры находятся в `.env.example`; production-шаблон —
`.env.prod.example`. Секреты не должны попадать в git. Для production задайте
`LINKWATCH_ENV=production`, PostgreSQL credentials, bootstrap admin (пароль не
короче 12 символов), HTTPS CORS origins и webhook transport.

Агент принимает `LINKWATCH_*`; старые `VKO_*` имена поддерживаются для плавной
миграции. Приоритет локальной конфигурации: defaults → JSON-файл → environment.
Если задать `LINKWATCH_USE_SERVER_CONFIG=1`, расписание из
`/api/v1/agent/config` применяется после локальных значений; при недоступности
сервера агент продолжает работу с локальной конфигурацией и очередью. Пример:

```bash
LINKWATCH_SERVER_URL=http://127.0.0.1:8080 \
LINKWATCH_DEVICE_ID=device-42-primary \
LINKWATCH_DEVICE_TOKEN=demo-device-42-primary-token \
LINKWATCH_PROBE=demo \
cargo run --release --manifest-path agent/Cargo.toml -- once
```

## Проверки и production-like запуск

```bash
make server-test
make agent-test
make smoke
```

Для PowerShell используйте `scripts/windows/start-vko-prod.ps1` и
`scripts/windows/stop-vko-prod.ps1`; они запускают Go image из
`docker-compose.prod.yml`. Windows binary агента собирается
`scripts/build-agent.ps1` в `dist/linkwatch-agent-windows-amd64.exe`.
