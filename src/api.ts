import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import type {
  Block,
  Playlist,
  PlaylistImportReport,
  Settings,
  StreamProbe,
  StreamStatus,
  Track,
  TrackDetails,
  TrackPatch,
  AnalysisResult,
  Waveform,
} from "./types";

export const AUDIO_EXTENSIONS = [
  "mp3", "wav", "flac", "ogg", "oga", "opus", "m4a", "aac", "aif", "aiff", "wma", "webm",
];

export function listTracks(): Promise<Track[]> {
  return invoke<Track[]>("list_tracks");
}

export function importFiles(paths: string[], library: "a" | "b" = "a"): Promise<Track[]> {
  return invoke<Track[]>("import_files", { paths, library });
}

export function scanMusicFolder(): Promise<number> {
  return invoke<number>("scan_music_folder");
}

export function updateTrack(id: string, patch: TrackPatch): Promise<void> {
  return invoke("update_track", { id, patch });
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

export function installAppUpdate(
  url: string,
  version: string,
): Promise<{ path: string; launched: boolean; bytes: number }> {
  return invoke("install_update", { url, version });
}

export function openExternal(url: string): Promise<void> {
  return invoke("open_url", { url });
}

export function probeStreaming(): Promise<StreamProbe> {
  return invoke<StreamProbe>("stream_probe");
}

export function getStreamStatus(): Promise<StreamStatus> {
  return invoke<StreamStatus>("stream_status");
}

export function startStreaming(settings: Settings): Promise<StreamStatus> {
  return invoke<StreamStatus>("stream_start", { settings });
}

export function stopStreaming(): Promise<StreamStatus> {
  return invoke<StreamStatus>("stream_stop");
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
  return convertFileSrc(track.file);
}

export async function pickAudioFiles(): Promise<string[] | null> {
  return openDialog({
    multiple: true,
    filters: [{ name: "Audio", extensions: [...AUDIO_EXTENSIONS] }],
  });
}

export async function pickFolder(): Promise<string | null> {
  return openDialog({ directory: true, title: "Carpeta de música de MiRadio" });
}

export async function pickSingleAudioFile(): Promise<string | null> {
  return openDialog({
    multiple: false,
    filters: [{ name: "Audio", extensions: [...AUDIO_EXTENSIONS] }],
  });
}

export async function onWindowFileDrop(
  handlers: {
    onDrop?: (paths: string[], position?: { x: number; y: number }) => void;
    onEnter?: () => void;
    onLeave?: () => void;
  },
): Promise<() => void> {
  const unlisten = await getCurrentWindow().onDragDropEvent((event) => {
    if (event.payload.type === "drop" && event.payload.paths.length > 0) {
      handlers.onDrop?.(event.payload.paths, event.payload.position);
    } else if (event.payload.type === "enter") {
      handlers.onEnter?.();
    } else if (event.payload.type === "leave") {
      handlers.onLeave?.();
    }
  });
  return unlisten;
}
