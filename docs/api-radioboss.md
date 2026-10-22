# API compatible con RadioBOSS (MiRadio → ngradio.es)

MiRadio incluye un servidor HTTP que responde como la API de RadioBOSS, de modo
que el worker `core.ngradio.es` solo tiene que cambiar `API_BASE`.

## Puesta en marcha

1. MiRadio → Ajustes → **API**: activar, puerto (por defecto 9000), usuario y clave
   (mínimo 6 caracteres) y, si se quiere, un token Bearer.
2. Publicar el puerto con Cloudflare Tunnel, por ejemplo:
   `cloudflared tunnel --url http://127.0.0.1:9000` (prueba rápida) o un túnel con
   nombre que apunte `rb-direct.ngradio.es` (o `api.ngradio.es`) a `http://127.0.0.1:9000`.
   Si se reutiliza `rb-direct.ngradio.es`, el worker no cambia nada.
3. En el worker: `API_BASE` = la dirección del túnel. Usuario y clave nuevos como
   secretos del worker (no son los del panel).
4. Aviso de cambios: en la misma pestaña, URL `https://core.ngradio.es/update` y el
   `AUTH_TOKEN` del worker. MiRadio llama una vez por cambio de canción, sin reintentos.

## Peticiones

`GET /?action=<acción>&user=<usuario>&pass=<clave>` o con `Authorization: Bearer <token>`.
Sin credenciales válidas: `401 E001: Wrong password`. Las URL no se registran (la clave nunca
acaba en un log). Las credenciales se guardan con hash en `api_secrets.json`.

Las respuestas copian RadioBOSS 7.2 byte a byte en estructura (elementos, atributos y su orden,
CRLF, errores `E00x`): ver [radioboss-referencia.md](radioboss-referencia.md). Acciones de
lectura: `playbackinfo`, `status`, `getplaylist2`, `getplaylist`, `trackinfo`, `getlastplayed`,
`library`, `readtag` (con y sin `artwork=1`), `trackartwork`, `nexttrackartwork`,
`prevtrackartwork`, `encoderstatus`, `getencoder`, `songrequestlist`, `mic`,
`streamarchivestatus`, `schedulecontrol&type=state`. Escritura: `writetag` (responde `OK`).

Diferencias con RadioBOSS:
- `readtag`/`writetag` solo leen o escriben archivos de la biblioteca; otra ruta recibe la ficha
  vacía (como un archivo inexistente) y `writetag` la rechaza.
- `getencoder` nunca envía las claves (`Password=""`).
- Las carátulas se envían con su tipo real (`image/jpeg`…), no como `text/html`.
- No hay `Overlay` en `playbackinfo`, ni comandos de control (`cmd=…`), ni `generalinfo`/`getlog`.
- `RATING`, `Added` y `F1`…`F5` van vacíos o a 0 (MiRadio no los guarda).

## Identidad de las canciones (FILENAME)

`FILENAME` es la **ruta completa del archivo**, en forma Unicode NFC y con los espacios
unificados (misma entrada, mismo resultado). ARTIST y TITLE se normalizan igual, sin
tocar mayúsculas ni tildes. **Renombrar o mover el archivo cambia la identidad**
(también "Relinkar archivo" en MiRadio).

## Fuentes de datos

- Estado de emisión: la app lo publica al servidor en cada cambio y cada 2 s; la posición
  se extrapola, así que `playbackinfo` no toca disco ni red (respuestas de pocos ms).
- Oyentes: `status-json.xsl` de Icecast, sondeado cada 5 s (800 ms de límite); si falla
  se mantiene el último valor. Vacío = el servidor de la primera emisión Icecast.
- Historial (`getlastplayed`) y biblioteca: los ficheros de MiRadio.

## Verificación

```
node scripts/verify-rbapi.mjs --base https://api.ngradio.es --user U --pass P
node scripts/verify-rbapi.mjs --base … --token T --compare https://rb-direct.ngradio.es --compare-user U --compare-pass P
```

Comprueba cada acción (formato, orden de atributos, escapado, < 1 s), la autenticación,
el aislamiento de errores, 20 `playbackinfo` seguidas y, con `--compare`, la estructura
frente a la respuesta real de RadioBOSS (elementos y atributos en el mismo orden).
