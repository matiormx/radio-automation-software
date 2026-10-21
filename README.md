# MiRadio

Estudio de automatización de radio ligero, pensado para operadores que se
inician. Referencias: RadioDJ (funciona casi solo) y RadioBOSS (robustez,
biblioteca y reglas de rotación).

## Lo que hace

- **La canción es sus metadatos**: la biblioteca es un catálogo de
  canciones (título, artista, álbum, género, año, bloques y etiquetas).
  El archivo de audio es solo un enlace; si se mueve o desaparece, la
  canción sigue viva y se **relinka** a otro archivo en un momento.
- **Navegador de música** con pestañas: Carpetas (árbol real), Artistas,
  Bloques, Estilos y Etiquetas. Buscador por cualquier campo, ordenación
  por columnas, arrastre a la lista y menú contextual con **Propiedades**
  (metadatos + formato, bitrate, frecuencia, canales, tamaño y ruta).
- **Librería y normalizador A/B**: el botón **Librería** abre una ventana de
  dos columnas para mover canciones entre dos bibliotecas (sin mover ni
  borrar archivos), medir sonoridad EBU R128 (LUFS y pico real), calcular
  una **ganancia no destructiva** hacia el objetivo (-9 LUFS por defecto,
  ajustable) con techo de pico a -1 dBTP y marcar **inicio y final** para
  recortar silencios sin tocar el audio. Incluye editor de onda con marcas
  arrastrables y análisis desatendido por selección o por lista visible.
  Al analizar una selección se puede marcar **Omitir ya analizadas** para
  conservar los análisis previos y procesar solo lo nuevo.
  El análisis sigue en segundo plano al ocultar la ventana; se puede
  pausar, reanudar o cancelar desde la propia librería o desde el aviso
  flotante que queda sobre el reproductor.
- **Gestor de música**: arrastra archivos de audio a la ventana (o botón
  «Importar») y **se copian a la carpeta de música predefinida**
  (configurable en Ajustes; por defecto una carpeta interna de la app).
  Los originales no se tocan. El botón «Escanear» cataloga canciones que
  ya estén en esa carpeta sin copiar nada, estilo RadioDJ.
- **Bloques musicales**: clasifica las canciones en bloques
  («Éxitos 80», «Baladas»…). Cada bloque tiene un rayo: los encendidos
  alimentan al piloto automático.
- **Importar listas M3U/M3U8**: carga una lista existente y asígnala a un
  bloque (existente o nuevo). Respeta rutas absolutas de Windows
  (`R:\Musica\…`), rutas relativas al archivo de lista, BOM, CRLF y
  `#EXTINF`. Informa de las rutas que ya no existen. Las canciones que ya
  están en la biblioteca solo se asignan al bloque; las nuevas se pueden
  copiar a la carpeta de música o enlazar en su sitio.
- **Lista de emisión**: tabla profesional con hora estimada de emisión,
  **carátula**, duración y orden por arrastre. La portada se toma de la
  imagen incrustada en el audio o de un `cover.jpg`/`folder.jpg` cercano;
  al pulsarla se abren los detalles completos de la canción.
- **Pantalla principal**: el tema en emisión muestra portada, título,
  artista, álbum y progreso; el siguiente muestra también portada,
  artista, álbum y duración. El VU vertical ocupa la división entre la
  biblioteca y la lista.
- **Piloto automático**: rellena la lista solo cuando quedan pocas pistas
  por delante, respetando **reglas de rotación**: no repetir tema, título
  ni artista dentro de los minutos configurados, y no emparejar dos temas
  del mismo artista de forma consecutiva. Estilo RadioDJ/RadioBOSS.
- **Identidad de emisora**: nombre, eslogan y logo propios. El logo se
  copia a la carpeta de datos y sustituye la marca de la cabecera.
