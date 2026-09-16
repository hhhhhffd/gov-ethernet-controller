# Отчёт production-like прогона LINKWATCH

Дата: 16 сентября 2026 г. Стенд: Docker Compose, PostgreSQL 16, Go 1.23
server image и Rust 2021 agent.

## Результат

- `docker compose up -d --build` собрал multi-stage image без Python runtime;
- PostgreSQL и `linkwatch-server` получили статус `healthy`;
- embedded migration создала доменные таблицы и `schema_migrations`;
- `/health`, `/health/live`, `/health/ready`, login, scope-фильтры, agent batch,
  incidents, provider case, reports и static `web/` проверены HTTP-запросами;
- `cargo test --manifest-path agent/Cargo.toml` прошёл (7 unit-тестов);
- в репозитории присутствует проверенный `dist/linkwatch-agent-windows-amd64.exe`
  (`PE32+ x86-64`, 1,996,288 bytes; `file` подтвердил Windows PE); native
  Windows build path задокументирован в `scripts/build-agent.ps1`;
- Linux release binary: 2,162,064 bytes; локальное измерение показало около
  3.7 MiB RSS / 0.0% CPU в idle и около 3.6 MiB RSS во время `once`;
- `go test ./...` в `server/` прошёл;
- `./scripts/smoke.sh` — канонический повторяемый E2E прогон (Compose + Rust
  `once` + PostgreSQL persistence).

Для локального теста занятие порта можно изменить через
`LINKWATCH_SERVER_PORT=18080`; внутренний server всегда слушает `:8080`.

## Архитектура

`Organization → Line → ContractVersion → MonitoringPoint/Device → Measurement →
Evaluation → LineState → Incident → ProviderCase → Recovery → Passport/Export`.
PostgreSQL — единственный source of truth. Evaluation хранит snapshots effective
policy/contract. Уникальная пара `(device_id, client_event_id)` делает batch
идемпотентным. Backfill записывается как evidence и не переписывает watermark
текущего состояния. Инцидент закрывается только после последовательного
подтверждения recovery.

Агент — native Rust binary с CLI `run`, `once`, `probe`, `version`. Filesystem
spool использует временный файл + `fsync` + atomic rename; подтверждённые server
rows удаляются, ошибки оставляют очередь для retry. Demo probe доступен только в
development/staging, network probe не запускает shell.

## Production-профиль

`docker-compose.prod.yml` требует `LINKWATCH_POSTGRES_PASSWORD`, отключает
demo seed/auth bypass и использует HTTPS webhook transport по умолчанию.
Пустая БД требует `LINKWATCH_BOOTSTRAP_ADMIN_USERNAME` и пароль длиной не менее
12 символов. Секреты передаются только через environment/secret store.
TLS reverse proxy, firewall, rotation device tokens и нагрузочный прогон остаются
обязанностями deployment-окружения.

## Ограничения проверки

PowerShell непосредственно в Linux-сессии не запускался; для нативной Windows
сборки остаётся `scripts/build-agent.ps1`. Браузерный Playwright прогон здесь не
выполнялся, но static UI и API contract проверены curl smoke. Никакие persistent
volumes не удалялись.
