import { emit, listen } from "@tauri-apps/api/event";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ask, message, open as nativeOpen, save as nativeSave } from "@tauri-apps/plugin-dialog";
import { pickOpen, pickSave, type PickOptions } from "./filePicker";
import type {
  Block,
  Playlist,
  PlaylistImportReport,
  Settings,
  StreamProbe,
  StreamStatus,
  NdiProbe,
  Track,
  TrackDetails,
  NotificationRule,
  TrackPatch,
  AnalysisResult,
  DeezerTrack,
  HistoryEntry,
  SessionState,
  Waveform,
  AiSuggestion,
  VideoCaptureDevice,
} from "./types";

export const VIDEO_EXTENSIONS = [
  "mp4", "m4v", "mov", "mkv", "webm", "avi", "wmv", "asf", "mpg", "mpeg", "m2v", "flv", "f4v", "3gp", "ts", "m2ts", "mts", "vob", "ogv",
];
/** Videos que se reproducen tal cual; el resto se convierte a MP4 al importar. */
export const NATIVE_VIDEO = ["mp4", "m4v", "mov", "webm"];

function extOfPath(path: string): string {
  const dot = path.lastIndexOf(".");
  return dot < 0 ? "" : path.slice(dot + 1).toLowerCase();
}

export function isVideoFile(path: string): boolean {
  return VIDEO_EXTENSIONS.includes(extOfPath(path));
}

export function needsVideoConversion(path: string): boolean {
  return isVideoFile(path) && !NATIVE_VIDEO.includes(extOfPath(path));
}

export interface ConvertedVideo {
  source: string;
  output: string | null;
  error: string | null;
}

export function convertVideos(paths: string[]): Promise<ConvertedVideo[]> {
  return invoke<ConvertedVideo[]>("convert_videos", { paths });
}

export const AUDIO_EXTENSIONS = [
  "mp3", "wav", "flac", "ogg", "oga", "opus", "m4a", "aac", "aif", "aiff", "wma", "webm",
];

export function listTracks(): Promise<Track[]> {
  return invoke<Track[]>("list_tracks");
}

export function importFiles(paths: string[], library: "a" | "b" = "a"): Promise<Track[]> {
  return invoke<Track[]>("import_files", { paths, library });
}

/** Importa sin duplicar; con `blockId`, todas quedan en ese bloque. */
export function importFilesDedup(
  paths: string[],
  library: "a" | "b" = "a",
  blockId: string | null = null,
  /** Catalogar en su sitio (sin copiar a la carpeta de música) */
  inPlace = false,
): Promise<{ added: number; existing: number; ids: string[] }> {
  return invoke("import_files_dedup", { paths, library, blockId, inPlace });
}

export function deezerSearch(query: string): Promise<DeezerTrack[]> {
  return invoke<DeezerTrack[]>("deezer_search", { query });
}

export function deezerTrack(id: number): Promise<DeezerTrack> {
  return invoke<DeezerTrack>("deezer_track", { id });
}

/** Escanea una carpeta o disco (con subcarpetas) y cataloga sin copiar. */
export function scanFolder(path: string): Promise<number> {
  return invoke<number>("scan_folder", { path });
}

export function backfillQuality(): Promise<number> {
  return invoke<number>("backfill_quality");
}

export async function pickScanFolder(): Promise<string | null> {
  const p = await openDialog({ directory: true, multiple: false, title: "Carpeta o disco que escanear" });
  return typeof p === "string" ? p : null;
}

export function scanMusicFolder(): Promise<number> {
  return invoke<number>("scan_music_folder");
}

export function updateTrack(id: string, patch: TrackPatch): Promise<void> {
  return invoke("update_track", { id, patch });
}

export function aiModels(url: string): Promise<string[]> {
  return invoke<string[]>("ai_models", { url });
}

export function aiSuggestMetadata(
  id: string,
  url: string,
  model: string,
  styles: string[],
): Promise<AiSuggestion> {
  return invoke<AiSuggestion>("ai_suggest_metadata", { id, url, model, styles });
}

export function notifyFire(event: string, vars: Record<string, string>): Promise<void> {
  return invoke("notify_fire", { event, vars });
}

