# LINKWATCH

Платформа мониторинга качества интернет-линий в школах и других организациях: от измерения на edge-устройстве и проверки политики договора до инцидента, обращения провайдеру, подтверждённого восстановления и отчёта.

[Репозиторий на GitHub](https://github.com/hhhhhffd/gov-ethernet-controller)

> **Статус проекта.** Локальный Docker Compose-сценарий и основные серверные/агентские проверки находятся в репозитории. Публичный выпуск нельзя считать полностью принятым без внешних проверок TLS/ACME, авторизованной доставки провайдеру, non-WEB-уведомлений и полного acceptance native Windows. См. раздел [Перед публичным релизом](#перед-публичным-релизом).

## Что решает LINKWATCH

LINKWATCH связывает техническое измерение линии с операционной работой:

~~~text
Организация → Линия → Договор/политика → Точка мониторинга → Устройство
      → Измерение → Оценка → Текущее состояние линии → Инцидент
      → Обращение провайдеру → Подтверждённое восстановление → Отчёты
~~~

Система рассчитана на сценарий, в котором важно не просто увидеть «линия плохая», а сохранить доказательство того, что произошло, кто и когда отреагировал, какое обращение было отправлено и чем подтверждено восстановление.

## Возможности

| Область | Что есть в проекте |
| --- | --- |
| Карта и реестр | Карта точек мониторинга на Leaflet, школы из реестра ВКО, привязка организации к провайдеру и линии, статусы и быстрый переход к деталям. |
| Edge-мониторинг | Нативный Rust-агент для Windows и Linux: heartbeat, измерения, probe, локальная очередь при отсутствии связи и повторная отправка. |
| Доказательные измерения | client_event_id для идемпотентного ingest, снимки действующей политики и договора, разделение обычных и backfill-измерений. |
| Инциденты | Жизненный цикл инцидента, timeline событий, комментарии, ответственные, смена статуса и закрытие только после подтверждённого восстановления. |
| Ситуации | Группировка связанных инцидентов, affected schools, факторы, live-проверка, сравнение, объединение и разделение. |
| Обращения | ProviderCase workspace: AI-черновик, ручная проверка, отправка, retry после ошибки доставки и история попыток. |
| Отчёты | Сводка, аналитика, паспорт качества, доказательный отчёт и экспорт в HTML/CSV/XLSX/JSON. |
| Уведомления | Outbox и сохранённые delivery attempts для web, webhook, email/SMTP и Telegram; retry там, где транспорт это поддерживает. |
| Управление и аудит | Администрирование организаций, школ, провайдеров, линий, устройств и политик; capability-проверки, scopes и журнал действий. |

## Архитектура

~~~mermaid
flowchart LR
    Registry[Реестр школ ВКО] --> Web[Web UI]
    Agent[LINKWATCH Agent<br/>Windows / Linux] -->|heartbeat + measurements| API[Go API]
    User[Оператор] --> Web
    Caddy[Caddy<br/>TLS / reverse proxy] --> API
    Web --> API
    API --> PG[(PostgreSQL)]
    API --> Workers[Outbox / freshness / situations / agent commands]
    Workers --> PG
    API --> Provider[Provider transport]
    API --> Notify[Notification transports]
~~~

### Границы компонентов

- server/ — production runtime: Go API, аутентификация, авторизация, бизнес-правила, миграции, фоновые workers и статический web.
- agent/ — Rust 2021 edge-бинарник. Он собирает измерения, держит локальную очередь и общается с API по агентскому протоколу.
- web/ — статический frontend на JavaScript/MJS и CSS. React/Vue/Svelte для runtime не требуются; Leaflet поставляется локально.
- PostgreSQL — источник истины. SQLite и in-memory storage не используются в production path.
- deployment/ и docker-compose.prod.yml — внешний Caddy с HTTPS/ACME и production-окружение.

## Быстрый старт

### Требования

- Docker Engine с Compose v2;
- Git;
- для локальной разработки без контейнеров: Go 1.23+, Rust stable и Node.js для web-проверок;
- для AI-черновиков локально — необязательно — Ollama с доступной моделью.

### Запуск полного локального стенда

~~~bash
docker compose up -d --build
curl -fsS http://127.0.0.1:8080/health/ready
~~~

Откройте <http://127.0.0.1:8080>.

Development Compose поднимает PostgreSQL и LINKWATCH API, применяет миграции и по умолчанию включает демо-данные. Для другого окружения можно создать локальный .env из .env.example:

~~~bash
cp .env.example .env
docker compose up -d --build
~~~

Остановка без удаления данных:

~~~bash
docker compose down
~~~

docker compose down -v удаляет локальный PostgreSQL volume. Используйте эту команду только когда действительно нужно начать демо-базу заново.

### Демо-пользователи

При включённом seed доступны локальные пользователи с паролем demo:

| Логин | Роль | Область |
| --- | --- | --- |
| admin | ADMIN | вся система |
| oblast | OBLAST | область |
| district | DISTRICT | район Altai |
| provider-a | PROVIDER | Provider A |
| school-42 | SCHOOL | организация org-42 |

Эти учётные данные предназначены только для локального стенда. Не используйте их в production.

### Проверка стенда

~~~bash
make smoke
~~~

Smoke-проверка поднимает/проверяет Compose-сценарий, запускает offline-путь Rust-агента, resend и проверку идемпотентности ingest. Она использует демо-данные и может менять локальную базу.

Для быстрой ручной демонстрации можно сбросить только демо-данные через предусмотренный endpoint:

~~~bash
./scripts/manual-demo-reset.sh
~~~

Скрипт предназначен только для development и не должен запускаться против production URL.

## Frontend

Frontend собран вокруг рабочих пространств master-detail:

- **Карта** — карта и выбранная школа/линия с быстрыми действиями;
- **Инциденты** — список слева и inspector выбранного инцидента справа;
- **Ситуации** — отдельный list/detail workspace для связанных проблем;
- **Обращения** — реальные ProviderCase, редактор текста, review, отправка и retry;
- **Отчёты** — query pane и report stage с одинаковой композицией блоков;
- **Уведомления** — компактный delivery workspace из правой панели приложения;
- **Управление** — ресурсы слева, записи по центру, editor справа;
- **Аудит** — список действий и человекочитаемый detail.

Frontend использует backend-контракты, а не mock numbers. Подробная матрица возможностей и маршрутов: [docs/frontend/CAPABILITY_MATRIX.md](docs/frontend/CAPABILITY_MATRIX.md).

## Конфигурация

### Локальное окружение

| Переменная | Назначение |
| --- | --- |
| LINKWATCH_ENV | Режим приложения: development, test или production. |
| LINKWATCH_DATABASE_URL | Полный PostgreSQL DSN. |
| LINKWATCH_POSTGRES_DB, LINKWATCH_POSTGRES_USER, LINKWATCH_POSTGRES_PASSWORD | Параметры Compose PostgreSQL. |
| LINKWATCH_SERVER_PORT, LINKWATCH_ADDR | Порт и bind-адрес Go API. |
| LINKWATCH_SEED_DEMO | Включает демо seed; выключайте вне локальной разработки. |
| LINKWATCH_AUTH_DISABLED | Только локальный обход auth; в production должен быть выключен. |
| LINKWATCH_CORS_ORIGINS | Разрешённые origins. Не оставляйте wildcard в production. |
| LINKWATCH_SESSION_TTL_SECONDS | TTL сессии. |
| LINKWATCH_MAX_BACKFILL_DAYS, LINKWATCH_DB_MAX_CONNS | Ограничение backfill и размер DB pool. |
| LINKWATCH_TRUSTED_PROXY_CIDRS | Доверенные reverse-proxy сети для production. |
| LINKWATCH_BOOTSTRAP_ADMIN_* | Начальный production admin; пароль должен быть не короче 12 символов. |
| LINKWATCH_OLLAMA_URL, LINKWATCH_OLLAMA_MODEL | Необязательный локальный AI endpoint и модель. |
| LINKWATCH_PROVIDER_* | Provider transport: режим, webhook URL/token и retry-настройки. |
| LINKWATCH_NOTIFICATION_* | Notification transport: webhook, SMTP/email или Telegram. |

Полный список с безопасными значениями находится в [.env.example](.env.example) и [.env.prod.example](.env.prod.example). Секреты хранятся только в environment/secret manager и никогда не коммитятся.

### AI-черновики

AI-интеграция необязательна. По умолчанию используется локальный Ollama endpoint http://127.0.0.1:11434; сервер применяет timeout и ограниченное число retry. Если Ollama недоступна, приложение использует детерминированный русскоязычный/казахоязычный fallback для черновика — workflow ProviderCase не должен исчезать из-за отсутствия AI.

Development Compose может переопределять размер модели для локального запуска. Не указывайте удалённый или публичный AI endpoint без отдельной проверки политики безопасности.

### Транспорты

В development доступны internal/web transport для локальной проверки. В production transport должен быть явно настроен на разрешённый webhook, SMTP/email или Telegram. Для production webhook требуется HTTPS; попытки доставки, ошибка и retryable-состояние сохраняются до возврата ошибки вызывающему коду.

## Production-запуск

Перед production сначала заполните .env.prod.example значениями окружения, секретами, публичным hostname, CORS, bootstrap admin и transport-параметрами. Минимальный сценарий:

~~~bash
cp .env.prod.example .env
# Заполните .env: PostgreSQL, public host, TLS email, CORS, admin и transports.
docker compose -f docker-compose.prod.yml up -d --build
curl -fsS http://127.0.0.1:8080/health/ready
~~~

Production Compose использует Caddy для публичных 80/443, а Go API остаётся во внутренней сети. Для проверки публичного HTTPS после настройки DNS:

~~~bash
LINKWATCH_PUBLIC_URL=https://monitor.example.gov.kz \
  ./scripts/production-tls-smoke.sh
~~~

Проверьте до публикации:

- DNS указывает на production host, ACME может выпустить сертификат;
- LINKWATCH_TRUSTED_PROXY_CIDRS ограничен реальными сетями reverse proxy;
- LINKWATCH_AUTH_DISABLED=false, LINKWATCH_SEED_DEMO=false;
- PostgreSQL backup/restore и retention определены отдельно от Compose;
- provider и notification transports настроены на реальные авторизованные endpoints;
- секреты не попали в .env, логи, артефакты или Git history.

Подробный production отчёт: [docs/PRODUCTION_RUN_REPORT.md](docs/PRODUCTION_RUN_REPORT.md).

## Агент

LINKWATCH Agent — нативное Rust-приложение. Стабильные CLI-команды:

~~~text
run      непрерывный цикл мониторинга
once     один цикл измерения
probe    локальная проверка probe
version  версия и сведения о сборке
~~~

--once сохраняется как alias для одноразового запуска. Поддерживаются имена конфигурации LINKWATCH_* и legacy-алиасы VKO_*.

Одноразовый локальный запуск против development API:

~~~bash
LINKWATCH_SERVER_URL=http://127.0.0.1:8080 \
LINKWATCH_DEVICE_ID=device-42-primary \
LINKWATCH_DEVICE_TOKEN=demo-device-42-primary-token \
LINKWATCH_PROBE=network \
cargo run --release --manifest-path agent/Cargo.toml -- once
~~~

Сборка Windows-артефакта:

~~~powershell
.\\scripts\\build-agent.ps1 -DefaultServerUrl $env:LINKWATCH_PUBLIC_URL
~~~

Результат выпуска хранится в dist/linkwatch-agent-windows-amd64.exe. Подробности enrolment, установки, очереди и обновления: [agent/README.md](agent/README.md).

## API-контракт

Сервер сохраняет оба префикса: /api и /api/v1. Health endpoints не требуют пользовательской сессии:

~~~text
GET /health
GET /health/live
GET /health/ready
~~~

Основные группы API:

| Группа | Примеры |
| --- | --- |
| Auth | POST /auth/login, GET /auth/me, POST /auth/logout |
| Карта и данные | GET /overview, /map/points, /organizations, /providers, /lines, /lines/{id}, /devices/{id} |
| Измерения | /lines/{id}/measurements, /lines/{id}/states, агентские batch measurements |
| Инциденты | GET/POST /incidents, /incidents/{id}, /incidents/{id}/events, actions статуса/ответственного |
| Ситуации | GET/POST /situations, detail, live verify, comparison, merge и split |
| ProviderCase | GET/POST /provider-cases, /provider-cases/{id}, ai-draft, send, retry |
| Отчёты | /reports/aggregate, /reports/analytics, /reports/quality-passport, evidence и exports |
| Уведомления и аудит | /notifications, /audit, /agent-versions |
| Agent protocol | /agent/heartbeat, /agent/measurements:batch, /agent/config, /agent/commands:lease, /agent/commands/{id}:ack, enrolment и probe |
| Admin | /admin/* для capability-gated CRUD и операций управления |

Frontend должен использовать текущие field contracts и реальные permission responses. Не меняйте API-префиксы и не удаляйте alias без отдельной versioned migration.

## Важные инварианты данных

- PostgreSQL — единственный источник истины production path.
- Каждое observation несёт client_event_id; ingest идемпотентен для устройства и события.
- С каждым evaluation сохраняются effective policy и contract snapshots.
- Backfill — только evidence: он не переписывает текущее состояние линии.
- Инцидент закрывается только после подтверждённого recovery evidence.
- Provider и notification transports сохраняют attempt/failure/retryable status до возврата ошибки.
- Capability checks и line scopes применяются на сервере; frontend не является границей безопасности.
- Миграции добавляются версионно в server/internal/database/migrations.

## Структура репозитория

~~~text
.
├── server/                         Go API, domain, workers, embedded migrations
│   ├── cmd/linkwatch-server/       entrypoint
│   └── internal/database/migrations/  canonical PostgreSQL migrations
├── agent/                          Rust 2021 native monitoring agent
├── web/                            static frontend, Leaflet, boundaries and tests
├── deployment/                     Caddy configuration and deployment helpers
├── docs/                           runbooks, contracts, acceptance evidence
├── scripts/                        smoke, build, reset and acceptance scripts
├── Dockerfile                      server image
├── docker-compose.yml              local development stack
├── docker-compose.prod.yml         production stack with Caddy
├── Makefile                        common developer commands
├── .env.example                    safe local configuration template
└── .env.prod.example               production configuration template
~~~

## Разработка и проверки

Основные команды из Makefile:

~~~bash
make server-test    # Go tests
make agent-test     # Rust tests
make web-test       # web syntax, contract and foundation checks
make smoke          # Compose + runtime smoke path
make server-build
make agent-build
make agent-release
~~~

Эквивалентные прямые команды:

~~~bash
cd server && go test ./...
cargo test --manifest-path agent/Cargo.toml
./scripts/web-foundation-check.sh
~~~

Acceptance-наборы:

~~~bash
./scripts/p0-acceptance.sh
./scripts/p0-local-acceptance.sh
./scripts/p1-acceptance.sh
./scripts/p2-acceptance.sh
~~~

P0/P1/P2 используют окружение и базы, описанные в самих скриптах; перед запуском прочитайте их заголовок и убедитесь, что LINKWATCH_* указывает на нужный стенд. Не направляйте acceptance reset-сценарии на production.

Для web-функциональности полезны:

- [docs/frontend/FRONTEND_CONTRACT.md](docs/frontend/FRONTEND_CONTRACT.md) — контракт frontend/backend;
- [docs/frontend/MAP_SUBSYSTEM_BASELINE.md](docs/frontend/MAP_SUBSYSTEM_BASELINE.md) — baseline карты;
- [docs/frontend/CAPABILITY_MATRIX.md](docs/frontend/CAPABILITY_MATRIX.md) — capability и route coverage.

## Демо-данные и очистка

Для безопасной проверки synthetic data сначала используйте dry-run:

~~~bash
./scripts/cleanup-synthetic-db.sh --dry-run
~~~

Инструкция с guardrails: [docs/SYNTHETIC_DB_CLEANUP.md](docs/SYNTHETIC_DB_CLEANUP.md). Не используйте широкие TRUNCATE ... CASCADE и не удаляйте школы/реестр вместе с operational data без явного понимания связей.

## Документация

| Документ | Для чего |
| --- | --- |
| [Production run report](docs/PRODUCTION_RUN_REPORT.md) | Что проверено в production-подобном сценарии и какие внешние gates остались. |
| [P0 acceptance runbook](docs/P0_ACCEPTANCE_RUNBOOK.md) | Повторяемая минимальная приёмка API/runtime. |
| [Manual functional acceptance](docs/MANUAL_FUNCTIONAL_ACCEPTANCE.md) | Ручные сценарии операторских workflows. |
| [Frontend contract](docs/frontend/FRONTEND_CONTRACT.md) | Контракт web с API и permissions. |
| [Capability matrix](docs/frontend/CAPABILITY_MATRIX.md) | Покрытие экранов, действий и backend endpoints. |
| [Map baseline](docs/frontend/MAP_SUBSYSTEM_BASELINE.md) | Проверки карты и registry mapping. |
| [Synthetic DB cleanup](docs/SYNTHETIC_DB_CLEANUP.md) | Безопасное удаление synthetic operational data. |
| [Agent README](agent/README.md) | Установка, enrolment, команды и запуск edge-агента. |

## Перед публичным релизом

### Уже можно проверить в репозитории

- [ ] make server-test проходит.
- [ ] make agent-test проходит.
- [ ] make web-test проходит.
- [ ] make smoke проходит на чистом локальном Compose.
- [ ] Production .env создан из шаблона и не добавлен в Git.
- [ ] Проверены /health/live и /health/ready.
- [ ] Проверены capability/scopes для ролей ADMIN, OBLAST, DISTRICT, PROVIDER и SCHOOL.
- [ ] Проверены ProviderCase send/retry, уведомления и запись delivery attempts.
- [ ] Проверены backup/restore PostgreSQL и rollback-процедура.

### Внешние gates, которые нельзя подтвердить только кодом

- [ ] Публичный DNS, ACME и HTTPS проверены на реальном hostname — [docs/TASK-020_TLS_ACME_ACCEPTANCE.md](docs/TASK-020_TLS_ACME_ACCEPTANCE.md).
- [ ] Реальная авторизованная доставка провайдеру проверена — [docs/TASK-021_PROVIDER_ACCEPTANCE.md](docs/TASK-021_PROVIDER_ACCEPTANCE.md).
- [ ] Чистая установка, reboot, uninstall, tray и update native Windows проверены — [docs/TASK-022_WINDOWS_ACCEPTANCE.md](docs/TASK-022_WINDOWS_ACCEPTANCE.md).
- [ ] Non-WEB notification transport проверен на разрешённых каналах — [docs/TASK-023_NOTIFICATION_ACCEPTANCE.md](docs/TASK-023_NOTIFICATION_ACCEPTANCE.md).

## Лицензия

Проект распространяется по лицензии MIT. Полный текст — в [LICENSE](LICENSE).

## Участие в разработке

Перед pull request:

1. Изучите соответствующий контракт или runbook в docs/.
2. Не меняйте публичный API и схему данных без versioned migration и обновления документации.
3. Запустите релевантные Go/Rust/web проверки и make smoke для runtime-изменений.
4. Не добавляйте credentials, локальные базы, очереди, target/ и сгенерированные секретные артефакты.
