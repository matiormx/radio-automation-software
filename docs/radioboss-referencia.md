# Formato de referencia de RadioBOSS 7.2

Capturado el 22-10-2026 de la instalación real (`rb-direct.ngradio.es`) usando solo
acciones de lectura. Es lo que MiRadio reproduce. Sin claves ni letras completas.

## Reglas generales

- Cabecera `<?xml version="1.0" encoding="utf-8"?>`, líneas con CRLF y CRLF final.
- Etiquetas vacías con espacio antes del cierre: `<Player version="7.2.2.0" uptime="721259" />`.
- Saltos de línea dentro de atributos: `&#13;&#10;` (letras, PlayedHistory).
- XML: `Content-Type: text/xml; charset=UTF-8`. Texto (errores, `OK`, `0`/`1`):
  `text/html; charset=UTF-8`.
- Errores: `401 E001: Wrong password`, `400 E003: Nothing to do` (sin `action`),
  `400 E005: Unknown action`.
- Fechas `YYYY-MM-DD HH:MM:SS` (hora local). Duraciones `mm:ss` o `h:mm:ss`.

## Ficha de pista (`TRACK`)

Atributos comunes, en este orden (tras `DURATION` hay **dos** espacios):

`ARTIST TITLE ALBUM YEAR GENRE COMMENT FILENAME DURATION PLAYCOUNT LASTPLAYED INTRO OUTRO LANGUAGE RATING BPM TAGS PUBLISHER ALBUMARTIST COMPOSER COPYRIGHT TRACKNUMBER F1 F2 F3 F4 F5`

- `INTRO`/`OUTRO`: segundos con dos decimales (`2.66`). `LANGUAGE`: nombre (`Español`, `English`).
- Final según la acción:
  - `playbackinfo` actual: `CASTTITLE LISTENERS LYRICS ITEMTITLE FT_IDX`
  - `playbackinfo` anterior/siguiente: `LYRICS CASTTITLE ITEMTITLE FT_IDX`
  - `trackinfo`: `LYRICS FT_IDX` · `getplaylist`: `LYRICS`
  - `getlastplayed`: `LYRICS STARTTIME CASTTITLE TRACKTITLE ARTWORKID TITLESENT FT_IDX`
- `ITEMTITLE`/`TRACKTITLE`: `Artista - Título (Año)`. `CASTTITLE` de anterior/siguiente:
  `Artista - Título - Álbum`; el de la actual es el título enviado a la emisión.

## Acciones

| Acción | Respuesta |
| --- | --- |
| `playbackinfo` | `<Info>`: `CurrentTrack`, `Playback pos len state playlistpos streams netstream playingtimeleft timestamp volume`, `Options repeat_list shuffle queuemode`, `Features scheduler`, `Streaming listeners`, `Relay On Active`, [`Overlay title file playing_file len pos`], `PrevTrack`, `NextTrack`. `playlistpos` base 1; `playingtimeleft` = ms que quedan de lista. |
| `status` | `<Status><Player version uptime /></Status>` (uptime en s) |
| `getplaylist2[&cnt=N]` | `<Playlist COUNT TS FILE>` + `TRACK STARTTIME(hh:mm:ss) CASTTITLE DURATION(con recortes) FILENAME TRACKFILENAME RATING PLAYCOUNT INTRO(mm:ss) OUTRO BPM PLAYLISTINDEX(base 0) INDEX(base 1) FT_IDX(-1) ITEMTYPE(TRACK_PLAYED/TRACK) PQUEUE ARTIST TITLE ALBUM YEAR GENRE COMMENT LASTPLAYED LANGUAGE F1…F5`. `cnt` = ventana alrededor de la actual ((cnt-1)/2 antes); 0 o sin `cnt` = toda. |
| `trackinfo&pos=N` | `<Info><Track><TRACK …/></Track></Info>`; fuera de rango `<Info></Info>` |
| `getplaylist[&from&to]` | `<Playlist>` con fichas (base 1, inclusivo) |
| `getlastplayed` | `<LastPlayed>` 101 pistas, más reciente primero (incluye la que suena). `PLAYCOUNT`/`LASTPLAYED` = los de antes de esa vez. |
| `readtag&fn=…[&artwork=1]` | `<TagInfo><File FN Duration(ms) Artist Title Album Year Genre Comment BPM Rating Playcount LastPlayed Added UserField1…5 TypeIdentifier TagsList Intro Outro FadeIn FadeOut Mix Level Start End PlayedHistory Artwork_Base64 HookIn HookOut /></TagInfo>`. Puntos en ms (`-1` = sin marcar), `Level` en dB con coma (`-0,7`). Archivo inexistente: misma ficha vacía. |
| `trackartwork` / `nexttrackartwork` / `prevtrackartwork` | bytes de la imagen; sin carátula: vacío |
| `encoderstatus` | `<Encoders><Encoder index status(active/idle/off) error name listeners /></Encoders>` |
| `getencoder&id=N` | `<Encoder Server Password Public Format Bitrate Encoding SampleRate Channels StatPassword DisplayName Enabled UseStatsRelay RelayAddress RelayType RelayMount RelaySSL ></Encoder>` |
| `songrequestlist` | `<SongRequest></SongRequest>` |
| `mic`, `streamarchivestatus` | `0` / `1` |
| `generalinfo`, `getlog`, `schedulecontrol` | en 7.2: `E005: Unknown action` |
