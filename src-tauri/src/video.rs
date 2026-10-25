//! Videos en la biblioteca: su audio va por el motor como cualquier cancion
//! y la imagen la pinta la ventana de video (WebView). Los formatos que el
//! WebView no abre se convierten a MP4 (H.264 + AAC) con FFmpeg al importar.

use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::AppState;

/// Contenedores de video que se aceptan al importar.
pub const VIDEO_EXTENSIONS: [&str; 19] = [
    "mp4", "m4v", "mov", "mkv", "webm", "avi", "wmv", "asf", "mpg", "mpeg", "m2v", "flv", "f4v", "3gp", "ts", "m2ts", "mts", "vob",
    "ogv",
];

/// Los que el WebView (y el motor de audio) abren tal cual.
const NATIVE: [&str; 4] = ["mp4", "m4v", "mov", "webm"];

pub const CONVERT_DIR: &str = "convert-tmp";

fn ext_of(path: &Path) -> String {
    path.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase()
}

pub fn is_video(path: &Path) -> bool {
    VIDEO_EXTENSIONS.contains(&ext_of(path).as_str())
}

pub fn needs_conversion(path: &Path) -> bool {
    is_video(path) && !NATIVE.contains(&ext_of(path).as_str())
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CaptureDevice {
    /// Valor que se pasa a FFmpeg como fuente
    pub id: String,
    pub name: String,
    /// "video" o "audio"
    pub kind: String,
}

/// Capturadoras y dispositivos de audio disponibles en el equipo.
#[tauri::command]
pub async fn video_capture_devices(app: AppHandle) -> Result<Vec<CaptureDevice>, String> {
    let ffmpeg = crate::streaming::find_ffmpeg(&app)
        .unwrap_or_else(|| PathBuf::from(if cfg!(windows) { "ffmpeg.exe" } else { "ffmpeg" }));
    tauri::async_runtime::spawn_blocking(move || list_capture_devices(&ffmpeg))
        .await
        .map_err(|error| error.to_string())?
}

#[cfg(target_os = "windows")]
fn list_capture_devices(ffmpeg: &Path) -> Result<Vec<CaptureDevice>, String> {
    let mut cmd = Command::new(ffmpeg);
    cmd.args(["-hide_banner", "-list_devices", "true", "-f", "dshow", "-i", "dummy"])
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    crate::streaming::configure_no_window(&mut cmd);
    let out = cmd
        .output()
        .map_err(|e| format!("No se pudo ejecutar FFmpeg: {e}"))?;
    let text = String::from_utf8_lossy(&out.stderr);
    let mut list: Vec<CaptureDevice> = Vec::new();
    let mut section = "";
    for line in text.lines() {
        if line.contains("DirectShow video devices") {
            section = "video";
            continue;
        }
        if line.contains("DirectShow audio devices") {
            section = "audio";
            continue;
        }
        if line.contains("Alternative name") {
            continue;
        }
        // Segun la version de FFmpeg el tipo va en un encabezado, al final de
        // la linea (… (video)) o en ambos sitios.
        let kind = if line.contains("(video)") {
            "video"
        } else if line.contains("(audio)") {
            "audio"
        } else {
            section
        };
        if kind.is_empty() {
            continue;
        }
        let (Some(start), Some(end)) = (line.find('"'), line.rfind('"')) else {
            continue;
        };
        if end <= start {
            continue;
        }
        let name = line[start + 1..end].trim();
        if name.is_empty()
            || name.starts_with("@device")
            || list.iter().any(|device| device.name == name && device.kind == kind)
        {
            continue;
        }
        list.push(CaptureDevice {
            id: name.to_string(),
            name: name.to_string(),
            kind: kind.to_string(),
        });
    }
    if list.is_empty() {
        let mut tail: Vec<&str> = text
            .lines()
            .map(str::trim)
            .filter(|line| !line.is_empty())
            .collect();
        tail = tail.split_off(tail.len().saturating_sub(8));
        return Err(format!(
            "FFmpeg no devolvió dispositivos. Revisa la salida de «ffmpeg -list_devices true -f dshow -i dummy»: {}",
            tail.join(" | ")
        ));
    }
    Ok(list)
}

#[cfg(target_os = "linux")]
fn list_capture_devices(_ffmpeg: &Path) -> Result<Vec<CaptureDevice>, String> {
    let mut list = Vec::new();
    for index in 0..32 {
        let id = format!("/dev/video{index}");
        if !Path::new(&id).exists() {
            continue;
        }
        let label = fs::read_to_string(format!("/sys/class/video4linux/video{index}/name"))
            .ok()
            .map(|text| text.trim().to_string())
            .filter(|text| !text.is_empty());
        let name = label
            .map(|label| format!("{label} ({id})"))
            .unwrap_or_else(|| id.clone());
        list.push(CaptureDevice { id, name, kind: "video".to_string() });
    }
    // Tarjetas de sonido ALSA: se usan como audio de una capturadora.
    if let Ok(text) = fs::read_to_string("/proc/asound/cards") {
        for line in text.lines() {
            let trimmed = line.trim_start();
            let mut head = trimmed.split_whitespace();
            let Some(index) = head.next() else { continue };
            if !index.chars().all(|c| c.is_ascii_digit()) {
                continue;
            }
            let name = line
                .split_once("]:")
                .map(|(_, rest)| rest.trim().to_string())
                .filter(|rest| !rest.is_empty())
                .unwrap_or_else(|| format!("Tarjeta de sonido {index}"));
            list.push(CaptureDevice {
                id: format!("hw:{index}"),
                name: format!("{name} (hw:{index})"),
                kind: "audio".to_string(),
            });
        }
    }
    Ok(list)
}

#[cfg(target_os = "macos")]
fn list_capture_devices(ffmpeg: &Path) -> Result<Vec<CaptureDevice>, String> {
    let mut cmd = Command::new(ffmpeg);
    cmd.args(["-hide_banner", "-list_devices", "true", "-f", "avfoundation", "-i", ""])
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    crate::streaming::configure_no_window(&mut cmd);
    let out = cmd
        .output()
        .map_err(|e| format!("No se pudo ejecutar FFmpeg: {e}"))?;
    let text = String::from_utf8_lossy(&out.stderr);
    let mut list = Vec::new();
    let mut section = "";
    for line in text.lines() {
        if line.contains("AVFoundation video devices") {
            section = "video";
            continue;
        }
        if line.contains("AVFoundation audio devices") {
            section = "audio";
            continue;
        }
        if section.is_empty() {
            continue;
        }
        let Some(start) = line.rfind("] [") else { continue };
        let rest = &line[start + 3..];
        let Some(end) = rest.find(']') else { continue };
        let index = rest[..end].trim();
        let label = rest[end + 1..].trim();
        if index.is_empty() || label.is_empty() {
            continue;
        }
        list.push(CaptureDevice {
            id: index.to_string(),
            name: format!("{index}: {label}"),
            kind: section.to_string(),
        });
    }
    Ok(list)
}

#[cfg(not(any(target_os = "windows", target_os = "linux", target_os = "macos")))]
fn list_capture_devices(_ffmpeg: &Path) -> Result<Vec<CaptureDevice>, String> {
    Err("La captura de vídeo no está soportada en este sistema".to_string())
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Converted {
    pub source: String,
    /// MP4 listo para importar (en la carpeta temporal)
    pub output: Option<String>,
    pub error: Option<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ConvertProgress {
    index: usize,
    total: usize,
    name: String,
    /// 0..1 del archivo actual (si se conoce)
    fraction: f64,
}

fn duration_us(line: &str) -> Option<u64> {
    // "  Duration: 00:03:21.45, start: ..."
    let d = line.trim().strip_prefix("Duration:")?.trim();
    let t = d.split(',').next()?.trim();
    let mut parts = t.split(':');
    let h: f64 = parts.next()?.parse().ok()?;
    let m: f64 = parts.next()?.parse().ok()?;
    let s: f64 = parts.next()?.parse().ok()?;
    Some(((h * 3600.0 + m * 60.0 + s) * 1_000_000.0) as u64)
}

/// Argumentos de FFmpeg: `copy_video` intenta no recomprimir la imagen.
pub fn ffmpeg_args(src: &Path, out: &Path, copy_video: bool) -> Vec<String> {
    let mut a: Vec<String> = vec!["-hide_banner".into(), "-nostdin".into(), "-y".into(), "-i".into(), src.display().to_string()];
    a.extend(["-map", "0:v:0?", "-map", "0:a:0?"].iter().map(|s| s.to_string()));
    if copy_video {
        a.extend(["-c:v", "copy"].iter().map(|s| s.to_string()));
    } else {
        a.extend(
            ["-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2"]
                .iter()
                .map(|s| s.to_string()),
        );
    }
    a.extend(
        ["-c:a", "aac", "-b:a", "256k", "-ac", "2", "-movflags", "+faststart", "-progress", "pipe:1", "-nostats"].iter().map(|s| s.to_string()),
    );
    a.push(out.display().to_string());
    a
}

fn run(ffmpeg: &Path, args: &[String], mut on_progress: impl FnMut(f64)) -> Result<(), String> {
    let mut cmd = Command::new(ffmpeg);
    cmd.args(args).stdout(Stdio::piped()).stderr(Stdio::piped());
    crate::streaming::configure_no_window(&mut cmd);
    let mut child = cmd.spawn().map_err(|e| format!("No se pudo ejecutar FFmpeg: {e}"))?;
    // stderr: duracion total y errores (en otro hilo para no bloquear).
    let stderr = child.stderr.take();
    let err_thread = std::thread::spawn(move || {
        let mut total = 0u64;
        let mut tail: Vec<String> = Vec::new();
        if let Some(s) = stderr {
            for line in BufReader::new(s).lines().map_while(Result::ok) {
                if total == 0 {
                    if let Some(d) = duration_us(&line) {
                        total = d;
                    }
                }
                tail.push(line);
                if tail.len() > 6 {
                    tail.remove(0);
                }
            }
        }
        (total, tail)
    });
    if let Some(out) = child.stdout.take() {
        for line in BufReader::new(out).lines().map_while(Result::ok) {
            if let Some(v) = line.strip_prefix("out_time_us=").or_else(|| line.strip_prefix("out_time_ms=")) {
                if let Ok(us) = v.trim().parse::<u64>() {
                    on_progress(us as f64);
                }
            }
        }
    }
    let status = child.wait().map_err(|e| e.to_string())?;
    let (_, tail) = err_thread.join().unwrap_or_default();
    if status.success() {
        Ok(())
    } else {
        Err(tail.last().cloned().unwrap_or_else(|| "FFmpeg terminó con error".into()))
    }
}

/// Convierte a MP4 los videos que lo necesitan. Devuelve, por archivo, el
/// MP4 temporal (que `import_files` mueve a la biblioteca) o el error.
#[tauri::command]
pub async fn convert_videos(app: AppHandle, paths: Vec<String>) -> Result<Vec<Converted>, String> {
    let data_dir = app.state::<AppState>().data_dir.clone();
    let ffmpeg = crate::streaming::find_ffmpeg(&app);
    tauri::async_runtime::spawn_blocking(move || {
        let dir = data_dir.join(CONVERT_DIR);
        let _ = fs::create_dir_all(&dir);
        let total = paths.len();
        let mut out = Vec::new();
        for (i, p) in paths.into_iter().enumerate() {
            let src = PathBuf::from(&p);
            let name = src.file_name().and_then(|n| n.to_str()).unwrap_or("video").to_string();
            let Some(ffmpeg) = ffmpeg.as_ref() else {
                out.push(Converted {
                    source: p,
                    output: None,
                    error: Some("Hace falta FFmpeg para convertir este formato (pon ffmpeg.exe junto a MiRadio.exe)".into()),
                });
                continue;
            };
            let stem = src.file_stem().and_then(|n| n.to_str()).unwrap_or("video");
            let mut target = dir.join(format!("{stem}.mp4"));
            let mut n = 2;
            while target.exists() {
                target = dir.join(format!("{stem} ({n}).mp4"));
                n += 1;
            }
            let emit = |fraction: f64| {
                let _ = app.emit("video://convert", ConvertProgress { index: i, total, name: name.clone(), fraction });
            };
            emit(0.0);
            // Primero sin recomprimir la imagen (rapido); si no vale, a H.264.
            let ext = ext_of(&src);
            let try_copy = matches!(ext.as_str(), "mkv" | "ts" | "m2ts" | "mts" | "flv" | "f4v" | "3gp");
            let mut res = Err(String::new());
            let mut total_us = 0f64;
            if try_copy {
                res = run(ffmpeg, &ffmpeg_args(&src, &target, true), |_| {});
            }
            if res.is_err() {
                // Duracion para la barra de progreso.
                total_us = probe_us(ffmpeg, &src).unwrap_or(0) as f64;
                res = run(ffmpeg, &ffmpeg_args(&src, &target, false), |us| {
                    if total_us > 0.0 {
                        emit((us / total_us).clamp(0.0, 1.0));
                    }
                });
            }
            let _ = total_us;
            match res {
                Ok(()) if target.is_file() => out.push(Converted { source: p, output: Some(target.display().to_string()), error: None }),
                Ok(()) => out.push(Converted { source: p, output: None, error: Some("FFmpeg no generó el archivo".into()) }),
                Err(e) => {
                    let _ = fs::remove_file(&target);
                    out.push(Converted { source: p, output: None, error: Some(e) })
                }
            }
            emit(1.0);
        }
        Ok(out)
    })
    .await
    .map_err(|e| e.to_string())?
}

fn probe_us(ffmpeg: &Path, src: &Path) -> Option<u64> {
    let mut cmd = Command::new(ffmpeg);
    cmd.args(["-hide_banner", "-nostdin", "-i"]).arg(src);
    crate::streaming::configure_no_window(&mut cmd);
    let out = cmd.output().ok()?;
    String::from_utf8_lossy(&out.stderr).lines().find_map(duration_us)
}

/// Copia en WAV del audio de un archivo, para el motor web cuando el WebView
/// no sabe decodificarlo (algunos MP4/MOV de video). Se guarda en cache.
#[tauri::command]
pub async fn audio_fallback(app: AppHandle, path: String) -> Result<String, String> {
    let data_dir = app.state::<AppState>().data_dir.clone();
    tauri::async_runtime::spawn_blocking(move || wav_cache(&data_dir, Path::new(&path)))
        .await
        .map_err(|e| e.to_string())?
}

pub fn wav_cache(data_dir: &Path, src: &Path) -> Result<String, String> {
    let meta = fs::metadata(src).map_err(|e| format!("No se pudo abrir el archivo: {e}"))?;
    let stamp = meta.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_secs()).unwrap_or(0);
    let mut h: u64 = 1469598103934665603;
    for b in src.to_string_lossy().bytes().chain(stamp.to_le_bytes()).chain(meta.len().to_le_bytes()) {
        h ^= b as u64;
        h = h.wrapping_mul(1099511628211);
    }
    let dir = data_dir.join(AUDIO_CACHE_DIR);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let out = dir.join(format!("{h:016x}.wav"));
    if out.is_file() {
        return Ok(out.display().to_string());
    }
    let pcm = crate::engine::pcm::decode_file(src, 48000)?;
    let tmp = out.with_extension("wav.part");
    write_wav(&tmp, 48000, &pcm.data).map_err(|e| e.to_string())?;
    fs::rename(&tmp, &out).map_err(|e| e.to_string())?;
    prune(&dir, 40);
    Ok(out.display().to_string())
}

pub const AUDIO_CACHE_DIR: &str = "audio-cache";

fn write_wav(path: &Path, rate: u32, data: &[f32]) -> std::io::Result<()> {
    use std::io::Write;
    let mut f = std::io::BufWriter::new(fs::File::create(path)?);
    let bytes = (data.len() * 2) as u32;
    f.write_all(b"RIFF")?;
    f.write_all(&(36 + bytes).to_le_bytes())?;
    f.write_all(b"WAVEfmt ")?;
    f.write_all(&16u32.to_le_bytes())?;
    f.write_all(&1u16.to_le_bytes())?; // PCM
    f.write_all(&2u16.to_le_bytes())?; // estereo
    f.write_all(&rate.to_le_bytes())?;
    f.write_all(&(rate * 4).to_le_bytes())?;
    f.write_all(&4u16.to_le_bytes())?;
    f.write_all(&16u16.to_le_bytes())?;
    f.write_all(b"data")?;
    f.write_all(&bytes.to_le_bytes())?;
    for s in data {
        let v = (s.clamp(-1.0, 1.0) * 32767.0).round() as i16;
        f.write_all(&v.to_le_bytes())?;
    }
    f.flush()
}

/// Deja solo los `keep` archivos mas recientes.
fn prune(dir: &Path, keep: usize) {
    let Ok(rd) = fs::read_dir(dir) else { return };
    let mut files: Vec<(std::time::SystemTime, PathBuf)> = rd
        .flatten()
        .filter_map(|e| Some((e.metadata().ok()?.modified().ok()?, e.path())))
        .collect();
    if files.len() <= keep {
        return;
    }
    files.sort_by(|a, b| b.0.cmp(&a.0));
    for (_, p) in files.into_iter().skip(keep) {
        let _ = fs::remove_file(p);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kinds() {
        assert!(is_video(Path::new("a.MP4")) && !needs_conversion(Path::new("a.MP4")));
        assert!(needs_conversion(Path::new("C:\\v\\clip.avi")));
        assert!(needs_conversion(Path::new("x.mkv")));
        assert!(!is_video(Path::new("a.mp3")));
        assert_eq!(duration_us("  Duration: 00:03:21.50, start: 0.000000, bitrate: 128 kb/s"), Some(201_500_000));
    }

    #[test]
    fn converts_avi_to_mp4_with_audio() {
        let dir = std::env::temp_dir().join(format!("miradio-video-{}", uuid::Uuid::new_v4().simple()));
        fs::create_dir_all(&dir).unwrap();
        let avi = dir.join("clip.avi");
        let ok = Command::new("ffmpeg")
            .args(["-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=320x240:rate=25:duration=2", "-f", "lavfi", "-i", "sine=frequency=440:duration=2", "-c:v", "mpeg4", "-c:a", "mp3"])
            .arg(&avi)
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
        assert!(ok, "hace falta ffmpeg");
        let out = dir.join("clip.mp4");
        run(Path::new("ffmpeg"), &ffmpeg_args(&avi, &out, false), |_| {}).unwrap();
        // El motor lee el audio del MP4 resultante.
        let pcm = crate::engine::pcm::decode_file(&out, 48000).unwrap();
        assert!(pcm.duration() > 1.8, "{}", pcm.duration());
        // Copia WAV para el motor web.
        let wav = wav_cache(&dir, &out).unwrap();
        let again = wav_cache(&dir, &out).unwrap();
        assert_eq!(wav, again, "se reutiliza la cache");
        let back = crate::engine::pcm::decode_file(Path::new(&wav), 48000).unwrap();
        assert!((back.duration() - pcm.duration()).abs() < 0.05);
    }
}
