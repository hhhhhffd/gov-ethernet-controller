# Отчёт production-like прогона VKO LINKWATCH

Дата прогона: 16 сентября 2026 г.
Среда: Linux/WSL внутри текущего окружения, Docker Desktop 4.91.0 / Engine 29.8.0.

## Актуализация после hardening

Этот файл сохраняет исторические результаты первоначального staging-прогона. В
текущем рабочем дереве поверх него добавлены следующие production-path блоки:

- password/session auth с salted PBKDF2, независимыми сессиями, logout/revoke и
  bootstrap-администратором; demo seed/replay/reset не выполняются в production;
- `NetworkProbe` с ограниченными HTTP/TCP/ping и throughput-измерениями для
  агента; `DemoProbe` в production запрещён без явного override;
- webhook/SMTP provider delivery и webhook notifications с HTTPS-проверкой,
  idempotency keys, bounded timeouts, durable `FAILED`/attempts/error и retry API;
- versioned additive migrations (`schema_migrations`) и bounded PostgreSQL
  connection pool;
- ситуации создаются только для корреляций от двух инцидентов (порог задаётся
  `VKO_SITUATION_MIN_MEMBERS`), а строгие API-модели отклоняют неизвестные поля.

Ниже приведён отчёт именно о первом прогоне и его ограничениях; перед внешним
production всё ещё обязательны TLS/reverse proxy, секрет-хранилище,
наблюдаемость и нагрузочная проверка.

## Короткий итог

Production-like стенд поднят и оставлен работающим:

- PostgreSQL 16 — `healthy`, опубликован только на `127.0.0.1:5433`;
- FastAPI-приложение — два Uvicorn worker-а, `healthy`, опубликовано только на `127.0.0.1:8000`;
- PostgreSQL действительно используется приложением через `VKO_DATABASE_URL`, а не SQLite;
- WSL-агент отправил измерение в контейнерный backend;
- black-box smoke прошёл: `POSTGRES_LIVE_SMOKE=PASS`;
- контрольная точка после первого завершённого smoke + WSL agent: `13` измерений, `2` инцидента, `1` отправленное обращение поставщику; после двух повторных smoke без сброса volume финальный счётчик persistent БД — `53`/`6`/`5`;
- существующая локальная регрессия не сломалась: 7 backend-тестов и 3 agent-теста прошли.

Это именно production-like staging, а не готовый внешний production: в нём
намеренно оставлены локальные порты и staging-профиль. Production-профиль
отдельно отключает demo seed/auth и требует явные credentials и transport
endpoints. Ограничения перечислены ниже.

## Что было сделано

### Топология запуска

Добавлены минимальные эксплуатационные файлы:

| Файл | Назначение |
|---|---|
| [`Dockerfile`](../Dockerfile) | Python 3.13 slim image; запуск FastAPI двумя Uvicorn worker-ами |
| [`.dockerignore`](../.dockerignore) | Не отправляет в build context локальные env/venv/БД/отчёты |
| [`docker-compose.prod.yml`](../docker-compose.prod.yml) | PostgreSQL 16 + app, healthcheck-и, named volume, localhost-only ports |
| [`.env.prod.example`](../.env.prod.example) | Явный staging-профиль и список обязательных переменных |
| [`scripts/windows/start-vko-prod.ps1`](../scripts/windows/start-vko-prod.ps1) | Запуск/сборка стека из Windows PowerShell и проверка `/health` |
| [`scripts/windows/stop-vko-prod.ps1`](../scripts/windows/stop-vko-prod.ps1) | Остановка без удаления PostgreSQL volume |
| [`scripts/wsl/run-agent-once.sh`](../scripts/wsl/run-agent-once.sh) | Однократный сбор и flush агента из WSL |
| [`scripts/wsl/run-agent-loop.sh`](../scripts/wsl/run-agent-loop.sh) | Непрерывный режим агента |
| [`scripts/verify_postgres.py`](../scripts/verify_postgres.py) | Чёрный HTTP smoke полного P0/P1 сценария |

