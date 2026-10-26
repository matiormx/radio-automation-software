#!/usr/bin/env bash
# MiRadio en modo quiosco: convierte un Debian 12 / Ubuntu 22.04-24.04
# recién instalado (sin escritorio) en un equipo que arranca directamente en
# MiRadio y no abre nada más.
#
# Uso (como root):
#   curl -fsSL https://raw.githubusercontent.com/matiormx/radio-automation-software/main/scripts/linux/instalar-quiosco.sh -o instalar-quiosco.sh
#   sudo bash instalar-quiosco.sh
#
# Opciones (variables de entorno):
#   KIOSK_USER=radio            usuario que arranca solo (se crea si no existe)
#   MIRADIO_APPIMAGE=/ruta.AppImage   usar este AppImage en vez de descargarlo
#   CABLES=4                    cables de audio virtuales (8 canales cada uno)
#   PLUGINS="lsp airwindows dragonfly"   plugins VST3 que MiRadio instala al
#                               primer arranque ("" = ninguno; ver Ajustes › Plugins VST)
#
# Salidas de emergencia para el técnico:
#   Ctrl+Alt+T  terminal          Ctrl+Alt+F2  consola de texto (login normal)
#   Ctrl+Alt+R  reiniciar MiRadio
# Para quitar el arranque automático: sudo rm /etc/systemd/system/getty@tty1.service.d/miradio-autologin.conf

set -euo pipefail

KIOSK_USER="${KIOSK_USER:-radio}"
CABLES="${CABLES:-4}"
PLUGINS="${PLUGINS-lsp airwindows dragonfly}"
REPO="matiormx/radio-automation-software"
APP_DIR="/opt/miradio"
APP="$APP_DIR/MiRadio.AppImage"

say() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
die() { printf '\n\033[1;31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "Ejecútalo como root (sudo bash $0)"
command -v apt-get >/dev/null || die "Este script es para Debian/Ubuntu (apt)"

say "Paquetes del sistema (pantalla mínima, audio, códecs, FFmpeg)"
export DEBIAN_FRONTEND=noninteractive
apt-get update
# libfuse2 se llama libfuse2t64 en Ubuntu 24.04
FUSE=libfuse2
apt-cache show libfuse2t64 >/dev/null 2>&1 && FUSE=libfuse2t64
apt-get install -y --no-install-recommends \
  xserver-xorg xinit x11-xserver-utils xterm openbox picom dbus-x11 \
  pipewire pipewire-alsa pipewire-pulse wireplumber alsa-utils \
  ffmpeg v4l-utils "$FUSE" curl jq ca-certificates \
  gstreamer1.0-plugins-base gstreamer1.0-plugins-good gstreamer1.0-plugins-bad \
  gstreamer1.0-plugins-ugly gstreamer1.0-libav \
  fonts-dejavu fonts-noto-color-emoji libwebkit2gtk-4.1-0 libgtk-3-0

say "Usuario del quiosco: $KIOSK_USER"
if ! id "$KIOSK_USER" >/dev/null 2>&1; then
  useradd -m -s /bin/bash "$KIOSK_USER"
  echo "Pon una contraseña al usuario $KIOSK_USER (para entrar por consola):"
  passwd "$KIOSK_USER" || true
fi
for g in audio video input render plugdev; do
  getent group "$g" >/dev/null && usermod -aG "$g" "$KIOSK_USER"
done
HOME_DIR=$(getent passwd "$KIOSK_USER" | cut -d: -f6)

say "MiRadio (AppImage en $APP_DIR, se actualiza sola)"
mkdir -p "$APP_DIR"
if [ -n "${MIRADIO_APPIMAGE:-}" ]; then
  cp "$MIRADIO_APPIMAGE" "$APP"
else
  url=$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" \
    | jq -r '.assets[] | select(.name | endswith(".AppImage")) | .browser_download_url' | head -n1)
  [ -n "$url" ] && [ "$url" != "null" ] || die "No encontré el AppImage en la última versión publicada. Descárgalo a mano y usa MIRADIO_APPIMAGE=/ruta"
  curl -fL "$url" -o "$APP.part"
  mv "$APP.part" "$APP"
fi
chmod +x "$APP"
# El actualizador de MiRadio sustituye este archivo: el usuario debe poder escribir aquí.
chown -R "$KIOSK_USER:$KIOSK_USER" "$APP_DIR"

say "Cables de audio virtuales ($CABLES, de 8 canales)"
mkdir -p /etc/pipewire/pipewire.conf.d /etc/alsa/conf.d
{
  echo "# MiRadio: salida por defecto muda y cables virtuales de 8 canales."
  echo "# Cada cable: lo que se manda a «miradio_cableN_in» sale por «miradio_cableN_out»."
  # Salida por defecto que no suena: el audio interno del WebView (que en el
  # motor nativo no debe oírse por su cuenta) va aquí y no se cuela en un cable.
  cat <<'EOF'
context.objects = [
  { factory = adapter
    args = {
      factory.name     = support.null-audio-sink
      node.name        = "miradio_silencio"
      node.description = "MiRadio (silencio)"
      media.class      = "Audio/Sink"
      audio.position   = [ FL FR ]
      priority.session = 2000
      priority.driver  = 2000
      object.linger    = true
    }
  }
]
context.modules = [
EOF
  for i in $(seq 1 "$CABLES"); do
    cat <<EOF
  { name = libpipewire-module-loopback
    args = {
      node.description = "MiRadio Cable $i"
      audio.position   = [ FL FR FC LFE RL RR SL SR ]
      capture.props  = { node.name = "miradio_cable${i}_in"  media.class = "Audio/Sink"   node.description = "MiRadio Cable $i" }
      playback.props = { node.name = "miradio_cable${i}_out" media.class = "Audio/Source" node.description = "MiRadio Cable $i" node.passive = true }
    }
  }
EOF
  done
  echo "]"
} > /etc/pipewire/pipewire.conf.d/50-miradio-cables.conf
# Que MiRadio los vea como dispositivos de sonido (por ALSA): reproducir en
# «MiRadio Cable N» lo mete en el cable y grabar de él lo saca.
{
  for i in $(seq 1 "$CABLES"); do
    cat <<EOF
pcm.miradio_cable$i {
  type pipewire
  playback_node "miradio_cable${i}_in"
  capture_node "miradio_cable${i}_out"
  hint { show on description "MiRadio Cable $i" }
}
EOF
  done
} > /etc/alsa/conf.d/60-miradio-cables.conf

# Las tarjetas de sonido las usa MiRadio directamente (sin PipeWire en medio):
# menos latencia y acceso a todos sus canales. PipeWire solo lleva los cables.
mkdir -p /etc/wireplumber/main.lua.d /etc/wireplumber/wireplumber.conf.d
echo 'alsa_monitor.enabled = false' > /etc/wireplumber/main.lua.d/51-miradio.lua
cat > /etc/wireplumber/wireplumber.conf.d/51-miradio.conf <<'EOF'
wireplumber.profiles = {
  main = {
    monitor.alsa = disabled
  }
}
EOF

say "Plugins VST3 de serie: ${PLUGINS:-ninguno}"
# MiRadio los descarga e instala en su primer arranque (y los mantiene al día).
if [ -n "$PLUGINS" ]; then
  DATA_DIR="$(getent passwd "$KIOSK_USER" | cut -d: -f6)/.local/share/com.miradio.app"
  install -d -o "$KIOSK_USER" -g "$KIOSK_USER" "$(dirname "$DATA_DIR")" "$DATA_DIR"
  printf '%s\n' $PLUGINS > "$DATA_DIR/vst-preinstall"
  chown "$KIOSK_USER:$KIOSK_USER" "$DATA_DIR/vst-preinstall"
fi

say "Arranque automático en MiRadio"
mkdir -p /etc/systemd/system/getty@tty1.service.d
cat > /etc/systemd/system/getty@tty1.service.d/miradio-autologin.conf <<EOF
[Service]
ExecStart=
ExecStart=-/sbin/agetty --autologin $KIOSK_USER --noclear %I \$TERM
EOF
systemctl daemon-reload
systemctl set-default multi-user.target >/dev/null

install -d -o "$KIOSK_USER" -g "$KIOSK_USER" "$HOME_DIR/.config/openbox" "$HOME_DIR/.local/bin"

# Al entrar en tty1 se abre la pantalla gráfica
cat > "$HOME_DIR/.bash_profile" <<'EOF'
[ -f ~/.bashrc ] && . ~/.bashrc
if [ -z "${DISPLAY:-}" ] && [ "$(tty)" = /dev/tty1 ]; then
  exec startx -- -nolisten tcp vt1 >~/.xsession.log 2>&1
fi
EOF
echo 'exec openbox-session' > "$HOME_DIR/.xinitrc"

# MiRadio se vuelve a abrir si se cierra o se cuelga
cat > "$HOME_DIR/.local/bin/miradio-quiosco" <<EOF
#!/usr/bin/env bash
while true; do
  "$APP" >>"\$HOME/miradio.log" 2>&1
  sleep 2
done
EOF
chmod +x "$HOME_DIR/.local/bin/miradio-quiosco"

cat > "$HOME_DIR/.config/openbox/autostart" <<'EOF'
# Pantalla siempre encendida
xset s off; xset s noblank; xset -dpms
# Compositor: deja capturar las ventanas de MiRadio aunque estén tapadas
picom --backend xrender &
~/.local/bin/miradio-quiosco &
EOF

# Openbox sin menú de escritorio y con atajos para el técnico
cp /etc/xdg/openbox/rc.xml "$HOME_DIR/.config/openbox/rc.xml"
sed -i '/<menu>root-menu<\/menu>/d; /<menu>client-list-combined-menu<\/menu>/d' "$HOME_DIR/.config/openbox/rc.xml"
sed -i 's|<keyboard>|<keyboard>\
    <keybind key="C-A-t"><action name="Execute"><command>xterm</command></action></keybind>\
    <keybind key="C-A-r"><action name="Execute"><command>pkill -f MiRadio.AppImage</command></action></keybind>|' \
  "$HOME_DIR/.config/openbox/rc.xml"

chown -R "$KIOSK_USER:$KIOSK_USER" "$HOME_DIR/.config" "$HOME_DIR/.local" "$HOME_DIR/.bash_profile" "$HOME_DIR/.xinitrc"

say "Listo"
cat <<EOF
Reinicia el equipo (sudo reboot): arrancará directamente en MiRadio.

  Ctrl+Alt+T   terminal para el técnico
  Ctrl+Alt+R   reiniciar MiRadio
  Ctrl+Alt+F2  consola de texto (vuelve con Ctrl+Alt+F1)

Audio: las tarjetas aparecen en la mesa con su nombre (hw:…) y hay $CABLES
cables virtuales «MiRadio Cable N» de 8 canales.
EOF
