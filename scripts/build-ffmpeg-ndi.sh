#!/usr/bin/env bash
# Compila FFmpeg con el device libndi_newtek usando los parches de
# https://github.com/lplassman/FFMPEG-NDI.
#
# Uso normal en Windows: scripts/build-ffmpeg-ndi.ps1
# En Linux/macOS hay que indicar NDI_INCLUDE y NDI_LIB (SDK de NDI).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUILD_DIR="${BUILD_DIR:-$ROOT/.build/ffmpeg-ndi}"
OUT_DIR="${OUT_DIR:-$ROOT/src-tauri/bin}"
FFMPEG_NDI_REPO="${FFMPEG_NDI_REPO:-https://github.com/lplassman/FFMPEG-NDI.git}"
FFMPEG_REPO="${FFMPEG_REPO:-https://github.com/FFmpeg/FFmpeg.git}"
FFMPEG_REF="${FFMPEG_REF:-n5.1}"
JOBS="${JOBS:-$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 2)}"
WITH_X264="${WITH_X264:-1}"
WITH_TLS="${WITH_TLS:-1}"

need() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Falta '$1'. Instálalo y vuelve a intentarlo." >&2
    exit 1
  fi
}

need git
need make
if ! command -v cc >/dev/null 2>&1; then
  if command -v gcc >/dev/null 2>&1; then
    CC=gcc
    export CC
  else
    echo "Falta un compilador C (gcc/cc)." >&2
    exit 1
  fi
fi

if [ -z "${NDI_INCLUDE:-}" ] || [ -z "${NDI_LIB:-}" ]; then
  cat >&2 <<'EOF'
Falta NDI_INCLUDE y NDI_LIB.

En Windows ejecuta:
  powershell -ExecutionPolicy Bypass -File scripts\build-ffmpeg-ndi.ps1

En Linux/macOS instala el NDI SDK e indica las rutas, por ejemplo:
  NDI_INCLUDE="/ruta/NDI SDK/include" \
  NDI_LIB="/ruta/NDI SDK/lib/x86_64-linux-gnu" \
  scripts/build-ffmpeg-ndi.sh
EOF
  exit 1
fi

mkdir -p "$BUILD_DIR" "$OUT_DIR"

echo "==> Clonando/actualizando FFMPEG-NDI"
if [ -d "$BUILD_DIR/FFMPEG-NDI/.git" ]; then
  git -C "$BUILD_DIR/FFMPEG-NDI" fetch --depth 1 origin master
  git -C "$BUILD_DIR/FFMPEG-NDI" reset --hard FETCH_HEAD
else
  git clone --depth 1 --branch master "$FFMPEG_NDI_REPO" "$BUILD_DIR/FFMPEG-NDI"
fi
NDI_REPO_DIR="$BUILD_DIR/FFMPEG-NDI"
git -C "$NDI_REPO_DIR" config core.autocrlf false
git -C "$NDI_REPO_DIR" config core.eol lf
git -C "$NDI_REPO_DIR" reset --hard HEAD >/dev/null

echo "==> Clonando/actualizando FFmpeg $FFMPEG_REF"
if [ -d "$BUILD_DIR/ffmpeg/.git" ]; then
  git -C "$BUILD_DIR/ffmpeg" fetch --depth 1 origin "$FFMPEG_REF"
  git -C "$BUILD_DIR/ffmpeg" reset --hard FETCH_HEAD
  git -C "$BUILD_DIR/ffmpeg" clean -fdx >/dev/null
else
  git clone --depth 1 --branch "$FFMPEG_REF" "$FFMPEG_REPO" "$BUILD_DIR/ffmpeg"
fi
FFMPEG_DIR="$BUILD_DIR/ffmpeg"
cd "$FFMPEG_DIR"

git config user.email "miradio-build@localhost"
git config user.name "MiRadio build"
git config core.autocrlf false
git config core.eol lf
git reset --hard HEAD >/dev/null

# Los parches se aplican sobre n5.1. Si se vuelve a ejecutar el script,
# el reset anterior deja el árbol limpio y se aplican otra vez.
if ! git log --oneline --grep='Revert "lavd: Remove libndi_newtek"' | grep -q .; then
  echo "==> Aplicando parche libndi_newtek"
  git am --abort >/dev/null 2>&1 || true
  git am "$NDI_REPO_DIR/libndi.patch"
fi
cp "$NDI_REPO_DIR/libavdevice/libndi_newtek_"* libavdevice/

if ! git log --oneline --grep='patch mathops' | grep -q .; then
  echo "==> Aplicando parche mathops"
  git am "$NDI_REPO_DIR/mathops.patch"
fi

CONFIG_ARGS=(
  --prefix="$BUILD_DIR/install"
  --disable-doc
  --disable-debug
  --disable-shared
  --enable-static
  --enable-gpl
  --enable-nonfree
  --enable-libndi_newtek
  --disable-inline-asm
  --extra-cflags="-I$NDI_INCLUDE"
  --extra-ldflags="-L$NDI_LIB"
)

STATIC_PKGS=0
if [ "$WITH_X264" = "1" ]; then
  if ! command -v pkg-config >/dev/null 2>&1 || ! pkg-config --exists x264; then
    echo "No se encontró x264 (pkg-config). Instala libx264-dev o ejecuta con WITH_X264=0." >&2
    exit 1
  fi
  CONFIG_ARGS+=(--enable-libx264)
  STATIC_PKGS=1
fi

if [ "$WITH_TLS" = "1" ]; then
  if command -v pkg-config >/dev/null 2>&1 && pkg-config --exists openssl; then
    CONFIG_ARGS+=(--enable-openssl)
    STATIC_PKGS=1
  else
    echo "Aviso: OpenSSL no encontrado; se compila sin RTMPS. Instala libssl-dev o usa WITH_TLS=0." >&2
  fi
fi

if [ "$STATIC_PKGS" = "1" ]; then
  CONFIG_ARGS+=(--pkg-config-flags=--static)
fi

echo "==> Configurando FFmpeg"
./configure "${CONFIG_ARGS[@]}" "$@"

echo "==> Compilando FFmpeg (jobs: $JOBS)"
make -j"$JOBS" ffmpeg

case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*) EXE="ffmpeg.exe" ;;
  *) EXE="ffmpeg" ;;
esac

DEST="$OUT_DIR/ffmpeg-ndi"
if [ "$EXE" = "ffmpeg.exe" ]; then
  DEST="$DEST.exe"
fi
cp "$FFMPEG_DIR/$EXE" "$DEST"

echo "==> Verificando libndi_newtek"
if [ "$(uname -s)" = "Darwin" ]; then
  NDI_DEVICES="$(DYLD_LIBRARY_PATH="$NDI_LIB:${DYLD_LIBRARY_PATH:-}" "$DEST" -hide_banner -devices 2>&1 || true)"
else
  NDI_DEVICES="$(LD_LIBRARY_PATH="$NDI_LIB:${LD_LIBRARY_PATH:-}" "$DEST" -hide_banner -devices 2>&1 || true)"
fi
if ! printf '%s' "$NDI_DEVICES" | grep -q 'libndi_newtek'; then
  echo "El binario se compiló pero no lista el device libndi_newtek." >&2
  printf '%s\n' "$NDI_DEVICES" >&2
  exit 1
fi

echo
echo "Listo: $DEST"
echo "NDI_INCLUDE=$NDI_INCLUDE"
echo "NDI_LIB=$NDI_LIB"
