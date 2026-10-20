use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::State;

use crate::AppState;
use crate::library::Track;

const SETTINGS_FILE: &str = "settings.json";
const HISTORY_FILE: &str = "history.json";
const MAX_HISTORY: usize = 800;

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub fade_seconds: u32,
    pub autopilot_enabled: bool,
    /// Rellenar la lista cuando queden menos pistas por delante que este numero
    pub autopilot_min_upcoming: u32,
    /// Al rellenar, dejar la lista con este numero de pistas por delante
    pub autopilot_fill_to: u32,
    /// Minutos sin repetir el mismo titulo
    pub repeat_title_minutes: u32,
    /// Minutos sin repetir el mismo artista
    pub repeat_artist_minutes: u32,
    /// Minutos sin repetir la misma pista
    pub repeat_track_minutes: u32,
    /// Evitar dos temas consecutivos del mismo artista en la lista
    pub avoid_consecutive_artist: bool,
    pub master_volume: f32,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            fade_seconds: 6,
            autopilot_enabled: false,
            autopilot_min_upcoming: 4,
            autopilot_fill_to: 10,
            repeat_title_minutes: 240,
            repeat_artist_minutes: 120,
            repeat_track_minutes: 480,
            avoid_consecutive_artist: true,
            master_volume: 1.0,
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntry {
    pub track_id: String,
    pub played_at: u64, // epoch segundos
}

fn read_settings(data_dir: &PathBuf) -> Settings {
    std::fs::read(data_dir.join(SETTINGS_FILE))
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default()
}

fn write_settings(data_dir: &PathBuf, s: &Settings) -> Result<(), String> {
    let json = serde_json::to_vec_pretty(s).map_err(|e| e.to_string())?;
    std::fs::write(data_dir.join(SETTINGS_FILE), json).map_err(|e| e.to_string())
}

fn read_history(data_dir: &PathBuf) -> Vec<HistoryEntry> {
    std::fs::read(data_dir.join(HISTORY_FILE))
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default()
}

fn write_history(data_dir: &PathBuf, h: &[HistoryEntry]) -> Result<(), String> {
    let json = serde_json::to_vec_pretty(h).map_err(|e| e.to_string())?;
    std::fs::write(data_dir.join(HISTORY_FILE), json).map_err(|e| e.to_string())
}

fn now_epoch() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Hash simple (FNV-1a) con sal, para desempates pseudoaleatorios sin
/// anadir dependencia externa.
fn hash_with_salt(s: &str, salt: u64) -> u64 {
    let mut hash: u64 = 0xcbf29ce484222325 ^ salt;
    for b in s.as_bytes() {
        hash ^= *b as u64;
        hash = hash.wrapping_mul(0x100000001b3);
    }
    hash
}

#[tauri::command]
pub fn get_settings(state: State<'_, AppState>) -> Result<Settings, String> {
    Ok(read_settings(&state.data_dir))
}

#[tauri::command]
pub fn save_settings(state: State<'_, AppState>, settings: Settings) -> Result<(), String> {
    write_settings(&state.data_dir, &settings)
}

/// El frontend avisa cuando una pista empieza a sonar; se guarda para las
/// reglas de repeticion.
#[tauri::command]
pub fn report_started(state: State<'_, AppState>, track_id: String) -> Result<(), String> {
    let mut history = read_history(&state.data_dir);
    history.push(HistoryEntry {
        track_id,
        played_at: now_epoch(),
    });
    if history.len() > MAX_HISTORY {
        let cut = history.len() - MAX_HISTORY;
        history.drain(0..cut);
    }
    write_history(&state.data_dir, &history)
}

#[derive(Clone)]
struct Candidate {
    id: String,
    ok_rules: u8, // 3 = cumple pista+titulo+artista
    salt: u64,
}

