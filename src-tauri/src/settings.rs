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

/// Chat de NGRADIO en MiRadio (usa la direccion y el token de Llamadas).
#[derive(Deserialize, Serialize, Clone, Debug, PartialEq, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct ChatSettings {
    pub enabled: bool,
    pub name: String,
    pub floating: bool,
    pub collapsed: bool,
}

/// Ventana de video de la emision (pantalla completa en un monitor).
#[derive(Deserialize, Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct VideoScreenSettings {
    pub enabled: bool,
    pub monitor: u32,
    /// "cover" | "logo" | "black"
    pub audio_mode: String,
    /// "program" (lo que suena) o "capture" (la capturadora elegida)
    pub source: String,
    /// Entrada de video que se muestra en la pantalla y se emite por las salidas
    pub capture_input_id: String,
    /// Espejo horizontal solo en la ventana de los locutores
    pub mirror: bool,
    /// Si la capturadora no tiene senal: "program" (lo que suena) o "none" (negro)
    pub capture_fallback: String,
    /// Encierra el raton en el monitor de MiRadio (Ctrl+Mayus lo libera)
    pub cursor_wall: bool,
}

impl Default for VideoScreenSettings {
    fn default() -> Self {
        VideoScreenSettings {
            enabled: false,
            monitor: 1,
            audio_mode: "cover".into(),
            source: "program".into(),
            capture_input_id: String::new(),
            mirror: false,
            capture_fallback: "program".into(),
            cursor_wall: false,
        }
    }
}

/// Intros: audios de un bloque especial que suenan sobre el hueco entre el
/// inicio de la cancion y su punto de intro.
#[derive(Deserialize, Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct IntroSettings {
    pub enabled: bool,
    /// Bloque con los audios de intro
    pub block_id: String,
    /// "start" (al principio del hueco) o "end" (acabando en el punto de intro)
    pub align: String,
    /// Canciones que deben sonar antes de volver a poner un intro
    pub gap_songs: u32,
    /// Volumen del intro respecto al archivo (dB)
    pub gain_db: f64,
}

impl Default for IntroSettings {
    fn default() -> Self {
        IntroSettings { enabled: false, block_id: String::new(), align: "end".into(), gap_songs: 3, gain_db: 0.0 }
    }
}

/// Plugins VST3: carpetas extra donde buscar y plugins que no interesan.
#[derive(Deserialize, Serialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct VstSettings {
    pub extra_folders: Vec<String>,
    /// Rutas de plugins ocultos en el selector
    pub hidden: Vec<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub vst: VstSettings,
    pub fade_seconds: u32,
    /// Reproducir la lista automaticamente al abrir la app.
    pub auto_play_on_start: bool,
    /// Pasar a la siguiente pista (o reanudar) si hay silencio.
    pub silence_detection: bool,
    /// Umbral de silencio en dBFS (RMS).
    pub silence_threshold_db: f32,
    /// Motor de audio: "web" o "native" (beta).
    /// Canciones emitidas que siguen visibles en la lista.
    pub past_visible: u32,
    /// Idiomas habilitados para clasificar canciones (codigos)
    pub languages: Vec<String>,
    /// Probabilidad (%) de cada idioma en el AutoDJ; "" = sin idioma
    pub language_weights: HashMap<String, f64>,
    /// Avisos GET/POST ante eventos (cambio de cancion, errores...)
    pub notifications: Vec<crate::notify::Notification>,
    /// Intros superpuestos sobre el hueco inicio→intro de las canciones
    pub intros: IntroSettings,
    /// VU de la pantalla principal: "master" o "streaming"
    pub vu_source: String,
    /// Ventana de video de la emision
    pub video_screen: VideoScreenSettings,
    /// Ancho del panel de musica (px); 0 = automatico
    pub left_panel_width: f64,
    /// Chat de NGRADIO
    pub chat: ChatSettings,
    pub audio_engine: String,
    pub api: crate::rbapi::ApiConfig,
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
    /// Entradas y salidas habilitadas para la mesa.
    pub audio_devices: Vec<AudioDeviceSetting>,
    /// Analisis de metadatos con Ollama local.
    pub ai: AiSettings,
    /// Bus cuya señal muestra el VU de salida; vacio = salida general.
    pub monitor_bus_id: String,
    /// Tarjeta de salida del Master; vacio = salida predeterminada.
    pub master_output_device_id: String,
    /// Tarjeta de salida de monitorizacion/preescucha; vacio = predeterminada.
    pub monitor_output_device_id: String,
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
    /// Artista / bajada (el "artista" en los metadatos)
    pub subtitle: String,
    /// Metadatos como los de una cancion
    pub album: String,
    pub year: String,
    pub genre: String,
    /// Ruta de la imagen de portada
    pub cover: String,
    /// Hora de inicio prevista ("22:00"); vacio = sin hora
    pub starts_at: String,
    pub enabled: bool,
}

