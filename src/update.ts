import { appVersion, installAppUpdate, openExternal } from "./api";
import type { AppUpdateInfo } from "./types";

/** Origen por defecto: ultima release publicada en GitHub. */
export const DEFAULT_UPDATE_FEED =
  "https://api.github.com/repos/matiormx/radio-automation-software/releases/latest";

const FEED_KEY = "miradio.updateFeed";
const TOKEN_KEY = "miradio.updateToken";

export function loadUpdateFeed(): string {
  try {
    return window.localStorage.getItem(FEED_KEY) ?? DEFAULT_UPDATE_FEED;
  } catch {
    return DEFAULT_UPDATE_FEED;
  }
}

export function saveUpdateFeed(feed: string): void {
  try {
    window.localStorage.setItem(FEED_KEY, feed);
  } catch {
    /* sin almacenamiento */
  }
}

export function loadUpdateToken(): string {
  try {
    return window.localStorage.getItem(TOKEN_KEY) ?? "";
  } catch {
    return "";
  }
}

export function saveUpdateToken(token: string): void {
  try {
    if (token) window.localStorage.setItem(TOKEN_KEY, token);
    else window.localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* sin almacenamiento */
  }
}

/** Compara dos versiones tipo 0.4.3. Devuelve >0 si la primera es mayor. */
export function compareVersions(a: string, b: string): number {
  const parse = (value: string) =>
    value
      .trim()
      .replace(/^v/i, "")
      .split(/[.\-+]/)
      .map((part) => Number.parseInt(part, 10))
      .map((part) => (Number.isFinite(part) ? part : 0));
  const left = parse(a);
  const right = parse(b);
  const size = Math.max(left.length, right.length);
  for (let i = 0; i < size; i += 1) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}

interface GithubAsset {
  name?: string;
  browser_download_url?: string;
}

interface GithubRelease {
  tag_name?: string;
  body?: string;
  html_url?: string;
  assets?: GithubAsset[];
}

interface UpdateManifest {
  version?: string;
  url?: string;
  notes?: string;
  page?: string;
}

function pickAsset(assets: GithubAsset[]): GithubAsset | undefined {
  const list = assets ?? [];
  return (
    list.find((asset) => /-setup\.exe$/i.test(asset.name ?? "")) ??
    list.find((asset) => /\.exe$/i.test(asset.name ?? "")) ??
    list.find((asset) => /\.msi$/i.test(asset.name ?? "")) ??
    list.find((asset) => /\.zip$/i.test(asset.name ?? ""))
  );
}

/**
 * Busca una version nueva en el origen indicado. Admite la respuesta de la
 * API de GitHub (release) o un manifiesto propio { version, url }.
 */
export async function checkForUpdate(feed: string, token: string): Promise<AppUpdateInfo> {
  const current = await appVersion();
  const url = feed.trim() || DEFAULT_UPDATE_FEED;
  let response: Response;
  try {
    response = await fetch(url, {
      headers: {
        Accept: "application/vnd.github+json",
        ...(token.trim() ? { Authorization: `Bearer ${token.trim()}` } : {}),
      },
    });
  } catch (error) {
    throw new Error(`No se pudo contactar con el servidor de actualizaciones: ${String(error)}`);
  }
  if (response.status === 404) {
    throw new Error("Todavía no hay ninguna versión publicada en ese origen");
  }
  if (!response.ok) {
    throw new Error(`El servidor de actualizaciones respondió ${response.status}`);
  }

  let data: GithubRelease & UpdateManifest;
  try {
    data = (await response.json()) as GithubRelease & UpdateManifest;
  } catch {
    throw new Error("La respuesta del origen de actualizaciones no es válida");
  }

  let latest = "";
  let notes = "";
  let assetUrl = "";
  let assetName = "";
  let pageUrl = "";

  if (typeof data.tag_name === "string" && data.tag_name.trim()) {
    latest = data.tag_name.trim();
    notes = (data.body ?? "").trim();
    pageUrl = (data.html_url ?? "").trim();
    const asset = pickAsset(data.assets ?? []);
    if (asset) {
      assetUrl = (asset.browser_download_url ?? "").trim();
      assetName = (asset.name ?? "").trim();
    }
  } else if (typeof data.version === "string" && typeof data.url === "string") {
    latest = data.version.trim();
    notes = (data.notes ?? "").trim();
    assetUrl = data.url.trim();
    pageUrl = (data.page ?? "").trim();
    assetName = assetUrl.split("/").pop() ?? "";
  } else {
    throw new Error("El origen de actualizaciones no tiene un formato reconocido");
  }

  if (!latest) {
    throw new Error("El origen de actualizaciones no indica la versión");
  }

  return {
    current,
    latest: latest.replace(/^v/i, ""),
    available: compareVersions(latest, current) > 0,
    notes,
    assetUrl,
    assetName,
    pageUrl,
    error: null,
  };
}

/** Descarga el instalador y lo abre. */
export async function installUpdate(info: AppUpdateInfo): Promise<string> {
  if (!info.assetUrl) {
    throw new Error("Esta versión no trae instalador; ábrela desde la página de la release");
  }
  const result = await installAppUpdate(info.assetUrl, info.latest);
  return result.path;
}

/** Abre la pagina de la release en el navegador. */
export async function openRelease(info: AppUpdateInfo): Promise<void> {
  const url = info.pageUrl || info.assetUrl;
  if (!url) throw new Error("No hay ninguna pagina de descarga");
  await openExternal(url);
}
