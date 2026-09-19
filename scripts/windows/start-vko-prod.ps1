[CmdletBinding()]
param(
    [string]$HealthUrl = "",
    [ValidateRange(30, 3600)]
    [int]$ReadinessTimeoutSec = 180,
    [ValidateRange(1, 60)]
    [int]$ReadinessIntervalSec = 5,
    [int]$PostgresPort = 5433,
    [string]$ComposeProject = "vko-linkwatch"
)

$ErrorActionPreference = "Stop"
$repo = (Resolve-Path (Join-Path $PSScriptRoot "../..")).Path
$composeFile = Join-Path $repo "docker-compose.prod.yml"
$composeArguments = @("-p", $ComposeProject, "-f", $composeFile)
$diagnosticsRequired = $false
$locationChanged = $false

function Get-RequiredEnvironmentValue {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Name
    )

    $value = [Environment]::GetEnvironmentVariable($Name)
    if ([string]::IsNullOrWhiteSpace($value)) {
        throw "Set $Name in the PowerShell session before starting the production stack."
    }

    return $value
}

function Invoke-Compose {
    param(
        [Parameter(Mandatory = $true)]
        [string[]]$Arguments
    )

    & docker compose @composeArguments @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "docker compose $($Arguments -join ' ') failed with exit code $LASTEXITCODE."
    }
}

function Resolve-ReadinessUri {
    param(
        [Parameter(Mandatory = $true)]
        [string]$RequestedHealthUrl
    )

    $baseUrl = $RequestedHealthUrl.Trim()
    if ([string]::IsNullOrWhiteSpace($baseUrl)) {
        $baseUrl = [Environment]::GetEnvironmentVariable("LINKWATCH_PUBLIC_URL")
    }

    if ([string]::IsNullOrWhiteSpace($baseUrl)) {
        $publicHost = Get-RequiredEnvironmentValue -Name "LINKWATCH_PUBLIC_HOST"
        $httpsPort = 443
        $configuredHttpsPort = [Environment]::GetEnvironmentVariable("LINKWATCH_HTTPS_PORT")
        if (-not [string]::IsNullOrWhiteSpace($configuredHttpsPort)) {
            if (-not [int]::TryParse($configuredHttpsPort, [ref]$httpsPort) -or $httpsPort -lt 1 -or $httpsPort -gt 65535) {
                throw "LINKWATCH_HTTPS_PORT must be a valid TCP port."
            }
        }

        if ($httpsPort -eq 443) {
            $baseUrl = "https://$publicHost"
        }
        else {
            $baseUrl = "https://$publicHost`:$httpsPort"
        }
    }

    if (-not $baseUrl.EndsWith("/health/ready", [StringComparison]::OrdinalIgnoreCase)) {
        $baseUrl = $baseUrl.TrimEnd("/") + "/health/ready"
    }

    try {
        $uri = [Uri]$baseUrl
    }
    catch {
        throw "Readiness URL is not a valid absolute URL: $baseUrl"
    }

    if (-not $uri.IsAbsoluteUri -or $uri.Scheme -ne "https") {
        throw "Readiness URL must be an HTTPS Caddy surface URL: $uri"
    }
    if (-not [string]::IsNullOrWhiteSpace($uri.Query) -or -not [string]::IsNullOrWhiteSpace($uri.Fragment)) {
        throw "Readiness URL must not contain a query string or fragment: $uri"
    }
    if ($uri.AbsolutePath -ne "/health/ready") {
        throw "Readiness URL must end with /health/ready: $uri"
    }

    if ($uri.Host -in @("backend", "linkwatch-server", "localhost", "127.0.0.1", "::1")) {
        throw "Readiness must use the configured public Caddy surface; internal or loopback URL is not allowed: $uri"
    }

    return $uri
}

function Get-ResponseFailureDetail {
    param(
        [Parameter(Mandatory = $true)]
        [System.Management.Automation.ErrorRecord]$ErrorRecord
    )

    $response = $ErrorRecord.Exception.Response
    if ($null -ne $response -and $null -ne $response.StatusCode) {
        return "HTTP $([int]$response.StatusCode)"
    }

    return $ErrorRecord.Exception.Message
}

