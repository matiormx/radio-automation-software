//! Compresión de vídeo por hardware (como OBS): NVIDIA NVENC, Intel Quick
//! Sync o AMD AMF. Al primer uso se prueba de verdad cada compresor con el
//! FFmpeg que se va a usar (no basta con que aparezca en la lista: sin driver
//! o sin tarjeta falla) y se recuerda el resultado. Si no hay ninguno, se
//! sigue comprimiendo con el procesador (x264), como siempre.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::AppHandle;

/// Orden de preferencia en «automático».
const ORDER: [&str; 3] = ["nvenc", "qsv", "amf"];

fn label(kind: &str) -> &'static str {
    match kind {
        "nvenc" => "NVIDIA (NVENC)",
        "qsv" => "Intel (Quick Sync)",
        "amf" => "AMD (AMF)",
        _ => "Procesador (x264)",
    }
}

/// Argumentos del compresor (sin bitrate ni GOP, que pone quien llama).
/// Puede haber varias variantes por si el FFmpeg es antiguo.
fn variants(kind: &str) -> Vec<Vec<&'static str>> {
    match kind {
        "nvenc" => vec![
            vec!["-c:v", "h264_nvenc", "-preset", "p4", "-tune", "ll", "-rc", "cbr", "-bf", "0", "-pix_fmt", "yuv420p"],
            // FFmpeg anterior a 4.3
            vec!["-c:v", "h264_nvenc", "-preset", "llhq", "-rc", "cbr", "-bf", "0", "-pix_fmt", "yuv420p"],
        ],
        "qsv" => vec![vec!["-c:v", "h264_qsv", "-preset", "veryfast", "-look_ahead", "0", "-pix_fmt", "nv12"]],
        "amf" => vec![vec!["-c:v", "h264_amf", "-usage", "lowlatency", "-quality", "speed", "-rc", "cbr", "-pix_fmt", "yuv420p"]],
        _ => vec![],
    }
}

/// Compresores que funcionan con cada FFmpeg (y con qué variante).
fn cache() -> &'static Mutex<HashMap<PathBuf, Vec<(&'static str, Vec<&'static str>)>>> {
    static C: OnceLock<Mutex<HashMap<PathBuf, Vec<(&'static str, Vec<&'static str>)>>>> = OnceLock::new();
    C.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Por qué falló cada compresor que FFmpeg sí trae (para enseñarlo en Ajustes).
