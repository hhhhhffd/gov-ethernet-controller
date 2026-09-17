# linkwatch-agent

Нативный Rust-агент LINKWATCH для Windows и Linux. Он собирает light/performance
наблюдения, записывает их во filesystem spool и удаляет файл только после
подтверждения batch-сервера. Поэтому перезапуск, обрыв сети и повторная
доставка безопасны благодаря `client_event_id`.

## CLI

```text
linkwatch-agent version
linkwatch-agent probe                 # локальная проба без отправки
linkwatch-agent once                  # одна performance-проба и upload
linkwatch-agent run                   # расписание 3–5 раз в сутки
linkwatch-agent --once                # alias once
```

`LINKWATCH_*` — основной набор переменных конфигурации; старые `VKO_*` имена
остаются совместимыми. Для файла конфигурации задайте
`LINKWATCH_CONFIG_FILE` (JSON). Расписание и effective policy можно получить
из `/api/v1/agent/config`; чтобы агент применял server-side schedule, задайте
`LINKWATCH_USE_SERVER_CONFIG=1`. В режиме `run` каждые пять минут выполняются
heartbeat, flush очереди и обновление расписания; курсор слотов хранится рядом
со spool, поэтому перезапуск не повторяет уже сработавший слот. Повреждённые
JSON-файлы перемещаются в `queue/quarantine/`, не блокируя остальные события.
Ответ batch с явными `accepted:false` и `retryable:false` перемещает такой
элемент в `queue/rejected/` и сохраняет ограниченное описание ошибки рядом;
неизвестные ответы и retryable-ошибки остаются в основном spool.
Режимы `run` и `once` используют advisory lock `.instance.lock` внутри spool,
поэтому два процесса не обрабатывают одну очередь одновременно. `Ctrl+C` и
`SIGTERM` корректно завершают `run`: уже записанные события остаются в очереди,
а длительное ожидание расписания прерывается без задержки до следующего слота.
Heartbeat дополнительно передаёт session `boot_id`, monotonic `uptime_seconds`,
`queue_depth` и `last_probe_status`/`last_probe_at`; сервер использует их только
для fleet-диагностики, а не для вычисления authoritative freshness.

Минимальная привязка устройства:

```bash
LINKWATCH_SERVER_URL=http://127.0.0.1:8080 \
LINKWATCH_DEVICE_ID=device-42-primary \
LINKWATCH_DEVICE_TOKEN=demo-device-42-primary-token \
LINKWATCH_PROBE=demo \
cargo run --release --manifest-path agent/Cargo.toml -- once
```

Линия, школа и monitoring point определяются сервером по аутентифицированному
`device_id`. Старые поля `school_id`, `line_id`, `monitoring_point_id` и их
`VKO_*` aliases принимаются для совместимости с прежними конфигурациями, но не
влияют на отправляемую телеметрию.

Для production используйте `LINKWATCH_PROBE=network` и контролируемые
оператором endpoints в `LINKWATCH_CONFIG_FILE`/`VKO_PROBE_*`. NetworkProbe
формирует reachability, ICMP ping samples (с безопасным TCP-connect fallback),
jitter, packet loss, availability и адаптивные 3–5-секундные download/upload
метрики. Метод и версия замера сохраняются в `raw`; по умолчанию используются
Cloudflare download и upload endpoints, которые можно заменить оператором.
В `raw` сохраняются отдельные числители и знаменатели ping/availability;
историческое `ping_sample_count` означает только успешные samples. В сетевом
probe используется десять ping samples, поэтому `packet_loss` имеет шаг 10 п.п.;
порог вроде 2% всё равно нельзя интерпретировать как SLA по одной пробе — для
этого нужна агрегация наблюдений.
Если `ping_host` отключён, `packet_loss` равен `null`, а `raw.ping_enabled` —
`false`: отсутствие ping-метрики не считается потерей пакетов.
Для контролируемого замера через сам LINKWATCH задайте
`LINKWATCH_USE_SERVER_PROBE=1`: агент использует аутентифицированные
`/api/v1/agent/probe/download` и `/api/v1/agent/probe/upload`.
DemoProbe в production отключён без явного `LINKWATCH_ALLOW_DEMO_PROBE=1`.

## Сборка

```bash
cargo test --manifest-path agent/Cargo.toml
cargo build --release --manifest-path agent/Cargo.toml
```

Windows artifact собирается скриптом `scripts/build-agent.ps1` и помещается в
`dist/linkwatch-agent-windows-amd64.exe`. Служба Linux описана в
`agent/systemd/vko-agent.service.example`.