/// Motor de rotacion estilo RadioDJ/RadioBOSS: elige `count` pistas
/// de la biblioteca para anadir a la lista respetando las reglas.
#[tauri::command]
pub fn auto_pick(
    state: State<'_, AppState>,
    playlist_track_ids: Vec<String>,
    count: u32,
) -> Result<Vec<String>, String> {
    if count == 0 {
        return Ok(vec![]);
    }
    let s = read_settings(&state.data_dir);
    let library = crate::library::read_library_public(&state.data_dir);
    if library.is_empty() {
        return Ok(vec![]);
    }
    let history = read_history(&state.data_dir);
    let now = now_epoch();
    let mins = |m: u32| u64::from(m) * 60;

    let by_id: HashMap<&str, &Track> = library
        .iter()
        .map(|t| (t.id.as_str(), t))
        .collect();

    // Ultima vez que sono esa pista, ese artista y ese titulo.
    let mut last_track: HashMap<&str, u64> = HashMap::new();
    let mut last_artist: HashMap<String, u64> = HashMap::new();
    let mut last_title: HashMap<String, u64> = HashMap::new();
    for h in &history {
        if let Some(t) = by_id.get(h.track_id.as_str()) {
            let ta = t.artist.to_lowercase();
            let ti = t.title.to_lowercase();
            let e = last_track.entry(t.id.as_str()).or_insert(0);
            if h.played_at > *e {
                *e = h.played_at;
            }
            let e = last_artist.entry(ta).or_insert(0);
            if h.played_at > *e {
                *e = h.played_at;
            }
            let e = last_title.entry(ti).or_insert(0);
            if h.played_at > *e {
                *e = h.played_at;
            }
        }
    }

    // Artistas de las ultimas pistas de la lista actual, para no poner
    // dos del mismo artista seguidos.
    let tail_artists: Vec<String> = playlist_track_ids
        .iter()
        .rev()
        .take(3)
        .filter_map(|id| by_id.get(id.as_str()))
        .map(|t| t.artist.to_lowercase())
        .collect();

    let in_playlist: HashSet<&str> = playlist_track_ids.iter().map(|x| x.as_str()).collect();
    let salt = now ^ u64::from(std::process::id());

    let mut candidates: Vec<Candidate> = Vec::new();
    for t in &library {
        if in_playlist.contains(t.id.as_str()) {
            continue; // nada duplicado dentro de la misma lista
        }
        let ok_track =
            now.saturating_sub(*last_track.get(t.id.as_str()).unwrap_or(&0)) >= mins(s.repeat_track_minutes);
        let ok_artist = now.saturating_sub(*last_artist.get(&t.artist.to_lowercase()).unwrap_or(&0))
            >= mins(s.repeat_artist_minutes);
        let ok_title = now.saturating_sub(*last_title.get(&t.title.to_lowercase()).unwrap_or(&0))
            >= mins(s.repeat_title_minutes);
        candidates.push(Candidate {
            id: t.id.clone(),
            ok_rules: ok_track as u8 + ok_title as u8 + ok_artist as u8,
            salt: hash_with_salt(&t.id, salt),
        });
    }

    // Orden: mas reglas cumplidas primero, luego pseudoaleatorio.
    candidates.sort_by(|a, b| b.ok_rules.cmp(&a.ok_rules).then(a.salt.cmp(&b.salt)));

    let artist_of = |id: &str| -> String {
        by_id
            .get(id)
            .map(|t| t.artist.to_lowercase())
            .unwrap_or_default()
    };

    // Pasada 1: respetando artistas consecutivos. Pasada 2: relajada
    // (biblioteca pequena).
    let mut result: Vec<String> = Vec::new();
    for relax in [false, true] {
        let mut picked: Vec<String> = Vec::new();
        let mut tail = tail_artists.clone();
        for c in &candidates {
            if picked.len() >= count as usize {
                break;
            }
            if !relax && s.avoid_consecutive_artist {
                if tail.last().map(|a| a.as_str()) == Some(artist_of(&c.id).as_str()) {
                    continue;
                }
            }
            picked.push(c.id.clone());
            tail.push(artist_of(&c.id));
        }
        if result.len() < picked.len() {
            result = picked;
        }
        if result.len() >= count as usize {
            break;
        }
    }
    Ok(result)
}
