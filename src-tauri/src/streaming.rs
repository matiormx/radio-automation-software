use serde::Serialize;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Instant;
use std::sync::mpsc::{self, SyncSender, TrySendError};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Manager, State};

use crate::settings::{IcecastStream, Settings, VideoInput, VideoOutput, VideoSettings};

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
#[cfg(windows)]
const ABOVE_NORMAL_PRIORITY_CLASS: u32 = 0x0000_8000;

#[derive(Default)]
struct EngineInner {
    ffmpeg: Option<PathBuf>,
    processes: Vec<StreamProcess>,
    failed_outputs: Vec<StreamOutputStatus>,
    last_error: Option<String>,
}

/// Salida NDI nativa: FFmpeg (el normal) solo captura la imagen y la da en
/// BGRA por su salida; MiRadio la manda por NDI junto al audio de la mesa.
#[derive(Clone)]
struct NdiOut {
    name: String,
    width: u32,
    height: u32,
    fps: u32,
}

/// Como arrancar FFmpeg para una salida.
#[derive(Clone)]
struct Spec {
    ffmpeg: PathBuf,
    args: Vec<String>,
    wants_audio: bool,
    ndi_out: Option<NdiOut>,
}

/// Que hacer si la salida se cae o se cuelga: volver a arrancarla (con
/// espera creciente) y, si tiene respaldo, alternar entre principal y respaldo.
struct Restart {
    primary: Spec,
    backup: Option<Spec>,
    on_backup: bool,
    /// Caidas seguidas sin llegar a aguantar un minuto
    fails: u32,
}

impl Restart {
    fn new(primary: Spec, backup: Option<Spec>) -> Restart {
        Restart { primary, backup, on_backup: false, fails: 0 }
    }
}

/// Segundos sin avanzar para dar por colgada una salida (y margen al arrancar).
#[cfg(not(test))]
const STALL_SECS: u64 = 15;
#[cfg(not(test))]
const STALL_START_SECS: u64 = 40;
#[cfg(test)]
const STALL_SECS: u64 = 3;
#[cfg(test)]
const STALL_START_SECS: u64 = 5;

/// Avance de FFmpeg (de -progress): si out_time no sube, esta colgado.
struct Progress {
    value: String,
    at: Instant,
    seen: bool,
}

struct StreamProcess {
    id: String,
    name: String,
    kind: String,
    wants_audio: bool,
    alive: bool,
    child: Child,
    /// Cola hacia el hilo que escribe en FFmpeg (si la red va lenta, el motor
    /// de audio nunca se queda esperando).
    tx: Option<SyncSender<Vec<u8>>>,
    failed: Arc<AtomicBool>,
    error: Arc<Mutex<Option<String>>>,
    log: Arc<Mutex<Vec<String>>>,
    restart: Option<Restart>,
    /// Compartido con su supervisor; true = la detuvo el usuario
    cancel: Arc<AtomicBool>,
    progress: Arc<Mutex<Progress>>,
    started: Instant,
    warned_full: bool,
}

impl StreamProcess {
    fn supervised(&self) -> bool {
        self.restart.is_some() && !self.cancel.load(Ordering::SeqCst)
    }
}

/// Trozos de PCM que puede acumular un encoder antes de descartar (~10 s).
const QUEUE_CHUNKS: usize = 512;

pub struct StreamingState {
    inner: Arc<Mutex<EngineInner>>,
}

impl Default for StreamingState {
    fn default() -> Self {
        Self {
            inner: Arc::new(Mutex::new(EngineInner::default())),
        }
    }
}

