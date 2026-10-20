use lofty::file::{AudioFile, TaggedFileExt};
use lofty::read_from_path;
use lofty::tag::Accessor;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use tauri::State;
use uuid::Uuid;

use crate::AppState;

pub const MUSIC_DIR: &str = "music";
pub const LIBRARY_FILE: &str = "library.json";

const ALLOWED_EXTENSIONS: [&str; 12] = [
    "mp3", "wav", "flac", "ogg", "oga", "opus", "m4a", "aac", "aif", "aiff", "wma", "webm",
];

#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Track {
    pub id: String,
    pub title: String,
    pub artist: String,
    pub duration_secs: f64,
    /// Nombre del archivo dentro de la carpeta de musica (ej: "abc123.mp3")
    pub file_name: String,
    /// Nombre original con el que entro el archivo (solo informativo)
    pub original_name: String,
}

impl Track {
    /// Resuelve la ruta absoluta del archivo dentro de la carpeta de datos,
    /// asi la app sigue funcionando aunque el usuario mueva la instalacion.
    pub fn resolved_path(&self, data_dir: &Path) -> PathBuf {
        data_dir.join(MUSIC_DIR).join(&self.file_name)
    }
}

fn is_allowed(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| {
            let e = e.to_ascii_lowercase();
            ALLOWED_EXTENSIONS.contains(&e.as_str())
        })
        .unwrap_or(false)
}

/// Nombre para mostrar a partir del nombre de archivo: "Mi Cancion - Tema.mp3" -> "Mi Cancion - Tema"
fn display_name_from_file(path: &Path) -> (String, String) {
    let stem = path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("Cancion");
    // Si viene "Artista - Titulo", lo separamos para mostrarlo mejor
    let parts: Vec<&str> = stem.splitn(2, " - ").collect();
    if parts.len() == 2 && !parts[0].trim().is_empty() && !parts[1].trim().is_empty() {
        (parts[1].trim().to_string(), parts[0].trim().to_string())
    } else {
        (stem.trim().to_string(), "Desconocido".to_string())
    }
}

fn read_metadata(path: &Path, fallback_title: String, fallback_artist: String) -> (String, String, f64) {
    match read_from_path(path) {
        Ok(tagged) => {
            let duration = tagged
                .properties()
                .duration()
                .as_secs_f64();
            let (mut title, mut artist) = (fallback_title, fallback_artist);
            if let Some(tag) = tagged.primary_tag().or_else(|| tagged.first_tag()) {
                if let Some(t) = tag.title().filter(|t| !t.trim().is_empty()) {
                    title = t.trim().to_string();
                }
                if let Some(a) = tag.artist().filter(|a| !a.trim().is_empty()) {
                    artist = a.trim().to_string();
                }
            }
            (title, artist, duration)
        }
        Err(_) => (fallback_title, fallback_artist, 0.0),
    }
}

fn read_library(data_dir: &Path) -> Vec<Track> {
    let file = data_dir.join(LIBRARY_FILE);
    match fs::read(&file) {
        Ok(bytes) => serde_json::from_slice(&bytes).unwrap_or_default(),
        Err(_) => Vec::new(),
    }
}

fn write_library(data_dir: &Path, tracks: &[Track]) -> Result<(), String> {
    let p = data_dir.join(LIBRARY_FILE);
    let tmp = data_dir.join("library.json.tmp");
    let json = serde_json::to_vec_pretty(tracks).map_err(|e| e.to_string())?;
    fs::write(&tmp, json).map_err(|e| e.to_string())?;
    fs::rename(&tmp, &p).map_err(|e| e.to_string())
}

/// Importa archivos: los copia a la biblioteca interna y quedan guardados.
/// Es el equivalente a "arrastrar y soltar", la app nunca lee la carpeta
/// original: una copia segura queda dentro de MiRadio.
#[tauri::command]
pub fn import_files(
    state: State<'_, AppState>,
    paths: Vec<String>,
) -> Result<Vec<Track>, String> {
    let mut tracks = read_library(&state.data_dir);
    let mut imported = Vec::new();

    for raw in paths {
        let src = PathBuf::from(&raw);
        if !src.is_file() || !is_allowed(&src) {
            continue;
        }

        let (initial_title, initial_artist) = display_name_from_file(&src);
        let new_id = Uuid::new_v4().simple().to_string();
        let ext = src
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("bin")
            .to_ascii_lowercase();
        let file_name = format!("{new_id}.{ext}");
        let dest = state.data_dir.join(MUSIC_DIR).join(&file_name);

        if fs::copy(&src, &dest).is_err() {
            eprintln!("No se pudo copiar {raw}");
            continue;
        }

        let (title, artist, duration) =
            read_metadata(&dest, initial_title, initial_artist);

        let track = Track {
            id: new_id,
            title,
            artist,
            duration_secs: (duration * 100.0).round() / 100.0,
            file_name,
            original_name: src
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("archivo")
                .to_string(),
        };
        tracks.push(track.clone());
        imported.push(track);
    }

    write_library(&state.data_dir, &tracks)?;
    Ok(imported)
}

/// Devuelve todas las canciones de la biblioteca (con rutas resueltas).
#[tauri::command]
pub fn list_tracks(state: State<'_, AppState>) -> Result<Vec<TrackResolved>, String> {
    Ok(read_library(&state.data_dir)
        .into_iter()
        .map(|t| TrackResolved::from(t, &state.data_dir))
        .collect())
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TrackResolved {
    #[serde(flatten)]
    track: Track,
    file_path: String,
}

impl TrackResolved {
    fn from(t: Track, data_dir: &Path) -> Self {
        let file_path = t.resolved_path(data_dir).to_string_lossy().into_owned();
        Self {
            track: t,
            file_path,
        }
    }
}

/// Borra una cancion de la biblioteca (archivo incluido).
#[tauri::command]
pub fn delete_track(state: State<'_, AppState>, id: String) -> Result<(), String> {
    let tracks = read_library(&state.data_dir);
    let remaining: Vec<Track> = tracks
        .iter()
        .filter(|t| t.id != id)
        .cloned()
        .collect();

    if let Some(t) = tracks.iter().find(|t| t.id == id) {
        let path = t.resolved_path(&state.data_dir);
        if path.exists() {
            let _ = fs::remove_file(&path);
        }
    }
    write_library(&state.data_dir, &remaining)
}
