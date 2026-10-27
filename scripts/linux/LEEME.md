# OmniCaster en Linux (modo quiosco)

El equipo arranca directamente en OmniCaster: sin escritorio, sin barra de
tareas y sin nada más. Si OmniCaster se cierra o se cuelga, se vuelve a abrir.

## Instalación

1. Instala **Debian 12** o **Ubuntu Server 22.04/24.04** *sin escritorio*
   (solo «servidor SSH» y «utilidades estándar»).
2. Entra como administrador y ejecuta:

   ```bash
   curl -fsSL https://raw.githubusercontent.com/matiormx/radio-automation-software/main/scripts/linux/instalar-quiosco.sh -o instalar-quiosco.sh
   sudo bash instalar-quiosco.sh
   ```

3. Reinicia (`sudo reboot`). Arranca solo en OmniCaster con el usuario `radio`.

En el primer arranque OmniCaster instala de serie LSP Plugins, Airwindows y
Dragonfly Reverb (y los mantiene al día; más en Ajustes › Plugins VST).

Opciones: `sudo KIOSK_USER=estudio CABLES=6 PLUGINS="lsp dragonfly" bash instalar-quiosco.sh`, o
`MIRADIO_APPIMAGE=/ruta/OmniCaster.AppImage` para instalar un AppImage concreto.

## Para el técnico

| Atajo | Qué hace |
|---|---|
| Ctrl+Alt+T | Terminal |
| Ctrl+Alt+R | Reiniciar OmniCaster |
| Ctrl+Alt+F2 | Consola de texto (vuelve con Ctrl+Alt+F1) |

Registro de OmniCaster: `~radio/miradio.log`. Quitar el arranque automático:
`sudo rm /etc/systemd/system/getty@tty1.service.d/miradio-autologin.conf`.

## Audio

- **Tarjetas de sonido**: OmniCaster las usa directamente (aparecen como
  `hw:…`), con todos sus canales y la menor latencia.
- **Cables virtuales** (en lugar de VB-Matrix/Voicemeeter): «OmniCaster Cable 1…N»,
  de 8 canales. Lo que una salida de la mesa manda a un cable se recoge como
  entrada eligiendo ese mismo cable.
- Usa el **motor nativo** de audio (Ajustes › Sonido › Motor).

## Diferencias con Windows

- Plugins VST3: solo los que tienen versión para Linux.
- La pantalla de emisión y «Lo que está sonando» se capturan con X11; el
  compositor (picom) que instala el script permite capturarlas aunque estén
  tapadas u ocultas.
- FFmpeg viene del sistema (se actualiza con `apt`).
- NDI: instala el NDI Runtime para Linux si lo usas.

## Acceso remoto

El instalador deja preparados (apagados) tres servicios que se manejan desde
OmniCaster › Ajustes › **Acceso remoto**, sin terminal:

- **VNC** (x11vnc): ver y manejar la pantalla del equipo desde otro ordenador.
  Con contraseña; opcionalmente, solo a través de WireGuard.
- **WireGuard**: se importa el `.conf` que da el servidor (sin órdenes
  PostUp/PreUp, por seguridad) y se conecta o desconecta desde ahí.
- **Samba**: comparte la carpeta de música como `\\IP\Musica` (usuario del
  quiosco y la contraseña que se ponga ahí).

Las acciones de sistema las hace `/usr/local/bin/omnicaster-remote`, el único
programa que el usuario del quiosco puede ejecutar como administrador.