/// Entrada o salida de audio habilitada en Ajustes > Sonido.
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct AudioDeviceSetting {
    pub id: String,
    /// "audioinput" o "audiooutput"
    pub kind: String,
    /// Nombre del sistema
    pub label: String,
    /// Alias visible en la mesa; vacio = usar label
    pub name: String,
    pub enabled: bool,
}

/// Analisis de metadatos con un Ollama local.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct AiSettings {
    /// Direccion del servidor Ollama.
    pub url: String,
    /// Modelo que se usara para clasificar.
    pub model: String,
}

impl Default for AiSettings {
    fn default() -> Self {
        Self {
            url: "http://127.0.0.1:11434".to_string(),
            model: "llama3.1:8b".to_string(),
        }
    }
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
    /// Estereo: par de canales (1 = 1-2, 2 = 3-4...). Mono: canal (0 = mezcla L+R)
    pub channel: u32,
}

impl Default for MixerInput {
    fn default() -> Self {
        Self {
            kind: "app".to_string(),
            app: "music".to_string(),
            device_id: String::new(),
            channel: 0,
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
    /// Ganancia de entrada, antes de inserts y del fader.
    pub input_gain_db: f32,
    /// "off", "slow" o "fast"; si no es "off", ignora input_gain_db.
    pub agc: String,
    pub gain_db: f32,
    pub muted: bool,
    pub leveler: LevelerSettings,
    pub compressor: CompressorSettings,
    /// Plugins VST3 (motor nativo), en orden
    pub plugins: Vec<PluginSlot>,
    pub insert: InsertSettings,
    pub pan: f32,
    pub solo: bool,
    /// "", "sum", "left" o "right"
    pub mono_mode: String,
    pub sends: Vec<MixerSend>,
}

impl Default for MixerChannel {
    fn default() -> Self {
        Self {
            id: String::new(),
            name: String::new(),
            color: "#4f8cff".to_string(),
            input: MixerInput::default(),
            output: MixerOutput::default(),
            input_gain_db: 0.0,
            agc: "off".to_string(),
            gain_db: 0.0,
            muted: false,
            leveler: LevelerSettings::default(),
            compressor: CompressorSettings::default(),
            plugins: Vec::new(),
            insert: InsertSettings::default(),
            pan: 0.0,
            solo: false,
            mono_mode: String::new(),
            sends: Vec::new(),
        }
    }
}

/// Envio de un canal a un bus.
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct MixerSend {
    pub bus_id: String,
    pub gain_db: f32,
    pub pre: bool,
    pub muted: bool,
}

/// Insert (envio y retorno por tarjetas) de un canal o bus.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct InsertSettings {
    pub enabled: bool,
    pub send_device_id: String,
    pub return_device_id: String,
}

impl Default for InsertSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            send_device_id: String::new(),
            return_device_id: String::new(),
        }
    }
}