Compose требует `VKO_POSTGRES_PASSWORD`; остальные staging-параметры имеют безопасные локальные defaults. Секрет в тесте передавался только через окружение и в репозиторий не записывался.

### Что уже покрывает MVP

- `backend/app/main.py` — FastAPI API, health/auth, Role × Scope, device ingest/config, incidents, provider workflow, reports и exports.
- `backend/app/services.py` — temporal policy/contract evaluation, evidence snapshots, независимые оси connection/contract, freshness, recovery/reopen/recurrence и audit.
- `web/` — русская web-панель обзора, карты/линии, evidence, инцидента, отчётов и административных операций.
- `agent/` — автономный сборщик с локальной очередью и HTTP flush.

Сквозной поток данных: `Organization → Line → ContractVersion → MonitoringPoint/Device → Measurement → Evaluation → LineState → Incident → ProviderCase → Recovery → Passport/Export`. Backend остаётся единственным источником итогового состояния; UI не пересчитывает verdict.

### PostgreSQL при минимальном вмешательстве

Основной доменный и сервисный код сохранён. В [`backend/app/db.py`](../backend/app/db.py) добавлен небольшой DB-API compatibility adapter:

1. `VKO_DATABASE_URL`/`DATABASE_URL` имеют приоритет над `VKO_DB_PATH`.
2. Существующая SQLite-схема преобразуется в PostgreSQL-схему на старте: identity-колонки вместо `AUTOINCREMENT`, `DOUBLE PRECISION` вместо `REAL`, без SQLite `PRAGMA`.
3. Адаптер переводит только реально используемый диалект запросов: `?` → `%s`, `INSERT OR IGNORE`, `IS NOT DISTINCT FROM` для nullable scope и вычисление длительности через PostgreSQL `EXTRACT(EPOCH ...)`.
4. `psycopg[binary]` добавлен в зависимости; строки остаются текстом, а JSON остаётся сериализованным текстом, поэтому сервисный слой и API не менялись.
5. При запуске нескольких worker-ов DDL сериализуется через PostgreSQL advisory lock. Это устраняет гонку первичной инициализации системных каталогов.
6. `lastrowid` совместим с текущим сервисным кодом через `LASTVAL()`, а конфликт уникальности преобразуется в ожидаемый `sqlite3.IntegrityError`, чтобы сохранить прежний idempotent/race-safe путь.
7. Автосидирование также получает отдельный transaction-scoped advisory lock, поэтому два worker-а не создают одну policy row одновременно.

Это сознательно не полноценная миграция на ORM: меняется только транспорт хранения, публичные API и доменная логика не переписываются.

### Агент и поток данных

Агент находится в [`agent/vko_agent/agent.py`](../agent/vko_agent/agent.py) и написан на Python. Он состоит из:

- `Probe` protocol и детерминированного `DemoProbe` для воспроизводимого стенда;
- `MonitoringAgent`, который формирует событие с `client_event_id`, UTC timestamp, device/line/point binding и метриками;
- `OfflineBuffer` на SQLite WAL с уникальным event ID;
- `flush()` через стандартный HTTP `urllib`, с device token headers;
- расписания 3–5 performance-тестов в сутки, bounded jitter и опциональными light-check между ними;
- `run_once` для WSL smoke и `run_forever` для длительной работы.

Сервер остаётся единственным источником verdict/state: агент только измеряет, буферизует и доставляет. При отсутствии сети очередь не теряется; после восстановления события отправляются, а дубликаты безопасно игнорируются по `(device_id, client_event_id)`.

## Как выполнялся прогон

### 1. Docker из WSL

Docker Desktop был доступен из Linux-контекста. Команда Compose запускалась с локальным Docker config без Windows credential helper, поскольку WSL не умеет исполнять `docker-credential-desktop.exe` (`Exec format error`):

```bash
DOCKER_CONFIG="$PWD/.docker-config" \
VKO_ENV=staging VKO_AUTO_SEED=1 \
VKO_POSTGRES_DB=vko VKO_POSTGRES_USER=vko \
VKO_POSTGRES_PASSWORD='<локальный пароль>' \
VKO_POSTGRES_PORT=5433 VKO_APP_PORT=8000 \
docker compose -p vko-linkwatch -f docker-compose.prod.yml up -d --build
```

