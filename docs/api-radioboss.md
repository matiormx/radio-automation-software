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
Sin credenciales válidas: 401. Las URL no se registran (la clave nunca acaba en un log).
Las credenciales se guardan con hash en `api_secrets.json` (carpeta de datos de MiRadio).

| Acción | Respuesta |
| --- | --- |
| `playbackinfo` | `<Info><Playback state pos len/><CurrentTrack><TRACK ARTIST TITLE FILENAME ALBUM DURATION STARTTIME/></CurrentTrack><NextTrack><TRACK ARTIST TITLE FILENAME/></NextTrack><Listeners>N</Listeners></Info>` (pos y len en ms) |
| `encoderstatus` | `<Encoders><Encoder name listeners/>…</Encoders>` (mounts de Icecast) |
| `getlastplayed` | `<LastPlayed><Track ARTIST TITLE FILENAME LASTPLAYED/>…</LastPlayed>`, más recientes primero; `count=N` (20 por defecto) |
| `library` | `<Library><Track ARTIST TITLE FILENAME ALBUM GENRE YEAR DURATION/>…</Library>` |
| `getplaylist2` | `<Playlist><TRACK ARTIST TITLE FILENAME ITEMTYPE STARTTIME/>…</Playlist>` |
| `readtag&fn=<ruta>[&artwork=1]` | `<TagInfo><File FN ARTIST TITLE ALBUM YEAR GENRE COMMENT DURATION/>[<Artwork MIME>base64</Artwork>]</TagInfo>` |
| `writetag&fn=<ruta>&data=<xml>` | `data` = `<File ARTIST="…" TITLE="…" …/>`; escribe en el archivo y en la ficha. Respuesta `<Result>OK</Result>` |
| `trackartwork` / `nexttrackartwork` | bytes de la imagen (404 si no hay) |
| `songrequestlist` | `<Requests></Requests>` (MiRadio no tiene peticiones de oyentes) |

`readtag` y `writetag` solo aceptan archivos que estén en la biblioteca.
Un error en una acción devuelve `<Error>…</Error>` con 400/404/500 solo en esa petición.

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
