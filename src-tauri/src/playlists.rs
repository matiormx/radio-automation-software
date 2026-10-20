use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use tauri::State;
use uuid::Uuid;

use crate::AppState;

pub const PLAYLISTS_DIR: &str = "playlists";
pub const DEFAULT_PLAYLIST_NAME: &str = "Mi lista";

#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Playlist {
    pub id: String,
    pub name: String,
    pub track_ids: Vec<String>,
}

fn playlists_dir(data_dir: &PathBuf) -> PathBuf {
    data_dir.join(PLAYLISTS_DIR)
}

fn playlist_file(data_dir: &PathBuf, id: &str) -> PathBuf {
    playlists_dir(data_dir).join(format!("{id}.json"))
}

/// Lista todas las listas de reproduccion. Si no hay ninguna
/// (primer uso), crea una lista vacia "Mi lista".
#[tauri::command]
pub fn list_playlists(state: State<'_, AppState>) -> Result<Vec<Playlist>, String> {
    let dir = playlists_dir(&state.data_dir);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    let mut result = Vec::new();
    let mut names: Vec<PathBuf> = fs::read_dir(&dir)
        .map(|entries| {
            entries
                .filter_map(|e| e.ok())
                .map(|e| e.path())
                .filter(|p| p.extension().and_then(|x| x.to_str()) == Some("json"))
                .collect()
        })
        .unwrap_or_default();
    names.sort();

    for file in names {
        if let Ok(bytes) = fs::read(&file) {
            if let Ok(pl) = serde_json::from_slice::<Playlist>(&bytes) {
                result.push(pl);
            }
        }
    }

    if result.is_empty() {
        let first = Playlist {
            id: Uuid::new_v4().simple().to_string(),
            name: DEFAULT_PLAYLIST_NAME.to_string(),
            track_ids: Vec::new(),
        };
        store(&state.data_dir, &first)?;
        result.push(first);
    }
    Ok(result)
}

fn store(data_dir: &PathBuf, pl: &Playlist) -> Result<(), String> {
    let dir = playlists_dir(data_dir);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let json = serde_json::to_vec_pretty(pl).map_err(|e| e.to_string())?;
    fs::write(playlist_file(data_dir, &pl.id), json).map_err(|e| e.to_string())
}

/// Crea o actualiza una lista de reproduccion.
#[tauri::command]
pub fn save_playlist(state: State<'_, AppState>, playlist: Playlist) -> Result<(), String> {
    store(&state.data_dir, &playlist)
}

/// Borra una lista de reproduccion (no borra las canciones).
#[tauri::command]
pub fn delete_playlist(state: State<'_, AppState>, id: String) -> Result<(), String> {
    let file = playlist_file(&state.data_dir, &id);
    if file.exists() {
        fs::remove_file(&file).map_err(|e| e.to_string())?;
    }
    Ok(())
}
