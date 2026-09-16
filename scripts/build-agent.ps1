[CmdletBinding()]
param(
    [ValidateSet("x86_64-pc-windows-gnu", "x86_64-pc-windows-msvc")]
    [string]$Target = "x86_64-pc-windows-gnu"
)

$ErrorActionPreference = "Stop"
$repo = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$manifest = Join-Path $repo "agent/Cargo.toml"
$dist = Join-Path $repo "dist"
New-Item -ItemType Directory -Force -Path $dist | Out-Null

rustup target add $Target
cargo build --release --manifest-path $manifest --target $Target

$binary = Join-Path $repo ("agent/target/{0}/release/linkwatch-agent.exe" -f $Target)
if (-not (Test-Path $binary)) {
    throw "Rust did not produce $binary. Install the linker/toolchain for $Target and retry."
}
Copy-Item -Force $binary (Join-Path $dist "linkwatch-agent-windows-amd64.exe")
Write-Host ("Created {0}" -f (Join-Path $dist "linkwatch-agent-windows-amd64.exe"))
