# Start the Cat Tower Factory daemon in this window (Ctrl+C stops it and any runs it started).
# For a hidden background start, use the Startup shortcut that install.ps1 creates.
$ErrorActionPreference = 'Stop'
$factory = $PSScriptRoot
if (-not (Test-Path (Join-Path $factory 'node_modules/better-sqlite3'))) {
  Write-Host 'Installing the Factory dependency (better-sqlite3)...'
  Push-Location $factory; npm install --no-audit --no-fund; Pop-Location
}
Start-Process 'http://127.0.0.1:4477'
node (Join-Path $factory 'server.mjs')
