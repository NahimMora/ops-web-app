# Seguridad y recuperación

## Modelo de amenazas

Se protege contra acceso no autorizado al panel, robo del repo público, CSRF, fuerza bruta, filtración de logs, agente falso, comandos duplicados, caída parcial, dos workers concurrentes y exposición del backend local. No se asume que una red social ofrezca idempotencia universal; por eso el resultado incierto se detiene.

## Controles implementados

- Password Scrypt N=32768/r=8/p=1 con salt único.
- Sesión y CSRF almacenados sólo como HMAC.
- Cookie HttpOnly/Secure/SameSite Strict.
- TOTP cifrado en reposo con AES-256-GCM.
- Login limitado y cuenta bloqueada 15 minutos tras cinco fallos.
- CSP, frame denial, no-referrer, no-store y body máximo 5 MiB.
- Token del agente separado de sesión humana.
- Payloads Zod estrictos y comandos enumerados; no hay shell, ruta o URL de destino arbitraria.
- SQL parametrizado; sólo DDL y queries constantes del repositorio.
- Logs con redacción de authorization/cookie/password/token/secret/api key.
- Timeouts en toda llamada HTTP; retries con backoff sólo donde son seguros.
- Las exportaciones y previews R2 usan credenciales locales. Hostinger usa un token R2 diferente, limitado al bucket, sólo para firmar, validar y limpiar cargas temporales.

## Secretos

| Secreto | Ubicación | Hostinger | Git |
|---|---|---:|---:|
| Password admin crudo | gestor + `.secrets\ADMIN_CREDENTIALS.txt` temporal | no | no |
| Hash admin | variable hPanel | sí | no |
| Session/TOTP/pepper | variables hPanel | sí | no |
| Token agente crudo | `.secrets\agent.env` | no | no |
| HMAC token agente | variable hPanel/MySQL | sí | no |
| R2 de publicación/previews, redes y WordPress | backend `.env` local | no | no |
| R2 de cargas temporales | variables hPanel `OPS_UPLOAD_R2_*` | sí, token separado | no |
| Credenciales MySQL | variables hPanel | sí | no |

Después de guardar la contraseña inicial en un gestor, borrar el archivo temporal de credenciales. Restringir acceso NTFS a `D:\Ops\.secrets` y al `.env` actual al usuario operativo.

## Backup

- MySQL: activar/verificar backups automáticos del plan Hostinger y tomar uno antes de migraciones.
- Código: GitHub `main` es recuperable; tags de release recomendados.
- Secretos: gestor de contraseñas y copia cifrada fuera de la PC.
- Perfiles Playwright/WhatsApp: incluirlos en la política de backup existente, nunca Git/R2 público.
- R2: habilitar versionado/reglas de lifecycle según retención deseada.

## Retención

`OPS_COMMAND_RETENTION_DAYS=90` define la política prevista. La versión inicial no borra automáticamente auditoría/comandos para evitar pérdida accidental; implementar purge sólo después de confirmar backup y requisitos legales. Los videos en R2 no se borran desde Ops.

## Incidentes

### Repo contiene un secreto

1. Tratarlo como comprometido aunque se borre del último commit.
2. Rotar primero el secreto en el proveedor.
3. Revocar sesiones/tokens relacionados.
4. Limpiar historial con procedimiento Git aprobado y coordinar clones.
5. Ejecutar el escaneo nuevamente.

### Token de agente comprometido

1. Detener/revocar el agente en MySQL.
2. Detener tarea local.
3. Revisar auditoría/comandos durante la ventana.
4. Rotar token coordinadamente.
5. Reiniciar y validar capacidades.

### Cuenta admin comprometida

1. Ejecutar `npm run secrets:rotate-admin` en `D:\Ops`; el comando sólo modifica el hash admin en `.secrets\hostinger.env` y la contraseña en `.secrets\ADMIN_CREDENTIALS.txt`.
2. En hPanel, reemplazar únicamente `OPS_BOOTSTRAP_ADMIN_PASSWORD_HASH` con el nuevo valor local y usar Save and redeploy.
3. El bootstrap sincroniza el hash dentro de una transacción, limpia el bloqueo y revoca las sesiones del admin cuando detecta el cambio.
4. Ingresar con la nueva contraseña dejando 2FA vacío si aún no fue activado. Guardarla en un gestor y eliminar el archivo temporal.
5. Rotar TOTP si ya estaba configurado y revisar audit log y destinos externos.

### Publicación incierta

1. Congelar reintento.
2. Consultar destino y `localJobId`.
3. Comparar URL/título/fecha para deduplicar.
4. Sólo reintentar con evidencia de no publicación.

## Recuperación total de PC

1. Restaurar `D:\WebApp_HolaSalta` y dependencias/perfiles.
2. Clonar `ops-web-app` a `D:\Ops`.
3. Restaurar `.secrets\agent.env` cifrado.
4. `npm ci && npm run build`.
5. Instalar Scheduled Task.
6. `doctor.ps1`.
7. Ejecutar snapshot y scraper de humo antes de publicación.

Hostinger no necesita restauración si MySQL/app siguen disponibles. Si también se pierde Hostinger, recrear Node app desde GitHub, restaurar MySQL y variables, conectar dominio y validar antes de habilitar el agente.