impl Drop for StreamingState {
    fn drop(&mut self) {
        if let Ok(mut inner) = self.inner.lock() {
            stop_all(&mut inner);
        }
    }
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct StreamProbe {
    pub available: bool,
    pub path: Option<String>,
    pub version: Option<String>,
    pub error: Option<String>,
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct NdiProbe {
    pub available: bool,
    pub ffmpeg: Option<String>,
    pub device: Option<String>,
    pub runtime: bool,
    pub sources: Vec<String>,
    pub error: Option<String>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct StreamOutputStatus {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub running: bool,
    /// "live", "stopped" o "error".
    pub state: String,
    pub error: Option<String>,
    /// Ultimas lineas de FFmpeg, para diagnosticar conexiones y fuentes.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub log: Option<String>,
}

fn failed_output(id: &str, name: &str, kind: &str, error: String) -> StreamOutputStatus {
    StreamOutputStatus {
        id: id.to_string(),
        name: name.to_string(),
        kind: kind.to_string(),
        running: false,
        state: "error".to_string(),
        error: Some(error),
        log: None,
    }
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct StreamStatus {
    pub running: bool,
    pub needs_audio: bool,
    pub ffmpeg: Option<String>,
    pub outputs: Vec<StreamOutputStatus>,
    pub last_error: Option<String>,
}

#[tauri::command]
pub fn stream_probe(app: AppHandle) -> StreamProbe {
    match find_ffmpeg(&app) {
        Some(path) => match probe_ffmpeg(&path) {
            Ok(version) => StreamProbe {
                available: true,
                path: Some(path.display().to_string()),
                version: Some(version),
                error: None,
            },
            Err(error) => StreamProbe {
                available: false,
                path: Some(path.display().to_string()),
                version: None,
                error: Some(error),
            },
        },
        None => StreamProbe {
            available: false,
            path: None,
            version: None,
            error: Some(crate::ffmpeg_dl::missing_message()),
        },
    }
}

#[tauri::command]
pub async fn ndi_probe(app: AppHandle, ffmpeg_path: String) -> NdiProbe {
    tauri::async_runtime::spawn_blocking(move || probe_ndi(&app, &ffmpeg_path))
        .await
        .unwrap_or_else(|error| NdiProbe {
            available: false,
            error: Some(format!("No se pudo comprobar NDI: {error}")),
            ..NdiProbe::default()
        })
}

#[tauri::command]
pub fn stream_status(app: AppHandle, state: State<StreamingState>) -> StreamStatus {
    let mut inner = match state.inner.lock() {
        Ok(inner) => inner,
        Err(_) => return empty_status(None, Some("El motor de emisión no responde".to_string())),
    };
    if inner.ffmpeg.is_none() {
        inner.ffmpeg = find_ffmpeg(&app);
    }
    status_from(&mut inner)
}

#[tauri::command]
pub fn stream_start(
    app: AppHandle,
    state: State<StreamingState>,
    settings: Settings,
    group: Option<String>,
) -> Result<StreamStatus, String> {
    let group = group.as_deref().unwrap_or("all");
    let want_audio = group != "video";
    let want_video = group != "audio";
    let ffmpeg = find_ffmpeg(&app)
        .or_else(|| {
            find_ndi_ffmpeg(&app, &settings.video.ndi_ffmpeg_path)
                .ok()
                .map(|(path, _)| path)
        })
        .ok_or_else(|| {
            crate::ffmpeg_dl::missing_message()
        })?;

    let mut inner = state
        .inner
        .lock()
        .map_err(|_| "El motor de emisión no responde".to_string())?;
    stop_group(&mut inner, group);
    inner.ffmpeg = Some(ffmpeg.clone());
    inner.last_error = None;

    let shared = state.inner.clone();
    let mut errors: Vec<String> = Vec::new();
    let mut requested = 0usize;

    let needs_ndi = (settings.video.enabled
        && settings
            .video
            .outputs
            .iter()
            .any(|o| o.enabled && o.kind == "ndi"))
        || settings
            .video
            .inputs
            .iter()
            .any(|i| i.enabled && i.kind == "ndi");
    let ndi = if needs_ndi {
        find_ndi_ffmpeg(&app, &settings.video.ndi_ffmpeg_path).ok()
    } else {
        None
    };
    let ndi_device = ndi.as_ref().map(|(_, device)| device.as_str());
    let ndi_ffmpeg = ndi.as_ref().map(|(path, _)| path.as_path());
    // La entrada que se ve en la pantalla externa es la que emiten las salidas.
    let preferred_input = if settings.video_screen.source == "capture" {
        let id = settings.video_screen.capture_input_id.trim();
        if id.is_empty() { None } else { Some(id) }
    } else {
        None
    };
    let selected_input_is_ndi = pick_video_input(&settings.video, preferred_input)
        .map(|input| input.kind == "ndi")
        .unwrap_or(false)
        // Con el NDI Runtime basta el FFmpeg normal.
        && crate::ndi::runtime().is_err();
    let video_ffmpeg = if selected_input_is_ndi {
        ndi_ffmpeg.unwrap_or(&ffmpeg)
    } else {
        &ffmpeg
    };
    let needs_program = settings.video.outputs.iter().any(|output| {
        output.enabled
            && (output.kind == "rtmp" || output.kind == "screen")
            && (output.fallback_video_input_id == "program"
                || output.fallback_video_input_id == "nowplaying"
                || output.video_input_id.trim() == "nowplaying"
                || output.video_input_id.trim().is_empty()
                || output.video_input_id.trim() == "program")
    });
    let gfxcapture = cfg!(windows) && needs_program && has_filter(&ffmpeg, "gfxcapture");
    let ddagrab = cfg!(windows) && needs_program && !gfxcapture && has_filter(&ffmpeg, "ddagrab");

    if want_audio {
    for stream in settings.streaming.icecast.iter().filter(|s| s.enabled) {
        requested += 1;
        let id = format!("icecast:{}", stream.id);
        let name = if stream.name.trim().is_empty() {
            "Icecast".to_string()
        } else {
            stream.name.clone()
        };
        let output_id = id.clone();
        let output_name = name.clone();
        match icecast_args(stream) {
            Ok(args) => {
                let restart = Restart::new(Spec { ffmpeg: ffmpeg.clone(), args: args.clone(), wants_audio: true, ndi_out: None }, None);
                if let Err(error) = spawn_process(
                    &mut inner,
                    &shared,
                    &ffmpeg,
                    args,
                    id,
                    name,
                    "icecast",
                    true,
                    Some(restart),
                ) {
                    errors.push(error.clone());
                    inner.failed_outputs.push(failed_output(
                        &output_id,
                        &output_name,
                        "icecast",
                        error,
                    ));
                }
            }
            Err(error) => {
                let message = format!("{name}: {error}");
                errors.push(message.clone());
                inner.failed_outputs.push(failed_output(
                    &output_id,
                    &output_name,
                    "icecast",
                    message,
                ));
            }
        }
    }
    }

    if want_video && settings.video.enabled {
        // Tope de resolucion (Ajustes > Video): todas las salidas a 720p, p. ej.
        let capped: Vec<crate::settings::VideoOutput> =
            settings.video.outputs.iter().filter(|o| o.enabled).map(|o| settings.video.capped(o)).collect();
        for output in capped.iter() {
            requested += 1;
            let id = format!("video:{}", output.id);
            let name = if output.name.trim().is_empty() {
                output.kind.clone()
            } else {
                output.name.clone()
            };
            let kind = output.kind.clone();
            let video_choice = output.video_input_id.trim();
            // "" y "program" emiten la ventana de programa (lo que suena).
            // "nowplaying": la ventana que siempre enseña lo que suena (sin camaras).
            let use_np = video_choice == "nowplaying";
            let use_program = video_choice.is_empty() || video_choice == "program" || use_np;
            let output_video = if use_program {
                None
            } else {
                Some(video_choice)
            };
            // "input" = el audio de la propia entrada de video (NDI o capturadora).
            let input_audio: Option<String> = if output.audio_source == "input" && !use_program {
                settings.video.inputs.iter().find(|i| i.id == video_choice).and_then(|i| match i.kind.as_str() {
                    "ndi" => Some(format!("ndi:{}", i.source.trim())),
                    "capture" => Some(i.source.trim().to_string()),
                    _ => None,
                })
            } else {
                None
            };
            let output_audio = if output.audio_source == "device" {
                Some(output.audio_source_id.trim()).filter(|id| !id.is_empty())
            } else {
                input_audio.as_deref()
            };
            // Salida NDI con el NDI Runtime (sin FFmpeg con NDI): FFmpeg solo
            // captura la imagen y MiRadio la envia por NDI con el audio de la mesa.
            if kind == "ndi" && crate::ndi::runtime().is_ok() {
                let (w, h, fps) = (output.width.max(16) & !1, output.height.max(16) & !1, output.fps.clamp(1, 60));
                let video_args = if use_program {
                    program_args(fps, settings.video_screen.monitor, gfxcapture, ddagrab, use_np)
                } else {
                    match settings.video.inputs.iter().find(|i| i.id == video_choice) {
                        Some(input) if input.kind == "ndi" => Err(
                            "una fuente NDI no se reenvía por NDI: elige la pantalla de emisión".to_string(),
                        ),
                        Some(input) => video_input_args(input, None),
                        None => Err("la entrada de vídeo elegida no existe".to_string()),
                    }
                };
                let ndi_name = {
                    let src = output.source.trim();
                    if !src.is_empty() { src.to_string() } else if !output.name.trim().is_empty() { output.name.trim().to_string() } else { "MiRadio".to_string() }
                };
                let result = video_args.and_then(|video_args| {
                    let mut args: Vec<String> = ["-hide_banner", "-loglevel", "warning", "-nostdin"].iter().map(|x| x.to_string()).collect();
                    args.extend(video_args);
                    args.extend([
                        arg("-an"),
                        arg("-vf"),
                        format!("scale={w}:{h}:force_original_aspect_ratio=decrease,pad={w}:{h}:(ow-iw)/2:(oh-ih)/2,fps={fps},format=bgra"),
                        arg("-f"),
                        arg("rawvideo"),
                        arg("-pix_fmt"),
                        arg("bgra"),
                        arg("pipe:1"),
                    ]);
                    let out = NdiOut { name: ndi_name, width: w, height: h, fps };
                    let restart = Restart::new(
                        Spec { ffmpeg: ffmpeg.clone(), args: args.clone(), wants_audio: false, ndi_out: Some(out.clone()) },
                        None,
                    );
                    spawn_process_ex(
                        &mut inner,
                        &shared,
                        &ffmpeg,
                        args,
                        id.clone(),
                        name.clone(),
                        &kind,
                        false,
                        Some(restart),
                        Some(out),
                        None,
                    )
                });
                if let Err(error) = result {
                    let message = format!("{name}: {error}");
                    errors.push(message.clone());
                    inner.failed_outputs.push(failed_output(&id, &name, &kind, message));
                }
                continue;
            }
            let args = if use_program && kind == "rtmp" {
                program_args(output.fps, settings.video_screen.monitor, gfxcapture, ddagrab, use_np).and_then(|video_args| {
                    rtmp_args_for_video(
                        video_args,
                        &output.source,
                        output.width,
                        output.height,
                        output.fps,
                        output.bitrate_kbps,
                        2,
                        output_audio,
                        false,
                    )
                })
            } else if use_program && kind == "screen" {
                program_args(output.fps, settings.video_screen.monitor, gfxcapture, ddagrab, use_np)
                    .and_then(|video_args| video_output_args_for_source(output, video_args))
            } else {
                match kind.as_str() {
                "screen" | "decklink" => {
                    video_output_args(output, &settings.video, ndi_device, output_video)
                }
                "rtmp" => rtmp_args(
                    &settings.video,
                    &output.source,
                    output.width,
                    output.height,
                    output.fps,
                    output.bitrate_kbps,
                    2,
                    ndi_device,
                    output_video,
                    output_audio,
                ),
                "ndi" => match ndi.as_ref() {
                    Some((_, device)) => {
                        let source = if output.source.trim().is_empty() {
                            if output.name.trim().is_empty() {
                                "MiRadio"
                            } else {
                                output.name.trim()
                            }
                        } else {
                            output.source.trim()
                        };
                        ndi_args(
                            &settings.video,
                            source,
                            output.width,
                            output.height,
                            output.fps,
                            device,
                            ndi_device,
                            output_video,
                            output_audio,
                        )
                    }
                    None => Err(
                        "NDI no disponible: indica un FFmpeg con soporte NDI en Ajustes > Vídeo > NDI"
                            .to_string(),
                    ),
                },
                other => Err(format!("Tipo de salida de vídeo desconocido: {other}")),
                }
            };
            match args {
                Ok(args) => {
                    // La tuberia de audio de la mesa se alimenta siempre (aunque el
                    // audio elegido sea otro): FFmpeg no se queda esperandola y el
                    // respaldo tiene sonido desde el primer momento.
                    let wants_audio = kind == "rtmp" || kind == "ndi";
                    let process_ffmpeg = if kind == "ndi" {
                        ndi_ffmpeg.unwrap_or(&ffmpeg)
                    } else {
                        video_ffmpeg
                    };
                    // Respaldo automatico cuando la entrada principal se pierde.
                    let fallback = if kind == "rtmp" || kind == "screen" {
                        let backup = output.fallback_video_input_id.trim();
                        if backup.is_empty() {
                            None
                        } else {
                            let backup_np = backup == "nowplaying";
                            let backup_is_ndi = backup != "program"
                                && !backup_np
                                && settings
                                    .video
                                    .inputs
                                    .iter()
                                    .find(|input| input.id == backup)
                                    .map(|input| input.kind == "ndi")
                                    .unwrap_or(false)
                                && crate::ndi::runtime().is_err();
                            let backup_ffmpeg = if backup == "program" || backup_np {
                                ffmpeg.as_path()
                            } else if backup_is_ndi {
                                ndi_ffmpeg.unwrap_or(video_ffmpeg)
                            } else {
                                video_ffmpeg
                            };
                            let backup_args = if backup == "program" || backup_np {
                                program_args(output.fps, settings.video_screen.monitor, gfxcapture, ddagrab, backup_np).and_then(|video_args| {
                                    if kind == "rtmp" {
                                        rtmp_args_for_video(
                                            video_args,
                                            &output.source,
                                            output.width,
                                            output.height,
                                            output.fps,
                                            output.bitrate_kbps,
                                            2,
                                            // El respaldo lleva siempre el audio de la mesa:
                                            // si cae la fuente, su sonido tambien.
                                            None,
                                            false,
                                        )
                                    } else {
                                        video_output_args_for_source(output, video_args)
                                    }
                                })
                            } else if kind == "rtmp" {
                                rtmp_args(
                                    &settings.video,
                                    &output.source,
                                    output.width,
                                    output.height,
                                    output.fps,
                                    output.bitrate_kbps,
                                    2,
                                    ndi_device,
                                    Some(backup),
                                    None,
                                )
                            } else {
                                video_output_args(output, &settings.video, ndi_device, Some(backup))
                            };
                            match backup_args {
                                Ok(args) => Some(Spec {
                                    ffmpeg: backup_ffmpeg.to_path_buf(),
                                    args,
                                    wants_audio: kind == "rtmp",
                                    ndi_out: None,
                                }),
                                Err(error) => {
                                    errors.push(format!("{name} (respaldo): {error}"));
                                    None
                                }
                            }
                        }
                    } else {
                        None
                    };
                    let restart = Restart::new(
                        Spec { ffmpeg: process_ffmpeg.to_path_buf(), args: args.clone(), wants_audio, ndi_out: None },
                        fallback,
                    );
                    if let Err(error) = spawn_process(
                        &mut inner,
                        &shared,
                        process_ffmpeg,
                        args,
                        id.clone(),
                        name.clone(),
                        &kind,
                        wants_audio,
                        Some(restart),
                    ) {
                        errors.push(error.clone());
                        inner
                            .failed_outputs
                            .push(failed_output(&id, &name, &kind, error));
                    }
                }
                Err(error) => {
                    let message = format!("{name}: {error}");
                    errors.push(message.clone());
                    inner
                        .failed_outputs
                        .push(failed_output(&id, &name, &kind, message));
                }
            }
        }
    }

    if requested == 0 {
        return Err(match group {
            "audio" => "No hay salidas de audio activas. Activa una emisión Icecast.".to_string(),
            "video" => "No hay salidas de vídeo activas. Activa una salida en Streaming.".to_string(),
            _ => "No hay salidas activas. Activa una emisión Icecast, RTMP o un canal de vídeo.".to_string(),
        });
    }
    if !errors.is_empty() {
        inner.last_error = Some(errors.join(" · "));
    }
    // Aunque no arranque ninguna salida, devolvemos el estado con los errores
    // por salida para que Ajustes pueda mostrar qué emisión falló.
    Ok(status_from(&mut inner))
}

#[tauri::command]
pub fn stream_stop(state: State<StreamingState>, group: Option<String>) -> StreamStatus {
    let mut inner = match state.inner.lock() {
        Ok(inner) => inner,
        Err(_) => return empty_status(None, Some("El motor de emisión no responde".to_string())),
    };
    stop_group(&mut inner, group.as_deref().unwrap_or("all"));
    inner.last_error = None;
    status_from(&mut inner)
}

#[tauri::command]
pub async fn stream_push_pcm(
    state: State<'_, StreamingState>,
    data: Vec<u8>,
) -> Result<(), String> {
    if data.len() > 2 * 1024 * 1024 {
        return Err("El fragmento PCM es demasiado grande".to_string());
    }
    let shared = state.inner.clone();
    tauri::async_runtime::spawn_blocking(move || push_pcm(&shared, &data))
    .await
    .map_err(|error| format!("No se pudo enviar el audio: {error}"))?
}

fn empty_status(ffmpeg: Option<String>, error: Option<String>) -> StreamStatus {
    StreamStatus {
        running: false,
        needs_audio: false,
        ffmpeg,
        outputs: Vec::new(),
        last_error: error,
    }
}

fn status_from(inner: &mut EngineInner) -> StreamStatus {
    let mut last_error = inner.last_error.clone();
    for process in inner.processes.iter_mut() {
        if !process.alive {
            continue;
        }
        match process.child.try_wait() {
            Ok(Some(status)) => {
                process.alive = false;
                if !status.success() {
                    let message = format!(
                        "{} se detuvo inesperadamente ({status})",
                        process.name
                    );
                    if let Ok(mut slot) = process.error.lock() {
                        if slot.is_none() {
                            *slot = Some(message.clone());
                        }
                    }
                    if last_error.is_none() {
                        last_error = Some(message);
                    }
                }
            }
            Ok(None) => {}
            Err(error) => {
                process.alive = false;
                let message = format!("{}: {error}", process.name);
                if let Ok(mut slot) = process.error.lock() {
                    *slot = Some(message.clone());
                }
                last_error = Some(message);
            }
        }
    }
    inner.last_error = last_error.clone();
    let mut outputs: Vec<StreamOutputStatus> = inner
        .processes
        .iter()
        .map(|process| {
            let error = process
                .error
                .lock()
                .ok()
                .and_then(|slot| Option::clone(&*slot));
            let log = process.log.lock().ok().map(|lines| lines.join(" | "));
            let reconnecting = !process.alive && process.supervised();
            let state = if process.alive {
                "live"
            } else if reconnecting {
                "reconnecting"
            } else if error.is_some() {
                "error"
            } else {
                "stopped"
            };
            StreamOutputStatus {
                id: process.id.clone(),
                name: process.name.clone(),
                kind: process.kind.clone(),
                running: process.alive || reconnecting,
                state: state.to_string(),
                error,
                log,
            }
        })
        .collect();
    outputs.extend(inner.failed_outputs.iter().cloned());
    StreamStatus {
        running: outputs.iter().any(|output| output.running),
        needs_audio: inner
            .processes
            .iter()
            .any(|process| (process.alive || process.supervised()) && process.wants_audio),
        ffmpeg: inner.ffmpeg.as_ref().map(|path| path.display().to_string()),
        outputs,
        last_error,
    }
}

fn spawn_process(
    inner: &mut EngineInner,
    shared: &Arc<Mutex<EngineInner>>,
    ffmpeg: &Path,
    args: Vec<String>,
    id: String,
    name: String,
    kind: &str,
    wants_audio: bool,
    restart: Option<Restart>,
) -> Result<(), String> {
    spawn_process_ex(inner, shared, ffmpeg, args, id, name, kind, wants_audio, restart, None, None)
}

#[allow(clippy::too_many_arguments)]
fn spawn_process_ex(
    inner: &mut EngineInner,
    shared: &Arc<Mutex<EngineInner>>,
    ffmpeg: &Path,
    args: Vec<String>,
    id: String,
    name: String,
    kind: &str,
    wants_audio: bool,
    restart: Option<Restart>,
    ndi_out: Option<NdiOut>,
    // Al rearrancar se reutiliza el del supervisor (que ya esta en marcha).
    cancel: Option<Arc<AtomicBool>>,
) -> Result<(), String> {
    // Con NDI nativo se crea antes la salida: si falta el Runtime, no se arranca nada.
    let ndi_sender = match &ndi_out {
        Some(o) => Some(Arc::new(crate::ndi::Sender::new(&o.name).map_err(|e| format!("{name}: {e}"))?)),
        None => None,
    };
    let mut command = Command::new(ffmpeg);
    command
        // Avance por stderr: el supervisor ve si FFmpeg se queda colgado.
        .args(["-progress", "pipe:2"])
        .args(&args)
        .stdin(Stdio::piped())
        .stdout(if ndi_out.is_some() { Stdio::piped() } else { Stdio::null() })
        .stderr(Stdio::piped());
    configure_no_window(&mut command);
    // El encoder va con prioridad superior a la normal: si el equipo anda
    // justo de CPU (interfaz, antivirus...) el audio emitido no se entrecorta.
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(CREATE_NO_WINDOW | ABOVE_NORMAL_PRIORITY_CLASS);
    }
    let mut child = command
        .spawn()
        .map_err(|error| format!("{name}: no se pudo iniciar FFmpeg ({error})"))?;

    let progress = Arc::new(Mutex::new(Progress { value: String::new(), at: Instant::now(), seen: false }));
    let error_slot = Arc::new(Mutex::new(None));
    let log_slot = Arc::new(Mutex::new(Vec::new()));
    {
        let shown = sanitize_error(&args.join(" "));
        if let Ok(mut lines) = log_slot.lock() {
            lines.push(format!("$ ffmpeg {shown}"));
        }
    }
    if let Some(stderr) = child.stderr.take() {
        let shared = shared.clone();
        let slot = error_slot.clone();
        let log = log_slot.clone();
        let progress = progress.clone();
        std::thread::spawn(move || {
            let reader = BufReader::new(stderr);
            for line in reader.lines() {
                let Ok(line) = line else { break };
                let line = line.trim();
                if line.is_empty() {
                    continue;
                }
                // Lineas de -progress (clave=valor, sin espacios): no van al registro.
                if let Some((key, value)) = line.split_once('=') {
                    if !key.is_empty() && !line.contains(' ') && key.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_') {
                        if key == "out_time_us" {
                            if let Ok(mut p) = progress.lock() {
                                if value != p.value && value != "N/A" {
                                    p.value = value.to_string();
                                    p.at = Instant::now();
                                    p.seen = true;
                                }
                            }
                        }
                        continue;
                    }
                }
                let clean = sanitize_error(line);
                if let Ok(mut lines) = log.lock() {
                    lines.push(clean.clone());
                    if lines.len() > 16 {
                        lines.remove(0);
                    }
                }
                if !is_error_line(line) {
                    continue;
                }
                if let Ok(mut slot) = slot.lock() {
                    *slot = Some(clean.clone());
                }
                if let Ok(mut inner) = shared.lock() {
                    inner.last_error = Some(clean);
                }
            }
        });
    }

    let failed = Arc::new(AtomicBool::new(false));
    let mut tx = None;
    if let (Some(o), Some(sender)) = (ndi_out.as_ref(), ndi_sender.as_ref()) {
        // Imagen: fotogramas BGRA de tamaño fijo por la salida de FFmpeg.
        if let Some(mut stdout) = child.stdout.take() {
            let (sender, o, failed) = (sender.clone(), o.clone(), failed.clone());
            std::thread::Builder::new()
                .name("miradio-ndi-send-video".into())
                .spawn(move || {
                    let size = (o.width * o.height * 4) as usize;
                    let mut frame = vec![0u8; size];
                    while stdout.read_exact(&mut frame).is_ok() {
                        sender.video_bgra(&mut frame, o.width as i32, o.height as i32, o.fps as i32);
                    }
                    failed.store(true, Ordering::SeqCst);
                })
                .ok();
        }
        // Sonido: el mismo PCM que reciben los encoders, directo a NDI.
        let (stx, srx) = mpsc::sync_channel::<Vec<u8>>(QUEUE_CHUNKS);
        let sender = sender.clone();
        std::thread::Builder::new()
            .name("miradio-ndi-send-audio".into())
            .spawn(move || {
                let mut planar = Vec::new();
                while let Ok(chunk) = srx.recv() {
                    sender.audio_s16_stereo(&chunk, &mut planar);
                }
            })
            .ok();
        tx = Some(stx);
    } else if wants_audio {
        if let Some(mut stdin) = child.stdin.take() {
            let (sender, receiver) = mpsc::sync_channel::<Vec<u8>>(QUEUE_CHUNKS);
            let (shared, failed, label) = (shared.clone(), failed.clone(), name.clone());
            std::thread::Builder::new()
                .name("miradio-encoder-write".into())
                .spawn(move || {
                    while let Ok(chunk) = receiver.recv() {
                        if stdin.write_all(&chunk).and_then(|_| stdin.flush()).is_err() {
                            failed.store(true, Ordering::SeqCst);
                            if let Ok(mut inner) = shared.lock() {
                                inner.last_error = Some(sanitize_error(&format!("{label}: se cerró la entrada de audio")));
                            }
                            break;
                        }
                    }
                })
                .ok();
            tx = Some(sender);
        }
    }

    let supervise_new = restart.is_some() && cancel.is_none();
    let cancel = cancel.unwrap_or_else(|| Arc::new(AtomicBool::new(false)));
    let watch_id = id.clone();
    inner.processes.push(StreamProcess {
        id,
        name,
        kind: kind.to_string(),
        wants_audio: wants_audio || ndi_out.is_some(),
        alive: true,
        child,
        tx,
        failed,
        error: error_slot,
        log: log_slot,
        restart,
        cancel: cancel.clone(),
        progress,
        started: Instant::now(),
        warned_full: false,
    });
    if supervise_new {
        let shared = shared.clone();
        std::thread::Builder::new()
            .name("miradio-stream-supervisor".into())
            .spawn(move || supervise(shared, watch_id, cancel))
            .ok();
    }
    Ok(())
}

/// Vigila una salida: si FFmpeg se cierra o deja de avanzar, la vuelve a
/// arrancar sin que nadie toque nada. Con respaldo, la primera caida pasa al
/// respaldo al instante; si el respaldo cae, se prueba otra vez la principal.
fn supervise(shared: Arc<Mutex<EngineInner>>, id: String, cancel: Arc<AtomicBool>) {
    let mine = |inner: &EngineInner| inner.processes.iter().position(|p| p.id == id && Arc::ptr_eq(&p.cancel, &cancel));
    loop {
        std::thread::sleep(Duration::from_secs(1));
        if cancel.load(Ordering::SeqCst) {
            return;
        }
        // ¿Sigue bien?
        let (reason, delay) = {
            let Ok(mut inner) = shared.lock() else { return };
            let Some(index) = mine(&inner) else { return };
            let p = &mut inner.processes[index];
            let exited = !matches!(p.child.try_wait(), Ok(None));
            let broken = p.failed.load(Ordering::SeqCst);
            let stalled = p
                .progress
                .lock()
                .map(|pr| {
                    if pr.seen {
                        pr.at.elapsed() > Duration::from_secs(STALL_SECS)
                    } else {
                        p.started.elapsed() > Duration::from_secs(STALL_START_SECS)
                    }
                })
                .unwrap_or(false);
            if !(exited || broken || stalled) {
                continue;
            }
            let last = p.error.lock().ok().and_then(|e| e.clone());
            let reason = if stalled && !exited {
                "la imagen o el envío se quedó parado".to_string()
            } else {
                last.unwrap_or_else(|| "FFmpeg se cerró".to_string())
            };
            p.alive = false;
            let lived = p.started.elapsed();
            let Some(r) = p.restart.as_mut() else { return };
            if lived > Duration::from_secs(60) {
                r.fails = 0;
            }
            // La primera caida con respaldo: al momento. Despues, espera creciente.
            let delay = if r.backup.is_some() && !r.on_backup && r.fails == 0 {
                0
            } else {
                (1u64 << r.fails.min(5)).min(30)
            };
            r.fails += 1;
            (reason, delay)
        };
        for _ in 0..delay {
            std::thread::sleep(Duration::from_secs(1));
            if cancel.load(Ordering::SeqCst) {
                return;
            }
        }
        let Ok(mut inner) = shared.lock() else { return };
        let Some(index) = mine(&inner) else { return };
        let mut old = inner.processes.remove(index);
        old.tx.take();
        let _ = old.child.kill();
        let _ = old.child.wait();
        let Some(mut r) = old.restart.take() else { return };
        let to_backup = r.backup.is_some() && !r.on_backup;
        r.on_backup = to_backup;
        let spec = if to_backup { r.backup.clone() } else { Some(r.primary.clone()) };
        let Some(spec) = spec else { return };
        let what = if to_backup {
            "pasa al vídeo de respaldo"
        } else if r.backup.is_some() {
            "vuelve a probar la entrada principal"
        } else {
            "reconectando"
        };
        inner.last_error = Some(sanitize_error(&format!("{}: {reason} — {what}", old.name)));
        if let Err(error) = spawn_process_ex(
            &mut inner,
            &shared,
            &spec.ffmpeg,
            spec.args,
            id.clone(),
            old.name.clone(),
            &old.kind,
            spec.wants_audio,
            Some(r),
            spec.ndi_out,
            Some(cancel.clone()),
        ) {
            inner.failed_outputs.push(failed_output(&id, &old.name, &old.kind, error));
            return;
        }
    }
}

fn stop_all(inner: &mut EngineInner) {
    for mut process in inner.processes.drain(..) {
        process.cancel.store(true, Ordering::SeqCst);
        process.tx.take();
        if let Some(stdin) = process.child.stdin.take() {
            drop(stdin);
        }
        let _ = process.child.kill();
        let _ = process.child.wait();
    }
    inner.failed_outputs.clear();
}

fn in_group(kind: &str, group: &str) -> bool {
    match group {
        "audio" => kind == "icecast",
        "video" => kind != "icecast",
        _ => true,
    }
}

fn stop_group(inner: &mut EngineInner, group: &str) {
    let mut keep = Vec::new();
    for mut process in inner.processes.drain(..) {
        if !in_group(&process.kind, group) {
            keep.push(process);
            continue;
        }
        process.cancel.store(true, Ordering::SeqCst);
        process.tx.take();
        if let Some(stdin) = process.child.stdin.take() {
            drop(stdin);
        }
        let _ = process.child.kill();
        let _ = process.child.wait();
    }
    inner.processes = keep;
    inner.failed_outputs.retain(|output| !in_group(&output.kind, group));
}

pub(crate) fn find_ffmpeg(app: &AppHandle) -> Option<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(raw) = std::env::var("MIRADIO_FFMPEG") {
        let raw = raw.trim();
        if !raw.is_empty() {
            candidates.push(PathBuf::from(raw));
        }
    }
    if let Ok(dir) = app.path().resource_dir() {
        candidates.push(dir.join(ffmpeg_name()));
        candidates.push(dir.join("bin").join(ffmpeg_name()));
        candidates.push(dir.join(ndi_ffmpeg_name()));
        candidates.push(dir.join("bin").join(ndi_ffmpeg_name()));
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.push(dir.join(ffmpeg_name()));
            candidates.push(dir.join("bin").join(ffmpeg_name()));
            candidates.push(dir.join(ndi_ffmpeg_name()));
            candidates.push(dir.join("bin").join(ndi_ffmpeg_name()));
        }
    }
    // El que descarga y mantiene MiRadio (antes que el del PATH, que puede ser viejo).
    if let Ok(data_dir) = app.path().app_data_dir() {
        if let Some(p) = crate::ffmpeg_dl::installed(&data_dir) {
            candidates.push(p);
        }
    }
    candidates.push(PathBuf::from(ffmpeg_name()));
    candidates.push(PathBuf::from(ndi_ffmpeg_name()));

