# MiRadio

Software de radio facil para chicos que recien empiezan. Inspirado en RadioBOSS y
Salamandra, pero sin configuraciones tecnicas: **arrastras tus canciones, quedan
guardadas y suenan una tras otra con transicion suave**.

## Lo que hace

- **Biblio (biblioteca)**: arrastra archivos de musica a la ventana (o toca el
  banner para buscarlos) y las canciones se copian a una carpeta interna de la
  app. Nunca se mueven ni borran tus archivos originales.
- **Al aire (lista)**: agrega canciones con el boton `+`, ordenalas arrastrando
  o con las flechas, y toca el boton grande para que suenen solas.
- **Radio de verdad**: doble deck (A/B) con crossfade. Cuando una cancion se
  acerca al final, la siguiente sube el volumen y la actual baja (3, 6 o 10
  segundos, a eleccion).
- **Extras simples**: aborta? no. Repetir lista, volumen, anterior/siguiente,
  buscar canciones, varias listas con nombres propios (ej: "Manana", "Sabado").

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
