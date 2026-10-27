#!/usr/bin/env bash
# OmniCaster en modo quiosco: convierte un Debian 12 / Ubuntu 22.04-24.04
# recién instalado (sin escritorio) en un equipo que arranca directamente en
# OmniCaster y no abre nada más.
#
# Uso (como root):
#   curl -fsSL https://raw.githubusercontent.com/matiormx/radio-automation-software/main/scripts/linux/instalar-quiosco.sh -o instalar-quiosco.sh
#   sudo bash instalar-quiosco.sh
#
# Opciones (variables de entorno):
#   KIOSK_USER=radio            usuario que arranca solo (se crea si no existe)
#   MIRADIO_APPIMAGE=/ruta.AppImage   usar este AppImage en vez de descargarlo
#   CABLES=4                    cables de audio virtuales (8 canales cada uno)
#   PLUGINS="lsp airwindows dragonfly"   plugins VST3 que OmniCaster instala al
#                               primer arranque ("" = ninguno; ver Ajustes › Plugins VST)
#
# Salidas de emergencia para el técnico:
#   Ctrl+Alt+T  terminal          Ctrl+Alt+F2  consola de texto (login normal)
#   Ctrl+Alt+R  reiniciar OmniCaster
# Para quitar el arranque automático: sudo rm /etc/systemd/system/getty@tty1.service.d/miradio-autologin.conf

set -euo pipefail

KIOSK_USER="${KIOSK_USER:-radio}"
CABLES="${CABLES:-4}"
PLUGINS="${PLUGINS-lsp airwindows dragonfly}"
REPO="matiormx/radio-automation-software"
APP_DIR="/opt/miradio"
APP="$APP_DIR/OmniCaster.AppImage"

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
  xserver-xorg xinit x11-xserver-utils xterm openbox picom dbus-x11 dbus-user-session \
  pipewire pipewire-alsa pipewire-pulse wireplumber alsa-utils \
  ffmpeg v4l-utils "$FUSE" curl jq ca-certificates \
  x11vnc wireguard-tools iproute2 samba \
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

say "OmniCaster (AppImage en $APP_DIR, se actualiza sola)"
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
# El actualizador de OmniCaster sustituye este archivo: el usuario debe poder escribir aquí.
chown -R "$KIOSK_USER:$KIOSK_USER" "$APP_DIR"