    for candidate in candidates {
        let is_path = candidate.components().count() > 1;
        if is_path && !candidate.is_file() {
            continue;
        }
        if probe_ffmpeg(&candidate).is_ok() {
            return Some(candidate);
        }
    }
    None
}

fn ffmpeg_name() -> &'static str {
    if cfg!(windows) {
        "ffmpeg.exe"
    } else {
        "ffmpeg"
    }
}

/// Primera linea de `ffmpeg -version`.
pub(crate) fn ffmpeg_version(path: &Path) -> Result<String, String> {
    probe_ffmpeg(path)
}

fn probe_ffmpeg(path: &Path) -> Result<String, String> {
    let mut command = Command::new(path);
    command.arg("-version");
    configure_no_window(&mut command);
    let output = command
        .output()
        .map_err(|error| format!("No se pudo ejecutar {}: {error}", path.display()))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(sanitize_error(
            stderr.lines().next().unwrap_or("FFmpeg terminó con error"),
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout)
        .lines()
        .next()
        .unwrap_or("FFmpeg")
        .trim()
        .to_string())
}

fn ndi_ffmpeg_name() -> &'static str {
    if cfg!(windows) {
        "ffmpeg-ndi.exe"
    } else {
        "ffmpeg-ndi"
    }
}

fn add_candidate(out: &mut Vec<PathBuf>, path: PathBuf) {
    if !out.contains(&path) {
        out.push(path);
    }
}

