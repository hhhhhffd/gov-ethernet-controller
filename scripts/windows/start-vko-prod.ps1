[CmdletBinding()]
param(
    [int]$AppPort = 8000,
    [int]$PostgresPort = 5433,
    [string]$ComposeProject = "vko-linkwatch"
)

$ErrorActionPreference = "Stop"
$repo = (Resolve-Path (Join-Path $PSScriptRoot "../..")).Path

if ([string]::IsNullOrWhiteSpace($env:VKO_POSTGRES_PASSWORD)) {
    throw "Set VKO_POSTGRES_PASSWORD in the PowerShell session before starting the stack."
}

$env:VKO_ENV = if ($env:VKO_ENV) { $env:VKO_ENV } else { "staging" }
$env:VKO_AUTO_SEED = if ($env:VKO_AUTO_SEED) { $env:VKO_AUTO_SEED } else { "1" }
$env:VKO_POSTGRES_DB = if ($env:VKO_POSTGRES_DB) { $env:VKO_POSTGRES_DB } else { "vko" }
$env:VKO_POSTGRES_USER = if ($env:VKO_POSTGRES_USER) { $env:VKO_POSTGRES_USER } else { "vko" }
$env:VKO_APP_PORT = $AppPort
$env:VKO_POSTGRES_PORT = $PostgresPort

Push-Location $repo
try {
    docker compose -p $ComposeProject -f docker-compose.prod.yml up -d --build
    docker compose -p $ComposeProject -f docker-compose.prod.yml ps
    Invoke-RestMethod -Uri ("http://127.0.0.1:{0}/health" -f $AppPort) -TimeoutSec 15
    Write-Host "VKO staging stack is ready. Run scripts/wsl/run-agent-once.sh from WSL."
}
finally {
    Pop-Location
}