Фактический итог `docker compose ps`:

```text
vko-linkwatch-app-1        Up ... (healthy)   127.0.0.1:8000->8000/tcp
vko-linkwatch-postgres-1   Up ... (healthy)   127.0.0.1:5433->5432/tcp
```

Проверка приложения вернула:

```json
{"status":"ok","service":"vko-backend"}
```

Логи показали успешный старт parent process и обоих Uvicorn worker-ов; после advisory lock ошибок первичной DDL-инициализации нет.

### 2. Агент из WSL

Агент запускался против опубликованного Docker backend:

```bash
VKO_SERVER_URL=http://127.0.0.1:8000 \
VKO_DEVICE_ID=device-42-primary \
VKO_DEVICE_TOKEN='<зарегистрированный token>' \
VKO_BUFFER_PATH=.vko-agent/postgres-smoke.sqlite3 \
./scripts/wsl/run-agent-once.sh
```

Результат:

```json
{"event_id":"<uuid>","sent":1,"pending":0}
```

Проверка API после отправки показала `device-42-primary`, обновлённый `last_seen`, 7 измерений и отсутствие `auth_token_hash` в device detail.

### 3. Black-box smoke

[`scripts/verify_postgres.py`](../scripts/verify_postgres.py) проверяет через HTTP:

1. `/health` и admin login;
2. Role × Scope: provider видит только свои линии, чужая reserve-линия возвращает 404;
3. три `NO_INTERNET` наблюдения создают состояние и incident;
4. три доступных наблюдения закрывают incident и возвращают connection state в `OK`;
5. отдельная contract violation на primary-линии;
6. draft обращения, запрет отправки без `reviewed`, затем разрешённая reviewed-отправка;
7. quality passport, CSV и XLSX exports;
8. device detail без секрета и заполненный audit trail.

Итог команды (в том числе два последовательных повторных прогона на том же volume):

```text
POSTGRES_LIVE_SMOKE=PASS
```

Прямая проверка PostgreSQL после первого smoke + WSL agent:

```text
measurements=13
incidents=2
provider_sent=1
```

После повторных прогонов с уникальными event IDs контрольные счётчики стали `measurements=53`, `incidents=6`, `provider_sent=5`. Рост ожидаем: каждый smoke намеренно создаёт outage/recovery, contract incident и reviewed provider case, а named volume не очищается.

Во время первого повторного запуска был найден дефект теста: фиксированные event IDs и прошлые `observed_at` превращали сценарий в late-observation no-op. Smoke исправлен: каждый run получает уникальный prefix и монотонный timestamp после последнего evidence. Два последовательных прогона после исправления прошли.

### 4. Регрессия после изменений

```text
.venv/bin/pytest -q                                  7 passed
PYTHONPATH=agent .venv/bin/python -m unittest ...     3 passed
.venv/bin/python -m compileall -q backend agent scripts PASS
node --check web/app.js                               PASS
docker compose ... config --quiet                     PASS
```

## Почему выбран Python

Выбор Python относится и к backend, и к текущему агенту и был сделан прагматично:

- исходная реализация уже FastAPI/Pydantic; переход на PostgreSQL потребовал только DB adapter, без смены API и доменных сервисов;
- задача в основном I/O-bound: HTTP, PostgreSQL, локальная WAL-очередь, расписание и сериализация JSON. Узкого CPU-bound участка, ради которого нужен Rust, в текущем MVP нет;
- стандартная библиотека закрывает HTTP, SQLite WAL, время, CLI и retry-скелет агента, поэтому мало зависимостей и простой запуск одинаково из WSL и Windows;
- Python проще покрывать короткими contract/in-process тестами и быстро расширять доменную матрицу verdict/evidence/incidents;
- FastAPI даёт готовые health/API маршруты и понятную эксплуатацию через Uvicorn/Docker;
- Python снижает время до работающего vertical slice и риск расхождения между UI, API, state engine и агентом.

