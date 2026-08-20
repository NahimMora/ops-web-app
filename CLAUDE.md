# HolaSalta Ops — contexto para Claude

## Qué es esto

El plano de control remoto de HolaSalta: panel web en
[ops.holasalta.com](https://ops.holasalta.com) (desplegado en Hostinger,
Node.js/Fastify + React + MySQL) más un **agente local** que corre en la
PC de producción y ejecuta los comandos contra el backend real. Ver
`docs/ARCHITECTURE.md` y `README.md` para el diseño completo — esto es
solo el resumen operativo.

**Este repo es público en GitHub** (`NahimMora/ops-web-app`). Los secrets
reales viven en `.secrets/` (gitignored, nunca se commitean) — antes de
tocar nada, verificá que ningún cambio exponga tokens/credenciales en
código o docs.

## Cómo encaja con el backend

- `apps/server`: la API/SPA de Hostinger — login, cola de comandos, MySQL,
  auditoría. No ejecuta Playwright ni scraping.
- `apps/agent`: worker que corre en la PC local, hace long-polling saliente
  a Hostinger, y llama a `http://127.0.0.1:8000` — el backend real, en el
  repo hermano **`C:\HolaSalta\WebApp_HolaSalta`**. El agente se autentica
  ahí con usuario/contraseña vía `POST /api/auth/login` (`local-api.ts`).
- El backend de WebApp_HolaSalta sigue siendo la fuente de verdad de
  ejecución (scrapers, Playwright, video, publicación) — este repo nunca
  reemplaza esa lógica, solo agrega una interfaz remota sin exponer el
  puerto 8000 a internet.

## Scripts clave (`scripts/`)

- `supervisor.ps1`: corre como tarea de Windows **"HolaSalta Ops Local
  Agent"** (trigger AtLogOn). Chequea `/health` del backend cada 10s
  (si no responde y no hay proceso, lo arranca vía `start_backend.bat`;
  si el proceso existe pero no responde por 180s+, lo mata y lo relanza),
  y mantiene vivo el agente (`dist/agent/main.js`). No instalar un segundo
  supervisor de otro lado — si esta tarea ya corre en la máquina, es la
  única fuente de verdad de "quién levanta qué".
- `doctor.ps1`: diagnóstico de una pasada — Node, build, config, backend
  local, conexión a Hostinger, estado de la tarea. Correrlo con
  `-ExecutionPolicy Bypass` si la sesión no tiene la política seteada.
- `deploy.ps1`: **usar esto para desplegar cualquier cambio**, en vez de
  editar en vivo sobre la PC de producción. Pull-ea este repo y el
  backend, reconstruye/reinstala solo lo que cambió, reinicia solo el
  proceso correspondiente (el supervisor lo relevanta solo), y termina
  con `doctor.ps1`. Uso: `cd C:\HolaSalta\Ops; git pull; .\scripts\deploy.ps1`.
- `install-agent-task.ps1`: registra la tarea programada. Usa
  `$env:COMPUTERNAME`, no `$env:USERDOMAIN` (ver Gotchas).
- `init-new-pc.bat`: instalador maestro para una PC nueva/definitiva — clona
  el backend, corre su instalador, compila este repo, y pausa en los pasos
  manuales obligatorios (pepper de Hostinger, QR de WhatsApp, login de X).
  Requiere `gh` CLI autenticado, Node 22, Python 3.10+, ffmpeg/ffprobe/yt-dlp
  en PATH.

## Requisitos de versión

**Node 22 puntual** (`package.json`: `"engines": {"node": ">=22 <23"}`) —
no alcanza con Node 18, que es lo que pide el backend para SU parte
(`frontend/whatsapp` legacy, ya casi sin uso).

## Bugs ya encontrados y arreglados (para no repetirlos)

- **`apps/agent/src/main.ts`, `localHealth()`**: comparaba el `status` del
  `/health` del backend contra el string literal `"healthy"` — el stub
  viejo del backend siempre devolvía eso, pero el `/health` real (ver
  CLAUDE.md del backend) devuelve `"running"`/`"stopped"`/`"needs_auth"`/
  `"degraded"`. Si tocás cualquiera de los dos lados de esta interfaz,
  mantené sincronizado qué valores de `/health` cuentan como "sano" acá.
- **`install-agent-task.ps1`**: usaba `$env:USERDOMAIN`, que en una PC sin
  dominio (workgroup) puede resolver a `"WORKGROUP"` en vez del nombre de
  la máquina en sesiones abiertas por SSH — rompe
  `Register-ScheduledTask` con "No se efectuó ninguna asignación entre
  los nombres de cuenta...". Se corrigió a `$env:COMPUTERNAME`.

## Gotchas de Windows

- PowerShell restringido por defecto: `Set-ExecutionPolicy -Scope Process
  -ExecutionPolicy Bypass -Force` una vez por sesión nueva, o
  `-ExecutionPolicy Bypass` explícito en cada invocación.
- Sesión por SSH = sin GUI. El paso de escanear QR de WhatsApp / loguear X
  necesita ver una ventana de navegador real — cambiar a Escritorio Remoto
  o Quick Assist solo para ese paso puntual.
- `dist/` está gitignored (se compila por PC, `npm run build`/`build:agent`)
  — un `git pull` solo no actualiza el agente corriendo, hay que
  reconstruir y reiniciar el proceso (`deploy.ps1` ya lo hace).
