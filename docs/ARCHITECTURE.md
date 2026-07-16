# Arquitectura

## Decisión

La alternativa más factible y rentable es una arquitectura híbrida. Cloud Startup ya está pagado y soporta Node.js/Fastify, React, GitHub y Node 22; por eso aloja sólo el plano de control. La PC ya preparada conserva el plano de ejecución. No hace falta VPS, túnel entrante, Redis administrado ni migrar Playwright.

## Responsabilidades

| Componente | Ejecuta | No ejecuta |
|---|---|---|
| Hostinger | login, SPA, validación, MySQL, cola, leases, auditoría, snapshots | Playwright, ffmpeg, scraping, imágenes, video, publicación |
| Agente local | polling, heartbeats, adaptación de comandos, seguimiento, stream a R2 | interfaz pública, almacenamiento de sesiones web |
| Backend actual | lógica existente, navegadores, scraping, media, redes | exposición pública |
| MySQL | usuarios, sesiones hasheadas, agentes, comandos, eventos, locks, snapshots | secretos operativos locales |
| R2 | imágenes y videos terminados | ejecución, cola o credenciales web |

## Flujo de un comando

1. La interfaz valida el formulario y genera una clave de idempotencia.
2. Fastify vuelve a validar el esquema y persiste `queued` en MySQL.
3. El agente hace `claim`; MySQL bloquea la fila y, si corresponde, el recurso exclusivo.
4. El agente recibe una lease de 60 segundos y la renueva cada 20 segundos.
5. El adaptador llama a `http://127.0.0.1:8000` con timeout explícito.
6. Si la API local crea un job, el agente guarda `localJobId` y consulta hasta estado terminal.
7. Resultado, progreso y eventos vuelven a Hostinger; el navegador sólo lee Hostinger.

## Semántica de fallos

| Momento de la falla | Resultado |
|---|---|
| Antes de reclamar | permanece `queued` |
| Scraping/proceso seguro antes de agotar intentos | vuelve a `queued` |
| Proceso seguro sin intentos restantes | `failed` |
| Después de marcar una publicación/efecto externo | `requires_attention` |
| Destino confirma parte del lote | `partial_success` |
| API local no puede verificar el resultado | `completed_unverified` o `requires_attention` |

`requires_attention` nunca se reintenta solo. Un operador debe verificar Facebook/Instagram/X/WhatsApp/Wix/WordPress antes de usar Reintentar.

## Idempotencia y concurrencia

- Índice único `(type, idempotency_key)`.
- Hash del payload: reutilizar la misma clave con otro contenido devuelve conflicto.
- `SELECT ... FOR UPDATE` para un solo claim.
- Locks por `resource_key` para publicación global, video, Wix, WhatsApp, Instagram y runtime.
- Token de lease hasheado; sólo el agente que posee la lease puede mutar el comando.
- La exportación R2 usa una key determinista `ops/videos/{jobId}/{filename}`; repetirla reemplaza el mismo objeto, no crea duplicados.
- El `claim` no tiene retry de red: una respuesta perdida podría contener una lease válida. Lecturas y heartbeats sí usan backoff.

## Datos sincronizados

El agente envía snapshots de baja frecuencia: salud, automatización, jobs, pendientes, noticias, videos, grupos, Wix y WordPress. Los binarios nunca se sincronizan. Cada snapshot lleva revisión, hash, versión de esquema y fecha; la web marca datos viejos.

## Escalabilidad realista

Una instancia Hostinger y una PC son suficientes. MySQL y los locks permiten más instancias web sin duplicar claims. Antes de agregar una segunda PC hay que asignar capacidades/recursos y probar la semántica de cada integración externa; no debe agregarse otro agente con todas las capacidades por defecto.

## Límites conscientes

- Si la PC está apagada, el panel funciona pero no ejecuta; la cola espera.
- Si Windows no inicia sesión, una tarea `Interactive` no puede usar perfiles Playwright. Debe mantenerse el inicio de sesión automático previsto para esa PC.
- MySQL de Hostinger es el estado autoritativo del panel; las publicaciones externas siguen siendo autoritativas en cada plataforma.
- El sistema actual permanece separado. Sólo se ajustó su binding a loopback para no exponer el puerto 8000.
