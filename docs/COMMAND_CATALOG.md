# Catálogo de comandos

Todos los comandos se validan en web y servidor, llevan idempotency key y se ejecutan sólo si el agente declara la capacidad correspondiente.

## Lectura, cache y scraping

| Tipo | Función | Timeout local máximo | Retry tras crash |
|---|---|---:|---|
| `snapshot.refresh` | sincroniza estados | según snapshot | sí |
| `scraper.titles` | titulares de una fuente | 5 min | sí, hasta 3 |
| `scraper.details` | artículos de URLs validadas | 20 min | sí, hasta 3 |
| `scraper.all.titles` | titulares de todas | 10 min | sí, hasta 3 |
| `scraper.all.details` | detalles multi-fuente | 30 min | sí, hasta 3 |
| `news.load_wordpress` | carga WordPress | 5 min | sí |
| `news.save` | guarda edición local | 5 min | sí, revisar atomicidad local |
| `news.clear_cache` | limpia noticias | 2 min | sí |
| `publish.clear` | limpia historial local | 2 min | sí |

## Publicación y automatización

| Tipo | Efecto externo | Recurso exclusivo | Política incierta |
|---|---:|---|---|
| `news.publish` | sí | `publishing:global` | atención manual |
| `wordpress.share` | sí | `publishing:global` | atención manual |
| `automation.start/stop/restart` | runtime | `automation:runtime` | no duplicar runtime |
| `automation.job.cancel` | cancelación local | por job | resultado registrado |
| `automation.jobs.clear` | limpieza local | — | sin retry de mutación HTTP |
| `instagram.pending.retry` | sí | `instagram:default` | atención manual |
| `instagram.pending.delete` | local | `instagram:default` | confirmar resultado |
| `whatsapp.groups.extract` | lectura Playwright | `whatsapp:profile_default` | reintentable antes de side effect |
| `whatsapp.group_set.save` | escritura | `whatsapp:profile_default` | atención manual |

## Video y R2

| Tipo | Función | Límite/estado |
|---|---|---|
| `xvideo.create_url` | procesa URL individual | espera hasta 4 h a `ready/failed` |
| `xvideo.update` | título/caption | job existente |
| `xvideo.share_test` | grupo de prueba | side effect, atención manual |
| `xvideo.publish` | publicación multicanal | side effect, hasta 4 h |
| `xvideo.batch.create` | hasta 100 URLs | hasta 8 h |
| `xvideo.batch.publish` | publica hasta 100 jobs | side effect, hasta 8 h |
| `xvideo.clear_cache` | limpia cache local | no borra R2 |
| `xvideo.clear_jobs` | limpia jobs locales | no borra R2 |
| `xvideo.export_r2` | stream local → R2 | key determinista, descargable |

## Estados

- `queued`: espera agente/recurso.
- `claimed`: agente tiene lease, todavía no comenzó.
- `running`: en ejecución con heartbeat.
- `completed`: éxito confirmado.
- `partial_success`: algunos destinos/items fallaron.
- `completed_unverified`: terminó pero una integración no confirmó totalmente.
- `waiting_manual_retry`: la API local exige intervención.
- `requires_attention`: el enlace se perdió después de un posible efecto externo.
- `failed`: fallo terminal conocido.
- `cancelled`: cancelado antes de efecto externo.

Cancelar no se permite después de marcar side effect. Reintentar sólo se permite desde estados de fallo/atención y siempre es una decisión explícita del usuario.
