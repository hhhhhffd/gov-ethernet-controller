[CmdletBinding()]
param(
    [int]$AppPort = 8000,
    [int]$PostgresPort = 5433,
    [string]$ComposeProject = "vko-linkwatch"
)

$ErrorActionPreference = "Stop"
$repo = (Resolve-Path (Join-Path $PSScriptRoot "../..")).Path

if ([string]::IsNullOrWhiteSpace($env:LINKWATCH_POSTGRES_PASSWORD)) {
    throw "Set LINKWATCH_POSTGRES_PASSWORD in the PowerShell session before starting the stack."
}
if ([string]::IsNullOrWhiteSpace($env:LINKWATCH_BOOTSTRAP_ADMIN_USERNAME) -or [string]::IsNullOrWhiteSpace($env:LINKWATCH_BOOTSTRAP_ADMIN_PASSWORD)) {
    throw "Set LINKWATCH_BOOTSTRAP_ADMIN_USERNAME and LINKWATCH_BOOTSTRAP_ADMIN_PASSWORD (12+ characters) before starting production."
}

$env:LINKWATCH_ENV = if ($env:LINKWATCH_ENV) { $env:LINKWATCH_ENV } else { "production" }
$env:LINKWATCH_POSTGRES_DB = if ($env:LINKWATCH_POSTGRES_DB) { $env:LINKWATCH_POSTGRES_DB } else { "linkwatch" }
$env:LINKWATCH_POSTGRES_USER = if ($env:LINKWATCH_POSTGRES_USER) { $env:LINKWATCH_POSTGRES_USER } else { "linkwatch" }
$env:LINKWATCH_SERVER_PORT = $AppPort
$env:LINKWATCH_POSTGRES_PORT = $PostgresPort

Push-Location $repo
try {
    docker compose -p $ComposeProject -f docker-compose.prod.yml up -d --build
    docker compose -p $ComposeProject -f docker-compose.prod.yml ps
    Invoke-RestMethod -Uri ("http://127.0.0.1:{0}/health/ready" -f $AppPort) -TimeoutSec 15
    Write-Host "LINKWATCH production-like stack is ready. Run scripts/wsl/run-agent-once.sh from WSL."
}
finally {
    Pop-Location
}