say "Cables de audio virtuales ($CABLES, de 8 canales)"
mkdir -p /etc/pipewire/pipewire.conf.d /etc/alsa/conf.d
{
  echo "# OmniCaster: salida por defecto muda y cables virtuales de 8 canales."
  echo "# Cada cable: lo que se manda a «miradio_cableN_in» sale por «miradio_cableN_out»."
  # Salida por defecto que no suena: el audio interno del WebView (que en el
  # motor nativo no debe oírse por su cuenta) va aquí y no se cuela en un cable.
  cat <<'EOF'
context.objects = [
  { factory = adapter
    args = {
      factory.name     = support.null-audio-sink
      node.name        = "miradio_silencio"
      node.description = "OmniCaster (silencio)"
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
      node.description = "OmniCaster Cable $i"
      audio.position   = [ FL FR FC LFE RL RR SL SR ]
      capture.props  = { node.name = "miradio_cable${i}_in"  media.class = "Audio/Sink"   node.description = "OmniCaster Cable $i" }
      playback.props = { node.name = "miradio_cable${i}_out" media.class = "Audio/Source" node.description = "OmniCaster Cable $i" node.passive = true }
    }
  }
EOF
  done
  echo "]"
} > /etc/pipewire/pipewire.conf.d/50-miradio-cables.conf
# Que OmniCaster los vea como dispositivos de sonido (por ALSA): reproducir en
# «OmniCaster Cable N» lo mete en el cable y grabar de él lo saca.
{
  for i in $(seq 1 "$CABLES"); do
    cat <<EOF
pcm.miradio_cable$i {
  type pipewire
  playback_node "miradio_cable${i}_in"
  capture_node "miradio_cable${i}_out"
  hint { show on description "OmniCaster Cable $i" }
}
EOF
  done
} > /etc/alsa/conf.d/60-miradio-cables.conf

# Las tarjetas de sonido las usa OmniCaster directamente (sin PipeWire en medio):
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
# OmniCaster los descarga e instala en su primer arranque (y los mantiene al día).
if [ -n "$PLUGINS" ]; then
  DATA_DIR="$(getent passwd "$KIOSK_USER" | cut -d: -f6)/.local/share/com.miradio.app"
  install -d -o "$KIOSK_USER" -g "$KIOSK_USER" "$(dirname "$DATA_DIR")" "$DATA_DIR"
  printf '%s\n' $PLUGINS > "$DATA_DIR/vst-preinstall"
  chown "$KIOSK_USER:$KIOSK_USER" "$DATA_DIR/vst-preinstall"
fi

say "Acceso remoto: VNC, WireGuard y carpeta de música compartida (se activan en Ajustes › Acceso remoto)"
# Ayudante con las únicas acciones de sistema que OmniCaster puede pedir
# (WireGuard y Samba). El usuario del quiosco lo ejecuta con sudo sin
# contraseña, y nada más.
cat > /usr/local/bin/omnicaster-remote <<'HELPER'
#!/usr/bin/env bash
# Ayudante de OmniCaster para el acceso remoto. Solo hace estas acciones.
set -euo pipefail
KUSER="__KIOSK_USER__"
CONF=/etc/wireguard/wg0.conf
SMB_CONF=/etc/samba/omnicaster.conf
case "${1:-}" in
  wg-import)
    src="${2:?falta el archivo}"
    [ -f "$src" ] || { echo "No existe $src" >&2; exit 1; }
    if ! grep -qE '^[[:space:]]*\[Interface\]' "$src" || ! grep -qiE '^[[:space:]]*PrivateKey' "$src"; then
      echo "No parece una configuración de WireGuard (.conf con [Interface] y PrivateKey)" >&2; exit 1
    fi
    # Sin órdenes: PreUp/PostUp… se ejecutarían como administrador.
    if grep -qiE '^[[:space:]]*(PreUp|PostUp|PreDown|PostDown|SaveConfig)[[:space:]]*=' "$src"; then
      echo "La configuración trae órdenes (PostUp, PreUp…): quítalas e impórtala otra vez" >&2; exit 1
    fi
    install -d -m 700 /etc/wireguard
    install -m 600 -o root -g root "$src" "$CONF"
    systemctl enable wg-quick@wg0 >/dev/null 2>&1 || true
    systemctl restart wg-quick@wg0 ;;
  wg-up) systemctl start wg-quick@wg0 ;;
  wg-down) systemctl stop wg-quick@wg0 ;;
  wg-remove)
    systemctl disable --now wg-quick@wg0 >/dev/null 2>&1 || true
    rm -f "$CONF" ;;
  wg-status|status)
    echo "configured=$([ -f "$CONF" ] && echo 1 || echo 0)"
    if ip link show wg0 >/dev/null 2>&1; then
      echo "up=1"
      wg show wg0 dump 2>/dev/null | awk 'NR==2{print "endpoint="$3; print "handshake="$5}'
    else
      echo "up=0"
    fi
    echo "smb_installed=$(command -v smbd >/dev/null 2>&1 && echo 1 || echo 0)"
    if [ -f "$SMB_CONF" ] && grep -q '^\[Musica\]' "$SMB_CONF" && systemctl is-active --quiet smbd; then
      echo "smb_enabled=1"
      sed -n 's/^[[:space:]]*path = //p' "$SMB_CONF" | head -n1 | sed 's/^/smb_path=/'
    else
      echo "smb_enabled=0"
    fi ;;
  smb-password)
    IFS= read -r pass
    [ "${#pass}" -ge 6 ] || { echo "La contraseña debe tener al menos 6 caracteres" >&2; exit 1; }
    printf '%s\n%s\n' "$pass" "$pass" | smbpasswd -s -a "$KUSER" >/dev/null
    smbpasswd -e "$KUSER" >/dev/null ;;
  smb-enable)
    dir="${2:?falta la carpeta}"
    real="$(realpath -e "$dir")"
    home="$(getent passwd "$KUSER" | cut -d: -f6)"
    case "$real" in
      "$home"/*|/srv/*|/media/*|/mnt/*) ;;
      *) echo "Solo se comparten carpetas del usuario, /srv, /media o /mnt" >&2; exit 1 ;;
    esac
    if ! pdbedit -L 2>/dev/null | grep -q "^$KUSER:"; then
      echo "Pon primero una contraseña para la carpeta compartida" >&2; exit 1
    fi
    cat > "$SMB_CONF" <<EOF
[Musica]
   path = $real
   valid users = $KUSER
   force user = $KUSER
   read only = no
   browseable = yes
   create mask = 0664
   directory mask = 0775
EOF
    grep -q "include = $SMB_CONF" /etc/samba/smb.conf || printf '\n[global]\n   include = %s\n' "$SMB_CONF" >> /etc/samba/smb.conf
    systemctl enable smbd >/dev/null 2>&1 || true
    systemctl restart smbd ;;
  smb-disable)
    : > "$SMB_CONF"
    systemctl restart smbd 2>/dev/null || true ;;
  *) echo "Uso: omnicaster-remote wg-import|wg-up|wg-down|wg-remove|status|smb-password|smb-enable|smb-disable" >&2; exit 2 ;;
esac
HELPER
sed -i "s/__KIOSK_USER__/$KIOSK_USER/" /usr/local/bin/omnicaster-remote
chmod 755 /usr/local/bin/omnicaster-remote
echo "$KIOSK_USER ALL=(root) NOPASSWD: /usr/local/bin/omnicaster-remote" > /etc/sudoers.d/omnicaster
chmod 440 /etc/sudoers.d/omnicaster
visudo -cf /etc/sudoers.d/omnicaster >/dev/null || { rm -f /etc/sudoers.d/omnicaster; die "No se pudo preparar el permiso del ayudante (sudoers)"; }
# Samba instalado pero sin compartir nada hasta que se active en Ajustes.
touch /etc/samba/omnicaster.conf
systemctl disable --now nmbd >/dev/null 2>&1 || true

say "Arranque automático en OmniCaster"
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

# OmniCaster se vuelve a abrir si se cierra o se cuelga
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
# Compositor: deja capturar las ventanas de OmniCaster aunque estén tapadas
picom --backend xrender &
~/.local/bin/miradio-quiosco &
EOF

# Openbox sin menú de escritorio y con atajos para el técnico
cp /etc/xdg/openbox/rc.xml "$HOME_DIR/.config/openbox/rc.xml"
sed -i '/<menu>root-menu<\/menu>/d; /<menu>client-list-combined-menu<\/menu>/d' "$HOME_DIR/.config/openbox/rc.xml"
sed -i 's|<keyboard>|<keyboard>\
    <keybind key="C-A-t"><action name="Execute"><command>xterm</command></action></keybind>\
    <keybind key="C-A-r"><action name="Execute"><command>pkill -f OmniCaster.AppImage</command></action></keybind>|' \
  "$HOME_DIR/.config/openbox/rc.xml"

chown -R "$KIOSK_USER:$KIOSK_USER" "$HOME_DIR/.config" "$HOME_DIR/.local" "$HOME_DIR/.bash_profile" "$HOME_DIR/.xinitrc"

say "Listo"
cat <<EOF
Reinicia el equipo (sudo reboot): arrancará directamente en OmniCaster.

  Ctrl+Alt+T   terminal para el técnico
  Ctrl+Alt+R   reiniciar OmniCaster
  Ctrl+Alt+F2  consola de texto (vuelve con Ctrl+Alt+F1)

Audio: las tarjetas aparecen en la mesa con su nombre (hw:…) y hay $CABLES
cables virtuales «OmniCaster Cable N» de 8 canales.

Acceso remoto (VNC, WireGuard y la carpeta de música por la red): se activa
en OmniCaster › Ajustes › Acceso remoto.
EOF
