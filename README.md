# MiRadio

Estudio de automatización de radio ligero, pensado para operadores que se
inician. Referencias: RadioDJ (funciona casi solo) y RadioBOSS (robustez,
biblioteca y reglas de rotación).

## Lo que hace

- **Biblioteca**: arrastra archivos de audio a la ventana (o botón «Importar»)
  y se copian a una carpeta interna de la app. Los originales no se tocan.
- **Lista de emisión**: tabla profesional con hora estimada de emisión,
  duración y orden por arrastre.
- **Piloto automático**: rellena la lista solo cuando quedan pocas pistas
  por delante, respetando **reglas de rotación**: no repetir tema, título
  ni artista dentro de los minutos configurados, y no emparejar dos temas
  del mismo artista de forma consecutiva. Estilo RadioDJ/RadioBOSS.
- **Motor de audio** con crossfade (3/6/10 s), seek, siguiente/anterior.
- **Ajustes persistentes** (reglas, transición, volumen) y reloj de cabecera.

## Archivos de musica soportados

mp3, wav, flac, ogg, oga, opus, m4a, aac, aif, aiff, wma, webm

La app lee el titulo, artista y duracion de las etiquetas del archivo si existen;
si no, usa el nombre del archivo (y si dice `Artista - Cancion`, lo separa solo).

## Donde se guardan las cosas

Todo queda en la carpeta de datos de la app (por ejemplo
`%APPDATA%/com.miradio.app` en Windows o `~/.local/share/com.miradio.app` en
Linux):

```
music/          <- copia de cada cancion importada (nombre seguro interno)
library.json    <- catalogo con titulo, artista y duracion
playlists/      <- una lista guardada por archivo JSON
```

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

## Instalador para Windows sin instalar nada antes

En la raiz del proyecto esta `MiRadio-Instalador-Windows.zip` (1,6 MB):

1. Descargalo, clic derecho y "Extraer todo".
2. Doble clic en `instalar.cmd`: copia la app a tu carpeta de usuario,
   crea el icono en el escritorio y en el menu de inicio. No pide
   permisos de administrador ni instala Node, Rust ni nada mas.
3. Abre MiRadio y suelta canciones.

Para desinstalar: `desinstalar.cmd`.

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
  components/       <- Biblio, Al aire, Deck, botones grandes
src-tauri/          <- backend (Rust + Tauri 2)
  src/library.rs    <- importar/copiar/borrar canciones y sus etiquetas
  src/playlists.rs  <- guardar y cargar listas de reproduccion
```
