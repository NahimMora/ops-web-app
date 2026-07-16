$ErrorActionPreference = "Stop"
$OpsRoot = Split-Path -Parent $PSScriptRoot
$AgentConfig = Join-Path $OpsRoot ".secrets\agent.env"
$BackendLauncher = "D:\WebApp_HolaSalta\backend\start_backend.bat"
$AgentEntry = Join-Path $OpsRoot "dist\agent\main.js"
$StateDir = Join-Path $OpsRoot "agent-state"
$SupervisorLog = Join-Path $StateDir "supervisor.log"

New-Item -ItemType Directory -Force -Path $StateDir | Out-Null

function Write-SafeLog([string]$Message) {
  $line = "{0} {1}" -f (Get-Date -Format "yyyy-MM-ddTHH:mm:ssK"), $Message
  Add-Content -LiteralPath $SupervisorLog -Value $line -Encoding UTF8
}

if (-not (Test-Path -LiteralPath $AgentConfig)) { throw "Falta .secrets\agent.env. Ejecute npm run secrets:generate." }
if (-not (Test-Path -LiteralPath $AgentEntry)) { throw "Falta dist\agent\main.js. Ejecute npm run build." }
if (-not (Test-Path -LiteralPath $BackendLauncher)) { throw "No se encontro el lanzador del backend local." }

$env:OPS_AGENT_CONFIG_PATH = $AgentConfig
$agentProcess = $null
Write-SafeLog "Supervisor iniciado."

while ($true) {
  try {
    $backendReady = $false
    try {
      $health = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:8000/health" -TimeoutSec 4
      $backendReady = $health.StatusCode -eq 200
    } catch { $backendReady = $false }

    if (-not $backendReady) {
      Write-SafeLog "Backend local no disponible; iniciando."
      Start-Process -FilePath "cmd.exe" -ArgumentList @("/c", $BackendLauncher) -WindowStyle Hidden | Out-Null
    }

    if ($null -eq $agentProcess -or $agentProcess.HasExited) {
      Write-SafeLog "Agente no disponible; iniciando."
      $agentProcess = Start-Process -FilePath "node.exe" -ArgumentList @($AgentEntry) -WorkingDirectory $OpsRoot -WindowStyle Hidden -PassThru
    }
  } catch {
    Write-SafeLog ("Error de supervision: " + $_.Exception.GetType().Name)
  }
  Start-Sleep -Seconds 10
}
