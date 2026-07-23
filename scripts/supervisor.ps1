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
$BackendLauncher = Join-Path $BackendRoot "start_backend.bat"
$BackendPort = Get-EnvValue -Path $BackendEnvPath -Name "BACKEND_PORT"
if (-not $BackendPort) { $BackendPort = "8000" }
$AgentEntry = Join-Path $OpsRoot "dist\agent\main.js"
$StateDir = Join-Path $OpsRoot "agent-state"
$SupervisorLog = Join-Path $StateDir "supervisor.log"
$AgentStdoutLog = Join-Path $StateDir "agent.stdout.log"
$AgentStderrLog = Join-Path $StateDir "agent.stderr.log"

New-Item -ItemType Directory -Force -Path $StateDir | Out-Null

function Write-SafeLog([string]$Message) {
  $line = "{0} {1}" -f (Get-Date -Format "yyyy-MM-ddTHH:mm:ssK"), $Message
  Add-Content -LiteralPath $SupervisorLog -Value $line -Encoding UTF8
}

function Rotate-Log([string]$Path) {
  if ((Test-Path -LiteralPath $Path) -and (Get-Item -LiteralPath $Path).Length -gt 5MB) {
    $archive = "$Path.1"
    if (Test-Path -LiteralPath $archive) { Remove-Item -LiteralPath $archive -Force }
    Move-Item -LiteralPath $Path -Destination $archive -Force
  }
}

function Get-BackendProcesses {
  return @(Get-CimInstance Win32_Process | Where-Object {
    $_.Name -eq "python.exe" -and
    $_.CommandLine -match "uvicorn\s+main:app" -and
    $_.CommandLine -match ("--port\s+{0}" -f [regex]::Escape($BackendPort))
  })
}

if (-not (Test-Path -LiteralPath $AgentConfig)) { throw "Falta .secrets\agent.env. Ejecute npm run secrets:generate." }
if (-not (Test-Path -LiteralPath $AgentEntry)) { throw "Falta dist\agent\main.js. Ejecute npm run build." }
if (-not (Test-Path -LiteralPath $BackendLauncher)) { throw "No se encontro el lanzador del backend local." }

$env:OPS_AGENT_CONFIG_PATH = $AgentConfig
$agentProcess = $null
$backendUnhealthyLogged = $false
Write-SafeLog "Supervisor iniciado."

while ($true) {
  try {
    $backendReady = $false
    try {
      $health = Invoke-WebRequest -UseBasicParsing -Uri ("http://127.0.0.1:{0}/health" -f $BackendPort) -TimeoutSec 4
      $backendReady = $health.StatusCode -eq 200
    } catch { $backendReady = $false }

    if (-not $backendReady) {
      $backendProcesses = Get-BackendProcesses
      if ($backendProcesses.Count -eq 0) {
        Write-SafeLog "Backend local no disponible y sin proceso; iniciando."
        $env:BACKEND_PORT = $BackendPort
        Start-Process -FilePath "cmd.exe" -ArgumentList @("/c", $BackendLauncher) -WindowStyle Hidden | Out-Null
      } elseif (-not $backendUnhealthyLogged) {
        Write-SafeLog "Backend local sin respuesta pero con proceso existente; no se inicia duplicado."
        $backendUnhealthyLogged = $true
      }
    } else {
      $backendUnhealthyLogged = $false
    }

    if ($null -eq $agentProcess -or $agentProcess.HasExited) {
      Write-SafeLog "Agente no disponible; iniciando."
      Rotate-Log $AgentStdoutLog
      Rotate-Log $AgentStderrLog
      $agentProcess = Start-Process -FilePath "node.exe" -ArgumentList @($AgentEntry) -WorkingDirectory $OpsRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput $AgentStdoutLog -RedirectStandardError $AgentStderrLog
    }
  } catch {
    Write-SafeLog ("Error de supervision: " + $_.Exception.GetType().Name)
  }
  Start-Sleep -Seconds 10
}