fn ndi_ffmpeg_candidates(app: &AppHandle, custom: &str) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = Vec::new();
    let custom = custom.trim();
    if !custom.is_empty() {
        add_candidate(&mut out, PathBuf::from(custom));
    }
    for var in ["MIRADIO_NDI_FFMPEG", "MIRADIO_FFMPEG"] {
        if let Ok(raw) = std::env::var(var) {
            let raw = raw.trim();
            if !raw.is_empty() {
                add_candidate(&mut out, PathBuf::from(raw));
            }
        }
    }
    if let Ok(dir) = app.path().resource_dir() {
        add_candidate(&mut out, dir.join(ndi_ffmpeg_name()));
        add_candidate(&mut out, dir.join("bin").join(ndi_ffmpeg_name()));
        add_candidate(&mut out, dir.join(ffmpeg_name()));
        add_candidate(&mut out, dir.join("bin").join(ffmpeg_name()));
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            add_candidate(&mut out, dir.join(ndi_ffmpeg_name()));
            add_candidate(&mut out, dir.join("bin").join(ndi_ffmpeg_name()));
            add_candidate(&mut out, dir.join(ffmpeg_name()));
            add_candidate(&mut out, dir.join("bin").join(ffmpeg_name()));
        }
    }
    add_candidate(&mut out, PathBuf::from(ndi_ffmpeg_name()));
    add_candidate(&mut out, PathBuf::from(ffmpeg_name()));
    out
}

