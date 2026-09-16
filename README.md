# VKO LINKWATCH

Локальный MVP системы доказательного мониторинга интернет-линий организаций образования ВКО. Продукт ведёт линию от контекста и автономных наблюдений до подтверждённого состояния, инцидента, обращения поставщику, проверки восстановления и паспорта качества за период.

## Быстрый запуск

Требуется Python 3.11+.

```bash
python -m venv .venv
. .venv/bin/activate
python -m pip install -e '.[test]'
python -m backend.seed --reset --measurements
uvicorn backend.app.main:app --reload --port 8000
```

Откройте http://127.0.0.1:8000/. Введите учётные данные в форме входа. Для
изолированного демонстрационного среза без подключения к API добавьте `?demo=1` к адресу;
такой режим явно помечается в интерфейсе. Для API доступны demo-учётные записи:

| username | password | scope |
|---|---|---|
| `admin` | `demo` | вся область |
| `provider-a` | `demo` | линии Provider A |
| `district` | `demo` | район Алтай |
| `school-42` | `demo` | организация Школа №42 |

Если зависимости FastAPI ещё не установлены, установите проект командой выше. База по умолчанию `vko_mvp.db`; путь можно изменить через `VKO_DB_PATH`.

В локальном профиле пароли demo хранятся как salted PBKDF2-хэши, а каждый
вход получает отдельную истекающую bearer-сессию. Для production задайте
`VKO_ENV=production`, `VKO_AUTH_MODE=password` и при первом старте
`VKO_BOOTSTRAP_ADMIN_USERNAME` вместе с паролем длиной не менее 12 символов.
Общий пароль `demo`, legacy user-токены и `VKO_AUTH_DISABLED` в production не
принимаются; `backend.seed` также отказывается создавать demo-данные в
production без явного override.

## Демо-сценарий

1. Для локального среза без подключения к API откройте `http://127.0.0.1:8000/?demo=1`; для API-варианта войдите как `admin` / `demo`.
2. На обзоре проверьте раздельные оси «Качество» и «Договор», а также отдельный статус «Нет актуальных данных».
3. Откройте линию `L-001`, раскройте evidence и effective policy.
4. Нажмите «Запустить replay»: агентский fixture проходит через тот же batch ingest и state engine.
5. Откройте инцидент, сформируйте draft обращения, отредактируйте текст, подтвердите проверку и явно отправьте.
6. Перейдите в «Отчёты» и выгрузите raw/aggregate в CSV или XLSX.

## Агент без внешнего Speedtest

```bash
PYTHONPATH=agent python -m vko_agent --server http://127.0.0.1:8000 --once
```

`DemoProbe` детерминирован; `OfflineBuffer` хранит очередь в SQLite WAL. Пример systemd unit находится в `agent/systemd/`.

Для реальной телеметрии агента используйте `VKO_PROBE=network`: NetworkProbe
собирает ограниченные HTTP/TCP/ping и throughput-метрики, не запускает shell и
сохраняет технические детали в `raw`. URL throughput лучше указывать на
контролируемый оператором endpoint.

Обращения и уведомления проходят через настраиваемые transport-адаптеры. В
staging по умолчанию сохраняется внутренний hand-off; в production задайте
`VKO_PROVIDER_TRANSPORT=webhook` (или `smtp`) и
`VKO_NOTIFICATION_TRANSPORT=webhook`. Ошибка внешней доставки не маскируется:
объект получает `FAILED`, число попыток и текст ошибки, после чего доступен
повтор через admin API. В production внутренние transport и `DemoProbe`
отключены, если оператор явно не меняет профиль окружения.

Схема обновляется версионированными additive migrations при старте либо явно:

```bash
python scripts/migrate.py --db "$VKO_DB_PATH"
```

## Проверки

```bash
PYTHONPATH=agent python -m unittest discover -s agent/tests -v
python -m compileall backend agent
node --check web/app.js
```

После установки test extras:

```bash
pytest
```

## Production-like PostgreSQL прогон

`docker-compose.prod.yml` поднимает PostgreSQL 16 и два-worker Uvicorn image. Это
staging-профиль: demo-данные и внутренние hand-off включаются только настройками
staging. В `VKO_ENV=production` используется password/session auth с bootstrap-
администратором; TLS reverse proxy и внешние transport endpoints задаются на
уровне развёртывания.

В PowerShell из корня репозитория:

```powershell
$env:VKO_POSTGRES_PASSWORD = "<локальный случайный пароль>"
.\scripts\windows\start-vko-prod.ps1
```

После публикации порта WSL-агент запускается так:

```bash
export VKO_DEVICE_TOKEN='<токен зарегистрированного устройства>'
./scripts/wsl/run-agent-once.sh
```

Black-box проверка опубликованного Postgres backend:

```bash
export VKO_DEVICE_TOKEN='<reserve token>'
export VKO_PRIMARY_DEVICE_TOKEN='<primary token>'
.venv/bin/python scripts/verify_postgres.py
```

Smoke можно повторять на persistent volume: каждый запуск использует новые
event IDs и timestamps после последнего evidence.

Остановить стек без удаления volume:

```powershell
.\scripts\windows\stop-vko-prod.ps1
```

Подробный отчёт о прогоне и выборе стека: `docs/PRODUCTION_RUN_REPORT.md`.

Архитектура и краткие отчёты оркестрации находятся в `.agent/`; полное ТЗ остаётся источником истины по пути `/mnt/c/Users/user/Desktop/VKO_Product_Concept_PRIORITIZED.md`.
