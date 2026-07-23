@echo off
setlocal EnableExtensions EnableDelayedExpansion
cd /d "%~dp0\.."

rem ============================================================
rem  HolaSalta - Inicializacion completa en una PC nueva/definitiva
rem ============================================================
rem
rem  Este script asume que se lo ejecuta parado dentro del repo Ops
rem  ya clonado (scripts\init-new-pc.bat). Clona el repo del backend
rem  como carpeta hermana si no existe, instala todo lo automatizable,
rem  y PAUSA explicitamente en los pasos que son manuales por diseno
rem  (no se pueden ni se deben saltear):
rem    - OPS_TOKEN_PEPPER (secreto de Hostinger)
rem    - QR de WhatsApp
rem    - Login/2FA de X
rem    - Confirmar hPanel/phpMyAdmin
rem
rem  Editar estas variables si el repo/rama del backend cambia:
set "BACKEND_REPO=NahimMora/HolaSaltaManager"
set "BACKEND_BRANCH=feat/xvideo-ux-refactor"
set "AGENT_ID=pc-holasalta-01"

set "OPS_ROOT=%CD%"
for %%I in ("%OPS_ROOT%") do set "PARENT_ROOT=%%~dpI"
set "BACKEND_ROOT=%PARENT_ROOT%WebApp_HolaSalta"

echo ======================================================
echo   HolaSalta - Inicializacion PC definitiva
echo ======================================================
echo   Ops:     %OPS_ROOT%
echo   Backend: %BACKEND_ROOT%
echo ======================================================
echo.

echo [1/9] Verificando herramientas...
set "MISSING=0"
where git >nul 2>&1 || (echo   [FALTA] git & set "MISSING=1")
where node >nul 2>&1 || (echo   [FALTA] node & set "MISSING=1")
where npm >nul 2>&1 || (echo   [FALTA] npm & set "MISSING=1")
where python >nul 2>&1 || (echo   [FALTA] python & set "MISSING=1")
where ffmpeg >nul 2>&1 || (echo   [FALTA] ffmpeg & set "MISSING=1")
where ffprobe >nul 2>&1 || (echo   [FALTA] ffprobe & set "MISSING=1")
where yt-dlp >nul 2>&1 || (echo   [FALTA] yt-dlp & set "MISSING=1")
where gh >nul 2>&1 || (echo   [FALTA] GitHub CLI ^(gh^) & set "MISSING=1")
if "%MISSING%"=="1" (
  echo.
  echo [ERROR] Instale las herramientas faltantes ^(y reinicie esta terminal^) antes de continuar.
  goto :fail
)
echo   OK.
echo.

echo [2/9] Verificando autenticacion de GitHub CLI...
gh auth status >nul 2>&1
if errorlevel 1 (
  echo [ERROR] gh no esta autenticado. Corra: gh auth login
  goto :fail
)
echo   OK.
echo.

echo [3/9] Clonando/verificando repo del backend...
if not exist "%BACKEND_ROOT%\.git" (
  echo   Clonando %BACKEND_REPO% ^(%BACKEND_BRANCH%^) en %BACKEND_ROOT%...
  gh repo clone %BACKEND_REPO% "%BACKEND_ROOT%" -- --branch %BACKEND_BRANCH%
  if errorlevel 1 (
    echo [ERROR] Fallo el clonado del backend.
    goto :fail
  )
) else (
  echo   Ya existe %BACKEND_ROOT%, no se toca ^(evita perder trabajo en curso^).
)
echo.

echo [4/9] Verificando backend\.env y frontend\.env...
if not exist "%BACKEND_ROOT%\backend\.env" (
  echo [ERROR] Falta %BACKEND_ROOT%\backend\.env
  echo         Copie el .env real desde un backup seguro antes de continuar.
  goto :fail
)
if not exist "%BACKEND_ROOT%\frontend\.env" (
  echo [ERROR] Falta %BACKEND_ROOT%\frontend\.env
  goto :fail
)
echo   OK, ambos presentes.
echo.

echo [5/9] Instalando dependencias del backend ^(puede tardar varios minutos^)...
call "%BACKEND_ROOT%\install_nueva_pc.bat"
if errorlevel 1 (
  echo [ERROR] Fallo la instalacion del backend.
  goto :fail
)
echo.