fn ndi_device(path: &Path) -> Result<String, String> {
    let mut command = Command::new(path);
    command.args(["-hide_banner", "-devices"]);
    configure_no_window(&mut command);
    let output = command
        .output()
        .map_err(|error| format!("No se pudo ejecutar {}: {error}", path.display()))?;
    let text = format!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    if text.contains("libndi_newtek") {
        Ok("libndi_newtek".to_string())
    } else if text.contains("libndi") {
        Ok("libndi".to_string())
    } else {
        Err("Este FFmpeg no incluye NDI".to_string())
    }
}

fn find_ndi_ffmpeg(app: &AppHandle, custom: &str) -> Result<(PathBuf, String), String> {
    for candidate in ndi_ffmpeg_candidates(app, custom) {
        let is_path = candidate.components().count() > 1;
        if is_path && !candidate.is_file() {
            continue;
        }
        if let Ok(device) = ndi_device(&candidate) {
            return Ok((candidate, device));
        }
    }
    Err(
        "No se encontró un FFmpeg con soporte NDI. Instala un FFmpeg compilado con NDI (libndi) y el NDI Runtime, o indica su ruta en Ajustes > Vídeo > NDI."
            .to_string(),
    )
}

fn probe_ndi(app: &AppHandle, custom: &str) -> NdiProbe {
    match find_ndi_ffmpeg(app, custom) {
        Ok((ffmpeg, device)) => {
            let (sources, error) = match ndi_list_sources(&ffmpeg, &device) {
                Ok(sources) => (sources, None),
                Err(error) => (Vec::new(), Some(error)),
            };
            NdiProbe {
                available: true,
                ffmpeg: Some(ffmpeg.display().to_string()),
                device: Some(device),
                runtime: true,
                sources,
                error,
            }
        }
        Err(error) => NdiProbe {
            available: false,
            error: Some(error),
            ..NdiProbe::default()
        },
    }
}

fn ndi_list_sources(ffmpeg: &Path, device: &str) -> Result<Vec<String>, String> {
    let mut command = Command::new(ffmpeg);
    command.args([
        "-hide_banner",
        "-loglevel",
        "info",
        "-f",
        device,
        "-find_sources",
        "1",
        "-i",
        "dummy",
    ]);
    configure_no_window(&mut command);
    let output = command
        .output()
        .map_err(|error| format!("No se pudo buscar fuentes NDI: {error}"))?;
    let text = format!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let sources = parse_ndi_sources(&text);
    if sources.is_empty() && !output.status.success() {
        let detail = text
            .lines()
            .rev()
            .map(str::trim)
            .find(|line| !line.is_empty())
            .unwrap_or("FFmpeg no pudo buscar fuentes NDI");
        return Err(sanitize_error(detail));
    }
    Ok(sources)
}

fn parse_ndi_sources(output: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for line in output.lines() {
        let line = line.trim();
        let Some(start) = line.find('\'') else {
            continue;
        };
        let rest = &line[start + 1..];
        let Some(end) = rest.find('\'') else {
            continue;
        };
        let name = rest[..end].trim();
        if !name.is_empty() && !out.iter().any(|s| s == name) {
            out.push(name.to_string());
        }
    }
    if out.is_empty() {
        let mut after_found = false;
        for line in output.lines() {
            let line = line.trim();
            if line.contains("NDI sources") || line.contains("NDI source") {
                after_found = true;
                continue;
            }
            if !after_found || line.is_empty() || line.starts_with('[') {
                continue;
            }
            let lower = line.to_ascii_lowercase();
            if lower.contains("error") || lower.contains("failed") {
                continue;
            }
            if !out.iter().any(|s| s == line) {
                out.push(line.to_string());
            }
        }
    }
    out
}

fn icecast_args(stream: &IcecastStream) -> Result<Vec<String>, String> {
    let codec = stream.codec.to_ascii_lowercase();
    if codec != "flac" && codec != "aac" {
        return Err(format!("códec desconocido: {}", stream.codec));
    }
    let host = clean_host(&stream.host);
    if host.is_empty() {
        return Err("falta el servidor".to_string());
    }
    if stream.port == 0 {
        return Err("el puerto no es válido".to_string());
    }
    let mount = normalize_mount(&stream.mount);
    if mount.is_empty() || mount == "/" {
        return Err("falta el montaje".to_string());
    }

    let mut args = base_input_args();
    args.push(arg("-vn"));
    if codec == "flac" {
        args.extend([arg("-c:a"), arg("flac")]);
        args.extend([arg("-compression_level"), arg("8")]);
    } else {
        let bitrate = if stream.bitrate_kbps == 0 {
            128
        } else {
            stream.bitrate_kbps.clamp(32, 512)
        };
        args.extend([arg("-c:a"), arg("aac")]);
        args.extend([arg("-b:a"), format!("{bitrate}k")]);
    }
    let sample_rate = stream.sample_rate.clamp(8000, 192_000);
    let channels = if stream.channels == 1 { 1 } else { 2 };
    args.extend([arg("-ar"), sample_rate.to_string()]);
    args.extend([arg("-ac"), channels.to_string()]);

    let (format, content_type) = if codec == "flac" {
        ("ogg", "audio/ogg")
    } else {
        ("adts", "audio/aac")
    };
    args.extend([arg("-content_type"), arg(content_type)]);
    if !stream.station_name.trim().is_empty() {
        args.extend([arg("-ice_name"), stream.station_name.trim().to_string()]);
    }
    if !stream.description.trim().is_empty() {
        args.extend([
            arg("-ice_description"),
            stream.description.trim().to_string(),
        ]);
    }
    if !stream.genre.trim().is_empty() {
        args.extend([arg("-ice_genre"), stream.genre.trim().to_string()]);
    }
    args.extend([arg("-ice_public"), arg(if stream.public { "1" } else { "0" })]);
    args.extend([arg("-f"), arg(format)]);
    args.push(icecast_url(stream, &host, &mount));
    Ok(args)
}

fn rtmp_args(
    video: &VideoSettings,
    url: &str,
    width: u32,
    height: u32,
    fps: u32,
    bitrate_kbps: u32,
    keyframe_secs: u32,
    ndi_device: Option<&str>,
    preferred_input: Option<&str>,
    audio_device: Option<&str>,
) -> Result<Vec<String>, String> {
    if !video.enabled {
        return Err("activa el motor de vídeo para emitir por RTMP".to_string());
    }
    let input = pick_video_input(video, preferred_input)?;
    let audio_in_video = cfg!(windows)
        && input.kind == "capture"
        && audio_device
            .map(|audio| same_capture_name(audio, &input.source))
            .unwrap_or(false);
    let video_args = if audio_in_video {
        capture_input_args_with_audio(&input.source)?
    } else {
        video_input_args(input, ndi_device)?
    };
    rtmp_args_for_video(
        video_args,
        url,
        width,
        height,
        fps,
        bitrate_kbps,
        keyframe_secs,
        if audio_in_video { None } else { audio_device },
        audio_in_video,
    )
}

/// Argumentos RTMP con una entrada de video ya preparada (capturadora o
/// pantalla de programa).
#[allow(clippy::too_many_arguments)]
fn rtmp_args_for_video(
    video_args: Vec<String>,
    url: &str,
    width: u32,
    height: u32,
    fps: u32,
    bitrate_kbps: u32,
    keyframe_secs: u32,
    audio_device: Option<&str>,
    audio_in_video: bool,
) -> Result<Vec<String>, String> {
    let url = url.trim();
    if url.is_empty() {
        return Err("falta la URL RTMP".to_string());
    }
    let lower = url.to_ascii_lowercase();
    if !lower.starts_with("rtmp://") && !lower.starts_with("rtmps://") {
        return Err("la URL RTMP debe empezar por rtmp:// o rtmps://".to_string());
    }
    let mut args = base_input_args();
    args.extend(video_args);
    if audio_in_video {
        args.extend([arg("-map"), arg("1:v:0")]);
        args.extend([arg("-map"), arg("1:a:0?")]);
    } else if let Some(audio) = audio_device {
        args.extend(audio_args(audio)?);
        args.extend([arg("-map"), arg("1:v:0")]);
        args.extend([arg("-map"), arg("2:a:0")]);
    } else {
        args.extend([arg("-map"), arg("1:v:0")]);
        args.extend([arg("-map"), arg("0:a:0?")]);
    }
    let width = even_size(width, 16);
    let height = even_size(height, 16);
    let fps = fps.clamp(1, 120);
    let bitrate = bitrate_kbps.clamp(100, 100_000);
    let keyframe = keyframe_secs.clamp(1, 10);
    let gop = fps.saturating_mul(keyframe).max(1);

    args.extend([arg("-c:v"), arg("libx264")]);
    args.extend([arg("-preset"), arg("veryfast")]);
    args.extend([arg("-tune"), arg("zerolatency")]);
    args.extend([arg("-pix_fmt"), arg("yuv420p")]);
    args.extend([arg("-flags"), arg("+global_header")]);
    args.extend([arg("-r"), fps.to_string()]);
    args.extend([arg("-s"), format!("{width}x{height}")]);
    args.extend([arg("-b:v"), format!("{bitrate}k")]);
    args.extend([arg("-maxrate"), format!("{bitrate}k")]);
    args.extend([arg("-bufsize"), format!("{}k", bitrate.saturating_mul(2))]);
    args.extend([arg("-g"), gop.to_string()]);
    args.extend([arg("-keyint_min"), gop.to_string()]);
    args.extend([arg("-sc_threshold"), arg("0")]);
    args.extend([arg("-c:a"), arg("aac")]);
    args.extend([arg("-b:a"), arg("128k")]);
    args.extend([arg("-ar"), arg("48000")]);
    args.extend([arg("-ac"), arg("2")]);
    args.extend([arg("-f"), arg("flv")]);
    args.extend([arg("-flvflags"), arg("no_duration_filesize")]);
    args.push(url.to_string());
    Ok(args)
}

