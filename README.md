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
- **Normalizador de bibliotecas A/B**: ventana de dos columnas para mover
  canciones entre dos bibliotecas (sin mover ni borrar archivos), medir
  sonoridad EBU R128 (LUFS y pico real), calcular una **ganancia no
  destructiva** hacia el objetivo (-9 LUFS por defecto, ajustable) con
  techo de pico a -1 dBTP y marcar **inicio y final** para recortar
  silencios sin tocar el audio. Incluye editor de onda con marcas
  arrastrables y análisis desatendido por selección o por lista visible.
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
  duración y orden por arrastre.
- **Piloto automático**: rellena la lista solo cuando quedan pocas pistas
  por delante, respetando **reglas de rotación**: no repetir tema, título
  ni artista dentro de los minutos configurados, y no emparejar dos temas
  del mismo artista de forma consecutiva. Estilo RadioDJ/RadioBOSS.
- **Identidad de emisora**: nombre, eslogan y logo propios. El logo se
  copia a la carpeta de datos y sustituye la marca de la cabecera.
- **Campañas de anuncios y jingles**: programa spots por días y horas
  exactas (o cada hora a un minuto). El AutoDJ inserta el spot después del
  tema que esté sonando, rota los spots de cada campaña y recupera la
  emisión si la app estaba cerrada hace menos de 15 minutos.
- **Motor de audio** con crossfade (3/6/10 s), seek, siguiente/anterior.
  La pista siguiente se decodifica 30 s antes del cruce y la caché de PCM
  está acotada a 4 pistas; si la decodificación se retrasa, el cruce se
  resuelve sin hueco.
- **Ajustes con navegación lateral**: General (identidad, logo y carpeta
  de música), AutoDJ (reglas y cola) y Campañas (anuncios y jingles).
  Todo se guarda al instante, junto con transición y volumen.

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
history.json    <- historial de emision (para las reglas de rotacion)
```

Las bibliotecas antiguas (solo titulo/artista/duracion) se migran sola:
el enlace al archivo se reconstruye desde la carpeta interna `music/`,
pero los archivos de audio **nunca se borran**.

## Campañas de anuncios y jingles

En **Ajustes > Campañas** se crea una campaña con nombre, tipo (anuncio o
jingle) y una lista ordenada de spots elegidos de la biblioteca. La
programación admite días de la semana y horas exactas (`HH:MM`), o la
opción de emitir cada hora a un minuto concreto.

- Solo se emiten con el piloto automático encendido.
- El spot se inserta justo después del tema que está sonando cuando llega
  la hora, sin cortarlo; si la lista está parada, se añade al final.
- Cada campaña rota sus spots en orden y recuerda la última emisión para
  no repetirla el mismo día y hora.
- Si la app estaba cerrada a esa hora, recupera la campaña al abrirla solo
  si han pasado menos de 15 minutos.
- Si un spot desaparece de la biblioteca, se salta y se usa el siguiente.

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

## Instalador para Windows sin instalar nada antes

En la raiz del proyecto esta `MiRadio-Instalador-Windows.zip`:

1. Descargalo, clic derecho y "Extraer todo".
2. Doble clic en `instalar.cmd`: copia la app a `%LOCALAPPDATA%\MiRadio`,
   crea los accesos directos y la registra en «Aplicaciones instaladas».
   No pide permisos de administrador. Si la app está abierta, la cierra
   antes de actualizar.
3. Abre MiRadio y suelta canciones.

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
  api.ts            <- llamadas al backend de Rust
  App.tsx           <- pantallas y estado general
  components/       <- gestor de musica, lista, deck, ajustes
src-tauri/          <- backend (Rust + Tauri 2)
  src/library.rs    <- catalogo de canciones, bloques, importar/escanear/relinkar
  src/settings.rs   <- reglas de rotacion y piloto automatico
  src/playlists.rs  <- guardar y cargar listas de reproduccion
```
