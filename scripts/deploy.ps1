# Run this after every round of fixes: pulls both repos (Ops + the backend),
# rebuilds/reinstalls only what actually changed, and restarts only the
# process(es) that need it - the supervisor task (already running) picks the
# restarted process back up within its own poll interval. The Windows
# scheduled task itself is only restarted when supervisor.ps1 changed (it's a
# long-running script: a pull alone never reaches the copy already running).
#
# Usage: from C:\HolaSalta\Ops -> .\scripts\deploy.ps1
# (Run `Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force`
# first in this shell if you haven't already this session.)

$ErrorActionPreference = "Stop"
$OpsRoot = Split-Path -Parent $PSScriptRoot
$AgentConfig = Join-Path $OpsRoot ".secrets\agent.env"

function Get-EnvValue([string]$Path, [string]$Name) {
  if (-not (Test-Path -LiteralPath $Path)) { return $null }
  $line = Select-String -LiteralPath $Path -Pattern ("^\s*{0}\s*=" -f [regex]::Escape($Name)) -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $line) { return $null }
  $value = ($line.Line -replace ("^\s*{0}\s*=\s*" -f [regex]::Escape($Name)), "").Trim()
  return $value.Trim('"').Trim("'")
}

$BackendEnvPath = Get-EnvValue -Path $AgentConfig -Name "OPS_LOCAL_BACKEND_ENV_PATH"
if (-not $BackendEnvPath) { throw "OPS_LOCAL_BACKEND_ENV_PATH no esta definido en .secrets\agent.env." }
$BackendRoot = Split-Path -Parent $BackendEnvPath

function Section([string]$Title) {
  Write-Host ""
  Write-Host "=== $Title ===" -ForegroundColor Cyan
}

function Pull-Repo([string]$Path, [string]$Label) {
  Push-Location $Path
  try {
    $before = (git rev-parse HEAD).Trim()
    git pull --ff-only
    if ($LASTEXITCODE -ne 0) { throw "git pull fallo en $Label ($Path)." }
    $after = (git rev-parse HEAD).Trim()
    $changedFiles = @()
    if ($before -ne $after) {
      $changedFiles = git diff --name-only $before $after
      Write-Host "$Label actualizado ($($before.Substring(0,7)) -> $($after.Substring(0,7))):" -ForegroundColor Green
      git log --oneline "$before..$after" | ForEach-Object { Write-Host "  $_" }
    } else {
      Write-Host "$Label sin cambios nuevos." -ForegroundColor DarkGray
    }
    return $changedFiles
  } finally {
    Pop-Location
  }
}

function Stop-MatchingProcess([string]$CommandLinePattern, [string]$Label) {
  $procs = Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like $CommandLinePattern }
  if (-not $procs) {
    Write-Host "  (no habia proceso de $Label corriendo - el supervisor lo va a arrancar solo)" -ForegroundColor DarkGray
    return
  }
  foreach ($p in $procs) {
    Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
    Write-Host "  Detenido $Label (PID $($p.ProcessId))" -ForegroundColor Yellow
  }
}

Section "Ops ($OpsRoot)"
$opsChanged = Pull-Repo -Path $OpsRoot -Label "Ops"

Section "Backend ($BackendRoot)"
$backendChanged = Pull-Repo -Path $BackendRoot -Label "Backend"

if ($opsChanged) {
  Section "Reconstruyendo agente"
  Push-Location $OpsRoot
  try {
    if ($opsChanged -match "package(-lock)?\.json") {
      Write-Host "package.json/package-lock.json cambio - corriendo npm ci..." -ForegroundColor Yellow
      npm ci
      if ($LASTEXITCODE -ne 0) { throw "npm ci fallo." }
    }
    npm run build:agent
    if ($LASTEXITCODE -ne 0) { throw "npm run build:agent fallo." }
  } finally {
    Pop-Location
  }
}

if ($backendChanged -match "backend/requirements\.txt") {
  Section "requirements.txt cambio - actualizando .venv (incremental)"
  $pipExe = Join-Path $BackendRoot ".venv\Scripts\pip.exe"
  if (Test-Path -LiteralPath $pipExe) {
    & $pipExe install -r (Join-Path $BackendRoot "backend\requirements.txt")
    if ($LASTEXITCODE -ne 0) { throw "pip install fallo." }
  } else {
    Write-Host "  No se encontro .venv en $BackendRoot - correr install_nueva_pc.bat a mano." -ForegroundColor Red
  }
}

# YouTube/X change their sites constantly and an old yt-dlp is the usual
# cause of 403s and failed video downloads. It's a subprocess of the backend,
# so updating needs no restart. Best effort: never fails the deploy.
Section "Actualizando yt-dlp"
try {
  $ytdlp = (Get-Command yt-dlp -ErrorAction Stop).Source
  & $ytdlp -U
  if ($LASTEXITCODE -ne 0) { Write-Host "  yt-dlp -U fallo (en una instalacion de chocolatey: choco upgrade yt-dlp -y como admin)." -ForegroundColor Yellow }
} catch {
  Write-Host "  No se pudo actualizar yt-dlp: $($_.Exception.Message)" -ForegroundColor Yellow
}

# Tells the health monitor (apps/monitor) that the restarts below are on
# purpose, so "backend/agente levantado" right after isn't mailed as a failure.
if ($backendChanged -or $opsChanged) {
  try {
    $line = "{0} Reinicio planificado (deploy.ps1): backend={1} agente={2}" -f (Get-Date -Format "yyyy-MM-ddTHH:mm:ssK"), [bool]$backendChanged, [bool]$opsChanged
    Add-Content -LiteralPath (Join-Path $OpsRoot "agent-state\supervisor.log") -Value $line -Encoding UTF8
  } catch {
    Write-Host "  (no se pudo anotar el reinicio en supervisor.log: $($_.Exception.Message))" -ForegroundColor DarkGray
  }
}

if ($opsChanged -match "scripts/supervisor\.ps1") {
  Section "supervisor.ps1 cambio - reiniciando la tarea del supervisor"
  # Backend/agent keep running across this: the new instance adopts them.
  Stop-ScheduledTask -TaskName "HolaSalta Ops Local Agent" -ErrorAction SilentlyContinue
  Start-ScheduledTask -TaskName "HolaSalta Ops Local Agent"
}

if ($backendChanged) {
  Section "Reiniciando backend"
  Stop-MatchingProcess -CommandLinePattern "*uvicorn main:app*" -Label "backend"
}

if ($opsChanged) {
  Section "Reiniciando agente"
  Stop-MatchingProcess -CommandLinePattern "*dist\agent\main.js*" -Label "agente"
}

if (-not $opsChanged -and -not $backendChanged) {
  Write-Host ""
  Write-Host "Nada nuevo para desplegar." -ForegroundColor DarkGray
  exit 0
}

Section "Esperando a que el supervisor levante todo de nuevo (20s)"
Start-Sleep -Seconds 20

Section "Verificacion final"
& (Join-Path $PSScriptRoot "doctor.ps1")
