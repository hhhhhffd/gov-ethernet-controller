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

Откройте http://127.0.0.1:8000/. Встроенный demo-login выполняется автоматически. Для API доступны demo-учётные записи:

| username | password | scope |
|---|---|---|
| `admin` | `demo` | вся область |
| `provider-a` | `demo` | линии Provider A |
| `district` | `demo` | район Алтай |
| `school-42` | `demo` | организация Школа №42 |

Если зависимости FastAPI ещё не установлены, установите проект командой выше. База по умолчанию `vko_mvp.db`; путь можно изменить через `VKO_DB_PATH`.

## Демо-сценарий

1. На обзоре проверьте раздельные оси «Качество» и «Договор», а также отдельный статус «Нет актуальных данных».
2. Откройте линию `L-001`, раскройте evidence и effective policy.
3. Нажмите «Запустить replay»: агентский fixture проходит через тот же batch ingest и state engine.
4. Откройте инцидент, сформируйте draft обращения, отредактируйте текст, подтвердите проверку и явно отправьте.
5. Перейдите в «Отчёты» и выгрузите raw/aggregate в CSV или XLSX.

## Агент без внешнего Speedtest

```bash
PYTHONPATH=agent python -m vko_agent --server http://127.0.0.1:8000 --once
```

`DemoProbe` детерминирован; `OfflineBuffer` хранит очередь в SQLite WAL. Пример systemd unit находится в `agent/systemd/`.

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
staging-профиль: для локального smoke оставлен demo login, а настоящий
`VKO_ENV=production` блокирует demo auth и требует внешний IdP/TLS.

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
