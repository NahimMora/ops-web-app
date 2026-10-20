# Ejecutar una vez desde PowerShell en la PC de produccion. Registra el
# monitor de salud (alertas por mail + reporte cada 3 dias) para el usuario
# actual. Mismo patron que install-agent-task.ps1.
$ErrorActionPreference = "Stop"
$OpsRoot = Split-Path -Parent $PSScriptRoot
$Monitor = Join-Path $PSScriptRoot "monitor.ps1"
$TaskName = "HolaSalta Ops Health Monitor"

if ($env:COMPUTERNAME -ne "FERNANDO") { throw "El monitor solo se instala en la PC de produccion (FERNANDO). Esta PC es $env:COMPUTERNAME." }
if (-not (Test-Path -LiteralPath (Join-Path $OpsRoot ".secrets\agent.env"))) { throw "Falta .secrets\agent.env." }
if (-not (Test-Path -LiteralPath (Join-Path $OpsRoot "dist\monitor\main.js"))) { throw "Ejecute npm run build:agent antes de instalar la tarea." }

$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$Monitor`""
# COMPUTERNAME, not USERDOMAIN - see install-agent-task.ps1.
$trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:COMPUTERNAME\$env:USERNAME"
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -RestartCount 100 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit (New-TimeSpan -Days 3650) -StartWhenAvailable
$principal = New-ScheduledTaskPrincipal -UserId "$env:COMPUTERNAME\$env:USERNAME" -LogonType Interactive -RunLevel Limited
$task = New-ScheduledTask -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Description "Manda mails cuando se cae un servicio o falla algo, y un reporte de salud cada 3 dias."
Register-ScheduledTask -TaskName $TaskName -InputObject $task -Force | Out-Null
Start-ScheduledTask -TaskName $TaskName
Write-Host "Tarea instalada e iniciada: $TaskName"
