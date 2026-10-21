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

/** Nombre de la imagen que se escribe junto al archivo de texto. */
export const NOW_PLAYING_IMAGE_NAME = "nowplaying.jpg";

/** Carpeta del archivo .txt (o "" si no hay ruta). */
export function nowPlayingFolder(txtPath: string): string {
  const clean = txtPath.trim();
  if (!clean) return "";
  const slash = Math.max(clean.lastIndexOf("\\"), clean.lastIndexOf("/"));
  return slash >= 0 ? clean.slice(0, slash + 1) : "";
}

/** Ruta de la portada: en la misma carpeta que el .txt. */
export function nowPlayingImagePath(txtPath: string): string {
  const clean = txtPath.trim();
  if (!clean) return "";
  return `${nowPlayingFolder(clean)}${NOW_PLAYING_IMAGE_NAME}`;
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result ?? "");
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(new Error("No se pudo leer la imagen"));
    reader.readAsDataURL(blob);
  });
}

export interface CoverFallback {
  title: string;
  artist: string;
  radio: string;
}

/**
 * Convierte la portada de la cancion en un JPEG cuadrado y lo devuelve en
 * base64. Si la cancion no tiene portada, genera una con el titulo.
 */
export async function buildCoverJpeg(
  coverUrl: string,
  fallback: CoverFallback,
  size = 600,
): Promise<string> {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Este equipo no puede preparar la imagen");
  ctx.fillStyle = "#141a26";
  ctx.fillRect(0, 0, size, size);

  let drew = false;
  if (coverUrl) {
    try {
      const response = await fetch(coverUrl);
      if (response.ok) {
        const blob = await response.blob();
        const bitmap = await createImageBitmap(blob);
        const scale = Math.max(size / bitmap.width, size / bitmap.height);
        const width = bitmap.width * scale;
        const height = bitmap.height * scale;
        ctx.drawImage(bitmap, (size - width) / 2, (size - height) / 2, width, height);
        bitmap.close?.();
        drew = true;
      }
    } catch {
      drew = false;
    }
  }

  if (!drew) {
    ctx.fillStyle = "#1b2334";
    ctx.fillRect(0, 0, size, size);
    ctx.fillStyle = "#8fa3c8";
    ctx.font = `bold ${Math.round(size * 0.07)}px sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const lines = [fallback.title, fallback.artist].filter((line) => line.trim() !== "");
    let y = size / 2 - (lines.length - 1) * (size * 0.06);
    for (const line of lines) {
      ctx.fillText(line.slice(0, 28), size / 2, y, size * 0.86);
      y += size * 0.12;
    }
    if (lines.length === 0 && fallback.radio) {
      ctx.fillText(fallback.radio, size / 2, size / 2, size * 0.86);
    }
  }

  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, "image/jpeg", 0.9),
  );
  if (!blob) throw new Error("No se pudo generar la imagen");
  return blobToBase64(blob);
}
