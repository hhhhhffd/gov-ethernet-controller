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
`LINKWATCH_USE_SERVER_CONFIG=1`. При сбое запроса локальная конфигурация и
очередь сохраняются.

Минимальная привязка устройства:

```bash
LINKWATCH_SERVER_URL=http://127.0.0.1:8080 \
LINKWATCH_DEVICE_ID=device-42-primary \
LINKWATCH_DEVICE_TOKEN=demo-device-42-primary-token \
LINKWATCH_PROBE=demo \
cargo run --release --manifest-path agent/Cargo.toml -- once
```

Для production используйте `LINKWATCH_PROBE=network` и контролируемые
оператором endpoints в `LINKWATCH_CONFIG_FILE`/`VKO_PROBE_*`. NetworkProbe
формирует reachability, TCP ping samples, jitter, packet loss, availability и
ограниченные download/upload метрики. DemoProbe в production отключён без
явного `LINKWATCH_ALLOW_DEMO_PROBE=1`.

## Сборка

```bash
cargo test --manifest-path agent/Cargo.toml
cargo build --release --manifest-path agent/Cargo.toml
```

Windows artifact собирается скриптом `scripts/build-agent.ps1` и помещается в
`dist/linkwatch-agent-windows-amd64.exe`. Служба Linux описана в
`agent/systemd/vko-agent.service.example`.