export function notifyTest(notification: NotificationRule): Promise<string> {
  return invoke<string>("notify_test", { notification });
}

export function setTracksLanguage(ids: string[], language: string): Promise<number> {
  return invoke<number>("set_tracks_language", { ids, language });
}

/** Cambia la caratula (imagen local o URL); vale para todo el album. */
export function setTrackCover(id: string, source: string): Promise<string> {
  return invoke<string>("set_track_cover", { id, source });
}

export function clearTrackCover(id: string): Promise<void> {
  return invoke("clear_track_cover", { id });
}

export async function pickCoverImage(): Promise<string | null> {
  return openDialog({
    multiple: false,
    title: "Carátula",
    filters: [{ name: "Imagen", extensions: ["jpg", "jpeg", "png", "webp", "gif", "bmp"] }],
  });
}

export function setTracksLibrary(ids: string[], library: "a" | "b"): Promise<number> {
  return invoke<number>("set_track_library", { ids, library });
}

export function analyzeTrack(
  id: string,
  targetLufs: number,
  truePeakDb: number,
): Promise<AnalysisResult> {
  return invoke<AnalysisResult>("analyze_track", { id, targetLufs, truePeakDb });
}

export function getTrackWaveform(id: string, buckets = 900): Promise<Waveform> {
  return invoke<Waveform>("track_waveform", { id, buckets });
}

export function saveTrackTrim(id: string, start: number, end: number): Promise<void> {
  return invoke("save_track_trim", { id, start, end });
}

export function saveTrackMarkers(
  id: string,
  introPoint: number,
  mixPoint: number,
  fadeOutStart: number,
): Promise<void> {
  return invoke("save_track_markers", { id, introPoint, mixPoint, fadeOutStart });
}

export function autoTrackTrim(id: string): Promise<void> {
  return invoke("auto_track_trim", { id });
}

export function backfillCovers(): Promise<number> {
  return invoke<number>("backfill_covers");
}

export function getTrackDetails(id: string): Promise<TrackDetails> {
  return invoke<TrackDetails>("track_details", { id });
}

export function relinkTrack(id: string, newPath: string): Promise<void> {
  return invoke("relink_track", { id, newPath });
}

export function deleteTrack(id: string): Promise<void> {
  return invoke("delete_track", { id });
}

export function listBlocks(): Promise<Block[]> {
  return invoke<Block[]>("list_blocks");
}

export function createBlock(name: string): Promise<Block> {
  return invoke<Block>("create_block", { name });
}

export function renameBlock(id: string, name: string): Promise<void> {
  return invoke("rename_block", { id, name });
}

export function deleteBlock(id: string): Promise<void> {
  return invoke("delete_block", { id });
}

export function setTrackBlocks(id: string, blockIds: string[]): Promise<void> {
  return invoke("set_track_blocks", { id, blockIds });
}

/**
 * Importa una lista .m3u/.m3u8 a un bloque musical.
 * blockId: bloque existente; si es null se usa/crea `blockName`
 * (o el nombre del archivo de la lista). copyFiles: false enlaza los
 * archivos en su sitio, true los copia a la carpeta de música.
 */
export function importPlaylist(
  path: string,
  blockId: string | null,
  blockName: string | null,
  copyFiles: boolean,
): Promise<PlaylistImportReport> {
  return invoke<PlaylistImportReport>("import_playlist", {
    path,
    blockId,
    blockName,
    copyFiles,
  });
}

export async function pickPlaylistFile(): Promise<string | null> {
  return openDialog({
    multiple: false,
    title: "Importar lista de reproducción a un bloque",
    filters: [{ name: "Listas M3U", extensions: ["m3u", "m3u8"] }],
  });
}

export function listPlaylists(): Promise<Playlist[]> {
  return invoke<Playlist[]>("list_playlists");
}

export function savePlaylist(playlist: Playlist): Promise<void> {
  return invoke("save_playlist", { playlist });
}

export function deletePlaylist(id: string): Promise<void> {
  return invoke("delete_playlist", { id });
}

export function getSettings(): Promise<Settings> {
  return invoke<Settings>("get_settings");
}

export function saveSettings(settings: Settings): Promise<void> {
  return invoke("save_settings", { settings });
}