/// Nivelador automatico de ganancia de un canal o bus.
/// Un plugin VST3 en un canal o bus.
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct PluginSlot {
    pub id: String,
    pub path: String,
    pub name: String,
    /// false = bypass (cargado pero sin procesar)
    pub enabled: bool,
    /// Desactivado: ni se carga ni gasta CPU
    #[serde(default)]
    pub off: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct CompressorSettings {
    pub enabled: bool,
    pub threshold_db: f32,
    pub ratio: f32,
    pub attack_ms: f32,
    pub release_ms: f32,
    pub makeup_db: f32,
}

impl Default for CompressorSettings {
    fn default() -> Self {
        Self { enabled: false, threshold_db: -18.0, ratio: 3.0, attack_ms: 10.0, release_ms: 200.0, makeup_db: 0.0 }
    }
}

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
    pub compressor: CompressorSettings,
    /// Plugins VST3 (motor nativo), en orden
    pub plugins: Vec<PluginSlot>,
    pub insert: InsertSettings,
    pub pan: f32,
    pub sends: Vec<MixerSend>,
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
            compressor: CompressorSettings::default(),
            plugins: Vec::new(),
            insert: InsertSettings::default(),
            pan: 0.0,
            sends: Vec::new(),
        }
    }
}

/// Una franja de programacion con sus propios dias y horas.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct ScheduleBlock {
    pub id: String,
    pub days: Vec<u8>,
    pub times: Vec<String>,
    pub hourly: bool,
    pub minute: u8,
    pub start: String,
    pub end: String,
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
    /// Varias franjas; si esta vacio, se usan days/times/hourly/minute.
    pub schedules: Vec<ScheduleBlock>,
    /// Metadatos que se usan al emitir cada spot.
    pub meta: StreamMeta,
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
            schedules: Vec::new(),
            meta: StreamMeta::default(),
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
    /// Horas adicionales para eventos sin fin (auto/insert); vacio = usar `start`.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub times: Vec<String>,
    /// Varias franjas; si esta vacio, se usan days/start/times/end.
    pub schedules: Vec<ScheduleBlock>,
    /// "block" o "library"
    pub source_kind: String,
    /// id de bloque o "a"/"b"
    pub source_id: String,
    pub track_id: String,
    pub max_wait_secs: u32,
    /// "force" o "cancel"
    pub on_timeout: String,
    pub last_fired: String,
    /// "stream": hora de fin (HH:MM)
    pub end: String,
    /// "stream": direccion del audio de internet (o archivo)
    pub stream_url: String,
    /// "stream": fundido de entrada y salida (s)
    pub fade_secs: f64,
    /// "stream": datos que se muestran mientras suena
    pub meta: StreamMeta,
    /// "insert": "fixed" (pista concreta) o "random" (al azar de source_kind/source_id)
    pub track_mode: String,
    /// "random": dias sin repetir la misma pista a la misma hora (0 = sin regla)
    pub no_repeat_slot_days: u32,
    /// "random": dias sin repetir la misma pista en este evento
    pub no_repeat_event_days: u32,
    /// "random": minutos sin elegir pistas que hayan sonado en antena
    pub no_repeat_air_mins: u32,
    /// "random": pistas elegidas (para las reglas de repeticion)
    pub pick_log: Vec<PickEntry>,
}

/// Una pista elegida al azar por un evento.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct PickEntry {
    pub slot: String,
    pub track_id: String,
    /// Milisegundos desde epoch
    pub at: u64,
}