- **Campañas de anuncios y jingles**: programa spots por días y horas
  exactas (eligiendo entre las 24 horas con el minuto deseado, o cada
  hora a un minuto), con fecha y hora de inicio y fin. Por defecto empieza
  hoy y continúa de forma permanente. El AutoDJ inserta el spot después
  del tema que esté sonando, rota los spots de cada campaña y recupera la
  emisión si la app estaba cerrada hace menos de 15 minutos.
- **Eventos de programación**: franjas que cambian la fuente del AutoDJ
  (un bloque musical o una biblioteca) y sonidos que se colocan como
  siguiente a una hora exacta. Cada evento se puede desactivar o lanzar
  manualmente; el interruptor **EVENTOS** de la cabecera los desactiva
  temporalmente todos.
- **Motor de audio** con crossfade (3/6/10 s), seek, siguiente/anterior.
  La pista siguiente se decodifica 30 s antes del cruce y la caché de PCM
  está acotada a 4 pistas; si la decodificación se retrasa, el cruce se
  resuelve sin hueco.
- **Mesa de sonido digital**: canales con entrada y salida, buses que
  combinan canales, fader y silencio por canal, nombre y color. Las
  entradas pueden ser tarjetas físicas o virtuales, la reproducción de la
  radio o la preescucha del normalizador; las salidas, cualquier tarjeta
  del equipo o la predeterminada. El **VU vertical** entre la biblioteca y
  la lista muestra el nivel de la salida general o del bus elegido en
  Sonido.
- **Vídeo y streaming**: canales de entrada (archivo, RTSP o NDI) y de
  salida (pantalla/HDMI, tarjeta SDI, NDI o RTSP), con formato, FPS y
  bitrate por salida. El motor FFmpeg emite audio por Icecast en FLAC o
  AAC y vídeo por RTSP; se inicia y detiene con el botón **EMITIR** de la
  cabecera.
- **Arranque y silencio**: en Ajustes > General se puede reproducir la
  lista automáticamente al abrir la app y activar la detección de
  silencio, que salta a la siguiente canción (o reanuda la reproducción)
  cuando pasan 3 segundos sin sonido.
- **Bloque del AutoDJ**: Ajustes > General elige el bloque musical por
  defecto, y la barra inferior, junto al piloto automático, permite
  cambiarlo en caliente y ver qué bloque está usando. Un evento activo
  tiene prioridad sobre esa elección.
- **Modo LIVE**: se preparan programas con antelación (título, portada y
  hora). La barra auxiliar está siempre visible: en gris con el programa
  preparado y en rojo cuando LIVE está activo, con sus metadatos
  sustituyendo a los de la canción en el archivo `live.txt`.
- **Historial de emisión**: las canciones que ya han sonado se guardan y se
  ven en gris en la pestaña «Historial» de Música, con la hora de emisión.
- **Continuar donde se quedó**: al reabrir la app, la lista activa, la
  pista y el punto exacto de reproducción se recuperan solos.
- **Dos archivos de directo**: `nowplaying.txt` (con su `nowplaying.jpg`)
  lleva siempre la música que está sonando, y `live.txt` (con su
  `live.jpg`) lleva el programa seleccionado cuando el modo LIVE está
  activado; si LIVE está apagado, los dos muestran la misma canción.
- **Actualización desde los ajustes**: en Ajustes > General se busca la
  última release publicada y se descarga el instalador, que se abre solo.
- **Ajustes con navegación lateral**: General (identidad, logo, carpeta
  de música, arranque y actualizaciones), Sonido (mesa de mezclas), Vídeo, AutoDJ (reglas
  y cola), Campañas (anuncios y jingles), Eventos (franjas y sonidos
  programados) y Streaming. Todo se guarda al instante, junto con
  transición y volumen. Al ocultar Ajustes o Librería no se pierde la
  pestaña ni lo que estés editando.

## Archivos de musica soportados

mp3, wav, flac, ogg, oga, opus, m4a, aac, aif, aiff, wma, webm

La app lee titulo, artista, álbum, género, año y duración de las etiquetas
del archivo si existen; si no, usa el nombre del archivo (y si dice
`Artista - Cancion`, lo separa solo).

