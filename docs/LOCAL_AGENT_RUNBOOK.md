# Runbook del agente local

## Arranque normal

La tarea `HolaSalta Ops Local Agent` inicia `scripts\supervisor.ps1` al abrir la sesión de Windows. Cada 10 segundos verifica:

- backend en `http://127.0.0.1:8000/health`;
- proceso Node `dist\agent\main.js`.

El agente carga primero `.secrets\agent.env` y después `D:\WebApp_HolaSalta\backend\.env` sin sobreescribir variables. Así reutiliza R2 y credenciales locales sin copiarlas.

## Comandos útiles

Estado general:

```powershell
powershell -ExecutionPolicy Bypass -File D:\Ops\scripts\doctor.ps1
Get-ScheduledTask -TaskName "HolaSalta Ops Local Agent" | Format-List TaskName,State
```

Reinicio controlado:

```powershell
Stop-ScheduledTask -TaskName "HolaSalta Ops Local Agent"
Start-ScheduledTask -TaskName "HolaSalta Ops Local Agent"
```

Actualizar después de un push:

```powershell
Set-Location D:\Ops
Stop-ScheduledTask -TaskName "HolaSalta Ops Local Agent"
git pull --ff-only origin main
npm.cmd ci
npm.cmd run typecheck
npm.cmd test
npm.cmd run build
Start-ScheduledTask -TaskName "HolaSalta Ops Local Agent"
```

No usar `git reset --hard`; si hay cambios locales, revisarlos antes.

## Diagnóstico por síntoma

### Web online, PC desconectada

1. Ejecutar `doctor.ps1`.
2. Revisar que Windows tenga Internet y hora correcta.
3. Ver sólo los eventos sanitizados recientes de `D:\Ops\agent-state\supervisor.log`.
4. Confirmar que la tarea no esté Disabled.
5. Reiniciar la tarea.
6. Si health local falla, revisar el backend actual; no abrir el puerto 8000 en firewall/router.

### Backend online, agente offline

- Confirmar que `.secrets\agent.env` existe.
- Confirmar que `OPS_AGENT_SERVER_URL=https://ops.holasalta.com`.
- Un 401 sostenido significa token descoordinado: rotarlo en ambos extremos, nunca copiar el hash como token crudo.
- Un error TLS/DNS debe resolverse antes de reintentar publicaciones.

### Comando `queued`

- Es normal si PC offline, capacidad ausente o recurso ocupado.
- Verificar estado del agente y comandos anteriores del mismo recurso.
- No crear otra publicación equivalente: usar el mismo comando/historial.

### Comando `requires_attention`

1. No pulsar Reintentar inmediatamente.
2. Revisar `localJobId` y eventos.
3. Consultar el destino externo y confirmar si publicó.
4. Si ya publicó, dejar el comando como evidencia y no repetir.
5. Si se confirma que no publicó, usar Reintentar manualmente.
6. Documentar decisión en el registro operativo externo si aplica.

### Video no llega a R2

- Confirmar job local `ready` y que descarga local funcione.
- Validar sólo presencia (no valor) de `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_S3_ENDPOINT`, `R2_BUCKET`, `R2_PUBLIC_BASE_URL` en `backend\.env`.
- Confirmar `R2_PUBLIC_BASE_URL=https://holasaltamedia.cc`.
- Repetir `xvideo.export_r2` es seguro: usa la misma object key.

## Corte de luz

1. BIOS/UEFI debe tener Restore on AC Power Loss.
2. Windows debe iniciar la sesión operativa para perfiles Playwright.
3. Scheduled Task usa StartWhenAvailable y reinicios.
4. Al volver:
   - Hostinger siguió aceptando comandos.
   - backend/agente reaparecen;
   - leases vencidas se clasifican automáticamente;
   - trabajos seguros vuelven a cola;
   - efectos inciertos requieren revisión manual.

## Rotación del agente

La rotación debe ser coordinada porque Hostinger guarda HMAC y la PC guarda token crudo:

1. Detener tarea local.
2. Generar nuevo token y hash con el mismo pepper mediante una herramienta segura.
3. Actualizar `OPS_BOOTSTRAP_AGENT_TOKEN_HASH`/registro MySQL de forma controlada.
4. Actualizar sólo `OPS_AGENT_TOKEN` en `.secrets\agent.env`.
5. Redeploy/restart server y después iniciar agente.
6. Confirmar heartbeat; revocar el token anterior.

No ejecutar `secrets:generate --force` como rotación parcial: también cambia contraseña, pepper y claves de sesión/TOTP.
