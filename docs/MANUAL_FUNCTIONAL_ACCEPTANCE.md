# Ручная функциональная проверка LINKWATCH

Этот сценарий использует development-данные. Школа №32 — реальная запись
реестра ВКО с настоящими координатами; замеры, которые создаёт агент во время
этой проверки, являются тестовыми.

## 1. Запустить LINKWATCH

Из корня проекта:

```bash
docker compose up -d --build
curl --fail http://127.0.0.1:8080/health/ready
```

Ожидаемый результат: ответ со статусом `ok`. Открыть
`http://127.0.0.1:8080`.

Если порт 8080 уже занят, сначала остановьте именно процесс или старый
контейнер, который его занимает, и снова выполните команду выше. Временный
fallback — `LINKWATCH_SERVER_PORT=18080 docker compose up -d --build`; тогда и
агенту нужно указать `LINKWATCH_SERVER_URL=http://127.0.0.1:18080`.

## 2. Очистить development-данные

```bash
./scripts/manual-demo-reset.sh
```

Ожидаемый результат:

```text
Demo database reset.
School 32 ready.
line-42-primary ready.
device-42-primary ready.
Open http://127.0.0.1:8080
```

Команда очищает прошлые замеры, инциденты, уведомления и обращения только в
локальной development-базе, затем заново создаёт demo-данные. Она не создаёт
инцидент, recovery или ProviderCase. После reset войдите в приложение заново:
`admin` / `demo`.

На карте найдите КГУ «Средняя школа №32» города Усть-Каменогорска, откройте
маркер и нажмите «Открыть линию». Это `line-42-primary` у `org-42`;
monitoring point — `point-42-primary`, device — `device-42-primary`.

## 3. Первый настоящий замер агента

На Windows, из корня проекта, соберите агент и положите рядом с ним готовую
конфигурацию:

```powershell
.\scripts\build-agent.ps1
Copy-Item .\agent\linkwatch-config.windows.example.json .\dist\linkwatch-config.json
$env:LINKWATCH_CONFIG_FILE = (Resolve-Path .\dist\linkwatch-config.json)
.\dist\linkwatch-agent-windows-amd64.exe once
```

Ожидаемый результат в консоли: `measurement collected`, `uploaded: 1` и
`accepted: true`. В приложении откройте School 32 → «Открыть линию»: появится
новый тестовый замер с состоянием подключения `OK`, если внешний интернет
доступен.

Конфигурация использует настоящий `network` probe. Он проверяет внешний
интернет; это не DemoProbe. Скорость зависит от фактической сети. Если реальная
скорость ниже договорной, рядом может появиться отдельное предупреждение о
качестве — это не отменяет проверку состояния интернет-подключения.

### Режимы измерения

Обычный network throughput использует внешние targets. Перед запуском убедитесь,
что `LINKWATCH_USE_SERVER_PROBE` не задан:

```powershell
Remove-Item Env:LINKWATCH_USE_SERVER_PROBE -ErrorAction SilentlyContinue
.\dist\linkwatch-agent-windows-amd64.exe once
```

Для стабильной функциональной проверки throughput можно включить endpoints
самого LINKWATCH:

```powershell
$env:LINKWATCH_USE_SERVER_PROBE = "1"
.\dist\linkwatch-agent-windows-amd64.exe once
Remove-Item Env:LINKWATCH_USE_SERVER_PROBE -ErrorAction SilentlyContinue
```

В этом режиме reachability и ping всё равно проверяют внешний интернет, а
download/upload измеряются через локальный LINKWATCH. Эти числа не являются
скоростью ISP.

## 4. Проверить NO_INTERNET и автоматический инцидент

Оставьте Docker и `http://127.0.0.1:8080` доступными, отключите только внешний
интернет/WAN. Затем три раза подряд запустите agent `once`:

```powershell
1..3 | ForEach-Object {
  .\dist\linkwatch-agent-windows-amd64.exe once
  Start-Sleep -Seconds 2
}
```

В каждом замере ожидается `NO_INTERNET`. Development policy требует три
последовательных подтверждения, поэтому после третьего запуска откройте
«Инциденты»: появится автоматический инцидент School 32. Индикатор уведомлений
в верхней панели должен показать новое непрочитанное событие.

Откройте инцидент и проверьте доступные действия: изменение статуса,
комментарий/назначение и подготовку обращения провайдеру. Создайте ProviderCase
только через этот экран. Черновик без Ollama должен оставаться ручным или
template-черновиком; это нормально. Не считайте отправку тестового обращения
внешнему провайдеру доказанной, пока не настроен реальный разрешённый transport.

## 5. Проверить recovery

Верните внешний интернет и снова выполните три последовательных `once`:

```powershell
1..3 | ForEach-Object {
  .\dist\linkwatch-agent-windows-amd64.exe once
  Start-Sleep -Seconds 2
}
```

После третьего успешного замера откройте инцидент: recovery должен быть
зафиксирован, а инцидент — закрыт согласно доступному workflow. Если внешний
интернет вернулся, но скорость действительно ниже условий договора, это может
создать отдельное performance-предупреждение; NO_INTERNET recovery при этом
проверяется по состоянию подключения `OK`.

## 6. Отчёты и выгрузки

Откройте «Отчёты», выберите School 32 / primary line и период «день». После
последовательности online → outage → recovery должны быть данные для:

- отчёта с доказательствами;
- quality passport;
- CSV;
- XLSX.

Скачайте CSV и XLSX через интерфейс и откройте оба файла. Это выгрузки реальных
тестовых наблюдений этого ручного запуска, а не заранее подложенная история.

## 7. Отдельно проверить offline queue

Используйте отдельную очередь, чтобы не смешивать её с обычной:

```powershell
$env:LINKWATCH_QUEUE_DIR = "$PWD\manual-offline-queue"
$env:LINKWATCH_SERVER_URL = "http://127.0.0.1:9"
.\dist\linkwatch-agent-windows-amd64.exe once
Get-ChildItem $env:LINKWATCH_QUEUE_DIR -Filter *.json
```

Первый `once` завершится ошибкой отправки — это ожидаемо. JSON-файл замера
должен остаться в `manual-offline-queue`.

Верните сервер и повторите:

```powershell
$env:LINKWATCH_SERVER_URL = "http://127.0.0.1:8080"
.\dist\linkwatch-agent-windows-amd64.exe once
Get-ChildItem $env:LINKWATCH_QUEUE_DIR -Filter *.json
Remove-Item Env:LINKWATCH_QUEUE_DIR, Env:LINKWATCH_SERVER_URL
```

Ожидаемый результат: агент отправит накопленное наблюдение вместе с новым, а
очередь останется пустой. Этот тест не требует установки Windows Service.
После ручной проверки также выполните
`Remove-Item Env:LINKWATCH_CONFIG_FILE -ErrorAction SilentlyContinue`, если
больше не хотите использовать этот файл явно.

## 8. Необязательная проверка Windows service и tray

Только после успешного `once` можно отдельно проверить запуск exe без команды,
установку service, tray, ручной probe из tray и диагностику. Для core-сценария
это не требуется.
