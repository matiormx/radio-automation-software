use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::State;

use crate::AppState;
use crate::library::Track;

const SETTINGS_FILE: &str = "settings.json";
const HISTORY_FILE: &str = "history.json";
const SESSION_FILE: &str = "session.json";
const MAX_HISTORY: usize = 800;

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub fade_seconds: u32,
    /// Reproducir la lista automaticamente al abrir la app.
    pub auto_play_on_start: bool,
    /// Pasar a la siguiente pista (o reanudar) si hay silencio.
    pub silence_detection: bool,
    /// Umbral de silencio en dBFS (RMS).
    pub silence_threshold_db: f32,
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
    /// Bloque por defecto del AutoDJ. Vacio = usar auto_blocks o toda la biblioteca.
    pub default_block_id: String,
    /// Modo LIVE: la barra auxiliar muestra el programa seleccionado y sus
    /// metadatos sustituyen a los de la cancion.
    pub live_mode: bool,
    /// Programa que esta en antena en modo LIVE.
    pub live_program_id: String,
    /// Programas preparados de antemano.
    pub programs: Vec<Program>,
    /// Archivo "now playing" que se escribe con la cancion que suena.
    /// Vacio = no escribir nada.
    pub now_playing_path: String,
    /// Plantilla del archivo nowplaying. Por defecto "artista - titulo".
    pub now_playing_template: String,
    /// Archivo "live" con el programa en directo. Vacio = en la misma
    /// carpeta que el nowplaying, con el nombre "live.txt".
    pub live_file_path: String,
    /// Plantilla del archivo live. Por defecto "artista - titulo".
    pub live_template: String,
    /// Objetivo de sonoridad integrada para la normalizacion.
    pub target_lufs: f64,
    /// Techo de pico real al aplicar la ganancia de normalizacion.
    pub true_peak_db: f64,
    pub radio_name: String,
    pub slogan: String,
    pub logo_path: String,
    pub campaigns: Vec<Campaign>,
    pub events: Vec<StationEvent>,
    /// Interruptor general de eventos; si esta apagado no se lanza ninguno.
    pub events_enabled: bool,
    pub mixer_channels: Vec<MixerChannel>,
    pub mixer_buses: Vec<MixerBus>,
    /// Bus cuya señal muestra el VU de salida; vacio = salida general.
    pub monitor_bus_id: String,
    pub video: VideoSettings,
    pub streaming: StreamingSettings,
    pub studio_calls: StudioCallsSettings,
}

/// Programa de emisión preparado con antelacion: tiene titulo, portada y
/// una hora opcional de inicio. En modo LIVE sustituye los metadatos de la
/// canción que suena.
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Program {
    pub id: String,
    pub name: String,
    pub subtitle: String,
    /// Ruta de la imagen de portada
    pub cover: String,
    /// Hora de inicio prevista ("22:00"); vacio = sin hora
    pub starts_at: String,
    pub enabled: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct MixerInput {
    /// "app" o "device"
    pub kind: String,
    /// "music", "preview" o "call" cuando kind = "app"
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
    pub leveler: LevelerSettings,
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
            leveler: LevelerSettings::default(),
        }
    }
}

/// Nivelador automatico de ganancia de un canal o bus.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct LevelerSettings {
    pub enabled: bool,
    /// Sonoridad objetivo (LUFS).
    pub target_lufs: f32,
    /// Maximo de subida o bajada (dB).
    pub max_gain_db: f32,
}

impl Default for LevelerSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            target_lufs: -16.0,
            max_gain_db: 9.0,
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
    pub leveler: LevelerSettings,
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
            leveler: LevelerSettings::default(),
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
            source_kind: "library".to_string(),
            source_id: "a".to_string(),
            track_id: String::new(),
            max_wait_secs: 60,
            on_timeout: "cancel".to_string(),
            last_fired: String::new(),
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct VideoInput {
    pub id: String,
    pub name: String,
    /// "file", "rtsp" o "ndi"
    pub kind: String,
    pub source: String,
    pub enabled: bool,
}

