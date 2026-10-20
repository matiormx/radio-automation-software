import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import type { Playlist, Track } from "./types";

export const AUDIO_EXTENSIONS = [
  "mp3", "wav", "flac", "ogg", "oga", "opus", "m4a", "aac", "aif", "aiff", "wma", "webm",
];

export function listTracks(): Promise<Track[]> {
  return invoke<Track[]>("list_tracks");
}

export function importFiles(paths: string[]): Promise<Track[]> {
  return invoke<Track[]>("import_files", { paths });
}

export function deleteTrack(id: string): Promise<void> {
  return invoke("delete_track", { id });
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

export function trackUrl(track: Track): string {
  return convertFileSrc(track.filePath);
}

export async function pickAudioFiles(): Promise<string[] | null> {
  return openDialog({
    multiple: true,
    filters: [{ name: "Canciones", extensions: [...AUDIO_EXTENSIONS] }],
  });
}

export async function onWindowFileDrop(
  handlers: {
    onDrop?: (paths: string[]) => void;
    onEnter?: () => void;
    onLeave?: () => void;
  },
): Promise<() => void> {
  const unlisten = await getCurrentWindow().onDragDropEvent((event) => {
    if (event.payload.type === "drop" && event.payload.paths.length > 0) {
      handlers.onDrop?.(event.payload.paths);
    } else if (event.payload.type === "enter") {
      handlers.onEnter?.();
    } else if (event.payload.type === "leave") {
      handlers.onLeave?.();
    }
  });
  return unlisten;
}