fn ndi_args(
    video: &VideoSettings,
    name: &str,
    width: u32,
    height: u32,
    fps: u32,
    device: &str,
    ndi_device: Option<&str>,
    preferred_input: Option<&str>,
    audio_device: Option<&str>,
) -> Result<Vec<String>, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("falta el nombre de la salida NDI".to_string());
    }
    if !video.enabled {
        return Err("activa el motor de vídeo para emitir por NDI".to_string());
    }
    let input = pick_video_input(video, preferred_input)?;
    let mut args = base_input_args();
    args.extend(video_input_args(input, ndi_device)?);
    if let Some(audio) = audio_device {
        args.extend(audio_args(audio)?);
        args.extend([arg("-map"), arg("1:v:0")]);
        args.extend([arg("-map"), arg("2:a:0")]);
    } else {
        args.extend([arg("-map"), arg("1:v:0")]);
        args.extend([arg("-map"), arg("0:a:0?")]);
    }
    let width = even_size(width, 16);
    let height = even_size(height, 16);
    let fps = fps.clamp(1, 120);

    args.extend([arg("-c:v"), arg("wrapped_avframe")]);
    args.extend([arg("-pix_fmt"), arg("uyvy422")]);
    args.extend([arg("-s"), format!("{width}x{height}")]);
    args.extend([arg("-r"), fps.to_string()]);
    args.extend([arg("-c:a"), arg("pcm_s16le")]);
    args.extend([arg("-ar"), arg("48000")]);
    args.extend([arg("-ac"), arg("2")]);
    args.extend([arg("-f"), arg(device)]);
    args.push(name.to_string());
    Ok(args)
}

fn video_output_args(
    output: &VideoOutput,
    video: &VideoSettings,
    ndi_device: Option<&str>,
    preferred_input: Option<&str>,
) -> Result<Vec<String>, String> {
    if !video.enabled {
        return Err("activa el motor de vídeo".to_string());
    }
    let input = pick_video_input(video, preferred_input)?;
    video_output_args_for_source(output, video_input_args(input, ndi_device)?)
}

fn video_output_args_for_source(
    output: &VideoOutput,
    mut args: Vec<String>,
) -> Result<Vec<String>, String> {
    let width = even_size(output.width, 16);
    let height = even_size(output.height, 16);
    let fps = output.fps.clamp(1, 120);
    match output.kind.as_str() {
        "screen" => {
            args.extend([arg("-an"), arg("-pix_fmt"), arg("yuv420p")]);
            args.extend([arg("-f"), arg("sdl")]);
            args.extend([arg("-window_title"), arg("MiRadio")]);
            args.extend([arg("-window_size"), format!("{width}x{height}")]);
            args.extend([arg("-window_borderless"), arg("1")]);
            args.extend([arg("-window_fullscreen"), arg("1")]);
        }
        "decklink" => {
            let device = if output.source.trim().is_empty() {
                "0"
            } else {
                output.source.trim()
            };
            args.extend([arg("-an"), arg("-pix_fmt"), arg("uyvy422")]);
            args.extend([arg("-s"), format!("{width}x{height}")]);
            args.extend([arg("-r"), fps.to_string()]);
            args.extend([arg("-f"), arg("decklink")]);
            args.push(device.to_string());
        }
        other => return Err(format!("salida de vídeo desconocida: {other}")),
    }
    Ok(args)
}

/// Entrada de vídeo que se emite: la elegida para la pantalla externa o, si
/// no hay, la primera activa.
fn pick_video_input<'a>(
    video: &'a VideoSettings,
    preferred: Option<&str>,
) -> Result<&'a VideoInput, String> {
    preferred
        .and_then(|id| {
            video
                .inputs
                .iter()
                .find(|input| input.id == id && input.enabled && !input.source.trim().is_empty())
        })
        .or_else(|| {
            video
                .inputs
                .iter()
                .find(|input| input.enabled && !input.source.trim().is_empty())
        })
        .ok_or_else(|| "no hay una entrada de vídeo activa".to_string())
}

fn video_input_args(input: &VideoInput, ndi_device: Option<&str>) -> Result<Vec<String>, String> {
    let source = input.source.trim();
    if source.is_empty() {
        return Err("la entrada de vídeo no tiene fuente".to_string());
    }
    match input.kind.as_str() {
        "file" => Ok(vec![
            arg("-re"),
            arg("-stream_loop"),
            arg("-1"),
            arg("-i"),
            source.to_string(),
        ]),
        "capture" => capture_input_args(source),
        "rtmp" => Ok(vec![arg("-i"), source.to_string()]),
        "ndi" => {
            // Con el NDI Runtime no hace falta un FFmpeg especial.
            if let Ok(args) = crate::ndi::ffmpeg_video_input(source) {
                return Ok(args);
            }
            let device = ndi_device.ok_or_else(|| {
                "NDI no disponible: indica un FFmpeg con soporte NDI en Ajustes > Vídeo > NDI"
                    .to_string()
            })?;
            Ok(vec![
                arg("-f"),
                arg(device),
                arg("-i"),
                source.to_string(),
            ])
        }
        other => Err(format!("tipo de entrada de vídeo desconocido: {other}")),
    }
}

/// Comprueba si el FFmpeg instalado incluye el filtro gfxcapture.
fn has_filter(ffmpeg: &Path, name: &str) -> bool {
    let mut cmd = Command::new(ffmpeg);
    cmd.args(["-hide_banner", "-filters"]).stdout(Stdio::piped()).stderr(Stdio::null());
    configure_no_window(&mut cmd);
    cmd.output()
        .map(|out| String::from_utf8_lossy(&out.stdout).contains(name))
        .unwrap_or(false)
}

/// Entrada de video con la ventana de programa de MiRadio.
/// Imagen de una ventana de MiRadio: la pantalla de emision («MiRadio
/// Programa», sigue la botonera) o la de lo que suena («MiRadio Lo que suena»).
fn program_args(fps: u32, monitor: u32, gfxcapture: bool, ddagrab: bool, now_playing: bool) -> Result<Vec<String>, String> {
    if !now_playing {
        return program_video_input_args(fps, monitor, gfxcapture, ddagrab);
    }
    let fps = fps.clamp(1, 120);
    if cfg!(windows) && gfxcapture {
        return Ok(vec![
            arg("-f"),
            arg("lavfi"),
            arg("-i"),
            format!(
                "gfxcapture=window_title='(?i)^MiRadio Lo que suena$':max_framerate={fps}:capture_cursor=0,hwdownload,format=bgra,format=yuv420p,fps={fps}"
            ),
        ]);
    }
    if cfg!(windows) {
        return Ok(vec![
            arg("-f"),
            arg("gdigrab"),
            arg("-framerate"),
            fps.to_string(),
            arg("-draw_mouse"),
            arg("0"),
            arg("-i"),
            arg("title=MiRadio Lo que suena"),
        ]);
    }
    #[cfg(target_os = "linux")]
    {
        let _ = (monitor, gfxcapture, ddagrab);
        x11_window_args("MiRadio Lo que suena", fps)
    }
    #[cfg(not(target_os = "linux"))]
    program_video_input_args(fps, monitor, gfxcapture, ddagrab)
}

#[cfg(target_os = "windows")]
fn program_video_input_args(
    fps: u32,
    monitor: u32,
    gfxcapture: bool,
    ddagrab: bool,
) -> Result<Vec<String>, String> {
    if gfxcapture {
        Ok(vec![
            arg("-f"),
            arg("lavfi"),
            arg("-i"),
            format!(
                "gfxcapture=window_title='(?i)^MiRadio Programa$':max_framerate={}:capture_cursor=0,hwdownload,format=bgra,format=yuv420p,fps={}",
                fps.clamp(1, 120),
                fps.clamp(1, 120)
            ),
        ])
    } else if ddagrab {
        Ok(vec![
            arg("-f"),
            arg("lavfi"),
            arg("-i"),
            format!(
                "ddagrab=output_idx={}:framerate={},hwdownload,format=bgra,format=yuv420p",
                monitor,
                fps.clamp(1, 120)
            ),
        ])
    } else {
        Ok(vec![
            arg("-f"),
            arg("gdigrab"),
            arg("-framerate"),
            fps.clamp(1, 120).to_string(),
            arg("-draw_mouse"),
            arg("0"),
            arg("-i"),
            arg("title=MiRadio Programa"),
        ])
    }
}

#[cfg(target_os = "linux")]
fn program_video_input_args(fps: u32, _monitor: u32, _gfxcapture: bool, _ddagrab: bool) -> Result<Vec<String>, String> {
    x11_window_args("MiRadio Programa", fps)
}

/// Linux (X11): solo la ventana de MiRadio (no la pantalla entera). Con un
/// compositor (picom) se captura aunque este tapada o fuera de la pantalla.
#[cfg(target_os = "linux")]
fn x11_window_args(title: &str, fps: u32) -> Result<Vec<String>, String> {
    let id = crate::x11util::find_window(title)
        .ok_or_else(|| format!("no se encuentra la ventana «{title}» (¿está abierta? En Linux hace falta X11)"))?;
    let display = std::env::var("DISPLAY").unwrap_or_else(|_| ":0".into());
    Ok(vec![
        arg("-f"),
        arg("x11grab"),
        arg("-framerate"),
        fps.clamp(1, 120).to_string(),
        arg("-draw_mouse"),
        arg("0"),
        arg("-window_id"),
        id.to_string(),
        arg("-i"),
        display,
    ])
}