/// Metadatos de una emision de internet (como los de una cancion).
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct StreamMeta {
    pub title: String,
    pub artist: String,
    pub album: String,
    pub year: String,
    pub genre: String,
    pub comment: String,
    /// Ruta de la portada
    pub cover: String,
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
            times: Vec::new(),
            schedules: Vec::new(),
            source_kind: "library".to_string(),
            source_id: "a".to_string(),
            track_id: String::new(),
            max_wait_secs: 60,
            on_timeout: "cancel".to_string(),
            last_fired: String::new(),
            end: "07:00".to_string(),
            stream_url: String::new(),
            fade_secs: 3.0,
            meta: StreamMeta::default(),
            track_mode: "fixed".to_string(),
            no_repeat_slot_days: 7,
            no_repeat_event_days: 1,
            no_repeat_air_mins: 120,
            pick_log: Vec::new(),
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct VideoInput {
    pub id: String,
    pub name: String,
    /// "file", "rtmp", "ndi" o "capture"
    pub kind: String,
    pub source: String,
    /// Identificador del navegador para previsualizar una capturadora
    pub device_id: String,
    pub enabled: bool,
}

impl Default for VideoInput {
    fn default() -> Self {
        Self {
            id: String::new(),
            name: String::new(),
            kind: "file".to_string(),
            source: String::new(),
            device_id: String::new(),
            enabled: true,
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct VideoOutput {
    pub id: String,
    pub name: String,
    /// "screen", "decklink", "ndi" o "rtmp"
    pub kind: String,
    pub source: String,
    /// Entrada de video a emitir; "" = la de la pantalla externa.
    pub video_input_id: String,
    /// Respaldo si falla: "" = ninguno, "program" = pantalla de emision,
    /// "nowplaying" = lo que suena.
    pub fallback_video_input_id: String,
    /// "mixer" = salida Encoders; "input" = el de la propia entrada (NDI o
    /// capturadora); "device" = otro dispositivo de audio.
    pub audio_source: String,
    /// Dispositivo de audio de captura.
    pub audio_source_id: String,
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
            video_input_id: String::new(),
            fallback_video_input_id: String::new(),
            audio_source: "mixer".to_string(),
            audio_source_id: String::new(),
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
    /// FFmpeg compilado con NDI; vacio = usar el FFmpeg normal.
    pub ndi_ffmpeg_path: String,
}

impl Default for VideoSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            inputs: Vec::new(),
            outputs: Vec::new(),
            ndi_ffmpeg_path: String::new(),
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
pub struct RtmpOutput {
    pub enabled: bool,
    pub url: String,
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub bitrate_kbps: u32,
    pub keyframe_secs: u32,
    /// Entrada de video a emitir; "" = la de la pantalla externa.
    pub video_input_id: String,
    /// "mixer" = salida Encoders; "device" = audio de una capturadora.
    pub audio_source: String,
    pub audio_source_id: String,
}

impl Default for RtmpOutput {
    fn default() -> Self {
        Self {
            enabled: false,
            url: String::new(),
            width: 1920,
            height: 1080,
            fps: 25,
            bitrate_kbps: 6000,
            keyframe_secs: 2,
            video_input_id: String::new(),
            audio_source: "mixer".to_string(),
            audio_source_id: String::new(),
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
    pub rtmp: RtmpOutput,
    /// Empezar a emitir al abrir MiRadio
    pub auto_start: bool,
}

impl Default for StreamingSettings {
    fn default() -> Self {
        Self {
            icecast: Vec::new(),
            rtmp: RtmpOutput::default(),
            auto_start: false,
        }
    }
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            vst: VstSettings::default(),
            fade_seconds: 6,
            auto_play_on_start: false,
            silence_detection: false,
            silence_threshold_db: -55.0,
            past_visible: 5,
            languages: ["es", "en", "pt", "de", "fr"].iter().map(|s| s.to_string()).collect(),
            language_weights: HashMap::new(),
            notifications: Vec::new(),
            intros: IntroSettings::default(),
            vu_source: "master".into(),
            video_screen: VideoScreenSettings::default(),
            left_panel_width: 0.0,
            chat: ChatSettings::default(),
            audio_engine: "web".to_string(),
            api: crate::rbapi::ApiConfig::default(),
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
            audio_devices: Vec::new(),
            ai: AiSettings::default(),
            monitor_bus_id: String::new(),
            master_output_device_id: String::new(),
            monitor_output_device_id: String::new(),
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

pub fn read_history_public(data_dir: &PathBuf) -> Vec<HistoryEntry> {
    read_history(data_dir)
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
    let history = read_history(&state.data_dir);
    Ok(pick_tracks(&s, &library, &history, &playlist_track_ids, count, scope_kind, scope_id, now_epoch()))
}

/// Artistas de una ficha: "Alicia Keys, John Mayer" son dos. Minusculas y sin
/// espacios sobrantes; un campo vacio cuenta como un solo artista vacio.
pub fn artists_of(artist: &str) -> Vec<String> {
    let v: Vec<String> = artist
        .split(|c| c == ',' || c == ';')
        .map(|a| a.trim().to_lowercase())
        .filter(|a| !a.is_empty())
        .collect();
    if v.is_empty() {
        vec![artist.trim().to_lowercase()]
    } else {
        v
    }
}

/// Eleccion del AutoDJ (sin estado: se puede probar).
#[allow(clippy::too_many_arguments)]
pub fn pick_tracks(
    s: &Settings,
    library: &[Track],
    history: &[HistoryEntry],
    playlist_track_ids: &[String],
    count: u32,
    scope_kind: Option<String>,
    scope_id: Option<String>,
    now: u64,
) -> Vec<String> {
    if library.is_empty() || count == 0 {
        return vec![];
    }
    let mins = |m: u32| u64::from(m) * 60;

    let by_id: HashMap<&str, &Track> = library
        .iter()
        .map(|t| (t.id.as_str(), t))
        .collect();

    // Bloques activos del piloto automatico: vacio = toda la biblioteca.
    // Un evento activo puede sustituirlos por un bloque concreto o por una
    // de las dos bibliotecas.
    let mut pick_blocks = pick_block_ids(s);
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
    for h in history {
        if let Some(t) = by_id.get(h.track_id.as_str()) {
            let ti = t.title.to_lowercase();
            let e = last_track.entry(t.id.as_str()).or_insert(0);
            if h.played_at > *e {
                *e = h.played_at;
            }
            for ta in artists_of(&t.artist) {
                let e = last_artist.entry(ta).or_insert(0);
                if h.played_at > *e {
                    *e = h.played_at;
                }
            }
            let e = last_title.entry(ti).or_insert(0);
            if h.played_at > *e {
                *e = h.played_at;
            }
        }
    }

    // Artistas de las ultimas pistas de la lista actual, para no poner
    // dos del mismo artista seguidos.
    let tail_artists: Vec<Vec<String>> = playlist_track_ids
        .iter()
        .rev()
        .take(3)
        .filter_map(|id| by_id.get(id.as_str()))
        .map(|t| artists_of(&t.artist))
        .collect();

    let in_playlist: HashSet<&str> = playlist_track_ids.iter().map(|x| x.as_str()).collect();
    let salt = now ^ u64::from(std::process::id());

    // El bloque de intros no entra en la rotacion normal.
    let intro_block = s.intros.block_id.as_str();
    let is_intro = |t: &Track| !intro_block.is_empty() && t.blocks.iter().any(|b| b == intro_block) && !pick_blocks.contains(intro_block);

    let mut candidates: Vec<Candidate> = Vec::new();
    let mut in_scope: HashSet<&str> = HashSet::new();
    for t in library {
        if is_intro(t) {
            continue;
        }
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
        // Todos los artistas de la ficha deben cumplir el tiempo.
        let ok_artist = artists_of(&t.artist)
            .iter()
            .all(|a| now.saturating_sub(*last_artist.get(a).unwrap_or(&0)) >= mins(s.repeat_artist_minutes));
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
        for t in library {
            if in_playlist.contains(t.id.as_str()) || is_intro(t) {
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

    let artist_of = |id: &str| -> Vec<String> { by_id.get(id).map(|t| artists_of(&t.artist)).unwrap_or_default() };

    // Probabilidad de cada idioma (%). Sin pesos: todos los idiomas igual.
    let weights: HashMap<String, f64> = s
        .language_weights
        .iter()
        .filter(|(_, w)| w.is_finite() && **w > 0.0)
        .map(|(k, w)| (k.trim().to_ascii_lowercase(), *w))
        .collect();
    let lang_of = |id: &str| -> String { by_id.get(id).map(|t| t.language.clone()).unwrap_or_default() };
    let mut rng = salt | 1;
    let mut next_rand = move || {
        // xorshift64: suficiente para repartir idiomas
        rng ^= rng << 13;
        rng ^= rng >> 7;
        rng ^= rng << 17;
        (rng >> 11) as f64 / (1u64 << 53) as f64
    };

    // Pasada 1: respetando artistas consecutivos. Pasada 2: relajada
    // (biblioteca pequena).
    let mut result: Vec<String> = Vec::new();
    for relax in [false, true] {
        let mut picked: Vec<String> = Vec::new();
        let mut tail = tail_artists.clone();
        let mut used: HashSet<&str> = HashSet::new();
        while picked.len() < count as usize {
            let eligible: Vec<&Candidate> = candidates
                .iter()
                .filter(|c| !used.contains(c.id.as_str()))
                .filter(|c| {
                    relax
                        || !s.avoid_consecutive_artist
                        || tail.last().map(|a| !a.iter().any(|x| artist_of(&c.id).contains(x))).unwrap_or(true)
                })
                .collect();
            let Some(first) = eligible.first() else { break };
            let mut chosen: &Candidate = first;
            if !weights.is_empty() {
                // Idiomas disponibles ahora mismo, con su peso.
                let mut avail: Vec<(String, f64)> = Vec::new();
                for c in &eligible {
                    let l = lang_of(&c.id);
                    if avail.iter().any(|(x, _)| *x == l) {
                        continue;
                    }
                    if let Some(w) = weights.get(&l) {
                        avail.push((l, *w));
                    }
                }
                let total: f64 = avail.iter().map(|(_, w)| w).sum();
                if total > 0.0 {
                    let mut r = next_rand() * total;
                    let mut lang = avail[0].0.clone();
                    for (l, w) in &avail {
                        if r < *w {
                            lang = l.clone();
                            break;
                        }
                        r -= w;
                    }
                    if let Some(c) = eligible.iter().find(|c| lang_of(&c.id) == lang) {
                        chosen = c;
                    }
                }
            }
            used.insert(chosen.id.as_str());
            picked.push(chosen.id.clone());
            tail.push(artist_of(&chosen.id));
        }
        if result.len() < picked.len() {
            result = picked;
        }
        if result.len() >= count as usize {
            break;
        }
    }
    result
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

#[cfg(test)]
mod language_tests {
    use super::*;

    fn lib() -> Vec<Track> {
        (0..300)
            .map(|i| {
                let mut t: Track = serde_json::from_value(serde_json::json!({
                    "id": format!("t{i}"), "title": format!("T{i}"), "artist": format!("A{i}"),
                    "durationSecs": 200.0, "file": "", "blocks": [], "tags": []
                }))
                .unwrap();
                t.language = if i % 3 == 0 { "en".into() } else if i % 3 == 1 { "es".into() } else { String::new() };
                t
            })
            .collect()
    }

    fn count(picked: &[String], lib: &[Track], lang: &str) -> usize {
        picked.iter().filter(|id| lib.iter().any(|t| &t.id == *id && t.language == lang)).count()
    }

    #[test]
    fn weights_shape_the_mix() {
        let library = lib();
        let mut s = Settings::default();
        s.language_weights.insert("es".into(), 80.0);
        s.language_weights.insert("en".into(), 20.0);
        let mut es = 0;
        let mut en = 0;
        let mut none = 0;
        for k in 0..20u64 {
            let p = pick_tracks(&s, &library, &[], &[], 50, None, None, 1_000_000 + k * 7919);
            assert_eq!(p.len(), 50);
            es += count(&p, &library, "es");
            en += count(&p, &library, "en");
            none += count(&p, &library, "");
        }
        let total = (es + en + none) as f64;
        assert!(none == 0, "sin idioma con peso 0 no entra mientras haya otros: {none}");
        let pct = es as f64 / total * 100.0;
        assert!((70.0..90.0).contains(&pct), "es {pct:.1}% (en {en})");
    }

    #[test]
    fn no_weights_keeps_everything() {
        let library = lib();
        let s = Settings::default();
        let p = pick_tracks(&s, &library, &[], &[], 90, None, None, 42);
        assert_eq!(p.len(), 90);
        assert!(count(&p, &library, "") > 0 && count(&p, &library, "en") > 0);
    }

    #[test]
    fn falls_back_when_language_runs_out() {
        let library = lib();
        let mut s = Settings::default();
        s.language_weights.insert("de".into(), 100.0); // nadie en aleman
        let p = pick_tracks(&s, &library, &[], &[], 10, None, None, 7);
        assert_eq!(p.len(), 10, "no deja la lista sin canciones");
    }
}

#[cfg(test)]
mod artist_tests {
    use super::*;

    #[test]
    fn split_artists() {
        assert_eq!(artists_of("Alicia Keys, John Mayer"), vec!["alicia keys", "john mayer"]);
        assert_eq!(artists_of("  John Mayer "), vec!["john mayer"]);
        assert_eq!(artists_of(""), vec![""]);
    }

    fn t(id: &str, artist: &str) -> Track {
        serde_json::from_value(serde_json::json!({
            "id": id, "title": id, "artist": artist, "durationSecs": 200.0, "file": "", "blocks": [], "tags": []
        }))
        .unwrap()
    }

    #[test]
    fn collaboration_counts_for_each_artist() {
        let library = vec![t("a", "John Mayer"), t("b", "Alicia Keys, John Mayer"), t("c", "Queen")];
        let now = 10_000_000u64;
        let history = vec![HistoryEntry { track_id: "a".into(), played_at: now - 600 }];
        let mut s = Settings::default();
        s.repeat_artist_minutes = 120;
        s.repeat_track_minutes = 0;
        s.repeat_title_minutes = 0;
        let p = pick_tracks(&s, &library, &history, &[], 1, None, None, now);
        assert_eq!(p, vec!["c".to_string()], "con Mayer reciente no puede salir el feat.");
    }

    #[test]
    fn no_consecutive_with_collaborator() {
        let library = vec![t("a", "John Mayer"), t("b", "Alicia Keys, John Mayer"), t("c", "Queen")];
        let mut s = Settings::default();
        s.repeat_artist_minutes = 0;
        s.avoid_consecutive_artist = true;
        let p = pick_tracks(&s, &library, &[], &["a".to_string()], 1, None, None, 5);
        assert_ne!(p, vec!["b".to_string()]);
    }

    #[test]
    fn random_event_fields_roundtrip_and_default() {
        // Un evento guardado antes de existir la pista aleatoria sigue valiendo.
        let old: StationEvent = serde_json::from_str(r#"{"id":"e1","name":"Himno","kind":"insert","start":"08:00","trackId":"t1"}"#).unwrap();
        assert_eq!(old.track_mode, "fixed");
        assert_eq!((old.no_repeat_slot_days, old.no_repeat_event_days, old.no_repeat_air_mins), (7, 1, 120));
        assert!(old.pick_log.is_empty());
        let json = r#"{"id":"e2","kind":"insert","trackMode":"random","sourceKind":"block","sourceId":"b1",
            "noRepeatSlotDays":14,"noRepeatEventDays":0,"noRepeatAirMins":30,
            "pickLog":[{"slot":"08:15","trackId":"t9","at":1761290000000}]}"#;
        let e: StationEvent = serde_json::from_str(json).unwrap();
        assert_eq!(e.track_mode, "random");
        assert_eq!((e.no_repeat_slot_days, e.no_repeat_event_days, e.no_repeat_air_mins), (14, 0, 30));
        assert_eq!(e.pick_log, vec![PickEntry { slot: "08:15".into(), track_id: "t9".into(), at: 1_761_290_000_000 }]);
        let back: StationEvent = serde_json::from_str(&serde_json::to_string(&e).unwrap()).unwrap();
        assert_eq!(back.pick_log, e.pick_log);
    }
}