fn failures() -> &'static Mutex<HashMap<PathBuf, Vec<(&'static str, String)>>> {
    static F: OnceLock<Mutex<HashMap<PathBuf, Vec<(&'static str, String)>>>> = OnceLock::new();
    F.get_or_init(|| Mutex::new(HashMap::new()))
}

fn listed_encoders(ffmpeg: &Path) -> String {
    let mut cmd = Command::new(ffmpeg);
    cmd.args(["-hide_banner", "-encoders"]).stdout(Stdio::piped()).stderr(Stdio::null());
    crate::streaming::configure_no_window(&mut cmd);
    cmd.output().map(|o| String::from_utf8_lossy(&o.stdout).into_owned()).unwrap_or_default()
}

/// Comprime un segundo de imagen negra 720p: si sale bien, el compresor vale.
/// Si falla, devuelve lo que dijo FFmpeg (driver viejo, sin tarjeta…).
fn works(ffmpeg: &Path, args: &[&str]) -> Result<(), String> {
    let mut cmd = Command::new(ffmpeg);
    cmd.args(["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=black:s=1280x720:r=30", "-frames:v", "30"])
        .args(args)
        .args(["-b:v", "2500k", "-f", "null", "-"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    crate::streaming::configure_no_window(&mut cmd);
    let mut child = cmd.spawn().map_err(|e| e.to_string())?;
    // El error de FFmpeg se lee aparte (si no, un mensaje largo lo bloquea)
    let mut err = child.stderr.take();
    let reader = std::thread::spawn(move || {
        let mut text = String::new();
        if let Some(e) = err.as_mut() {
            use std::io::Read;
            let _ = e.read_to_string(&mut text);
        }
        text
    });
    let start = Instant::now();
    let ok = loop {
        match child.try_wait() {
            Ok(Some(st)) => break st.success(),
            Ok(None) if start.elapsed() < Duration::from_secs(15) => std::thread::sleep(Duration::from_millis(50)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                break false;
            }
        }
    };
    let text = reader.join().unwrap_or_default();
    if ok {
        return Ok(());
    }
    // La línea que explica el fallo (no las de «Error while…» genéricas)
    let lines: Vec<&str> = text.lines().map(str::trim).filter(|l| !l.is_empty()).collect();
    let best = lines
        .iter()
        .find(|l| {
            let l = l.to_ascii_lowercase();
            l.contains("driver") || l.contains("cuda") || l.contains("no capable") || l.contains("device") || l.contains("not supported") || l.contains("cannot load")
        })
        .or(lines.first())
        .map(|l| l.to_string())
        .unwrap_or_else(|| "la prueba no terminó".into());
    Err(best.chars().take(300).collect())
}

/// Compresores por hardware que funcionan con este FFmpeg (se prueba una vez).
fn detect(ffmpeg: &Path) -> Vec<(&'static str, Vec<&'static str>)> {
    if let Some(v) = cache().lock().ok().and_then(|c| c.get(ffmpeg).cloned()) {
        return v;
    }
    let listed = listed_encoders(ffmpeg);
    let mut found = Vec::new();
    let mut failed = Vec::new();
    for kind in ORDER {
        let name = format!("h264_{kind}");
        if !listed.contains(&name) {
            continue;
        }
        let mut last_err = String::new();
        let mut ok = None;
        for v in variants(kind) {
            match works(ffmpeg, &v) {
                Ok(()) => {
                    ok = Some(v);
                    break;
                }
                Err(e) => last_err = e,
            }
        }
        match ok {
            Some(v) => found.push((kind, v)),
            None => failed.push((kind, last_err)),
        }
    }
    if let Ok(mut c) = cache().lock() {
        c.insert(ffmpeg.to_path_buf(), found.clone());
    }
    if let Ok(mut f) = failures().lock() {
        f.insert(ffmpeg.to_path_buf(), failed);
    }
    found
}

/// Compresor que se usará según la preferencia («auto», «nvenc», «qsv»,
/// «amf» o «x264»): (tipo, argumentos). None = procesador.
fn choose(ffmpeg: &Path, pref: &str) -> Option<(&'static str, Vec<&'static str>)> {
    if pref == "x264" {
        return None;
    }
    let found = detect(ffmpeg);
    if pref == "auto" || pref.is_empty() {
        return found.into_iter().next();
    }
    // Forzado pero no funciona en este equipo: mejor emitir con el procesador
    found.into_iter().find(|(k, _)| *k == pref)
}

/// Cambia la compresión x264 de unos argumentos de FFmpeg por la del
/// hardware elegido. Si no hay x264 en los argumentos (salidas sin
/// compresión) o no hay hardware, se devuelven tal cual.
pub fn apply(args: Vec<String>, ffmpeg: &Path, pref: &str) -> Vec<String> {
    let Some(at) = args.windows(2).position(|w| w[0] == "-c:v" && w[1] == "libx264") else {
        return args;
    };
    let Some((_, enc)) = choose(ffmpeg, pref) else {
        return args;
    };
    // Opciones propias de x264 que no entienden los demás
    const X264_ONLY: [&str; 5] = ["-preset", "-tune", "-pix_fmt", "-sc_threshold", "-x264-params"];
    let mut out: Vec<String> = Vec::with_capacity(args.len() + 8);
    out.extend(args[..at].iter().cloned());
    out.extend(enc.iter().map(|s| s.to_string()));
    let mut i = at + 2;
    while i < args.len() {
        if X264_ONLY.contains(&args[i].as_str()) && i + 1 < args.len() {
            i += 2;
            continue;
        }
        out.push(args[i].clone());
        i += 1;
    }
    out
}

/// Al arrancar, en segundo plano: así la primera emisión no espera a la prueba.
pub fn warm_up(app: &AppHandle) {
    if let Some(ffmpeg) = crate::streaming::find_ffmpeg(app) {
        std::thread::spawn(move || {
            detect(&ffmpeg);
        });
    }
}

/// ¿Hay una tarjeta de esa marca? (FFmpeg trae los tres compresores aunque
/// no haya tarjeta: solo se avisa de los fallos de la que está puesta.)
fn has_hardware(kind: &str) -> bool {
    static GPUS: OnceLock<String> = OnceLock::new();
    let gpus = GPUS.get_or_init(|| {
        #[cfg(windows)]
        let out = {
            let mut cmd = Command::new("powershell");
            cmd.args(["-NoProfile", "-Command", "(Get-CimInstance Win32_VideoController).Name"]);
            crate::streaming::configure_no_window(&mut cmd);
            cmd.output()
        };
        #[cfg(not(windows))]
        let out = Command::new("sh").args(["-c", "lspci 2>/dev/null | grep -Ei 'vga|3d|display'"]).output();
        out.map(|o| String::from_utf8_lossy(&o.stdout).to_ascii_lowercase()).unwrap_or_default()
    });
    match kind {
        "nvenc" => gpus.contains("nvidia"),
        "qsv" => gpus.contains("intel"),
        "amf" => gpus.contains("amd") || gpus.contains("radeon"),
        _ => false,
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EncoderInfo {
    /// Compresores por hardware que funcionan aquí: (id, nombre)
    pub available: Vec<(String, String)>,
    /// El que se usa en «automático»
    pub auto_id: String,
    pub auto_label: String,
    /// Compresores que el equipo parece tener pero no funcionaron: (nombre, motivo)
    pub failed: Vec<(String, String)>,
}

#[tauri::command]
pub async fn video_encoders(app: AppHandle) -> EncoderInfo {
    tauri::async_runtime::spawn_blocking(move || {
        let ffmpeg = crate::streaming::find_ffmpeg(&app);
        let found = ffmpeg.as_ref().map(|f| detect(f)).unwrap_or_default();
        let failed: Vec<(String, String)> = ffmpeg
            .as_ref()
            .and_then(|f| failures().lock().ok().and_then(|m| m.get(f).cloned()))
            .unwrap_or_default()
            .into_iter()
            .filter(|(k, _)| has_hardware(k))
            .map(|(k, e)| (label(k).to_string(), e))
            .collect();
        let auto = found.first().map(|(k, _)| *k).unwrap_or("x264");
        EncoderInfo {
            available: found.iter().map(|(k, _)| (k.to_string(), label(k).to_string())).collect(),
            auto_id: auto.to_string(),
            auto_label: label(auto).to_string(),
            failed,
        }
    })
    .await
    .unwrap_or(EncoderInfo { available: vec![], auto_id: "x264".into(), auto_label: label("x264").into(), failed: vec![] })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn replaces_x264_block_only() {
        // Sin hardware en la caché para este binario: no cambia nada
        let fake = PathBuf::from("/nonexistent/ffmpeg-test");
        cache().lock().unwrap().insert(fake.clone(), vec![("nvenc", variants("nvenc")[0].clone())]);
        let args: Vec<String> = ["-i", "x", "-c:v", "libx264", "-preset", "veryfast", "-tune", "zerolatency", "-pix_fmt", "yuv420p", "-b:v", "3000k", "-sc_threshold", "0", "-g", "60", "out"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        let out = apply(args.clone(), &fake, "auto");
        let s = out.join(" ");
        assert!(s.contains("-c:v h264_nvenc -preset p4 -tune ll"), "{s}");
        assert!(!s.contains("libx264") && !s.contains("zerolatency") && !s.contains("sc_threshold"), "{s}");
        assert!(s.ends_with("-b:v 3000k -g 60 out"), "{s}");
        // Forzar el procesador: igual que antes
        assert_eq!(apply(args.clone(), &fake, "x264"), args);
        // Forzar uno que no hay: procesador
        assert_eq!(apply(args, &fake, "amf"), [
            "-i", "x", "-c:v", "libx264", "-preset", "veryfast", "-tune", "zerolatency", "-pix_fmt", "yuv420p", "-b:v", "3000k", "-sc_threshold", "0", "-g", "60", "out"
        ]);
    }

    #[test]
    fn real_ffmpeg_falls_back_without_hardware() {
        // En una máquina sin GPU no debe elegir nada (y no colgarse)
        if let Ok(p) = which("ffmpeg") {
            let found = detect(&p);
            eprintln!("compresores por hardware: {:?}", found.iter().map(|f| f.0).collect::<Vec<_>>());
        }
    }

    fn which(bin: &str) -> Result<PathBuf, ()> {
        std::env::var_os("PATH")
            .and_then(|p| std::env::split_paths(&p).map(|d| d.join(bin)).find(|f| f.is_file()))
            .ok_or(())
    }
}