## Donde se guardan las cosas

Todo queda en la carpeta de datos de la app (por ejemplo
`%LOCALAPPDATA%/com.miradio.app` en Windows o `~/.local/share/com.miradio.app` en
Linux):

```
music/          <- carpeta de musica por defecto (ajustable en Ajustes)
library.json    <- catalogo: metadatos, etiquetas, analisis, recorte + enlace
blocks.json     <- bloques musicales
playlists/      <- una lista guardada por archivo JSON
branding/       <- logo de la emisora copiado por la app
covers/         <- caratulas extraidas de los audios
history.json    <- historial de emision (para las reglas de rotacion)
```

Las bibliotecas antiguas (solo titulo/artista/duracion) se migran sola:
el enlace al archivo se reconstruye desde la carpeta interna `music/`,
pero los archivos de audio **nunca se borran**.

## Carátulas y detalles

La lista de emisión muestra la carátula de cada canción. MiRadio extrae la
imagen incrustada en el archivo (MP3, M4A, FLAC, OGG…) o, si no hay, busca
`cover.jpg`, `folder.jpg`, `front.jpg`, `album.jpg` o una imagen con el
mismo nombre que el audio en su carpeta. Como la imagen pertenece al álbum,
se guarda **una sola copia por álbum** en `covers/`: todas las canciones del
mismo álbum comparten el archivo. Si una ficha no tiene álbum, se usa una
portada por canción. Las bibliotecas existentes se consolidan al iniciar.

Al pulsar la carátula se abre la ficha completa: metadatos, normalización,
recorte, formato, calidad, bloques, etiquetas, tamaño y ruta. Es la misma
ficha que aparece en «Propiedades» del navegador de música.

## Campañas de anuncios y jingles

En **Ajustes > Campañas** se crea una campaña con nombre, tipo (anuncio o
jingle) y una lista ordenada de spots elegidos de la biblioteca. La
programación admite días de la semana y un selector de las 24 horas: se
elige el minuto y se pulsa la hora para añadirla (o se vuelve a pulsar
para quitarla). También existe la opción de emitir cada hora a un minuto
concreto. Cada campaña tiene **inicio** y **fin** de fecha y hora; por
defecto empieza hoy y no tiene fin (continuidad permanente). Sin fin, la
campaña sigue activa hasta que se desactive o se le ponga una fecha.

- Solo se emiten con el piloto automático encendido y dentro de su
  ventana de fechas.
- El spot se inserta justo después del tema que está sonando cuando llega
  la hora, sin cortarlo; si la lista está parada, se añade al final.
- Cada campaña rota sus spots en orden y recuerda la última emisión para
  no repetirla el mismo día y hora.
- Si la app estaba cerrada a esa hora, recupera la campaña al abrirla solo
  si han pasado menos de 15 minutos.
- Si un spot desaparece de la biblioteca, se salta y se usa el siguiente.

## Vídeo y streaming

En **Ajustes > Vídeo** se definen los canales de entrada y salida. Las
entradas pueden ser archivos de vídeo, URLs RTSP o fuentes NDI; las salidas,
una pantalla/HDMI, una tarjeta SDI, NDI o una URL RTSP. Cada salida guarda su
resolución, FPS y bitrate. La mezcla inicial hace cortes entre la fuente
activa.

En **Ajustes > Streaming** se configuran una o varias emisiones de audio por
Icecast (FLAC sin pérdida o AAC con bitrate) con servidor, puerto, montaje,
credenciales y metadatos públicos, además de la salida de vídeo RTSP con
transporte TCP/UDP, resolución, FPS, bitrate y keyframes.

