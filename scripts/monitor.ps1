# Health monitor loop: runs as scheduled task "HolaSalta Ops Health Monitor"
# (see install-monitor-task.ps1). Each pass is a fresh node process
# (dist\monitor\main.js) that checks backend/agent/panel/supervisor, reads
# new failed jobs and errors, and mails alerts and the periodic health report
# (Gmail, OPS_ALERT_* in .secrets\agent.env). Kept separate from
# supervisor.ps1 on purpose: it has to be able to report the supervisor
# itself being down.
$ErrorActionPreference = "Continue"
$OpsRoot = Split-Path -Parent $PSScriptRoot
$MonitorEntry = Join-Path $OpsRoot "dist\monitor\main.js"
$env:OPS_AGENT_CONFIG_PATH = Join-Path $OpsRoot ".secrets\agent.env"
$IntervalSeconds = 300

Set-Location -LiteralPath $OpsRoot
while ($true) {
  if (Test-Path -LiteralPath $MonitorEntry) {
    # Output goes to agent-state\monitor.log from inside the node process.
    & node.exe $MonitorEntry *> $null
  }
  Start-Sleep -Seconds $IntervalSeconds
}
