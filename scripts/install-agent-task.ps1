# Ejecutar una vez desde PowerShell. Registra el supervisor para el usuario actual.
$ErrorActionPreference = "Stop"
$OpsRoot = Split-Path -Parent $PSScriptRoot
$Supervisor = Join-Path $PSScriptRoot "supervisor.ps1"
$TaskName = "HolaSalta Ops Local Agent"

if (-not (Test-Path -LiteralPath (Join-Path $OpsRoot ".secrets\agent.env"))) { throw "Ejecute npm run secrets:generate antes de instalar la tarea." }
if (-not (Test-Path -LiteralPath (Join-Path $OpsRoot "dist\agent\main.js"))) { throw "Ejecute npm run build antes de instalar la tarea." }

$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$Supervisor`""
$trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -RestartCount 100 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit (New-TimeSpan -Days 3650) -StartWhenAvailable
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
$task = New-ScheduledTask -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Description "Mantiene el backend HolaSalta y el agente Ops local disponibles."
Register-ScheduledTask -TaskName $TaskName -InputObject $task -Force | Out-Null
Start-ScheduledTask -TaskName $TaskName
Write-Host "Tarea instalada e iniciada: $TaskName"