El botón **EMITIR** de la cabecera arranca y detiene el motor. La captura de
audio toma el mismo bus que el VU de salida en PCM s16le a 48 kHz estéreo;
FFmpeg lo transcodifica a FLAC/AAC para Icecast y a AAC para RTSP. Las
salidas RTSP usan la primera entrada de vídeo activa y hacen cortes, sin
mezcla. La salida a pantalla/HDMI usa la salida SDL de FFmpeg y la salida SDI
requiere una build de FFmpeg con DeckLink y el SDK instalado.

MiRadio busca **FFmpeg** en este orden:

1. La variable de entorno `MIRADIO_FFMPEG`.
2. `ffmpeg.exe` junto a `MiRadio.exe` o en `bin\ffmpeg.exe`.
3. `ffmpeg.exe` en `PATH`.

El instalador copia `ffmpeg.exe` si lo incluyes en la misma carpeta que
`instalar.cmd`. Sin FFmpeg, el resto de la app funciona; al pulsar EMITIR se
muestra el error de que no se encontró.

NDI queda preparado en los canales para una segunda fase.

## Eventos de programación

En **Ajustes > Eventos** se programan dos tipos de evento por días de la
semana:

- **Franja AutoDJ**: empieza a la hora indicada y se mantiene hasta que
  empiece otro evento. Las próximas canciones que elige el piloto
  automático salen de un bloque musical o de la Biblioteca A/B. La cola ya
  cargada no se modifica y, si la fuente se queda sin pistas, el AutoDJ
  vuelve a la biblioteca completa.
- **Sonido programado**: a la hora exacta, la pista elegida se coloca justo
  después del tema que está sonando. Si el tema actual no termina dentro de
  la espera máxima, el evento puede forzarlo al aire (con el fundido de
  salida) o cancelarlo y quitarlo de la lista.

Cada evento recuerda su última emisión para no repetirse el mismo día y
hora. Si la app estaba cerrada, recupera el evento solo si han pasado menos
de 15 minutos. Las inserciones programadas funcionan aunque el piloto
automático esté apagado; las franjas solo afectan cuando el AutoDJ rellena
la lista.

En la lista, cada evento tiene botones para **desactivarlo** o **lanzarlo
manualmente**. El interruptor **EVENTOS** de la barra superior desactiva
temporalmente todos los eventos sin borrar su programación.

## Arranque, silencio y bloque del AutoDJ

En **Ajustes > General**:

- **Reproducir automáticamente al iniciar el programa**: al abrir la app
  empieza a sonar la lista activa.
- **Detección de silencio**: si durante 3 segundos no suena nada, el
  reproductor pasa a la siguiente canción; si la reproducción estaba
  parada, la reanuda. Si pausas a mano, no vuelve a arrancar sola.
- **Bloque musical por defecto del AutoDJ**: el piloto automático saca
  las próximas canciones de ese bloque. En «Automático» usa los bloques
  marcados con el rayo en la pestaña Música y, si no hay ninguno, toda la
  biblioteca.

En la barra inferior, junto al interruptor del piloto automático, está el
selector **BLOQUE AUTO**: muestra el bloque que se está usando y permite
asignar otro sin abrir los ajustes. Cuando hay un evento de franja
activo, la etiqueta muestra el origen del evento, que manda sobre el
bloque elegido.

## Historial y reanudación

**Historial.** Cada vez que empieza una canción, queda anotada en el
historial (archivo `history.json` de la app). En la pestaña **Historial** de
Música se ven las últimas 25, en gris y con la hora en que sonaron, de la
más reciente a la más antigua. El historial también alimenta las reglas de
rotación (no repetir tema, artista o pista).

**Continuar donde se quedó.** La app guarda cada 5 segundos y al cerrar en
qué lista estaba, qué pista sonaba y en qué segundo. Al volver a abrirla:

- recupera la lista activa y deja el reproductor en esa pista y ese punto;
- si estaba sonando y tienes activado «Reproducir automáticamente al iniciar
  el programa», sigue sonando; si no, queda en pausa justo donde estaba,
  y al pulsar el play continúa desde ahí.

La pista recuperada no cuenta como nueva en el historial.

