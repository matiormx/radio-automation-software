import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { appVersion } from "./api";
import type { AppUpdateInfo } from "./types";

/** Pagina de descargas, por si la actualizacion automatica no se puede usar. */
export const RELEASES_PAGE =
  "https://github.com/matiormx/radio-automation-software/releases/latest";

/** Actualizacion encontrada en la ultima busqueda, lista para instalar. */
let pending: Update | null = null;

function describeError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  if (/404|valid release json|latest\.json/i.test(raw)) {
    return "Todavía no hay ninguna versión publicada con actualización automática";
  }
  if (/signature|firma|pubkey/i.test(raw)) {
    return `La firma de la actualización no es válida: ${raw}`;
  }
  return `No se pudo contactar con el servidor de actualizaciones: ${raw}`;
}

/**
 * Busca una version nueva en las releases de GitHub. La comparacion de
 * versiones y la comprobacion de la firma las hace el plugin oficial.
 */
export async function checkForUpdate(): Promise<AppUpdateInfo> {
  const current = await appVersion();
  let update: Update | null;
  try {
    update = await check();
  } catch (error) {
    pending = null;
    throw new Error(describeError(error));
  }
  pending = update;
  if (!update) {
    return { current, latest: current, available: false, notes: "" };
  }
  return {
    current,
    latest: update.version,
    available: true,
    notes: (update.body ?? "").trim(),
  };
}

/**
 * Descarga la actualizacion, la verifica y la instala. En Windows el
 * instalador cierra la app y la vuelve a abrir al terminar. Si no lo hace
 * por su cuenta, se reinicia aqui.
 */
export async function installUpdate(
  onProgress?: (downloaded: number, total: number | null) => void,
): Promise<void> {
  if (!pending) {
    throw new Error("Busca actualizaciones antes de instalar");
  }
  let downloaded = 0;
  let total: number | null = null;
  await pending.downloadAndInstall((event) => {
    if (event.event === "Started") {
      total = event.data.contentLength ?? null;
      onProgress?.(0, total);
    } else if (event.event === "Progress") {
      downloaded += event.data.chunkLength;
      onProgress?.(downloaded, total);
    } else if (event.event === "Finished") {
      onProgress?.(total ?? downloaded, total);
    }
  });
  pending = null;
  await relaunch();
}