function Write-ComposeDiagnostics {
    Write-Host "--- docker compose ps ---"
    & docker compose @composeArguments ps
    if ($LASTEXITCODE -ne 0) {
        Write-Warning "Unable to read docker compose service status (exit code $LASTEXITCODE)."
    }

    foreach ($service in @("caddy", "linkwatch-server", "postgres")) {
        Write-Host "--- docker compose logs --no-color --tail=80 $service ---"
        & docker compose @composeArguments logs --no-color --tail=80 $service
        if ($LASTEXITCODE -ne 0) {
            Write-Warning "Unable to read logs for $service (exit code $LASTEXITCODE)."
        }
    }
}

try {
    [void](Get-RequiredEnvironmentValue -Name "LINKWATCH_POSTGRES_PASSWORD")
    [void](Get-RequiredEnvironmentValue -Name "LINKWATCH_BOOTSTRAP_ADMIN_USERNAME")
    [void](Get-RequiredEnvironmentValue -Name "LINKWATCH_BOOTSTRAP_ADMIN_PASSWORD")
    [void](Get-RequiredEnvironmentValue -Name "LINKWATCH_PUBLIC_HOST")
    [void](Get-RequiredEnvironmentValue -Name "LINKWATCH_TLS_EMAIL")

    $env:LINKWATCH_ENV = if ($env:LINKWATCH_ENV) { $env:LINKWATCH_ENV } else { "production" }
    $env:LINKWATCH_POSTGRES_DB = if ($env:LINKWATCH_POSTGRES_DB) { $env:LINKWATCH_POSTGRES_DB } else { "linkwatch" }
    $env:LINKWATCH_POSTGRES_USER = if ($env:LINKWATCH_POSTGRES_USER) { $env:LINKWATCH_POSTGRES_USER } else { "linkwatch" }
    $env:LINKWATCH_POSTGRES_PORT = $PostgresPort

    Push-Location $repo
    $locationChanged = $true

    & (Join-Path $PSScriptRoot "test-vko-prod.ps1") -ComposeProject $ComposeProject
    if ($LASTEXITCODE -ne 0) {
        throw "Production topology checks failed with exit code $LASTEXITCODE."
    }

    $readinessUri = Resolve-ReadinessUri -RequestedHealthUrl $HealthUrl
    Write-Host "Starting LINKWATCH production stack; readiness surface: $readinessUri"
    $diagnosticsRequired = $true
    Invoke-Compose -Arguments @("up", "-d", "--build")
    Invoke-Compose -Arguments @("ps")

    $deadline = [DateTime]::UtcNow.AddSeconds($ReadinessTimeoutSec)
    $ready = $false
    $lastFailure = "no response received"
    while ([DateTime]::UtcNow -lt $deadline) {
        try {
            $response = Invoke-WebRequest -Uri $readinessUri -UseBasicParsing -TimeoutSec ([Math]::Max(1, $ReadinessIntervalSec))
            if ([int]$response.StatusCode -eq 200) {
                $ready = $true
                break
            }

            $lastFailure = "HTTP $([int]$response.StatusCode)"
        }
        catch {
            $lastFailure = Get-ResponseFailureDetail -ErrorRecord $_
        }

        Write-Verbose "Readiness probe failed: $lastFailure. Retrying in $ReadinessIntervalSec second(s)."
        Start-Sleep -Seconds $ReadinessIntervalSec
    }

    if (-not $ready) {
        throw "LINKWATCH Caddy readiness did not succeed within $ReadinessTimeoutSec second(s) at $readinessUri. Last probe result: $lastFailure"
    }

    Write-Host "LINKWATCH production surface is ready: $readinessUri"
    Write-Host "Run scripts/wsl/run-agent-once.sh from WSL when the agent test is required."
}
catch {
    Write-Error $_
    if ($diagnosticsRequired) {
        Write-ComposeDiagnostics
    }
    exit 1
}
finally {
    if ($locationChanged) {
        Pop-Location
    }
}
