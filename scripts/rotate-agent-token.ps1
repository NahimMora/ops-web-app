# Ejecutar este script en una ventana de PowerShell propia (fuera de Claude Code),
# porque pide el pepper de forma interactiva enmascarada.
#
# Modo por defecto (sin -RotatePepper):
#  1. Pide el OPS_TOKEN_PEPPER existente (el que ya esta en Hostinger).
#  2. Genera un token de agente nuevo (48 bytes) y su hash HMAC-SHA256 con ese pepper.
#
# Modo -RotatePepper (recomendado si el pepper actual quedo expuesto):
#  1. Genera un OPS_TOKEN_PEPPER nuevo (no pide el viejo, no lo necesita).
#  2. Genera un token de agente nuevo y su hash con el pepper nuevo.
#  3. Hay que actualizar TANTO OPS_TOKEN_PEPPER como OPS_BOOTSTRAP_AGENT_TOKEN_HASH en hPanel.
#
# Mismo algoritmo que apps/server/src/security.ts (tokenHash): HMAC-SHA256(token, pepper) en hex.
# No imprime el pepper viejo ni el token crudo en pantalla. Si se rota el pepper, SI se imprime
# el pepper nuevo (hace falta para pegarlo en hPanel), pero nunca el viejo.

param(
    [switch]$RotatePepper,
    [switch]$Force,
    [string]$BackendRoot,
    [string]$AgentId = "pc-holasalta-01"
)

$ErrorActionPreference = "Stop"

$OpsRoot = Split-Path -Parent $PSScriptRoot
if (-not $BackendRoot) {
    if ($env:HOLASALTA_BACKEND_ROOT) { $BackendRoot = $env:HOLASALTA_BACKEND_ROOT }
    else { $BackendRoot = Join-Path (Split-Path -Parent $OpsRoot) "WebApp_HolaSalta" }
}
$BackendEnvPath = Join-Path $BackendRoot "backend\.env"

function New-RandomBase64Url([int]$Bytes) {
    $buffer = New-Object byte[] $Bytes
    $rng = New-Object System.Security.Cryptography.RNGCryptoServiceProvider
    try {
        $rng.GetBytes($buffer)
    } finally {
        $rng.Dispose()
    }
    return [Convert]::ToBase64String($buffer).TrimEnd('=').Replace('+','-').Replace('/','_')
}

if ($RotatePepper) {
    $pepper = New-RandomBase64Url -Bytes 48
    Write-Output ""
    Write-Output "Pepper NUEVO generado. Copielo para pegarlo en hPanel como OPS_TOKEN_PEPPER:"
    Write-Output "PEPPER NUEVO: $pepper"
    Write-Output ""
} else {
    $securePepper = Read-Host -Prompt "Pegue OPS_TOKEN_PEPPER existente (no se mostrara)" -AsSecureString
    $pepperPtr = [System.Runtime.InteropServices.Marshal]::SecureStringToGlobalAllocUnicode($securePepper)
    try {
        $pepper = [System.Runtime.InteropServices.Marshal]::PtrToStringUni($pepperPtr)
    } finally {
        [System.Runtime.InteropServices.Marshal]::ZeroFreeGlobalAllocUnicode($pepperPtr)
    }
}

if ([string]::IsNullOrWhiteSpace($pepper)) {
    Write-Error "Pepper vacio. Abortando."
    exit 1
}

$token = New-RandomBase64Url -Bytes 48

$hmac = New-Object System.Security.Cryptography.HMACSHA256
$hmac.Key = [System.Text.Encoding]::UTF8.GetBytes($pepper)
$hashBytes = $hmac.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($token))
$hashHex = ($hashBytes | ForEach-Object { $_.ToString("x2") }) -join ""

$secretsDir = Join-Path $OpsRoot ".secrets"
New-Item -ItemType Directory -Force -Path $secretsDir | Out-Null
$agentStateDir = Join-Path $OpsRoot "agent-state"

$agentEnv = @"
# Solo PC local. No subir a git.
OPS_AGENT_SERVER_URL=https://ops.holasalta.com
OPS_AGENT_ID=$AgentId
OPS_AGENT_TOKEN=$token
OPS_AGENT_POLL_MS=5000
OPS_AGENT_HEARTBEAT_MS=10000
OPS_LOCAL_API_URL=http://127.0.0.1:8000
OPS_LOCAL_API_USERNAME=admin
OPS_LOCAL_BACKEND_ENV_PATH=$BackendEnvPath
OPS_AGENT_STATE_DIR=$agentStateDir
OPS_R2_VIDEO_PREFIX=ops/videos
"@

$agentEnvPath = Join-Path $secretsDir "agent.env"
if ((Test-Path $agentEnvPath) -and -not $Force) {
    Write-Error "$agentEnvPath ya existe. Vuelva a ejecutar con -Force si de verdad quiere sobreescribirlo."
    exit 1
}
[System.IO.File]::WriteAllText($agentEnvPath, $agentEnv, (New-Object System.Text.UTF8Encoding($false)))

# Limpiar variables sensibles de la sesion
$pepper = $null
$token = $null
Remove-Variable pepper, token -ErrorAction SilentlyContinue
[System.GC]::Collect()

Write-Output ""
Write-Output "OK. Token crudo escrito en: $agentEnvPath (no se muestra aqui)."
Write-Output ""
if ($RotatePepper) {
    Write-Output "Pegar en hPanel:"
    Write-Output "  1) OPS_TOKEN_PEPPER = el pepper nuevo impreso arriba"
    Write-Output "  2) OPS_BOOTSTRAP_AGENT_TOKEN_HASH = el HASH de abajo"
} else {
    Write-Output "Copie este HASH para:"
    Write-Output "  1) hPanel > variable OPS_BOOTSTRAP_AGENT_TOKEN_HASH"
    Write-Output "  2) phpMyAdmin > UPDATE agents SET token_hash=... WHERE id='$AgentId'"
}
Write-Output ""
Write-Output "HASH: $hashHex"
