# Ejecutar una vez desde PowerShell. Registra el supervisor para el usuario actual.
$ErrorActionPreference = "Stop"
$OpsRoot = Split-Path -Parent $PSScriptRoot
$Supervisor = Join-Path $PSScriptRoot "supervisor.ps1"
$TaskName = "HolaSalta Ops Local Agent"

if (-not (Test-Path -LiteralPath (Join-Path $OpsRoot ".secrets\agent.env"))) { throw "Ejecute npm run secrets:generate antes de instalar la tarea." }
if (-not (Test-Path -LiteralPath (Join-Path $OpsRoot "dist\agent\main.js"))) { throw "Ejecute npm run build antes de instalar la tarea." }

$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$Supervisor`""
# COMPUTERNAME, not USERDOMAIN: these PCs aren't domain-joined, and in some
# session contexts (seen over an SSH-spawned shell) USERDOMAIN resolves to
# the network workgroup name ("WORKGROUP") instead of the machine name -
# Windows can't map that to a local account SID and Register-ScheduledTask
# fails with "No se efectuo ninguna asignacion entre los nombres de cuenta
# y los identificadores de seguridad." COMPUTERNAME is always the right
# qualifier for a local account regardless of how the shell was started.
$trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:COMPUTERNAME\$env:USERNAME"
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -RestartCount 100 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit (New-TimeSpan -Days 3650) -StartWhenAvailable
$principal = New-ScheduledTaskPrincipal -UserId "$env:COMPUTERNAME\$env:USERNAME" -LogonType Interactive -RunLevel Limited
$task = New-ScheduledTask -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Description "Mantiene el backend HolaSalta y el agente Ops local disponibles."
Register-ScheduledTask -TaskName $TaskName -InputObject $task -Force | Out-Null
Start-ScheduledTask -TaskName $TaskName
Write-Host "Tarea instalada e iniciada: $TaskName"