#[cfg(target_os = "macos")]
fn program_video_input_args(fps: u32, _monitor: u32, _gfxcapture: bool, _ddagrab: bool) -> Result<Vec<String>, String> {
    Ok(vec![
        arg("-f"),
        arg("avfoundation"),
        arg("-framerate"),
        fps.clamp(1, 120).to_string(),
        arg("-i"),
        arg("Capture screen 0:none"),
    ])
}

#[cfg(not(any(target_os = "windows", target_os = "linux", target_os = "macos")))]
fn program_video_input_args(_fps: u32, _monitor: u32, _gfxcapture: bool, _ddagrab: bool) -> Result<Vec<String>, String> {
    Err("La pantalla de programa no está soportada en este sistema".to_string())
}

#[cfg(target_os = "windows")]
fn audio_input_args(source: &str) -> Result<Vec<String>, String> {
    let raw = source.trim().trim_matches('"');
    Ok(vec![arg("-f"), arg("dshow"), arg("-i"), format!("audio={raw}")])
}

#[cfg(target_os = "linux")]
fn audio_input_args(source: &str) -> Result<Vec<String>, String> {
    let raw = source.trim().trim_matches('"');
    Ok(vec![arg("-f"), arg("alsa"), arg("-i"), raw.to_string()])
}

#[cfg(target_os = "macos")]
fn audio_input_args(source: &str) -> Result<Vec<String>, String> {
    let raw = source.trim().trim_matches('"');
    Ok(vec![arg("-f"), arg("avfoundation"), arg("-i"), format!(":{raw}")])
}

#[cfg(not(any(target_os = "windows", target_os = "linux", target_os = "macos")))]
fn audio_input_args(_source: &str) -> Result<Vec<String>, String> {
    Err("El audio de captura no está soportado en este sistema".to_string())
}

/// Audio aparte de una salida: un dispositivo de captura o, con «ndi:», el
/// audio de una fuente NDI (recibido con el NDI Runtime).
fn audio_args(source: &str) -> Result<Vec<String>, String> {
    match source.strip_prefix("ndi:") {
        Some(ndi) => crate::ndi::ffmpeg_audio_input(ndi),
        None => audio_input_args(source),
    }
}

fn same_capture_name(audio: &str, video: &str) -> bool {
    let clean = |value: &str| {
        value
            .trim()
            .trim_matches('"')
            .trim_start_matches("video=")
            .trim_start_matches("audio=")
            .trim()
            .to_ascii_lowercase()
    };
    !clean(audio).is_empty() && clean(audio) == clean(video)
}

#[cfg(target_os = "windows")]
fn capture_input_args_with_audio(source: &str) -> Result<Vec<String>, String> {
    let raw = source.trim().trim_matches('"');
    let raw = raw.strip_prefix("video=").unwrap_or(raw).trim();
    Ok(vec![
        arg("-thread_queue_size"),
        arg("512"),
        arg("-rtbufsize"),
        arg("256M"),
        arg("-f"),
        arg("dshow"),
        arg("-i"),
        format!("video={raw}:audio={raw}"),
    ])
}

#[cfg(not(target_os = "windows"))]
fn capture_input_args_with_audio(source: &str) -> Result<Vec<String>, String> {
    capture_input_args(source)
}

#[cfg(target_os = "windows")]
fn capture_input_args(source: &str) -> Result<Vec<String>, String> {
    let raw = source.trim();
    let raw = if raw.to_ascii_lowercase().starts_with("video=") {
        &raw[6..]
    } else {
        raw
    };
    let raw = raw.trim().trim_matches('"');
    Ok(vec![
        arg("-thread_queue_size"),
        arg("512"),
        arg("-rtbufsize"),
        arg("256M"),
        arg("-f"),
        arg("dshow"),
        arg("-i"),
        format!("video={raw}"),
    ])
}

#[cfg(target_os = "linux")]
fn capture_input_args(source: &str) -> Result<Vec<String>, String> {
    let source = source.trim().trim_matches('"');
    let device = if source.starts_with('/') {
        source.to_string()
    } else if source.chars().all(|c| c.is_ascii_digit()) {
        format!("/dev/video{source}")
    } else {
        source.to_string()
    };
    Ok(vec![arg("-f"), arg("v4l2"), arg("-i"), device])
}

#[cfg(target_os = "macos")]
fn capture_input_args(source: &str) -> Result<Vec<String>, String> {
    let source = source.trim().trim_matches('"');
    let device = if source.contains(':') {
        source.to_string()
    } else {
        format!("{source}:none")
    };
    Ok(vec![arg("-f"), arg("avfoundation"), arg("-i"), device])
}

#[cfg(not(any(target_os = "windows", target_os = "linux", target_os = "macos")))]
fn capture_input_args(_source: &str) -> Result<Vec<String>, String> {
    Err("la captura de vídeo no está soportada en este sistema".to_string())
}

fn base_input_args() -> Vec<String> {
    vec![
        arg("-hide_banner"),
        arg("-loglevel"),
        arg("warning"),
        arg("-f"),
        arg("s16le"),
        arg("-ar"),
        arg("48000"),
        arg("-ac"),
        arg("2"),
        arg("-thread_queue_size"),
        arg("1024"),
        arg("-i"),
        arg("pipe:0"),
    ]
}

fn icecast_url(stream: &IcecastStream, host: &str, mount: &str) -> String {
    let user = url_escape(stream.username.trim());
    let password = url_escape(&stream.password);
    let auth = if user.is_empty() {
        String::new()
    } else if password.is_empty() {
        format!("{user}@")
    } else {
        format!("{user}:{password}@")
    };
    let separator = if mount.contains('?') { '&' } else { '?' };
    let tls = if stream.tls {
        format!("{separator}tls=1")
    } else {
        String::new()
    };
    format!(
        "icecast://{auth}{host}:{}{mount}{tls}",
        stream.port
    )
}

fn clean_host(host: &str) -> String {
    let host = host
        .trim()
        .trim_start_matches("http://")
        .trim_start_matches("https://");
    host.split('/').next().unwrap_or("").trim().to_string()
}

fn normalize_mount(mount: &str) -> String {
    let mount = mount.trim();
    if mount.is_empty() {
        return String::new();
    }
    let with_slash = if mount.starts_with('/') {
        mount.to_string()
    } else {
        format!("/{mount}")
    };
    with_slash
        .bytes()
        .map(|byte| {
            if byte.is_ascii_alphanumeric() || b"-._~/".contains(&byte) {
                (byte as char).to_string()
            } else {
                format!("%{byte:02X}")
            }
        })
        .collect()
}

fn url_escape(value: &str) -> String {
    value
        .bytes()
        .map(|byte| {
            if byte.is_ascii_alphanumeric() || b"-._~".contains(&byte) {
                (byte as char).to_string()
            } else {
                format!("%{byte:02X}")
            }
        })
        .collect()
}

fn even_size(value: u32, minimum: u32) -> u32 {
    let value = value.max(minimum);
    if value % 2 == 0 {
        value
    } else {
        value.saturating_sub(1)
    }
}

fn arg(value: &str) -> String {
    value.to_string()
}

fn is_error_line(line: &str) -> bool {
    let line = line.to_ascii_lowercase();
    [
        "error",
        "failed",
        "cannot",
        "unable",
        "invalid",
        "no such",
        "not found",
        "connection refused",
        "timed out",
        "broken pipe",
        "401",
        "403",
    ]
    .iter()
    .any(|needle| line.contains(needle))
}

fn sanitize_error(line: &str) -> String {
    let mut out = String::with_capacity(line.len());
    let mut rest = line;
    while let Some(position) = rest.find("://") {
        let split = position + 3;
        let (head, tail) = rest.split_at(split);
        out.push_str(head);
        let end = tail
            .find(|c: char| c.is_whitespace() || matches!(c, '"' | '\'' | ')' | ']' | ','))
            .unwrap_or(tail.len());
        let (url, after) = tail.split_at(end);
        let scheme = head
            .trim_end_matches("://")
            .rsplit(|c: char| !(c.is_ascii_alphanumeric() || c == '+' || c == '.' || c == '-'))
            .next()
            .unwrap_or("")
            .to_ascii_lowercase();
        if scheme == "rtmp" || scheme == "rtmps" {
            let (prefix, host_path) = match url.find('@') {
                Some(at) => ("***@", &url[at + 1..]),
                None => ("", url),
            };
            out.push_str(prefix);
            match host_path.find('/') {
                Some(slash) => {
                    out.push_str(&host_path[..slash]);
                    out.push_str("/***");
                }
                None => out.push_str(host_path),
            }
        } else if let Some(at) = url.find('@') {
            out.push_str("***");
            out.push_str(&url[at..]);
        } else {
            out.push_str(url);
        }
        rest = after;
    }
    out.push_str(rest);
    out
}

#[cfg(windows)]
pub(crate) fn configure_no_window(command: &mut Command) {
    use std::os::windows::process::CommandExt;
    command.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(windows))]