Цена выбора известна: синхронный DB-API слой и более высокий базовый overhead
по сравнению с Rust. Connection pool и migrations уже добавлены; перед внешним
production нужны наблюдаемость и нагрузочное измерение.

## Почему не переписывать агент на Rust сразу

Агент маленький, но его корректность определяется не скоростью, а контрактом доставки. Минимально вмешивающийся rewrite осложняется следующими связями:

- нужно побайтно сохранить JSON-поля, UTC/ISO-8601 timestamps, device headers и endpoint `/api/v1/agent/measurements:batch`;
- нужно сохранить семантику offline SQLite WAL, уникального `client_event_id`, порядка очереди, retry и поведения при частичном сбое;
- нужно повторить schedule 3–5/day, bounded jitter, light-check policy и конфигурацию через те же `VKO_*` переменные;
- текущие тесты и demo fixture написаны вокруг Python `Probe`/`MonitoringAgent`; параллельная Rust-реализация временно удвоит код и матрицу тестирования;
- потребуется новый toolchain/runtime, сборка для Windows и Linux/WSL, cross-compilation, упаковка и обновление operational scripts;
- при ошибке в Rust-сериализации или времени можно получить тихо неполные доказательства, что опаснее выигрыша нескольких миллисекунд;
- rewrite не меняет backend bottleneck: state engine и HTTP-обвязка остаются
  Python I/O-bound, поэтому ускорение агента само по себе не решит масштабирование.

Без измеренного CPU/memory bottleneck это был бы архитектурный риск без доказанной пользы. Рекомендованный путь, если Rust потребуется:

1. Зафиксировать текущий HTTP/event contract и characterization tests на Python.
2. Сначала вынести только реальный probe (если появится тяжёлый speedtest/native networking) в Rust-бинарник, оставив Python queue/flush.
3. Затем сделать Rust agent с теми же env vars и payload, запустить shadow/canary на одном устройстве, сравнивая event count, latency, retry и pending queue.
4. Переключать устройства через существующий WSL script; Python-агент держать как быстрый rollback.
5. Удалять Python-ветку только после наблюдаемого периода без расхождений.

Такой порядок сохраняет серверный контракт и не требует миграции данных или одновременной остановки всех устройств.

## Ограничения и риски текущего стенда

- `VKO_ENV=staging` и `VKO_AUTO_SEED=1` нужны для smoke. При
  `VKO_ENV=production` demo seed/replay/reset и auth bypass блокируются; для
  bootstrap нужен явный парольный администратор или заранее настроенный IdP.
- Порты привязаны к loopback; для внешнего доступа нужен TLS reverse proxy, firewall и нормальная ротация device/user tokens.
- PostgreSQL compatibility layer остаётся синхронным; pool и versioned additive
  migrations покрывают эксплуатационный минимум, но перед реальной нагрузкой
  нужен отдельный нагрузочный прогон.
- Compose строит DSN из переменных. Пароли с URL-reserved символами нужно экранировать либо передавать через секрет/отдельный DSN.
- `NetworkProbe` ограничен стандартной библиотекой и endpoint-конфигурацией;
  throughput URL и ping target нужно заменить на контролируемые оператором
  точки, а не считать публичные defaults SLA-измерителем.
- Browser/Playwright smoke в этой среде не запускался: браузерные зависимости отсутствуют; API и JS syntax проверены.
- Нативный вызов `powershell.exe` из текущего WSL невозможен (`cannot execute binary file: Exec format error`). PowerShell-скрипт подготовлен и синтаксически просмотрен для запуска из Windows, но именно Windows PowerShell в этой Linux-сессии не исполнялся. Docker и агент фактически прогнаны из WSL.
- `.git/index` в sandbox read-only, поэтому коммит создать нельзя; файлы и результаты находятся в рабочем дереве.

## Остановка и откат

Обычная остановка не удаляет данные:

```powershell
.\scripts\windows\stop-vko-prod.ps1
```

Для повторного запуска используется тот же named volume. Возврат локального MVP возможен без изменения API: убрать `VKO_DATABASE_URL`/остановить compose и запустить backend с `VKO_DB_PATH` (SQLite). Удаление volume (`down -v`) намеренно не выполнялось.