export function setBrandingLogo(path: string | null): Promise<string> {
  return invoke<string>("set_branding_logo", { path });
}

export function importProgramCover(path: string): Promise<string> {
  return invoke<string>("import_program_cover", { path });
}

export function deleteProgramCover(path: string): Promise<void> {
  return invoke("delete_program_cover", { path });
}

export function writeNowPlaying(path: string, contents: string): Promise<string> {
  return invoke<string>("write_now_playing", { path, contents });
}

export function writeNowPlayingImage(path: string, data: string): Promise<string> {
  return invoke<string>("write_now_playing_image", { path, data });
}

export async function pickNowPlayingFile(current: string): Promise<string | null> {
  return saveDialog({
    title: "Archivo nowplaying",
    defaultPath: current || "nowplaying.txt",
    filters: [{ name: "Texto", extensions: ["txt"] }],
  });
}

export function appVersion(): Promise<string> {
  return invoke<string>("app_version");
}

export function openExternal(url: string): Promise<void> {
  return invoke("open_url", { url });
}

export function probeStreaming(): Promise<StreamProbe> {
  return invoke<StreamProbe>("stream_probe");
}

/** Plugins VST3 instalados (carpetas estándar). */
export interface VstFound {
  name: string;
  vendor: string;
  category: string;
  path: string;
}
export interface VstScanResult {
  folders: { path: string; standard: boolean; exists: boolean; count: number }[];
  plugins: VstFound[];
}

/** Plugins VST3 del equipo: carpetas habituales y las añadidas en Ajustes. */
export function vstScan(): Promise<VstScanResult> {
  return invoke("vst_scan");
}

/** Abre la ventana del plugin de una ranura (lo carga si hace falta). */
/** Copia los ajustes guardados de un plugin a otra ranura (al copiar un FX). */
export function vstCopyState(from: string, to: string): Promise<void> {
  return invoke("vst_copy_state", { from, to });
}

export function vstEditor(slot: { id: string; path: string; name: string }): Promise<void> {
  return invoke("vst_editor", { slot: slot.id, path: slot.path, name: slot.name });
}

/** Carpeta de plugins VST3 que añadir. */
export async function pickVstFolder(): Promise<string | null> {
  const p = await openDialog({ directory: true, multiple: false, title: "Carpeta de plugins VST3" });
  return typeof p === "string" ? p : null;
}

export async function pickVstFile(): Promise<string | null> {
  const p = await openDialog({ multiple: false, title: "Plugin VST3", filters: [{ name: "VST3", extensions: ["vst3"] }] });
  return typeof p === "string" ? p : null;
}

/** NDI nativo (NDI Runtime, sin FFmpeg especial): fuentes y servidor de imagen. */
export function ndiNative(): Promise<{ available: boolean; error: string | null; sources: string[]; server: string }> {
  return invoke("ndi_native");
}

/** Pared del ratón: rectángulo (px físicos) donde queda encerrado, o null para quitarla. */
export function cursorWall(rect: [number, number, number, number] | null): Promise<void> {
  return invoke<void>("cursor_wall", { rect });
}

/** Direccion del servidor local que sirve la imagen NDI (MJPEG). */
export function ndiServer(): Promise<string> {
  return invoke<string>("ndi_server");
}

/** Direccion del servidor local de las miniaturas monitorizadas. */
export function monitorServer(): Promise<string> {
  return invoke<string>("monitor_server");
}

export function probeNdi(ffmpegPath = ""): Promise<NdiProbe> {
  return invoke<NdiProbe>("ndi_probe", { ffmpegPath });
}

/** Capturadoras de vídeo disponibles en el equipo. */
export function listVideoCaptureDevices(): Promise<VideoCaptureDevice[]> {
  return invoke<VideoCaptureDevice[]>("video_capture_devices");
}

export async function pickFfmpegFile(): Promise<string | null> {
  return openDialog({
    multiple: false,
    title: "FFmpeg con soporte NDI",
  });
}

export function getStreamStatus(): Promise<StreamStatus> {
  return invoke<StreamStatus>("stream_status");
}

export type StreamGroup = "audio" | "video" | "all" | "local";

export function startStreaming(settings: Settings, group: StreamGroup = "all"): Promise<StreamStatus> {
  return invoke<StreamStatus>("stream_start", { settings, group });
}

