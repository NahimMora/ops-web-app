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

# Baileys (WhatsApp, optional): only watched when the backend is actually
# configured to use it - WHATSAPP_ENGINE=playwright (the default) means no
# such service is expected to be running at all, and "recovering" it then
# would just be noise/wrong. See WebApp_HolaSalta/CLAUDE.md's "Motor de
# WhatsApp" section. This mirrors the backend health-check loop below, but
# recovery here is "the PM2 daemon and/or the app under it isn't there at
# all" (start-pm2.ps1's `pm2 resurrect`, same script
# install-pm2-task.ps1 wires into AtLogOn) - PM2 itself already handles the
# underlying Node process crash-looping (ecosystem.config.js's
# min_uptime/max_restarts/restart_delay), so this supervisor only needs to
# step in when there's no PM2 daemon left to do that job (observed
# 2026-09-04: the daemon itself died, silently, with nothing watching it).
$BaileysEnabled = ((Get-EnvValue -Path $BackendEnvPath -Name "WHATSAPP_ENGINE") -eq "baileys")
$BaileysPort = Get-EnvValue -Path $BackendEnvPath -Name "WPP_BAILEYS_PORT"
if (-not $BaileysPort) { $BaileysPort = "8791" }
$BaileysServiceRoot = Join-Path $BackendRoot "whatsapp\baileys-service"
$BaileysStartScript = Join-Path $BaileysServiceRoot "scripts\start-pm2.ps1"
if ($BaileysEnabled -and -not (Test-Path -LiteralPath $BaileysStartScript)) {
  Write-Warning "WHATSAPP_ENGINE=baileys pero no se encontro $BaileysStartScript - el supervisor no va a poder recuperar ese servicio."
  $BaileysEnabled = $false
}
# Recovery is a full `pm2 resurrect`/`pm2 start`, not a cheap check - and if
# something genuinely needs a human (corrupted auth/, pm2 itself missing),
# retrying every 10s would just spam supervisor.log and burn CPU for no
# benefit. One attempt per cooldown window is enough; a real recovery is
# visible again well within it.
$BaileysRecoveryCooldownSeconds = 60
$baileysLastRecoveryAttempt = $null

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

function Get-AgentProcesses {
  # $agentProcess only tracks a process this *script instance* started. If
  # the supervisor task gets stopped and restarted (a fresh PowerShell
  # process, $agentProcess starts back at $null), the previous instance's
  # agent child is still alive but now orphaned from any tracking — the old
  # "always spawn when $agentProcess is null" logic would launch a second
  # one on top of it every time, silently, with no error (found running in
  # pairs after a routine task restart on 2026-08-06). Same fix as
  # Get-BackendProcesses: check the OS directly, not an in-memory variable.
  return @(Get-CimInstance Win32_Process | Where-Object {
    $_.Name -eq "node.exe" -and
    $_.CommandLine -match [regex]::Escape($AgentEntry)
  })
}

function Get-BackendProcesses {
  # Matches both the venv launcher (python.exe running the venv's
  # Scripts\python.exe path) and the interpreter it spawns to actually run
  # uvicorn on some venv layouts — either can end up as the CommandLine's
  # process name here since Win32_Process.Name is just the image file name.
  return @(Get-CimInstance Win32_Process | Where-Object {
    $_.Name -eq "python.exe" -and
    $_.CommandLine -match "uvicorn\s+main:app" -and
    $_.CommandLine -match ("--port\s+{0}" -f [regex]::Escape($BackendPort))
  })
}

# How long the backend is allowed to sit "process exists but /health doesn't
# respond" before we treat it as hung rather than just slow to start, and
# force-kill it so the next loop iteration launches a clean replacement.
# Without this, a genuinely deadlocked backend (observed for 18+ minutes on
# 2026-08-03, per supervisor.log) sits unrecovered forever: the existing
# "don't start a duplicate" guard is correct for a slow-starting process but
# has no expiry, so it never distinguishes "still starting" from "hung."
$BackendUnhealthyGraceSeconds = 180
$backendUnhealthySince = $null

if (-not (Test-Path -LiteralPath $AgentConfig)) { throw "Falta .secrets\agent.env. Ejecute npm run secrets:generate." }
if (-not (Test-Path -LiteralPath $AgentEntry)) { throw "Falta dist\agent\main.js. Ejecute npm run build." }
if (-not (Test-Path -LiteralPath $BackendLauncher)) { throw "No se encontro el lanzador del backend local." }