pub(crate) fn configure_no_window(_command: &mut Command) {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pcm_reaches_ffmpeg_through_writer_thread() {
        let Some(ffmpeg) = ["ffmpeg"].iter().map(PathBuf::from).find(|p| probe_ffmpeg(p).is_ok()) else {
            return;
        };
        let out = std::env::temp_dir().join(format!("miradio_stream_test_{}.wav", std::process::id()));
        let shared = Arc::new(Mutex::new(EngineInner::default()));
        let mut args = base_input_args();
        args.extend(["-y".to_string(), out.display().to_string()]);
        {
            let mut inner = shared.lock().unwrap();
            spawn_process(&mut inner, &shared, &ffmpeg, args, "t".into(), "t".into(), "icecast", true, None).unwrap();
        }
        let chunk = vec![0u8; 3840];
        for _ in 0..100 {
            push_pcm(&shared, &chunk).unwrap();
        }
        // Dar tiempo a vaciar la cola y cerrar la entrada.
        std::thread::sleep(std::time::Duration::from_millis(300));
        {
            let mut inner = shared.lock().unwrap();
            for p in inner.processes.iter_mut() {
                p.tx.take();
                p.child.stdin.take();
            }
            for p in inner.processes.iter_mut() {
                let _ = p.child.wait();
            }
            stop_all(&mut inner);
        }
        let len = std::fs::metadata(&out).map(|m| m.len()).unwrap_or(0);
        let _ = std::fs::remove_file(&out);
        assert!(len > 3840 * 90, "ffmpeg recibio {len} bytes");
    }

    fn stream() -> IcecastStream {
        IcecastStream {
            id: "s1".to_string(),
            name: "Prueba".to_string(),
            enabled: true,
            host: "https://icecast.example.com/".to_string(),
            port: 8443,
            mount: "mi radio".to_string(),
            username: "source user".to_string(),
            password: "p@ss:word".to_string(),
            tls: true,
            codec: "flac".to_string(),
            bitrate_kbps: 0,
            sample_rate: 48000,
            channels: 2,
            public: true,
            station_name: "MiRadio".to_string(),
            description: "Prueba".to_string(),
            genre: "Variado".to_string(),
        }
    }

    #[test]
    fn icecast_url_encodes_credentials_mount_and_tls() {
        let stream = stream();
        let host = clean_host(&stream.host);
        let mount = normalize_mount(&stream.mount);
        let url = icecast_url(&stream, &host, &mount);
        assert_eq!(
            url,
            "icecast://source%20user:p%40ss%3Aword@icecast.example.com:8443/mi%20radio?tls=1"
        );
    }

    #[test]
    fn icecast_args_set_flac_content_type() {
        let args = icecast_args(&stream()).expect("argumentos");
        assert!(args.windows(2).any(|pair| pair == ["-c:a", "flac"]));
        assert!(args.windows(2).any(|pair| pair == ["-content_type", "audio/ogg"]));
        assert!(args.windows(2).any(|pair| pair == ["-f", "ogg"]));
        assert!(args.windows(2).any(|pair| pair == ["-f", "s16le"]));
        assert!(args.iter().any(|arg| arg.ends_with("?tls=1")));
    }

    #[test]
    fn sanitize_error_hides_credentials() {
        let clean = sanitize_error("Error opening output icecast://source:secret@host/mount");
        assert!(!clean.contains("secret"));
        assert!(clean.contains("icecast://***@host/mount"));
        let slash = sanitize_error("Error rtmp://user:pa/ss@host/live");
        assert!(!slash.contains("pa/ss"));
        assert!(slash.contains("rtmp://***@host/***"));
        let key = sanitize_error("Error opening output rtmp://live.restream.io/live/clave-secreta");
        assert!(!key.contains("clave-secreta"));
        assert!(key.contains("rtmp://live.restream.io/***"));
    }

    #[test]
    fn parse_ndi_sources_reads_quoted_names() {
        let output = "[libndi_newtek @ 0x1] NDI sources:\n\
            [libndi_newtek @ 0x1] 'CAMARA A (Programa)'\n\
            [libndi_newtek @ 0x1] 'OBS PC'\n";
        assert_eq!(
            parse_ndi_sources(output),
            vec!["CAMARA A (Programa)", "OBS PC"]
        );
    }

    #[test]
    fn parse_ndi_sources_falls_back_to_plain_lines() {
        let output = "NDI sources:\nCAMARA A\nCAMARA B\n";
        assert_eq!(parse_ndi_sources(output), vec!["CAMARA A", "CAMARA B"]);
    }

    #[test]
    fn ndi_input_requires_device() {
        let input = VideoInput {
            id: "i1".to_string(),
            name: "NDI".to_string(),
            kind: "ndi".to_string(),
            source: "CAMARA A".to_string(),
            device_id: String::new(),
            enabled: true,
        };
        assert!(video_input_args(&input, None).is_err());
        let args = video_input_args(&input, Some("libndi_newtek")).expect("argumentos");
        assert!(args.windows(2).any(|pair| pair == ["-f", "libndi_newtek"]));
    }


    fn lavfi(secs: u32) -> Vec<String> {
        ["-hide_banner", "-loglevel", "warning", "-re", "-f", "lavfi", "-i", "testsrc=size=64x36:rate=10", "-t", &secs.to_string(), "-f", "null", "-"]
            .iter()
            .map(|x| x.to_string())
            .collect()
    }

    fn state(shared: &Arc<Mutex<EngineInner>>) -> Option<(bool, bool)> {
        let inner = shared.lock().unwrap();
        inner.processes.iter().find(|p| p.id == "v").map(|p| (p.alive, p.restart.as_ref().map(|r| r.on_backup).unwrap_or(false)))
    }

    /// La principal cae: pasa al respaldo al momento; cae el respaldo: vuelve a la principal.
    #[test]
    fn supervisor_switches_to_backup_and_back() {
        if Command::new("ffmpeg").arg("-version").output().is_err() {
            return;
        }
        let shared = Arc::new(Mutex::new(EngineInner::default()));
        let ff = PathBuf::from("ffmpeg");
        let primary = Spec { ffmpeg: ff.clone(), args: lavfi(2), wants_audio: false, ndi_out: None };
        let backup = Spec { ffmpeg: ff.clone(), args: lavfi(3), wants_audio: false, ndi_out: None };
        {
            let mut inner = shared.lock().unwrap();
            spawn_process(&mut inner, &shared, &ff, lavfi(2), "v".into(), "Prueba".into(), "rtmp", false, Some(Restart::new(primary, Some(backup))))
                .unwrap();
        }
        let start = Instant::now();
        let (mut saw_backup, mut back_to_main) = (false, false);
        while start.elapsed() < Duration::from_secs(20) && !back_to_main {
            std::thread::sleep(Duration::from_millis(250));
            match state(&shared) {
                Some((true, true)) => saw_backup = true,
                Some((true, false)) if saw_backup => back_to_main = true,
                _ => {}
            }
            // Mientras reconecta sigue contando como en marcha.
            assert!(status_from(&mut shared.lock().unwrap()).running);
        }
        assert!(saw_backup && back_to_main, "respaldo {saw_backup}, vuelta {back_to_main}");
        stop_all(&mut shared.lock().unwrap());
        std::thread::sleep(Duration::from_millis(1500));
        assert!(shared.lock().unwrap().processes.is_empty());
    }

    /// FFmpeg que no se cierra pero deja de avanzar (fuente congelada): se rearranca.
    #[test]
    fn supervisor_restarts_stalled() {
        if Command::new("ffmpeg").arg("-version").output().is_err() {
            return;
        }
        let shared = Arc::new(Mutex::new(EngineInner::default()));
        let ff = PathBuf::from("ffmpeg");
        // Espera audio por la tuberia, que nadie le manda: no avanza nunca.
        let args: Vec<String> = ["-hide_banner", "-loglevel", "warning", "-f", "s16le", "-ar", "48000", "-ac", "2", "-i", "pipe:0", "-f", "null", "-"]
            .iter()
            .map(|x| x.to_string())
            .collect();
        let spec = Spec { ffmpeg: ff.clone(), args: args.clone(), wants_audio: false, ndi_out: None };
        let first_pid;
        {
            let mut inner = shared.lock().unwrap();
            spawn_process(&mut inner, &shared, &ff, args, "v".into(), "Prueba".into(), "rtmp", false, Some(Restart::new(spec, None))).unwrap();
            first_pid = inner.processes[0].child.id();
        }
        let start = Instant::now();
        let mut restarted = false;
        while start.elapsed() < Duration::from_secs(15) && !restarted {
            std::thread::sleep(Duration::from_millis(250));
            let inner = shared.lock().unwrap();
            restarted = inner.processes.iter().any(|p| p.id == "v" && p.child.id() != first_pid);
        }
        assert!(restarted, "no se rearrancó la salida colgada");
        stop_all(&mut shared.lock().unwrap());
    }
}

/// Asa del motor de emision para quien envia PCM desde Rust (motor nativo).
#[derive(Clone)]
pub struct StreamingSink(Arc<Mutex<EngineInner>>);

impl StreamingState {
    pub fn sink(&self) -> StreamingSink {
        StreamingSink(self.inner.clone())
    }
}

impl StreamingSink {
    /// Envia PCM s16le 48 kHz estereo a los encoders activos.
    pub fn push(&self, data: &[u8]) {
        let _ = push_pcm(&self.0, data);
    }
}

fn push_pcm(shared: &Arc<Mutex<EngineInner>>, data: &[u8]) -> Result<(), String> {
    let mut inner = shared
        .lock()
        .map_err(|_| "El motor de emisión no responde".to_string())?;
    let mut error = None;
    for process in inner.processes.iter_mut() {
        if !process.alive || !process.wants_audio {
            continue;
        }
        let dead = process.failed.load(Ordering::SeqCst);
        let result = match process.tx.as_ref() {
            Some(tx) if !dead => tx.try_send(data.to_vec()),
            _ => Err(TrySendError::Disconnected(Vec::new())),
        };
        match result {
            Ok(()) => process.warned_full = false,
            Err(TrySendError::Full(_)) => {
                // El encoder no da abasto (red de subida lenta o servidor
                // lento): se descarta este trozo para no frenar el audio.
                if !process.warned_full {
                    process.warned_full = true;
                    error = Some(format!(
                        "{}: la conexión de subida no da abasto, se pierde audio",
                        process.name
                    ));
                }
            }
            Err(TrySendError::Disconnected(_)) => {
                process.alive = false;
                error = Some(format!("{}: entrada de audio cerrada", process.name));
                process.tx.take();
                let _ = process.child.kill();
                let _ = process.child.wait();
            }
        }
    }
    if let Some(message) = error {
        inner.last_error = Some(sanitize_error(&message));
    }
    Ok(())
}