**Vaciar la lista.** En la cabecera de la lista de emisión, el botón
**Vaciar** quita todas sus pistas (pregunta antes). No borra las canciones
de la biblioteca: solo la lista.

## Mesa de sonido

En **Ajustes > Sonido** se monta una mesa de mezclas con canales y buses:

- **Canal**: recibe una fuente y la envía a un bus o directamente a una
  tarjeta. Cada canal tiene fader (-60 a +12 dB), silencio, nombre y color.
- **Bus**: suma varios canales y sale por una tarjeta. Sirve para agrupar,
  por ejemplo, música y jingles en una salida y los micrófonos en otra.
- **Entradas**: las tarjetas de entrada del equipo (físicas o virtuales) y
  las dos fuentes internas: reproducción de música y preescucha del
  normalizador.
- **Salidas**: la salida predeterminada del sistema o cualquier tarjeta de
  salida. Se pueden usar varias a la vez.
- **VU de salida**: elige la salida general o un bus concreto. El medidor
  vertical de la pantalla principal muestra esa señal con pico y lectura
  en dB.

La mesa se guarda en `settings.json` y se aplica en caliente. Si no hay
canales configurados, la reproducción y la preescucha siguen saliendo por
la salida predeterminada. Si una fuente interna no está asignada a ningún
canal, también suena por la predeterminada para no dejar la radio muda.

En Windows, la primera vez que se usa una entrada física hay que conceder
permiso de micrófono. El botón «Ver entradas» solicita ese permiso y
actualiza los nombres de las tarjetas. El enrutado a varias salidas usa
`setSinkId` del WebView2; si el sistema no lo soporta, la mesa avisa y todo
sale por la salida predeterminada.

## Como correrla en tu maquina

### 1. Preparar el sistema

**Linux (Debian/Ubuntu):**

```bash
sudo apt update
sudo apt install -y libwebkit2gtk-4.1-dev build-essential curl wget file \
  libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev \
  pkg-config glib-2.0-dev
```

