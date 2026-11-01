import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
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
    // Versión publicada solo para el otro sistema (p. ej. solo Linux): para
    // este equipo no hay nada nuevo.
    if (/platform.*not found|not found.*platform/i.test(error instanceof Error ? error.message : String(error))) {
      return { current, latest: current, available: false, notes: "" };
    }
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
 * instalador cierra la app y la vuelve a abrir al terminar; si falla, se
 * avisa en vez de relanzar a ciegas (para no tragarse el motivo).
 */
export async function installUpdate(
  onProgress?: (downloaded: number, total: number | null) => void,
): Promise<void> {
  if (!pending) {
    throw new Error("Busca actualizaciones antes de instalar");
  }
  // Todo lo hace OmniCaster (Rust): descarga, comprueba la firma, para el
  // sonido, lanza el instalador y se cierra al instante. Si vuelve, es error.
  const off = await listen<[number, number | null]>("update://progress", (e) => onProgress?.(e.payload[0], e.payload[1]));
  try {
    await invoke("update_install_now");
  } catch (error) {
    pending = null;
    throw new Error(error instanceof Error ? error.message : String(error));
  } finally {
    off();
  }
  pending = null;
}