export function stopStreaming(group: StreamGroup = "all"): Promise<StreamStatus> {
  return invoke<StreamStatus>("stream_stop", { group });
}

export function pushStreamPcm(data: number[]): Promise<void> {
  return invoke("stream_push_pcm", { data });
}

export async function pickImageFile(): Promise<string | null> {
  return openDialog({
    multiple: false,
    title: "Logo de la emisora",
    filters: [{ name: "Imagen", extensions: ["png", "jpg", "jpeg", "webp", "gif"] }],
  });
}

export function listHistory(): Promise<HistoryEntry[]> {
  return invoke<HistoryEntry[]>("list_history");
}

export function saveSession(session: SessionState): Promise<void> {
  return invoke("save_session", { session });
}

export function loadSession(): Promise<SessionState | null> {
  return invoke<SessionState | null>("load_session");
}

export function reportStarted(trackId: string): Promise<void> {
  return invoke("report_started", { trackId });
}

export function autoPick(
  playlistTrackIds: string[],
  count: number,
  scopeKind?: "block" | "library",
  scopeId?: string,
): Promise<string[]> {
  return invoke<string[]>("auto_pick", { playlistTrackIds, count, scopeKind, scopeId });
}

export function trackUrl(track: { file: string }): string {
  // .m4v: el protocolo normal los marca como video/x-m4v y el WebView no los
  // reproduce; el protocolo «media» los sirve como MP4.
  if (/\.m4v$/i.test(track.file)) return convertFileSrc(track.file, "media");
  return convertFileSrc(track.file);
}

export async function pickAudioFiles(): Promise<string[] | null> {
  return openDialog({
    multiple: true,
    filters: [
      { name: "Audio y vídeo", extensions: [...AUDIO_EXTENSIONS, ...VIDEO_EXTENSIONS] },
      { name: "Audio", extensions: [...AUDIO_EXTENSIONS] },
      { name: "Vídeo", extensions: [...VIDEO_EXTENSIONS] },
    ],
  });
}

export async function pickFolder(): Promise<string | null> {
  return openDialog({ directory: true, title: "Carpeta de música de OmniCaster" });
}

export async function pickSingleAudioFile(): Promise<string | null> {
  return openDialog({
    multiple: false,
    filters: [
      { name: "Audio y vídeo", extensions: [...AUDIO_EXTENSIONS, ...VIDEO_EXTENSIONS] },
      { name: "Audio", extensions: [...AUDIO_EXTENSIONS] },
      { name: "Vídeo", extensions: [...VIDEO_EXTENSIONS] },
    ],
  });
}

export async function onWindowFileDrop(
  handlers: {
    onDrop?: (paths: string[], position?: { x: number; y: number }) => void;
    onEnter?: (position?: { x: number; y: number }) => void;
    onOver?: (position?: { x: number; y: number }) => void;
    onLeave?: () => void;
  },
): Promise<() => void> {
  const unlisten = await getCurrentWindow().onDragDropEvent((event) => {
    if (event.payload.type === "drop" && event.payload.paths.length > 0) {
      handlers.onDrop?.(event.payload.paths, event.payload.position);
    } else if (event.payload.type === "enter") {
      handlers.onEnter?.(event.payload.position);
    } else if (event.payload.type === "over") {
      handlers.onOver?.(event.payload.position);
    } else if (event.payload.type === "leave") {
      handlers.onLeave?.();
    }
  });
  return unlisten;
}

/**
 * Cierre de verdad de OmniCaster (la X solo minimiza). La ventana principal
 * escucha la peticion, pide confirmacion con `getMessage()` (que cambia segun
 * el estado: emitiendo, llamada al aire...) y cierra. Devuelve la funcion para
 * dejar de escuchar.
 */
/**
 * Pregunta antes de hacer algo. En el WebView de Tauri `window.confirm` no
 * espera la respuesta (devuelve una promesa, que cuenta como «sí»): se borraba
 * primero y se preguntaba después. Esto sí espera.
 */
export async function confirmAsk(message: string, okLabel = "Aceptar", title = "OmniCaster"): Promise<boolean> {
  try {
    return await ask(message, { title, kind: "warning", okLabel, cancelLabel: "Cancelar" });
  } catch {
    return false;
  }
}

