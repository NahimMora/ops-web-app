# Plan end-to-end

## Objetivo y decisión de viabilidad

Crear una app separada en `D:\Ops`, accesible como `ops.holasalta.com`, reutilizando las funciones del repositorio actual sin trasladar su carga. Es una inversión razonable porque aprovecha Cloud Startup, dominio, PC y R2 existentes; el costo nuevo principal es mantenimiento, no infraestructura. La arquitectura evita pagar un VPS y evita intentar ejecutar Playwright/ffmpeg en hosting administrado.

## Requisitos consolidados

- Repositorio nuevo, público y separado: `NahimMora/ops-web-app`.
- Email administrador: `holasalta@acceso.com`; contraseña generada localmente.
- Hostinger: sólo interfaz, autenticación, coordinación y MySQL.
- PC: Playwright, scrapers, imágenes, videos, automatización y publicación.
- R2: imágenes existentes y videos descargables bajo `holasaltamedia.cc`.
- PC encendida 24/7, recuperación al volver la energía.
- Sin nuevas preguntas ni dependencia de un túnel entrante.
- Uso de credenciales existentes sólo en la PC; ninguna se copia al repo/Hostinger.

## Fases ejecutadas

### Fase 1 — Inventario y contratos

- Mapear endpoints actuales de scraping, noticias, publicación, automatización, videos, WhatsApp y WordPress.
- Crear esquemas estrictos por comando con límites de longitud/cantidad y validación de URLs.
- Separar comandos de lectura/proceso de comandos con efecto externo.
- Definir estados terminales y recursos exclusivos.

Aceptación: ningún payload llega sin validación; tipos desconocidos responden 400.

### Fase 2 — Plano de control en Hostinger

- Fastify sirve API y SPA compilada.
- MySQL con migraciones versionadas y lock de migración.
- Cola persistente, prioridades, eventos, auditoría, snapshots y sesiones.
- Health/version endpoints para hPanel y diagnóstico.
- Compresión y límite de body para mantener bajo consumo.

Aceptación: producción se niega a arrancar con memoria o secretos débiles.

### Fase 3 — Seguridad de acceso

- Scrypt con salt para contraseña; no se almacena password reversible.
- Cookie HttpOnly, Secure en producción y SameSite Strict.
- CSRF obligatorio en mutaciones web.
- Rate limit de login y bloqueo temporal después de intentos fallidos.
- TOTP cifrado AES-256-GCM.
- Token independiente para agente, almacenado en Hostinger sólo como HMAC.
- CSP, headers Helmet, no-store y redacción de logs.

Aceptación: repositorio y logs no contienen credenciales; sesiones pueden revocarse.

### Fase 4 — Broker confiable

- Idempotency-Key + hash de payload + índice único.
- Claim transaccional `FOR UPDATE`.
- Lease renovable y resource locks.
- Máximo un intento automático para publicaciones externas.
- Falla posterior a side effect pasa a revisión manual.
- Export R2 determinista y repetible sin crear un segundo objeto.

Aceptación: pruebas de duplicados, workers concurrentes, crash y parcial pasan.

### Fase 5 — Agente local

- Sólo conexiones salientes HTTPS a Hostinger.
- Backend actual sólo en loopback.
- Adaptadores explícitos; no hay shell remoto genérico ni ejecución de comandos arbitrarios.
- Timeouts por operación, backoff sólo donde la operación es segura.
- Seguimiento de jobs locales de hasta 4/8 horas con heartbeat.
- Snapshots con hash y fecha.
- Stream directo de video API local → R2.

Aceptación: PC offline no afecta health web y la cola se retoma al volver.

### Fase 6 — Interfaz

- Responsive para escritorio/celular.
- Resumen, scrapers, noticias editables, automatización, videos/R2, comandos, auditoría y seguridad; WordPress y WhatsApp se integran en los flujos de publicación.
- Progreso y estado obtenidos de Hostinger; el navegador no conoce la IP local.
- Enlaces de descarga apuntan a `holasaltamedia.cc`.

Aceptación: todas las acciones remotas pasan por comandos validados.

### Fase 7 — Operación y recuperación

- Supervisor PowerShell y Scheduled Task al logon con restart.
- Diagnóstico sin imprimir secretos.
- Credenciales separadas para hPanel y agente.
- Manual de deploy, smoke test, rollback e incidentes.
- Modificación mínima del repo actual: binding por defecto `127.0.0.1` y puerto default 8000.

Aceptación: después de reinicio de Windows con sesión automática, backend/agente reaparecen sin acción manual.

### Fase 8 — Verificación y entrega

- `npm run typecheck`.
- `npm run lint`.
- `npm test`.
- `npm run build`.
- auditoría de archivos sensibles y `git diff --check`.
- Git init, commit y push a `main` sin `.secrets`.

## Datos que quedan pendientes sólo de hPanel

No pueden inventarse ni obtenerse desde el código: nombre/usuario/password/host MySQL creados en la cuenta y la acción de conectar el dominio. Están aislados como tres placeholders en `.secrets\hostinger.env`; todo lo demás ya está generado. El manual permite completar esos pasos sin modificar código.

## Definición de terminado

El proyecto está terminado cuando build/pruebas pasan, GitHub contiene sólo archivos públicos, hPanel devuelve health con MySQL, SSL funciona, agente online, scraper de humo completa, video de prueba llega a R2 y una publicación de prueba registra resultado/auditoría sin duplicado.