$env:OPS_AGENT_CONFIG_PATH = $AgentConfig
$agentProcess = $null
$backendUnhealthyLogged = $false
Write-SafeLog "Supervisor iniciado."

while ($true) {
  try {
    Rotate-Log $SupervisorLog
    $backendReady = $false
    try {
      $health = Invoke-WebRequest -UseBasicParsing -Uri ("http://127.0.0.1:{0}/health" -f $BackendPort) -TimeoutSec 4
      $backendReady = $health.StatusCode -eq 200
    } catch { $backendReady = $false }

    if (-not $backendReady) {
      $backendProcesses = Get-BackendProcesses
      if ($backendProcesses.Count -eq 0) {
        Write-SafeLog "Backend local no disponible y sin proceso; iniciando."
        $backendUnhealthySince = $null
        $env:BACKEND_PORT = $BackendPort
        Start-Process -FilePath "cmd.exe" -ArgumentList @("/c", $BackendLauncher) -WindowStyle Hidden | Out-Null
      } else {
        if ($null -eq $backendUnhealthySince) { $backendUnhealthySince = Get-Date }
        $unhealthyFor = (Get-Date) - $backendUnhealthySince
        if ($unhealthyFor.TotalSeconds -ge $BackendUnhealthyGraceSeconds) {
          Write-SafeLog ("Backend local colgado desde hace {0:N0}s (proceso vivo, /health no responde); forzando reinicio." -f $unhealthyFor.TotalSeconds)
          foreach ($proc in $backendProcesses) {
            try { Stop-Process -Id $proc.ProcessId -Force -ErrorAction Stop } catch { Write-SafeLog ("No se pudo terminar PID {0}: {1}" -f $proc.ProcessId, $_.Exception.Message) }
          }
          $backendUnhealthySince = $null
          $backendUnhealthyLogged = $false
        } elseif (-not $backendUnhealthyLogged) {
          Write-SafeLog "Backend local sin respuesta pero con proceso existente; no se inicia duplicado."
          $backendUnhealthyLogged = $true
        }
      }
    } else {
      $backendUnhealthySince = $null
      $backendUnhealthyLogged = $false
    }

    if ($BaileysEnabled) {
      $baileysReady = $false
      try {
        $baileysHealth = Invoke-WebRequest -UseBasicParsing -Uri ("http://127.0.0.1:{0}/health" -f $BaileysPort) -TimeoutSec 4
        # Any 200 means the process itself is up and answering - "ready" vs.
        # "needs_auth"/"connecting" is a WhatsApp-session concern (needs a
        # human for QR/pairing), not something restarting the process fixes.
        # Only a connection failure (process/daemon not there) is this
        # supervisor's job.
        $baileysReady = $baileysHealth.StatusCode -eq 200
      } catch { $baileysReady = $false }

      if (-not $baileysReady) {
        $now = Get-Date
        if ($null -eq $baileysLastRecoveryAttempt -or ((New-TimeSpan -Start $baileysLastRecoveryAttempt -End $now).TotalSeconds -ge $BaileysRecoveryCooldownSeconds)) {
          Write-SafeLog "Servicio Baileys (WhatsApp) no responde en 127.0.0.1:$BaileysPort; ejecutando start-pm2.ps1 para recuperarlo."
          $baileysLastRecoveryAttempt = $now
          try {
            & $BaileysStartScript *>> $SupervisorLog
          } catch {
            Write-SafeLog ("Fallo al recuperar el servicio Baileys: " + $_.Exception.Message)
          }
        }
      } else {
        $baileysLastRecoveryAttempt = $null
      }
    }

    if ($null -eq $agentProcess -or $agentProcess.HasExited) {
      $existingAgents = Get-AgentProcesses
      if ($existingAgents.Count -gt 0) {
        $adopted = $existingAgents[0]
        Write-SafeLog ("Agente ya en ejecucion (PID {0}); no se inicia duplicado." -f $adopted.ProcessId)
        $agentProcess = Get-Process -Id $adopted.ProcessId -ErrorAction SilentlyContinue
      } else {
        Write-SafeLog "Agente no disponible; iniciando."
        Rotate-Log $AgentStdoutLog
        Rotate-Log $AgentStderrLog
        $agentProcess = Start-Process -FilePath "node.exe" -ArgumentList @($AgentEntry) -WorkingDirectory $OpsRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput $AgentStdoutLog -RedirectStandardError $AgentStderrLog
      }
    }
  } catch {
    Write-SafeLog ("Error de supervision: " + $_.Exception.GetType().Name)
  }
  Start-Sleep -Seconds 10
}
