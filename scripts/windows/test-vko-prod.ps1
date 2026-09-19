[CmdletBinding()]
param(
    [string]$ComposeProject = "vko-linkwatch"
)

$ErrorActionPreference = "Stop"
$repo = (Resolve-Path (Join-Path $PSScriptRoot "../..")).Path
$composeFile = Join-Path $repo "docker-compose.prod.yml"
$startupScript = Join-Path $PSScriptRoot "start-vko-prod.ps1"
$caddyFile = Join-Path $repo "deployment/Caddyfile"
$composeArguments = @("-p", $ComposeProject, "-f", $composeFile)

function Get-ComposeConfig {
    $json = & docker compose @composeArguments config --format json
    if ($LASTEXITCODE -ne 0) {
        throw "docker compose config failed with exit code $LASTEXITCODE."
    }
    if ([string]::IsNullOrWhiteSpace(($json -join ""))) {
        throw "docker compose config returned an empty configuration."
    }

    try {
        return ($json -join [Environment]::NewLine) | ConvertFrom-Json
    }
    catch {
        throw "docker compose config did not return valid JSON: $($_.Exception.Message)"
    }
}

if (-not (Test-Path $startupScript)) {
    throw "Missing production startup script: $startupScript"
}
if (-not (Test-Path $caddyFile)) {
    throw "Missing production Caddyfile: $caddyFile"
}

$startupSource = Get-Content -Raw -Path $startupScript
foreach ($forbiddenPattern in @(
        '\$AppPort',
        "127\.0\.0\.1:\{0\}/health/ready",
        "LINKWATCH_SERVER_PORT"
    )) {
    if ($startupSource -match $forbiddenPattern) {
        throw "Startup script still contains the obsolete direct-backend probe pattern: $forbiddenPattern"
    }
}
foreach ($requiredPattern in @(
        "Resolve-ReadinessUri",
        "ReadinessTimeoutSec",
        "health/ready",
        "Write-ComposeDiagnostics"
    )) {
    if ($startupSource -notmatch $requiredPattern) {
        throw "Startup script is missing the required readiness behavior: $requiredPattern"
    }
}

$caddySource = Get-Content -Raw -Path $caddyFile
if ($caddySource -notmatch "(?m)^\s*reverse_proxy\s+linkwatch-server:8080(?:\s*\{)?\s*$") {
    throw "Caddyfile does not preserve the internal linkwatch-server:8080 reverse proxy."
}

Push-Location $repo
try {
    $config = Get-ComposeConfig
    $services = $config.services
    $server = $services.'linkwatch-server'
    $caddy = $services.caddy

    if ($null -eq $server) {
        throw "Production Compose is missing the linkwatch-server service."
    }
    if ($null -eq $caddy) {
        throw "Production Compose is missing the caddy service."
    }
    if (@($server.ports).Count -gt 0) {
        throw "Production Compose must not publish linkwatch-server ports to the host."
    }
    if (@($server.expose | ForEach-Object { [string]$_ }) -notcontains "8080") {
        throw "Production Compose must keep linkwatch-server:8080 internal via expose."
    }

    foreach ($requiredTarget in @("80", "443")) {
        $publishedMappings = @($caddy.ports | Where-Object { [string]$_.target -eq $requiredTarget })
        if ($publishedMappings.Count -ne 1 -or [string]::IsNullOrWhiteSpace([string]$publishedMappings[0].published)) {
            throw "Production Compose must publish Caddy target port $requiredTarget to a host port."
        }
    }
    $postgresDependency = $server.depends_on.postgres
    if ($null -eq $postgresDependency -or [string]$postgresDependency.condition -ne "service_healthy") {
        throw "linkwatch-server must wait for a healthy PostgreSQL service before starting."
    }
    $serverDependency = $caddy.depends_on.'linkwatch-server'
    if ($null -eq $serverDependency -or [string]$serverDependency.condition -ne "service_healthy") {
        throw "Caddy must wait for a healthy linkwatch-server before starting."
    }

    Write-Host "TASK-007 production topology checks: PASS"
    Write-Host "  backend: internal expose 8080 only"
    Write-Host "  public surface: Caddy ports 80/443"
    Write-Host "  readiness: HTTPS /health/ready"
}
finally {
    Pop-Location
}