**Windows:** instalar [Rust](https://www.rust-lang.org/tools/install)
(incluye C++ Build Tools si te lo pide) y Visual Studio 2022 Build Tools con
"carga de trabajo C++". Webview2 viene con Windows 10/11.

**macOS:** instalar Rust y Xcode Command Line Tools (`xcode-select --install`).

### 2. Instalar Node.js

Necesitas Node.js 20 o mas: https://nodejs.org

### 3. Compilar y abrir

```bash
npm install
npm run tauri dev
```

La primera vez demora unos minutos Rust compilando. Depues abre la ventana de
MiRadio y ya podes soltar canciones.

### 4. Hacer el instalador

```bash
npm run tauri build
```

El ejecutable/instalador queda en `src-tauri/target/release/bundle/`
(.msi/.exe en Windows, .deb/.AppImage en Linux, .dmg en macOS).

## Importar listas M3U / M3U8

1. Panel «Música» → botón «Lista».
2. Elige el `.m3u`/`.m3u8`.
3. Bloque de destino: uno existente o uno nuevo con el nombre de la lista.
4. «Copiar los archivos a la carpeta de música»:
   - desmarcado (recomendado si tu música ya está organizada): enlaza el
     archivo original sin duplicarlo;
   - marcado: copia a la carpeta de música configurada.
5. El informe indica cuántas se añadieron, cuántas ya estaban y qué rutas
   no existen en el disco.

El emparejamiento con canciones ya catalogadas es por ruta normalizada
(mayúsculas/minúsculas y separadores incluidos), así que reimportar la
misma lista no duplica canciones.

## Modo LIVE

En **Ajustes > Programas** se preparan los programas con antelación:
título, bajada, portada y hora de inicio. Cada programa se puede activar
(«Al aire») o cambiar desde la propia barra.

La barra auxiliar está **siempre visible** sobre el reproductor. En gris
(etiqueta *PREPARADO*) cuando el modo LIVE está apagado y en rojo
(*EN DIRECTO*) cuando está activo. Muestra la portada y el título del
programa preparado, la hora prevista y las portadas de los demás programas
(un clic pone ese programa en antena).

Como la barra está siempre a la vista, se puede **preparar el programa
antes de activarlo**: se elige en la barra (o en Ajustes > Programas) con
el LIVE apagado y, cuando llega el momento, se pulsa **LIVE** —en la barra
o en la cabecera— y ese programa pasa a estar en antena.

En modo LIVE, el archivo `live.txt` (y su `live.jpg`) pasan a llevar los
datos del programa en lugar de los de la canción:

| | `nowplaying.txt` | `live.txt` con LIVE activo | `live.txt` sin LIVE |
| --- | --- | --- | --- |
| `{title}` | Título de la canción | Título del programa | Título de la canción |
| `{artist}` | Artista | Bajada del programa | Artista |
| `{album}`, `{year}`, `{genre}` | Datos de la canción | Vacíos | Datos de la canción |
| `{block}` | Bloques de la canción | Vacío | Bloques de la canción |
| `{program}` | Vacío | Título del programa | Vacío |

Cada archivo tiene su propia plantilla (*Contenido* y *Contenido directo*).
El marcador `{program}` vale el título del programa en directo y queda
vacío si el modo LIVE está apagado.

## Archivo nowplaying

En **Ajustes > General > Archivo nowplaying** eliges dónde se escriben los
archivos de texto (por ejemplo `C:\MiRadio\nowplaying.txt`) y qué datos
llevan dentro. Por defecto es `{artist} - {title}`.

Hay dos salidas, que se escriben a la vez:

- **nowplaying.txt**: siempre la música que está sonando, con su
  `nowplaying.jpg`.
- **live.txt**: el programa seleccionado si el modo LIVE está activado; si
  LIVE está apagado, muestra la misma música que el nowplaying, así que
  los dos archivos coinciden. Va acompañado de su `live.jpg`.

Si dejas el archivo directo en blanco, se usa `live.txt` en la misma
carpeta que el nowplaying.

El archivo de texto se reescribe en cada cambio de canción, de forma
atómica (se escribe un temporal y se renombra), para que ningún programa
lea una línea a medias. Solo se aceptan archivos `.txt`.

Junto a él, en la misma carpeta, se escribe **`nowplaying.jpg`** con la
portada de la canción: un JPEG cuadrado de 600x600 (recortado al centro).
Si la canción no tiene portada, se genera una imagen con el título y el
artista. La imagen se escribe de forma atómica y solo se acepta un JPEG
válido.

Datos disponibles para la plantilla:

| Marcador | Contenido |
| --- | --- |
| `{artist}` | Artista |
| `{title}` | Título de la canción |
| `{album}` | Álbum |
| `{year}` | Año |
| `{genre}` | Género |
| `{duration}` | Duración en m:ss |
| `{duration_sec}` | Duración en segundos |
| `{radio}` | Nombre de la radio |
| `{block}` | Bloques a los que pertenece la canción |
| `{program}` | Programa en directo (modo LIVE) |
| `{time}` | Hora actual |

Un ejemplo: `{radio} | {artist} - {title} ({duration})`.

## Actualizar la app

En **Ajustes > General > Actualizaciones de la app**:

1. **Buscar actualizaciones** consulta el origen de actualizaciones (por
   defecto, la última release de este repositorio en GitHub) y compara la
   versión publicada con la que tienes instalada.
2. Si hay una versión más nueva, aparece **Instalar X.Y.Z**: descarga el
   instalador en la carpeta temporal y lo abre.
3. **Descargar .exe** guarda el instalador donde elijas (abre el diálogo
   de guardado) sin ejecutarlo, por si prefieres instalarlo a mano.
   **Abrir la descarga** lo hace en el navegador.

El origen puede cambiarse por cualquier URL que devuelva la respuesta de
la API de GitHub (`tag_name`, `body` y `assets`) o un manifiesto propio
con `version`, `url` y, opcionalmente, `notes`. Si el repositorio es
privado, pega un token de GitHub con permiso de lectura (se guarda solo en
este equipo).

Por seguridad, la instalación automática (descargar y ejecutar) solo
acepta instaladores descargados por HTTPS desde GitHub; la simple descarga
admite cualquier enlace https. Las
versiones se publican subiendo una etiqueta `vX.Y.Z`: el workflow de
GitHub Actions compila el instalador NSIS y lo adjunta a la release.

## Instalador para Windows sin instalar nada antes

En la raiz del proyecto esta `MiRadio-Instalador-Windows.zip`:

1. Descargalo, clic derecho y "Extraer todo".
2. Doble clic en `instalar.cmd`: copia la app a `%LOCALAPPDATA%\MiRadio`,
   crea los accesos directos y la registra en «Aplicaciones instaladas».
   No pide permisos de administrador. Si la app está abierta, la cierra
   antes de actualizar.
3. Abre MiRadio y suelta canciones.
4. Para emisión, coloca `ffmpeg.exe` junto a `instalar.cmd` antes de
   instalar. El instalador lo copia al lado de `MiRadio.exe`; también
   puedes instalarlo en `PATH` o usar `MIRADIO_FFMPEG`.

Para desinstalar: `desinstalar.cmd` o «Aplicaciones instaladas». Los datos
(`%LOCALAPPDATA%\com.miradio.app`) se conservan a propósito.

El ejecutable no está firmado, así que SmartScreen puede avisar la primera
vez. Para eliminarlo hace falta un certificado de firma de código; el
workflow `.github/workflows/windows.yml` compila el instalador NSIS en un
runner de Windows en cada tag `v*` y está preparado para firmar. La
compilación cruzada con `cargo-xwin` queda para desarrollo.

### Como se genero (por si hay que reproducirlo)

Se compilo en cruz con `cargo xwin` ejecutandose en Linux, contra
clang-18/llvm (binarios de Ubuntu) y el SDK de Windows descargado al
cache de cargo-xwin:

```bash
# toolchain clang local (sin root)
mkdir -p /tmp/opencode/toolchain && cd /tmp/opencode/toolchain
apt-get download clang-18 libclang-cpp18 libllvm18 llvm-18 llvm-18-runtime lld-18
for f in *.deb; do dpkg -x "$f" prefix/; done
ln -sf clang prefix/usr/lib/llvm-18/bin/clang-cl
ln -sf llvm-ar prefix/usr/lib/llvm-18/bin/llvm-lib

export PATH="/tmp/opencode/toolchain/prefix/usr/lib/llvm-18/bin:$HOME/.cargo/bin:$PATH"
export LD_LIBRARY_PATH="/tmp/opencode/toolchain/prefix/usr/lib/x86_64-linux-gnu"
cargo install cargo-xwin

cd src-tauri
# IMPORTANTE: --features custom-protocol embebe la interfaz (sin esto
# el exe buscara la interfaz en un servidor de desarrollo y quedara
# en blanco con "localhost rechazo la conexion").
cargo xwin build --release --target x86_64-pc-windows-msvc --features custom-protocol
# El exe queda en:
#   target/x86_64-pc-windows-msvc/release/miradio.exe
```

## Estructura del proyecto

```
src/                <- interfaz (React + TypeScript)
  audio.ts          <- motor de radio: dos decks + crossfade (Web Audio)
  mixer.ts          <- mesa de sonido: canales, buses, entradas y salidas
  api.ts            <- llamadas al backend de Rust
  App.tsx           <- pantallas y estado general
  components/       <- gestor de musica, lista, deck, ajustes y mesa
src-tauri/          <- backend (Rust + Tauri 2)
  src/library.rs    <- catalogo de canciones, bloques, importar/escanear/relinkar
  src/settings.rs   <- reglas de rotacion y piloto automatico
  src/playlists.rs  <- guardar y cargar listas de reproduccion
```