echo [6/9] Instalando y construyendo Ops...
call npm ci
if errorlevel 1 (
  echo [ERROR] npm ci fallo en Ops.
  goto :fail
)
call npm run build
if errorlevel 1 (
  echo [ERROR] npm run build fallo en Ops.
  goto :fail
)
echo.

echo [7/9] Token del agente...
if exist "%OPS_ROOT%\.secrets\agent.env" (
  echo   Ya existe .secrets\agent.env, no se regenera.
) else (
  echo.
  echo   ==============================================================
  echo   PASO MANUAL: hace falta el OPS_TOKEN_PEPPER actual de Hostinger
  echo   ^(hPanel ^> variables de entorno de ops-web-app^).
  echo   ==============================================================
  echo.
  set /p ROTATE_PEPPER="  Se filtro/no se tiene el pepper actual y hay que generar uno nuevo? ^(s/N^): "
  if /i "!ROTATE_PEPPER!"=="s" (
    powershell -ExecutionPolicy Bypass -File "%OPS_ROOT%\scripts\rotate-agent-token.ps1" -RotatePepper -AgentId "%AGENT_ID%" -BackendRoot "%BACKEND_ROOT%"
  ) else (
    powershell -ExecutionPolicy Bypass -File "%OPS_ROOT%\scripts\rotate-agent-token.ps1" -AgentId "%AGENT_ID%" -BackendRoot "%BACKEND_ROOT%"
  )
  if errorlevel 1 (
    echo [ERROR] No se pudo generar el token del agente.
    goto :fail
  )
  echo.
  echo   ==============================================================
  echo   PASO MANUAL OBLIGATORIO antes de continuar:
  echo     1^) hPanel: actualizar OPS_BOOTSTRAP_AGENT_TOKEN_HASH ^(y
  echo        OPS_TOKEN_PEPPER si se genero uno nuevo^). Save and redeploy.
  echo     2^) phpMyAdmin: UPDATE agents SET token_hash='...', status=
  echo        'offline', revoked_at=NULL WHERE id='%AGENT_ID%';
  echo        Confirmar "1 row affected".
  echo     3^) Revisar en ops.holasalta.com la seccion Comandos: cancelar
  echo        cualquier "queued" obsoleto antes de encender el agente.
  echo   ==============================================================
  echo.
  pause
)
echo.

echo [8/9] Primer arranque manual del backend ^(verificacion^)...
echo   Se va a abrir una ventana nueva con el backend. Verifique que diga
echo   "Uvicorn running on http://0.0.0.0:8000" antes de continuar.
set "BACKEND_PORT=8000"
start "HolaSalta Backend" cmd /k ""%BACKEND_ROOT%\backend\start_backend.bat""
echo.
echo   ==============================================================
echo   PASOS MANUALES pendientes en la ventana del backend / navegador:
echo     - WhatsApp: iniciar automatizacion y escanear el QR.
echo     - X: iniciar sesion y resolver 2FA si corresponde.
echo     (Los perfiles nuevos empiezan vacios; hay que re-autenticar).
echo   ==============================================================
echo.
pause
echo.

echo [9/9] Instalar tarea programada ^(deja todo corriendo solo^)...
set /p INSTALL_TASK="  Instalar la tarea programada 'HolaSalta Ops Local Agent' ahora? ^(s/N^): "
if /i "!INSTALL_TASK!"=="s" (
  powershell -ExecutionPolicy Bypass -File "%OPS_ROOT%\scripts\install-agent-task.ps1"
  if errorlevel 1 (
    echo [ERROR] Fallo la instalacion de la tarea programada.
    goto :fail
  )
  powershell -ExecutionPolicy Bypass -File "%OPS_ROOT%\scripts\doctor.ps1"
) else (
  echo   Salteado. Para instalarla despues:
  echo   powershell -ExecutionPolicy Bypass -File "%OPS_ROOT%\scripts\install-agent-task.ps1"
)

echo.
echo ======================================================
echo   Inicializacion completa.
echo   Verificar en ops.holasalta.com ^> Resumen que la PC
echo   aparezca conectada con heartbeat actualizandose.
echo ======================================================
exit /b 0

:fail
echo.
echo [FAIL] Inicializacion incompleta. Revisar el error de arriba.
exit /b 1