/** Si la vez anterior OmniCaster se cerró mal (y con qué plugin), lo avisa una vez. */
export async function showLastCrash(): Promise<void> {
  try {
    const text = await invoke<string | null>("last_crash");
    if (text) await message(text, { title: "OmniCaster se cerró inesperadamente", kind: "warning" });
  } catch {
    /* fuera de Tauri */
  }
}

export type QuitAction = "quit" | "reboot" | "poweroff";

export async function installQuitHandler(getMessage: (action: QuitAction) => string): Promise<() => void> {
  return listen<QuitAction | null>("app://quit-request", async (e) => {
    const action: QuitAction = e.payload ?? "quit";
    const what = action === "reboot" ? "Reiniciar el equipo" : action === "poweroff" ? "Apagar el equipo" : "Cerrar OmniCaster";
    const ok = await ask(getMessage(action), {
      title: what,
      kind: "warning",
      okLabel: what,
      cancelLabel: "Cancelar",
    }).catch(() => false);
    if (!ok) return;
    if (action === "quit") await invoke("app_quit");
    else await invoke("system_power", { action }).catch((err) => window.alert(String(err)));
  });
}

/** Pide cerrar OmniCaster, o reiniciar/apagar el equipo (desde cualquier ventana; confirma la principal). */
export function requestQuit(action: QuitAction = "quit"): Promise<void> {
  return emit("app://quit-request", action);
}

/** Linux (equipo dedicado / quiosco): los botones son reiniciar y apagar el equipo. */
export const IS_LINUX = typeof navigator !== "undefined" && /Linux/i.test(navigator.userAgent) && !/Android/i.test(navigator.userAgent);

/**
 * Diálogo de abrir archivo/carpeta. En Linux (quiosco) usa el selector propio,
 * limitado a Música, Plugins, Descargas, Personal y memorias USB.
 */
export function openDialog(o: PickOptions & { multiple: true }): Promise<string[] | null>;
export function openDialog(o: PickOptions): Promise<string | null>;
export async function openDialog(o: PickOptions): Promise<string | string[] | null> {
  if (IS_LINUX) return pickOpen(o);
  return (await nativeOpen(o)) as string | string[] | null;
}

export async function saveDialog(o: PickOptions): Promise<string | null> {
  if (IS_LINUX) return pickSave(o);
  return nativeSave(o);
}


// ---- API compatible con RadioBOSS ----

export interface ApiStatus {
  running: boolean;
  address: string;
  error: string | null;
  lastUpdate: string | null;
  user: string;
  hasPassword: boolean;
  hasToken: boolean;
  hasUpdateToken: boolean;
}

export function apiApply(config: import("./types").ApiSettings): Promise<ApiStatus> {
  return invoke<ApiStatus>("api_apply", { config });
}
export function apiStatus(): Promise<ApiStatus> {
  return invoke<ApiStatus>("api_status");
}
export function apiSetLogin(user: string, pass: string): Promise<ApiStatus> {
  return invoke<ApiStatus>("api_set_login", { user, pass });
}
export function apiNewToken(): Promise<string> {
  return invoke<string>("api_new_token");
}
export function apiSetUpdateToken(token: string): Promise<ApiStatus> {
  return invoke<ApiStatus>("api_set_update_token", { token });
}
export function apiPublish(published: unknown): Promise<void> {
  return invoke("api_publish", { published });
}

/** Pasa (o copia) canciones a un bloque; con removeBlock las saca del de origen. */
export function moveTracksBlock(ids: string[], addBlock: string, removeBlock: string | null): Promise<number> {
  return invoke<number>("move_tracks_block", { ids, addBlock, removeBlock });
}

// ---- copia de seguridad ----

export interface BackupRoot {
  prefix: string;
  tracks: number;
  exists: boolean;
  included: boolean;
}

export interface BackupInfo {
  manifest: {
    appVersion: string;
    created: string;
    tracks: number;
    playlists: number;
    includeAudio: boolean;
    audioFiles: number;
    audioBytes: number;
    dataDir: string;
  };
  roots: BackupRoot[];
}

export interface BackupExportResult {
  path: string;
  files: number;
  audioFiles: number;
  missingAudio: number;
  bytes: number;
}

