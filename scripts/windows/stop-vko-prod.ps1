[CmdletBinding()]
param([string]$ComposeProject = "vko-linkwatch")

$ErrorActionPreference = "Stop"
$repo = (Resolve-Path (Join-Path $PSScriptRoot "../..")).Path
Push-Location $repo
try {
    docker compose -p $ComposeProject -f docker-compose.prod.yml down
}
finally {
    Pop-Location
}
