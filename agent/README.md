# Автономный агент

Агент сохраняет observations в локальной SQLite WAL-очереди и доставляет их на `/api/agent/measurements:batch` после восстановления связи. У каждой записи есть `client_event_id`, поэтому повторная доставка безопасна. В demo используется `DemoProbe`; для установленного агента доступен `NetworkProbe` без обязательных внешних Python-зависимостей.

## Запуск

```bash
VKO_PROBE=demo PYTHONPATH=agent python -m vko_agent --server http://127.0.0.1:8000 --once
```

Переменные `VKO_SERVER_URL`, `VKO_DEVICE_ID`, `VKO_SCHOOL_ID`, `VKO_LINE_ID`, `VKO_POINT_ID`, `VKO_DEVICE_TOKEN` и `VKO_BUFFER_PATH` задают привязку устройства. `VKO_TESTS_PER_DAY` ограничивается диапазоном 3–5, `VKO_JITTER_MINUTES` задаёт смещение расписания, а `VKO_LIGHT_CHECKS_BETWEEN=1` включает лёгкие проверки доступности между performance-тестами. Для реальной телеметрии задайте `VKO_PROBE=network`, `VKO_PROBE_TARGETS` (через запятую), `VKO_PROBE_HOST`, `VKO_PROBE_PORT`, `VKO_THROUGHPUT_URL` и при необходимости `VKO_UPLOAD_URL`. NetworkProbe выполняет ограниченные HTTP HEAD/TCP/ping и range download/upload, сохраняет детали в `raw` и переводит полностью недоступную сеть в `NO_INTERNET`. Для Linux пример автозапуска находится в `systemd/vko-agent.service.example`; для Windows используйте Task Scheduler с той же командой.

При `VKO_ENV=production` агент принимает только HTTPS `VKO_SERVER_URL`; очередь
остаётся локальной и не удаляет событие, пока сервер не подтвердит batch.