export async function pickBackupDestination(): Promise<string | null> {
  const day = new Date().toISOString().slice(0, 10);
  const p = await saveDialog({ defaultPath: `OmniCaster-copia-${day}.zip`, filters: [{ name: "Copia de OmniCaster", extensions: ["zip"] }] });
  return p ?? null;
}

export async function pickBackupFile(): Promise<string | null> {
  const p = await openDialog({ multiple: false, filters: [{ name: "Copia de OmniCaster", extensions: ["zip"] }] });
  return typeof p === "string" ? p : null;
}

export async function pickAnyFolder(): Promise<string | null> {
  const p = await openDialog({ directory: true, multiple: false });
  return typeof p === "string" ? p : null;
}

export function backupExport(dest: string, includeAudio: boolean): Promise<BackupExportResult> {
  return invoke<BackupExportResult>("backup_export", { dest, includeAudio });
}

export function backupInspect(path: string): Promise<BackupInfo> {
  return invoke<BackupInfo>("backup_inspect", { path });
}

export function backupImport(path: string, mappings: { from: string; to: string }[], audioDest: string | null): Promise<{ audioFiles: number }> {
  return invoke("backup_import", { path, mappings, audioDest });
}

export function backupLastImportLog(): Promise<string | null> {
  return invoke<string | null>("backup_last_import_log");
}

export interface FfmpegProgress {
  busy: boolean;
  phase: string;
  fraction: number;
  error: string | null;
  done: string | null;
}
export interface FfmpegInfo {
  path: string;
  source: "manual" | "auto" | "system" | "none";
  version: string;
  managed: { dir: string; asset: string; sha256: string; installedAt: number; lastCheck: number } | null;
  canDownload: boolean;
  progress: FfmpegProgress | null;
}

/** FFmpeg en uso y estado de su descarga automática. */
export function ffmpegInfo(): Promise<FfmpegInfo> {
  return invoke("ffmpeg_info");
}

/** Busca (y si hay, instala) la última versión de FFmpeg. */
export function ffmpegUpdate(): Promise<void> {
  return invoke("ffmpeg_update");
}

export interface FsEntry {
  name: string;
  path: string;
  dir: boolean;
  kind: "audio" | "video" | "";
  size: number;
  modified: number;
}
export interface FsListing {
  path: string;
  parent: string | null;
  entries: FsEntry[];
  truncated: boolean;
}
export interface FsPlace {
  label: string;
  path: string;
  kind: "drive" | "folder";
}

/** Carpetas y archivos compatibles de una carpeta del ordenador. */
export function fsList(path: string): Promise<FsListing> {
  return invoke("fs_list", { path });
}

/** Accesos rápidos: carpetas del usuario y unidades. */
export function fsPlaces(): Promise<FsPlace[]> {
  return invoke("fs_places");
}

export interface VstPkg {
  item: {
    id: string;
    name: string;
    vendor: string;
    description: string;
    category: string;
    license: string;
    homepage: string;
    repo: string;
    platforms: string[];
  };
  available: boolean;
  installed: { version: string; files: string[]; installedAt: number; pending: string | null } | null;
  latest: string | null;
  busy: boolean;
}
export interface VstPkgProgress {
  id: string;
  busy: boolean;
  phase: string;
  fraction: number;
  error: string | null;
  done: string | null;
}

/** Catálogo de plugins recomendados con su estado. */
export function vstPkgList(): Promise<VstPkg[]> {
  return invoke("vstpkg_list");
}
export function vstPkgInstall(id: string): Promise<void> {
  return invoke("vstpkg_install", { id });
}
export function vstPkgCheck(): Promise<void> {
  return invoke("vstpkg_check");
}
export function vstPkgRemove(id: string): Promise<string> {
  return invoke("vstpkg_remove", { id });
}

/** Latencia (muestras a 48 kHz) de cada plugin cargado, por id de ranura. */
export function vstLatencies(): Promise<Record<string, number>> {
  return invoke("vst_latencies");
}

/** Foto de un artista (Deezer, guardada en el equipo); null si no hay. */
export function artistImage(name: string): Promise<string | null> {
  return invoke("artist_image", { name });
}
