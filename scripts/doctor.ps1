$ErrorActionPreference = "Continue"
$OpsRoot = Split-Path -Parent $PSScriptRoot
$checks = @()

function Add-Check([string]$Name, [bool]$Ok, [string]$Detail) {
  $script:checks += [pscustomobject]@{ Componente = $Name; Estado = $(if ($Ok) { "OK" } else { "ERROR" }); Detalle = $Detail }
}

Add-Check "Node" ($null -ne (Get-Command node.exe -ErrorAction SilentlyContinue)) "Node.js debe estar en PATH"
Add-Check "Build agente" (Test-Path -LiteralPath (Join-Path $OpsRoot "dist\agent\main.js")) "npm run build"
Add-Check "Config agente" (Test-Path -LiteralPath (Join-Path $OpsRoot ".secrets\agent.env")) "Valores no mostrados"
$backendProcesses = @(Get-CimInstance Win32_Process | Where-Object {
  $_.Name -eq "python.exe" -and
  $_.CommandLine -match "uvicorn\s+main:app" -and
  $_.CommandLine -match "--port\s+8000"
})
$backendIds = @($backendProcesses | ForEach-Object { $_.ProcessId })
$backendRoots = @($backendProcesses | Where-Object { $backendIds -notcontains $_.ParentProcessId })
Add-Check "Instancia backend" ($backendRoots.Count -le 1) ("Raices Uvicorn: " + $backendRoots.Count)
try { $r = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:8000/health" -TimeoutSec 5; Add-Check "Backend local" ($r.StatusCode -eq 200) "127.0.0.1:8000" } catch { Add-Check "Backend local" $false "Sin respuesta" }
try { $r = Invoke-WebRequest -UseBasicParsing -Uri "https://ops.holasalta.com/health" -TimeoutSec 10; Add-Check "Ops Hostinger" ($r.StatusCode -eq 200) "HTTPS" } catch { Add-Check "Ops Hostinger" $false "Sin respuesta o aun no desplegado" }
try { $task = Get-ScheduledTask -TaskName "HolaSalta Ops Local Agent" -ErrorAction Stop; Add-Check "Tarea Windows" ($task.State -ne "Disabled") ([string]$task.State) } catch { Add-Check "Tarea Windows" $false "No instalada" }

$checks | Format-Table -AutoSize
if ($checks.Estado -contains "ERROR") { exit 1 }
