use serde::Serialize;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, SyncSender, TrySendError};
use std::sync::{Arc, Mutex};
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
    warned_full: bool,
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
}

fn failed_output(id: &str, name: &str, kind: &str, error: String) -> StreamOutputStatus {
    StreamOutputStatus {
        id: id.to_string(),
        name: name.to_string(),
        kind: kind.to_string(),
        running: false,
        state: "error".to_string(),
        error: Some(error),
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
            error: Some(
                "No se encontró FFmpeg. Coloca ffmpeg.exe junto a MiRadio.exe o instálalo en PATH."
                    .to_string(),
            ),
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
) -> Result<StreamStatus, String> {
    let ffmpeg = find_ffmpeg(&app)
        .or_else(|| {
            find_ndi_ffmpeg(&app, &settings.video.ndi_ffmpeg_path)
                .ok()
                .map(|(path, _)| path)
        })
        .ok_or_else(|| {
            "No se encontró FFmpeg. Coloca ffmpeg.exe junto a MiRadio.exe o instálalo en PATH."
                .to_string()
        })?;

    let mut inner = state
        .inner
        .lock()
        .map_err(|_| "El motor de emisión no responde".to_string())?;
    stop_all(&mut inner);
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
        .unwrap_or(false);
    let video_ffmpeg = if selected_input_is_ndi {
        ndi_ffmpeg.unwrap_or(&ffmpeg)
    } else {
        &ffmpeg
    };

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
                if let Err(error) = spawn_process(
                    &mut inner,
                    &shared,
                    &ffmpeg,
                    args,
                    id,
                    name,
                    "icecast",
                    true,
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

    if settings.streaming.rtmp.enabled {
        requested += 1;
        let id = "rtmp".to_string();
        let name = "RTMP".to_string();
        let rtmp_video = if settings.streaming.rtmp.video_input_id.trim().is_empty() {
            preferred_input
        } else {
            Some(settings.streaming.rtmp.video_input_id.trim())
        };
        let rtmp_audio = if settings.streaming.rtmp.audio_source == "device" {
            Some(settings.streaming.rtmp.audio_source_id.trim()).filter(|id| !id.is_empty())
        } else {
            None
        };
        match rtmp_args(
            &settings.video,
            &settings.streaming.rtmp.url,
            settings.streaming.rtmp.width,
            settings.streaming.rtmp.height,
            settings.streaming.rtmp.fps,
            settings.streaming.rtmp.bitrate_kbps,
            settings.streaming.rtmp.keyframe_secs,
            ndi_device,
            rtmp_video,
            rtmp_audio,
        ) {
            Ok(args) => {
                let wants_audio = rtmp_audio.is_none();
                if let Err(error) = spawn_process(
                    &mut inner,
                    &shared,
                    video_ffmpeg,
                    args,
                    id.clone(),
                    name.clone(),
                    "rtmp",
                    wants_audio,
                ) {
                    errors.push(error.clone());
                    inner
                        .failed_outputs
                        .push(failed_output(&id, &name, "rtmp", error));
                }
            }
            Err(error) => {
                let message = format!("RTMP: {error}");
                errors.push(message.clone());
                inner
                    .failed_outputs
                    .push(failed_output(&id, &name, "rtmp", message));
            }
        }
    }

    if settings.video.enabled {
        for output in settings.video.outputs.iter().filter(|o| o.enabled) {
            requested += 1;
            let id = format!("video:{}", output.id);
            let name = if output.name.trim().is_empty() {
                output.kind.clone()
            } else {
                output.name.clone()
            };
            let kind = output.kind.clone();
            let output_video = if output.video_input_id.trim().is_empty() {
                preferred_input
            } else {
                Some(output.video_input_id.trim())
            };
            let output_audio = if output.audio_source == "device" {
                Some(output.audio_source_id.trim()).filter(|id| !id.is_empty())
            } else {
                None
            };
            let args = match kind.as_str() {
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
            };
            match args {
                Ok(args) => {
                    let wants_audio = (kind == "rtmp" || kind == "ndi") && output_audio.is_none();
                    let process_ffmpeg = if kind == "ndi" {
                        ndi_ffmpeg.unwrap_or(&ffmpeg)
                    } else {
                        video_ffmpeg
                    };
                    if let Err(error) = spawn_process(
                        &mut inner,
                        &shared,
                        process_ffmpeg,
                        args,
                        id.clone(),
                        name.clone(),
                        &kind,
                        wants_audio,
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
        return Err(
            "No hay salidas activas. Activa una emisión Icecast, RTMP o un canal de vídeo."
                .to_string(),
        );
    }
    if !errors.is_empty() {
        inner.last_error = Some(errors.join(" · "));
    }
    // Aunque no arranque ninguna salida, devolvemos el estado con los errores
    // por salida para que Ajustes pueda mostrar qué emisión falló.
    Ok(status_from(&mut inner))
}

#[tauri::command]
pub fn stream_stop(state: State<StreamingState>) -> StreamStatus {
    let mut inner = match state.inner.lock() {
        Ok(inner) => inner,
        Err(_) => return empty_status(None, Some("El motor de emisión no responde".to_string())),
    };
    stop_all(&mut inner);
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
            let state = if process.alive {
                "live"
            } else if error.is_some() {
                "error"
            } else {
                "stopped"
            };
            StreamOutputStatus {
                id: process.id.clone(),
                name: process.name.clone(),
                kind: process.kind.clone(),
                running: process.alive,
                state: state.to_string(),
                error,
            }
        })
        .collect();
    outputs.extend(inner.failed_outputs.iter().cloned());
    StreamStatus {
        running: outputs.iter().any(|output| output.running),
        needs_audio: inner
            .processes
            .iter()
            .any(|process| process.alive && process.wants_audio),
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
) -> Result<(), String> {
    let mut command = Command::new(ffmpeg);
    command
        .args(&args)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
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

    let error_slot = Arc::new(Mutex::new(None));
    if let Some(stderr) = child.stderr.take() {
        let shared = shared.clone();
        let slot = error_slot.clone();
        std::thread::spawn(move || {
            let reader = BufReader::new(stderr);
            for line in reader.lines() {
                let Ok(line) = line else { break };
                let line = line.trim();
                if line.is_empty() || !is_error_line(line) {
                    continue;
                }
                let clean = sanitize_error(line);
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
    if wants_audio {
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

    inner.processes.push(StreamProcess {
        id,
        name,
        kind: kind.to_string(),
        wants_audio,
        alive: true,
        child,
        tx,
        failed,
        error: error_slot,
        warned_full: false,
    });
    Ok(())
}

fn stop_all(inner: &mut EngineInner) {
    for mut process in inner.processes.drain(..) {
        process.tx.take();
        if let Some(stdin) = process.child.stdin.take() {
            drop(stdin);
        }
        let _ = process.child.kill();
        let _ = process.child.wait();
    }
    inner.failed_outputs.clear();
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
    let url = url.trim();
    if url.is_empty() {
        return Err("falta la URL RTMP".to_string());
    }
    let lower = url.to_ascii_lowercase();
    if !lower.starts_with("rtmp://") && !lower.starts_with("rtmps://") {
        return Err("la URL RTMP debe empezar por rtmp:// o rtmps://".to_string());
    }
    if !video.enabled {
        return Err("activa el motor de vídeo para emitir por RTMP".to_string());
    }
    let input = pick_video_input(video, preferred_input)?;
    let mut args = base_input_args();
    args.extend(video_input_args(input, ndi_device)?);
    if let Some(audio) = audio_device {
        args.extend(audio_input_args(audio)?);
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
        args.extend(audio_input_args(audio)?);
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
    let mut args = video_input_args(input, ndi_device)?;
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
            spawn_process(&mut inner, &shared, &ffmpeg, args, "t".into(), "t".into(), "icecast", true).unwrap();
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
