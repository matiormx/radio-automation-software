# MiRadio en Linux (modo quiosco)

El equipo arranca directamente en MiRadio: sin escritorio, sin barra de
tareas y sin nada más. Si MiRadio se cierra o se cuelga, se vuelve a abrir.

## Instalación

1. Instala **Debian 12** o **Ubuntu Server 22.04/24.04** *sin escritorio*
   (solo «servidor SSH» y «utilidades estándar»).
2. Entra como administrador y ejecuta:

   ```bash
   curl -fsSL https://raw.githubusercontent.com/matiormx/radio-automation-software/main/scripts/linux/instalar-quiosco.sh -o instalar-quiosco.sh
   sudo bash instalar-quiosco.sh
   ```

3. Reinicia (`sudo reboot`). Arranca solo en MiRadio con el usuario `radio`.

En el primer arranque MiRadio instala de serie LSP Plugins, Airwindows y
Dragonfly Reverb (y los mantiene al día; más en Ajustes › Plugins VST).

Opciones: `sudo KIOSK_USER=estudio CABLES=6 PLUGINS="lsp dragonfly" bash instalar-quiosco.sh`, o
`MIRADIO_APPIMAGE=/ruta/MiRadio.AppImage` para instalar un AppImage concreto.

## Para el técnico

| Atajo | Qué hace |
|---|---|
| Ctrl+Alt+T | Terminal |
| Ctrl+Alt+R | Reiniciar MiRadio |
| Ctrl+Alt+F2 | Consola de texto (vuelve con Ctrl+Alt+F1) |

Registro de MiRadio: `~radio/miradio.log`. Quitar el arranque automático:
`sudo rm /etc/systemd/system/getty@tty1.service.d/miradio-autologin.conf`.

## Audio

- **Tarjetas de sonido**: MiRadio las usa directamente (aparecen como
  `hw:…`), con todos sus canales y la menor latencia.
- **Cables virtuales** (en lugar de VB-Matrix/Voicemeeter): «MiRadio Cable 1…N»,
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
