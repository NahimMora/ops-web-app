# R2 para cargas y previews de Videos X

## Credenciales

El servidor público usa credenciales exclusivas y restringidas al prefijo
`ops/xvideo-uploads/*` para firmar, inspeccionar y borrar cargas temporales:

- `OPS_UPLOAD_R2_ACCESS_KEY_ID`
- `OPS_UPLOAD_R2_SECRET_ACCESS_KEY`
- `OPS_UPLOAD_R2_ACCOUNT_ID` o `OPS_UPLOAD_R2_S3_ENDPOINT`
- `OPS_UPLOAD_R2_BUCKET`
- `OPS_UPLOAD_R2_PREFIX=ops/xvideo-uploads`
- `OPS_UPLOAD_URL_TTL_SECONDS=900`
- `OPS_UPLOAD_RETENTION_HOURS=24`

El agente local conserva sus credenciales de R2 separadas. Estas permiten
escribir y borrar `ops/xvideo-previews/*` y escribir la exportación permanente
`ops/videos/*`:

- `OPS_R2_PREVIEW_PREFIX=ops/xvideo-previews`
- `OPS_R2_VIDEO_PREFIX=ops/videos`
- `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_S3_ENDPOINT`, `R2_BUCKET`
- `R2_PUBLIC_BASE_URL=https://holasaltamedia.cc`

## CORS del bucket

Aplicar esta política CORS al bucket de cargas. No se deben habilitar cookies ni
credenciales del navegador:

```json
[
  {
    "AllowedOrigins": ["https://ops.holasalta.com"],
    "AllowedMethods": ["PUT"],
    "AllowedHeaders": ["Content-Type"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3600
  }
]
```

Para un entorno local de prueba se puede agregar temporalmente el origen exacto
del frontend local. No usar `*` en producción.

## Ciclo de vida

Configurar una regla de lifecycle que elimine objetos con el prefijo
`ops/xvideo-uploads/` después de un día. La aplicación intenta borrar cada
objeto apenas el backend local confirma la recepción; el lifecycle es la red de
seguridad para cargas abandonadas.

Las previews usan una clave estable:
`ops/xvideo-previews/{jobId}/preview.mp4`. Cada render incrementa
`render_revision` y publica una URL con `?v={revision}`. La acción “Limpiar
trabajos” borra primero el objeto remoto y conserva el job local si esa limpieza
falla, para permitir un reintento.

## Orden de despliegue

1. Desplegar/reiniciar el backend local y comprobar `/health`.
2. Desplegar/reiniciar el agente local con `OPS_R2_PREVIEW_PREFIX`.
3. Aplicar la migración `temporary_media_uploads` y desplegar el servidor Ops
   con las credenciales `OPS_UPLOAD_R2_*`.
4. Aplicar CORS y lifecycle en Cloudflare R2.
5. Desplegar el frontend Ops.

Este orden mantiene compatibles los comandos anteriores. `xvideo.export_r2`
continúa usando `ops/videos/*` y no depende de la preview temporal.
