/** Datos que se pueden poner en el archivo "now playing". */
export interface NowPlayingFields {
  artist: string;
  title: string;
  album: string;
  year: string;
  genre: string;
  /** Duracion en m:ss */
  duration: string;
  /** Duracion en segundos */
  durationSec: string;
  /** Nombre de la radio */
  radio: string;
  /** Bloques a los que pertenece la cancion */
  block: string;
  /** Hora actual */
  time: string;
}

export const DEFAULT_NOW_PLAYING_TEMPLATE = "{artist} - {title}";

export const NOW_PLAYING_PLACEHOLDERS: { key: string; label: string }[] = [
  { key: "{artist}", label: "artista" },
  { key: "{title}", label: "titulo" },
  { key: "{album}", label: "album" },
  { key: "{year}", label: "ano" },
  { key: "{genre}", label: "genero" },
  { key: "{duration}", label: "duracion m:ss" },
  { key: "{duration_sec}", label: "duracion en segundos" },
  { key: "{radio}", label: "nombre de la radio" },
  { key: "{block}", label: "bloques de la cancion" },
  { key: "{time}", label: "hora actual" },
];

/**
 * Rellena la plantilla con los datos de la cancion. Lo que no exista se
 * deja tal cual, para que se vea que el dato no esta disponible.
 */
export function renderNowPlaying(template: string, fields: NowPlayingFields): string {
  const text = template.trim() || DEFAULT_NOW_PLAYING_TEMPLATE;
  return text.replace(/\{(\w+)\}/g, (match, key: string) => {
    const value = (fields as unknown as Record<string, string | undefined>)[key];
    return value === undefined ? match : value;
  });
}

/** Limpia los saltos de linea, que rompen el archivo de texto plano. */
export function nowPlayingLine(text: string): string {
  return text.replace(/[\r\n]+/g, " ").trim();
}