impl Default for VideoInput {
    fn default() -> Self {
        Self {
            id: String::new(),
            name: String::new(),
            kind: "file".to_string(),
            source: String::new(),
            enabled: true,
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct VideoOutput {
    pub id: String,
    pub name: String,
    /// "screen", "decklink", "ndi" o "rtsp"
    pub kind: String,
    pub source: String,
    pub enabled: bool,
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub bitrate_kbps: u32,
}

impl Default for VideoOutput {
    fn default() -> Self {
        Self {
            id: String::new(),
            name: String::new(),
            kind: "screen".to_string(),
            source: "0".to_string(),
            enabled: true,
            width: 1920,
            height: 1080,
            fps: 25,
            bitrate_kbps: 6000,
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct VideoSettings {
    pub enabled: bool,
    pub inputs: Vec<VideoInput>,
    pub outputs: Vec<VideoOutput>,
}

impl Default for VideoSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            inputs: Vec::new(),
            outputs: Vec::new(),
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct IcecastStream {
    pub id: String,
    pub name: String,
    pub enabled: bool,
    pub host: String,
    pub port: u16,
    pub mount: String,
    pub username: String,
    pub password: String,
    pub tls: bool,
    /// "flac" o "aac"
    pub codec: String,
    pub bitrate_kbps: u32,
    pub sample_rate: u32,
    pub channels: u8,
    pub public: bool,
    pub station_name: String,
    pub description: String,
    pub genre: String,
}

impl Default for IcecastStream {
    fn default() -> Self {
        Self {
            id: String::new(),
            name: String::new(),
            enabled: true,
            host: "localhost".to_string(),
            port: 8000,
            mount: "/miradio".to_string(),
            username: "source".to_string(),
            password: String::new(),
            tls: false,
            codec: "flac".to_string(),
            bitrate_kbps: 0,
            sample_rate: 48000,
            channels: 2,
            public: false,
            station_name: "MiRadio".to_string(),
            description: String::new(),
            genre: String::new(),
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct RtspOutput {
    pub enabled: bool,
    pub url: String,
    /// "tcp" o "udp"
    pub transport: String,
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub bitrate_kbps: u32,
    pub keyframe_secs: u32,
}

impl Default for RtspOutput {
    fn default() -> Self {
        Self {
            enabled: false,
            url: String::new(),
            transport: "tcp".to_string(),
            width: 1920,
            height: 1080,
            fps: 25,
            bitrate_kbps: 6000,
            keyframe_secs: 2,
        }
    }
}

/// Llamadas de oyentes al aire: conexion con el worker de NGRADIO.
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct StudioCallsSettings {
    pub enabled: bool,
    /// Direccion de la app, por ejemplo https://app.ngradio.es
    pub server_url: String,
    /// Secreto STUDIO_TOKEN del worker
    pub token: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct StreamingSettings {
    pub icecast: Vec<IcecastStream>,
    pub rtsp: RtspOutput,
}

impl Default for StreamingSettings {
    fn default() -> Self {
        Self {
            icecast: Vec::new(),
            rtsp: RtspOutput::default(),
        }
    }
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            fade_seconds: 6,
            auto_play_on_start: false,
            silence_detection: false,
            silence_threshold_db: -55.0,
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
            default_block_id: String::new(),
            live_mode: false,
            live_program_id: String::new(),
            programs: Vec::new(),
            now_playing_path: String::new(),
            now_playing_template: "{artist} - {title}".to_string(),
            live_file_path: String::new(),
            live_template: "{artist} - {title}".to_string(),
            target_lufs: -9.0,
            true_peak_db: -1.0,
            radio_name: "MiRadio".to_string(),
            slogan: "Estudio de automatización".to_string(),
            logo_path: String::new(),
            campaigns: Vec::new(),
            events: Vec::new(),
            events_enabled: true,
            mixer_channels: Vec::new(),
            mixer_buses: Vec::new(),
            monitor_bus_id: String::new(),
            video: VideoSettings::default(),
            streaming: StreamingSettings::default(),
            studio_calls: StudioCallsSettings::default(),
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

/// Copia la portada de un programa a la carpeta de la app y devuelve su ruta.
#[tauri::command]
pub fn import_program_cover(state: State<'_, AppState>, path: String) -> Result<String, String> {
    let src = PathBuf::from(path.trim());
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
    let dir = state.data_dir.join("programs");
    std::fs::create_dir_all(&dir).map_err(|e| format!("No se pudo preparar la carpeta: {e}"))?;
    let stem = src
        .file_stem()
        .and_then(|s| s.to_str())
        .map(|s| s.replace([' ', '/', '\\', ':'], "_"))
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "programa".to_string());
    let stamp = now_epoch();
    let dest = dir.join(format!("{stamp}-{stem}.{ext}"));
    std::fs::copy(&src, &dest).map_err(|e| format!("No se pudo copiar la portada: {e}"))?;
    Ok(dest.to_string_lossy().into_owned())
}

/// Borra la portada de un programa (solo dentro de la carpeta de la app).
#[tauri::command]
pub fn delete_program_cover(state: State<'_, AppState>, path: String) -> Result<(), String> {
    let dir = state.data_dir.join("programs");
    let target = PathBuf::from(path.trim());
    if target.parent() != Some(dir.as_path()) {
        return Err("Esa imagen no es de MiRadio".to_string());
    }
    if target.is_file() {
        let _ = std::fs::remove_file(&target);
    }
    Ok(())
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

/// Canciones ya emitidas, de la mas reciente a la mas antigua. Se guarda en
/// history.json, asi que sobrevive a los reinicios de la app.
#[tauri::command]
pub fn list_history(state: State<'_, AppState>) -> Vec<HistoryEntry> {
    let mut entries = read_history(&state.data_dir);
    entries.reverse();
    entries
}

/// Estado de la ultima sesion: lista, pista y posicion. Sirve para
/// continuar la emision donde se quedo al cerrar la app.
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct SessionState {
    pub playlist_id: String,
    pub track_id: String,
    pub position_secs: f64,
    pub playing: bool,
    pub updated_at: u64,
}

#[tauri::command]
pub fn save_session(state: State<'_, AppState>, session: SessionState) -> Result<(), String> {
    let mut session = session;
    session.updated_at = now_epoch();
    let json = serde_json::to_vec_pretty(&session).map_err(|e| e.to_string())?;
    std::fs::write(state.data_dir.join(SESSION_FILE), json).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn load_session(state: State<'_, AppState>) -> Option<SessionState> {
    std::fs::read(state.data_dir.join(SESSION_FILE))
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
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
    let mut pick_blocks = pick_block_ids(&s);
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

/// Bloques de los que saca canciones el AutoDJ. El bloque por defecto
/// manda sobre los bloques marcados en el navegador; si no hay, todos.
fn pick_block_ids(s: &Settings) -> HashSet<String> {
    if s.default_block_id.trim().is_empty() {
        s.auto_blocks.iter().cloned().collect()
    } else {
        std::iter::once(s.default_block_id.clone()).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn settings_with(blocks: &[&str], default_block: &str) -> Settings {
        let mut s = Settings::default();
        s.auto_blocks = blocks.iter().map(|b| b.to_string()).collect();
        s.default_block_id = default_block.to_string();
        s
    }

    #[test]
    fn el_bloque_por_defecto_manda_sobre_los_marcados() {
        let s = settings_with(&["uno", "dos"], "tres");
        let ids = pick_block_ids(&s);
        assert_eq!(ids.len(), 1);
        assert!(ids.contains("tres"));
    }

    #[test]
    fn sin_bloque_por_defecto_se_usan_los_marcados() {
        let s = settings_with(&["uno", "dos"], "");
        let ids = pick_block_ids(&s);
        assert_eq!(ids.len(), 2);
        assert!(ids.contains("uno") && ids.contains("dos"));
    }

    #[test]
    fn sin_bloques_la_biblioteca_esta_libre() {
        let s = settings_with(&[], "");
        assert!(pick_block_ids(&s).is_empty());
    }
}
