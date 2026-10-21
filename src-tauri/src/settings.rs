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
    /// Carpeta de musica predefinida (los arrastres se copian ahi).
    /// Vacia = carpeta interna de la app.
    pub music_path: String,
    /// Bloques musicales de los que elige el piloto automatico.
    /// Vacio = toda la biblioteca.
    pub auto_blocks: Vec<String>,
    /// Objetivo de sonoridad integrada para la normalizacion.
    pub target_lufs: f64,
    /// Techo de pico real al aplicar la ganancia de normalizacion.
    pub true_peak_db: f64,
    pub radio_name: String,
    pub slogan: String,
    pub logo_path: String,
    pub campaigns: Vec<Campaign>,
    pub events: Vec<StationEvent>,
    pub mixer_channels: Vec<MixerChannel>,
    pub mixer_buses: Vec<MixerBus>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct MixerInput {
    /// "app" o "device"
    pub kind: String,
    /// "music" o "preview" cuando kind = "app"
    pub app: String,
    /// Identificador del dispositivo de entrada cuando kind = "device"
    pub device_id: String,
}

impl Default for MixerInput {
    fn default() -> Self {
        Self {
            kind: "app".to_string(),
            app: "music".to_string(),
            device_id: String::new(),
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct MixerOutput {
    /// "bus" o "device"
    pub kind: String,
    /// id del bus o deviceId de la tarjeta; "default" = salida del sistema
    pub id: String,
}

impl Default for MixerOutput {
    fn default() -> Self {
        Self {
            kind: "device".to_string(),
            id: "default".to_string(),
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct MixerChannel {
    pub id: String,
    pub name: String,
    pub color: String,
    pub input: MixerInput,
    pub output: MixerOutput,
    pub gain_db: f32,
    pub muted: bool,
}

impl Default for MixerChannel {
    fn default() -> Self {
        Self {
            id: String::new(),
            name: String::new(),
            color: "#4f8cff".to_string(),
            input: MixerInput::default(),
            output: MixerOutput::default(),
            gain_db: 0.0,
            muted: false,
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct MixerBus {
    pub id: String,
    pub name: String,
    pub color: String,
    pub output_device_id: String,
    pub gain_db: f32,
    pub muted: bool,
}

impl Default for MixerBus {
    fn default() -> Self {
        Self {
            id: String::new(),
            name: String::new(),
            color: "#59d98c".to_string(),
            output_device_id: "default".to_string(),
            gain_db: 0.0,
            muted: false,
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct Campaign {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub enabled: bool,
    pub days: Vec<u8>,
    pub times: Vec<String>,
    pub hourly: bool,
    pub minute: u8,
    /// Inicio de la campana (fecha y hora local, YYYY-MM-DDTHH:MM).
    pub start_at: String,
    /// Fin de la campana; vacio = permanente.
    pub end_at: String,
    pub track_ids: Vec<String>,
    pub cursor: usize,
    pub last_fired: String,
}

impl Default for Campaign {
    fn default() -> Self {
        Self {
            id: String::new(),
            name: String::new(),
            kind: "ads".to_string(),
            enabled: true,
            days: vec![1, 2, 3, 4, 5, 6, 7],
            times: Vec::new(),
            hourly: false,
            minute: 0,
            start_at: String::new(),
            end_at: String::new(),
            track_ids: Vec::new(),
            cursor: 0,
            last_fired: String::new(),
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct StationEvent {
    pub id: String,
    pub name: String,
    pub enabled: bool,
    /// "auto" = franja de fuente AutoDJ; "insert" = sonido como siguiente
    pub kind: String,
    pub days: Vec<u8>,
    /// Inicio de la franja (auto) o hora de inserción (insert), HH:MM
    pub start: String,
    /// Fin de la franja AutoDJ; puede cruzar medianoche
    pub end: String,
    /// "block" o "library"
    pub source_kind: String,
    /// id de bloque o "a"/"b"
    pub source_id: String,
    pub track_id: String,
    pub max_wait_secs: u32,
    /// "force" o "cancel"
    pub on_timeout: String,
    pub last_fired: String,
}

impl Default for StationEvent {
    fn default() -> Self {
        Self {
            id: String::new(),
            name: String::new(),
            enabled: true,
            kind: "auto".to_string(),
            days: vec![1, 2, 3, 4, 5, 6, 7],
            start: "06:00".to_string(),
            end: "10:00".to_string(),
            source_kind: "library".to_string(),
            source_id: "a".to_string(),
            track_id: String::new(),
            max_wait_secs: 60,
            on_timeout: "cancel".to_string(),
            last_fired: String::new(),
        }
    }
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
            music_path: String::new(),
            auto_blocks: Vec::new(),
            target_lufs: -9.0,
            true_peak_db: -1.0,
            radio_name: "MiRadio".to_string(),
            slogan: "Estudio de automatización".to_string(),
            logo_path: String::new(),
            campaigns: Vec::new(),
            events: Vec::new(),
            mixer_channels: Vec::new(),
            mixer_buses: Vec::new(),
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

/// Lector para otros modulos (library.rs usa music_path)
pub fn read_settings_public(data_dir: &PathBuf) -> Settings {
    read_settings(data_dir)
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

#[tauri::command]
pub fn set_branding_logo(
    state: State<'_, AppState>,
    path: Option<String>,
) -> Result<String, String> {
    let dir = state.data_dir.join("branding");
    match path {
        None => {
            let _ = std::fs::remove_dir_all(&dir);
            Ok(String::new())
        }
        Some(raw) => {
            let src = PathBuf::from(raw.trim());
            if !src.is_file() {
                return Err("La imagen no existe".to_string());
            }
            let ext = src
                .extension()
                .and_then(|e| e.to_str())
                .map(|e| e.to_ascii_lowercase())
                .unwrap_or_default();
            if !["png", "jpg", "jpeg", "webp", "gif"].contains(&ext.as_str()) {
                return Err("Formato de imagen no soportado (png, jpg, webp o gif)".to_string());
            }
            std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
            let dest = dir.join(format!("logo.{ext}"));
            let tmp = dir.join(format!(".logo-nuevo.{ext}"));
            let _ = std::fs::remove_file(&tmp);
            std::fs::copy(&src, &tmp).map_err(|e| format!("No se pudo copiar el logo: {e}"))?;
            if let Ok(entries) = std::fs::read_dir(&dir) {
                for e in entries.flatten() {
                    let p = e.path();
                    if p != tmp {
                        let _ = std::fs::remove_file(p);
                    }
                }
            }
            std::fs::rename(&tmp, &dest).map_err(|e| format!("No se pudo guardar el logo: {e}"))?;
            Ok(dest.to_string_lossy().into_owned())
        }
    }
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
    scope_kind: Option<String>,
    scope_id: Option<String>,
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

    // Bloques activos del piloto automatico: vacio = toda la biblioteca.
    // Un evento activo puede sustituirlos por un bloque concreto o por una
    // de las dos bibliotecas.
    let mut pick_blocks: HashSet<String> = s.auto_blocks.iter().cloned().collect();
    let mut pick_library: Option<String> = None;
    match scope_kind.as_deref() {
        Some("block") => {
            pick_blocks.clear();
            if let Some(id) = scope_id.as_deref().filter(|id| !id.is_empty()) {
                pick_blocks.insert(id.to_string());
            }
        }
        Some("library") => {
            pick_blocks.clear();
            if let Some(id) = scope_id.as_deref().filter(|id| *id == "a" || *id == "b") {
                pick_library = Some(id.to_string());
            }
        }
        _ => {}
    }

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
    let mut in_scope: HashSet<&str> = HashSet::new();
    for t in &library {
        if !pick_blocks.is_empty() && !t.blocks.iter().any(|b| pick_blocks.contains(b)) {
            continue;
        }
        if let Some(lib) = pick_library.as_deref() {
            if t.library != lib {
                continue;
            }
        }
        if in_playlist.contains(t.id.as_str()) {
            continue; // nada duplicado dentro de la misma lista
        }
        in_scope.insert(t.id.as_str());
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

    // Si el ambito activo no tiene nada disponible, caer a la biblioteca
    // entera antes que dejar la lista sin gas.
    if candidates.is_empty()
        && in_scope.is_empty()
        && (!pick_blocks.is_empty() || pick_library.is_some())
    {
        for t in &library {
            if in_playlist.contains(t.id.as_str()) {
                continue;
            }
            candidates.push(Candidate {
                id: t.id.clone(),
                ok_rules: 0,
                salt: hash_with_salt(&t.id, salt),
            });
        }
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
