# Deploy end-to-end en Hostinger

Este documento empieza con el repositorio publicado y termina con `ops.holasalta.com`, MySQL, agente local, R2 y recuperación automática operativos.

## 0. Archivos sensibles preparados

En la PC existen, fuera de Git:

- `D:\Ops\.secrets\hostinger.env`: variables para hPanel; contiene placeholders de MySQL.
- `D:\Ops\.secrets\agent.env`: token crudo del agente; sólo local.
- `D:\Ops\.secrets\ADMIN_CREDENTIALS.txt`: contraseña inicial.

No pegar su contenido en chats, issues o logs. Antes del deploy, guardar `ADMIN_CREDENTIALS.txt` en un gestor de contraseñas.

## 1. Crear MySQL

1. hPanel → Websites → administrar el sitio/plan → Databases → Management.
2. Crear una base, por ejemplo `ops`, y un usuario exclusivo con contraseña aleatoria.
3. Copiar exactamente host, puerto, nombre completo, usuario completo y password mostrados por hPanel.
4. Editar localmente `D:\Ops\.secrets\hostinger.env` y reemplazar:
   - `DB_HOST` si hPanel muestra otro host.
   - `DB_USER`.
   - `DB_PASSWORD`.
   - `DB_NAME`.
5. No crear tablas manualmente. `OPS_DB_AUTO_MIGRATE=true` ejecuta migraciones con un lock MySQL al primer arranque.

## 2. Crear la Node.js Web App

1. hPanel → Websites → Add Website → Deploy Web App → Import Git Repository.
2. Pegar `https://github.com/NahimMora/ops-web-app.git` (es público).
3. Rama: `main`.
4. Framework: Fastify; si no se detecta, elegir `Other`.
5. Node.js: `22.x`.
6. Build command: dejar el valor detectado por Fastify (`npm run build:server`). El script genera servidor, agente y web.
7. Hostinger detecta Fastify y ejecuta el `server.js` de la raíz; ese archivo carga `dist/server/main.js` y reporta fallos de arranque sin exponer secretos.
8. Si solicita start command: `npm start`.
9. Si se usa el framework `Other`, configurar Entry file `server.js` y Output directory `dist`.
10. Importar variables desde el contenido ya corregido de `.secrets\hostinger.env`.

No definir `PORT`: Hostinger puede inyectarlo y la aplicación lo respeta. Si el asistente obliga a definirlo, usar el valor sugerido por hPanel.

## 3. Validar el primer deploy

Antes de conectar el dominio:

1. Abrir la URL temporal `/health`.
2. Debe responder JSON con `status=healthy`, `storage=mysql` y versión `1.0.0`.
3. Revisar Runtime Logs: deben aparecer `[startup] entry=server.js`, `repository=ready` y `server=ready`, nunca valores de variables.
4. Abrir la URL temporal. Debe mostrar login, no un listado de archivos.
5. Si falla MySQL, el log muestra un código seguro (`MYSQL_AUTH_FAILED`, `MYSQL_DATABASE_NOT_FOUND`, `MYSQL_DATABASE_ACCESS_DENIED` o `MYSQL_UNREACHABLE`). Corregir `DB_*` en Environment Variables y usar Save and redeploy.

## 4. Conectar el subdominio y SSL

1. Dashboard de la app → Connect domain.
2. Ingresar `ops.holasalta.com`.
3. Como `holasalta.com` está en Hostinger, seguir la propuesta automática de DNS.
4. Esperar propagación y certificado automático.
5. Confirmar `https://ops.holasalta.com/health`.
6. Confirmar que HTTP redirige a HTTPS.

La propagación puede demorar; no cambiar `agent.env` a la URL temporal salvo para un smoke test controlado.

## 5. Activar el agente local

En PowerShell desde `D:\Ops`:

```powershell
npm.cmd ci
npm.cmd run build
powershell -ExecutionPolicy Bypass -File .\scripts\install-agent-task.ps1
```

La tarea se ejecuta al iniciar sesión, queda oculta y reinicia procesos. El supervisor:

- inicia `D:\WebApp_HolaSalta\backend\start_backend.bat` si `127.0.0.1:8000/health` no responde;
- inicia/reinicia `dist\agent\main.js`;
- nunca abre un túnel ni escucha públicamente;
- escribe sólo eventos sanitizados en `agent-state\supervisor.log`.

Para recuperación tras corte eléctrico, Windows debe arrancar y abrir la sesión operativa automáticamente, requisito necesario para los perfiles interactivos de Playwright/WhatsApp.

## 6. Smoke test completo

Ejecutar:

```powershell
powershell -ExecutionPolicy Bypass -File D:\Ops\scripts\doctor.ps1
```

Luego en la web:

1. Ingresar con el archivo de credenciales.
2. Confirmar `PC conectada` antes de 30 segundos.
3. Seguridad → Configurar TOTP → agregar la clave al autenticador → activar con código de 6 dígitos.
4. Resumen → Actualizar estado; esperar `completed`.
5. Scrapers → fuente `tn`, máximo 1; validar resultado.
6. Videos → procesar una URL de prueba; esperar `ready`.
7. Subir a R2; abrir Descargar y confirmar host `holasaltamedia.cc`.
8. Ejecutar una publicación sólo con contenido de prueba y confirmar job local + resultado final.
9. Auditoría → confirmar login y creación de comandos.

## 7. Criterios de aceptación

- Login incorrecto se bloquea progresivamente y nunca revela si el usuario existe.
- Sin cookie no se accede a API ni panel.
- Sin CSRF no se crean/cancelan/reintentan comandos.
- Con PC apagada, un comando queda `queued` y Hostinger sigue saludable.
- Al volver la PC, el agente aparece online y reclama la cola.
- Dos clics simultáneos no crean dos comandos equivalentes en vuelo.
- Dos workers no reclaman la misma fila ni el mismo recurso exclusivo.
- Una publicación con lease perdida después del side effect queda `requires_attention`.
- Los binarios de video no pasan por Hostinger.
- El repositorio público no contiene `.env`, `.secrets`, tokens, cookies o archivos de estado.

## 8. Rollback

- Código: en GitHub revertir el commit defectuoso y redeploy de `main`.
- Variables: Environment Variables → restaurar el valor previo → Save and redeploy.
- Base: usar backup de Hostinger antes de migraciones futuras. La versión 1 sólo crea tablas y no borra datos.
- Agente: detener la tarea `HolaSalta Ops Local Agent`, volver al commit estable en `D:\Ops`, `npm ci`, `npm run build`, iniciar tarea.
- Emergencia de seguridad: revocar todas las sesiones desde Seguridad, rotar token del agente de manera coordinada y cambiar contraseña MySQL.

## Referencias oficiales

- Hostinger: `https://www.hostinger.com/support/how-to-deploy-a-nodejs-website-in-hostinger/`
- Variables: `https://www.hostinger.com/support/how-to-add-environment-variables-during-node-js-application-deployment/`
- Dominio/SSL: `https://www.hostinger.com/support/how-to-connect-a-custom-domain-to-a-node-js-application/`
- MySQL: `https://www.hostinger.com/support/1583542-how-to-create-a-new-mysql-database-in-hostinger/`
