# Автономный агент

Агент сохраняет observations в локальной SQLite WAL-очереди и доставляет их на `/api/agent/measurements:batch` после восстановления связи. У каждой записи есть `client_event_id`, поэтому повторная доставка безопасна. `DemoProbe` детерминирован и не требует внешнего Speedtest-сервиса.

## Запуск

```bash
PYTHONPATH=agent python -m vko_agent --server http://127.0.0.1:8000 --once
```

Переменные `VKO_SERVER_URL`, `VKO_DEVICE_ID`, `VKO_SCHOOL_ID`, `VKO_LINE_ID`, `VKO_POINT_ID`, `VKO_DEVICE_TOKEN` и `VKO_BUFFER_PATH` задают привязку устройства. `VKO_TESTS_PER_DAY` ограничивается диапазоном 3–5, `VKO_JITTER_MINUTES` задаёт смещение расписания, а `VKO_LIGHT_CHECKS_BETWEEN=1` включает лёгкие проверки доступности между performance-тестами. Для Linux пример автозапуска находится в `systemd/vko-agent.service.example`; для Windows используйте Task Scheduler с той же командой.
