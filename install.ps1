# Install the Cat Tower Factory on this PC:
#   - installs its one dependency (better-sqlite3)
#   - Startup shortcut: the daemon starts hidden whenever you log in
#   - Desktop shortcut "Cat Tower Factory": opens the dashboard
#   - starts the daemon now and opens the dashboard
# Run again any time (idempotent). Remove with:  ./factory/install.ps1 -Uninstall
param([switch]$Uninstall)
$ErrorActionPreference = 'Stop'
$factory = $PSScriptRoot
$startup = [Environment]::GetFolderPath('Startup')
$desktop = [Environment]::GetFolderPath('Desktop')
$startLink = Join-Path $startup 'Cat Tower Factory.lnk'
$deskLink = Join-Path $desktop 'Cat Tower Factory.url'
$url = 'http://127.0.0.1:4477'

if ($Uninstall) {
  Remove-Item $startLink, $deskLink -ErrorAction SilentlyContinue
  Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
    Where-Object { $_.CommandLine -like "*factory*server.mjs*" } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
  Write-Host 'Removed the Startup and Desktop shortcuts and stopped the daemon. Your Factory data in factory/data is kept.'
  return
}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Node.js is not on PATH.' }
Push-Location $factory
try { npm install --no-audit --no-fund | Out-Host } finally { Pop-Location }
New-Item -ItemType Directory -Force (Join-Path $factory 'data') | Out-Null

$shell = New-Object -ComObject WScript.Shell
$lnk = $shell.CreateShortcut($startLink)
$lnk.TargetPath = 'wscript.exe'
$lnk.Arguments = '"' + (Join-Path $factory 'start-hidden.vbs') + '"'
$lnk.WorkingDirectory = Split-Path $factory -Parent
$lnk.Description = 'Starts the Cat Tower Factory daemon'
$lnk.Save()

$icon = Join-Path $factory 'ui\factory.ico'
$lnk.IconLocation = "$icon,0"
$lnk.Save()
Set-Content -Path $deskLink -Value "[InternetShortcut]`r`nURL=$url`r`nIconFile=$icon`r`nIconIndex=0`r`n" -Encoding ASCII

$running = $false
try { $running = (Invoke-WebRequest "$url/api/home" -UseBasicParsing -TimeoutSec 2).StatusCode -eq 200 } catch {}
if (-not $running) {
  Start-Process 'wscript.exe' -ArgumentList ('"' + (Join-Path $factory 'start-hidden.vbs') + '"')
  Start-Sleep -Seconds 3
}
Start-Process $url
Write-Host "Cat Tower Factory installed. Dashboard: $url (Desktop shortcut 'Cat Tower Factory'). It starts by itself when you log in."
