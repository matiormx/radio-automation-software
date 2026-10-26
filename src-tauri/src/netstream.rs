//! Audio de internet (Icecast, HLS, MP3/AAC por HTTP… o un archivo) para los
//! eventos de emision. FFmpeg lo descarga y lo entrega como PCM f32 estereo:
//! - al motor nativo, por un buffer circular (engine::live);
//! - al motor web, por un servidor HTTP local (127.0.0.1) que el WebView lee
//!   con fetch y reproduce en un AudioWorklet.

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdout, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use tauri::AppHandle;

/// Argumentos de FFmpeg para leer `url` como f32le estereo a `rate` Hz.
pub fn ffmpeg_args(url: &str, rate: u32) -> Vec<String> {
    let mut a: Vec<String> = ["-hide_banner", "-nostdin", "-loglevel", "error"].iter().map(|s| s.to_string()).collect();
    let lower = url.to_ascii_lowercase();
    if lower.starts_with("http://") || lower.starts_with("https://") {
        // Si la conexion se corta, FFmpeg reintenta en lugar de terminar.
        a.extend(["-reconnect", "1", "-reconnect_streamed", "1", "-reconnect_on_network_error", "1", "-reconnect_delay_max", "5"].iter().map(|s| s.to_string()));
        a.extend(["-user_agent", "OmniCaster"].iter().map(|s| s.to_string()));
    }
    a.extend(["-i".to_string(), url.to_string()]);
    a.extend(["-vn", "-f", "f32le", "-ac", "2", "-ar"].iter().map(|s| s.to_string()));
    a.push(rate.to_string());
    a.push("pipe:1".into());
    a
}

pub fn valid_source(url: &str) -> bool {
    let l = url.trim().to_ascii_lowercase();
    (l.starts_with("http://") || l.starts_with("https://") || l.starts_with("rtmp://") || l.starts_with("rtsp://") || l.starts_with("srt://"))
        || (Path::new(url.trim()).is_file())
}

/// Lanza FFmpeg leyendo `url`; devuelve el proceso y su salida PCM.
pub fn spawn(ffmpeg: &Path, url: &str, rate: u32) -> Result<(Child, ChildStdout), String> {
    let mut cmd = Command::new(ffmpeg);
    cmd.args(ffmpeg_args(url, rate)).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null());
    crate::streaming::configure_no_window(&mut cmd);
    let mut child = cmd.spawn().map_err(|e| format!("No se pudo ejecutar FFmpeg: {e}"))?;
    let out = child.stdout.take().ok_or("FFmpeg sin salida")?;
    Ok((child, out))
}

pub fn ffmpeg_or_err(app: &AppHandle) -> Result<PathBuf, String> {
    crate::streaming::find_ffmpeg(app)
        .ok_or_else(|| crate::ffmpeg_dl::missing_message())
}

// ------------------------------------------------------------ servidor local (motor web)

struct Server {
    port: u16,
    key: String,
}

static SERVER: OnceLock<Mutex<Option<Server>>> = OnceLock::new();

fn random_key() -> String {
    uuid::Uuid::new_v4().simple().to_string()
}

fn start_server(ffmpeg: PathBuf) -> Result<(u16, String), String> {
    let cell = SERVER.get_or_init(|| Mutex::new(None));
    let mut g = cell.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(s) = g.as_ref() {
        return Ok((s.port, s.key.clone()));
    }
    let server = tiny_http::Server::http("127.0.0.1:0").map_err(|e| e.to_string())?;
    let port = server.server_addr().to_ip().map(|a| a.port()).ok_or("sin puerto")?;
    let key = random_key();
    let k2 = key.clone();
    let server = Arc::new(server);
    for i in 0..4 {
        let (server, key, ffmpeg) = (server.clone(), k2.clone(), ffmpeg.clone());
        let _ = std::thread::Builder::new().name(format!("miradio-netstream-{i}")).spawn(move || loop {
            let Ok(req) = server.recv() else { break };
            serve(req, &key, &ffmpeg);
        });
    }
    *g = Some(Server { port, key: key.clone() });
    Ok((port, key))
}

fn serve(req: tiny_http::Request, key: &str, ffmpeg: &Path) {
    let url = req.url().to_string();
    let q: std::collections::HashMap<String, String> =
        form_urlencoded::parse(url.split_once('?').map(|x| x.1).unwrap_or("").as_bytes()).into_owned().collect();
    let cors = tiny_http::Header::from_bytes("Access-Control-Allow-Origin", "*").expect("cabecera");
    if req.method() == &tiny_http::Method::Options {
        let _ = req.respond(tiny_http::Response::empty(204).with_header(cors));
        return;
    }
    if q.get("k").map(|k| k.as_str()) != Some(key) {
        let _ = req.respond(tiny_http::Response::empty(403).with_header(cors));
        return;
    }
    let src = q.get("u").cloned().unwrap_or_default();
    let rate: u32 = q.get("r").and_then(|r| r.parse().ok()).filter(|r| (8000..=192000).contains(r)).unwrap_or(48000);
    let (mut child, out) = match spawn(ffmpeg, &src, rate) {
        Ok(x) => x,
        Err(e) => {
            let _ = req.respond(tiny_http::Response::from_string(e).with_status_code(502).with_header(cors));
            return;
        }
    };
    let ct = tiny_http::Header::from_bytes("Content-Type", "application/octet-stream").expect("cabecera");
    let resp = tiny_http::Response::new(tiny_http::StatusCode(200), vec![cors, ct], out, None, None);
    // Cuando el WebView corta la lectura, respond() termina y FFmpeg se cierra.
    let _ = req.respond(resp);
    let _ = child.kill();
    let _ = child.wait();
}

/// URL local para que el motor web lea `source` como PCM f32le estereo.
#[tauri::command]
pub fn netstream_url(app: AppHandle, source: String, rate: u32) -> Result<String, String> {
    if !valid_source(&source) {
        return Err("La dirección no es válida (http, https, rtmp, rtsp, srt o un archivo)".into());
    }
    let ffmpeg = ffmpeg_or_err(&app)?;
    let (port, key) = start_server(ffmpeg)?;
    let u: String = form_urlencoded::byte_serialize(source.trim().as_bytes()).collect();
    Ok(format!("http://127.0.0.1:{port}/pcm?k={key}&r={rate}&u={u}"))
}

/// Lee PCM f32le de `out` y lo pasa a `push` hasta que `stop` o fin de datos.
pub fn pump(mut out: ChildStdout, stop: Arc<AtomicBool>, mut push: impl FnMut(&[f32]) -> bool) {
    let mut buf = vec![0u8; 16384];
    let mut carry: Vec<u8> = Vec::new();
    let mut samples: Vec<f32> = Vec::with_capacity(4096);
    while !stop.load(Ordering::SeqCst) {
        let n = match out.read(&mut buf) {
            Ok(0) | Err(_) => break,
            Ok(n) => n,
        };
        carry.extend_from_slice(&buf[..n]);
        let whole = carry.len() / 8 * 8; // pares L R completos
        samples.clear();
        for c in carry[..whole].chunks_exact(4) {
            samples.push(f32::from_le_bytes([c[0], c[1], c[2], c[3]]));
        }
        carry.drain(..whole);
        if !push(&samples) {
            break;
        }
    }
    let _ = std::io::stderr().flush();
    std::thread::sleep(Duration::from_millis(1));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn args_and_sources() {
        let a = ffmpeg_args("https://x/stream.m3u8?delay=28800", 48000);
        assert!(a.windows(2).any(|w| w == ["-reconnect", "1"]));
        assert!(a.ends_with(&["-ar".to_string(), "48000".to_string(), "pipe:1".to_string()]));
        let f = ffmpeg_args("/tmp/a.mp3", 44100);
        assert!(!f.iter().any(|x| x == "-reconnect"), "sin opciones http en archivos");
        assert!(valid_source("https://radio.example/live"));
        assert!(!valid_source("javascript:alert(1)"));
    }

    #[test]
    fn ffmpeg_pcm_from_file_and_local_server() {
        let dir = std::env::temp_dir().join(format!("miradio-ns-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&dir).unwrap();
        let mp3 = dir.join("tono.mp3");
        assert!(Command::new("ffmpeg").args(["-loglevel", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=2"]).arg(&mp3).status().unwrap().success());
        // Lectura directa (motor nativo)
        let (mut child, out) = spawn(Path::new("ffmpeg"), mp3.to_str().unwrap(), 48000).unwrap();
        let mut total = 0usize;
        let mut peak = 0f32;
        pump(out, Arc::new(AtomicBool::new(false)), |s| {
            total += s.len();
            peak = s.iter().fold(peak, |a, b| a.max(b.abs()));
            true
        });
        let _ = child.wait();
        assert!((total as f64 / 2.0 / 48000.0 - 2.0).abs() < 0.1, "{total}");
        assert!(peak > 0.05, "{peak}");
        // Servidor local (motor web)
        let (port, key) = start_server(PathBuf::from("ffmpeg")).unwrap();
        let u: String = form_urlencoded::byte_serialize(mp3.to_str().unwrap().as_bytes()).collect();
        let r = ureq::get(&format!("http://127.0.0.1:{port}/pcm?k={key}&r=44100&u={u}")).call().unwrap();
        assert_eq!(r.header("Access-Control-Allow-Origin"), Some("*"));
        let mut bytes = Vec::new();
        r.into_reader().read_to_end(&mut bytes).unwrap();
        assert!((bytes.len() as f64 / 8.0 / 44100.0 - 2.0).abs() < 0.1, "{}", bytes.len());
        let bad = ureq::get(&format!("http://127.0.0.1:{port}/pcm?k=otra&u={u}")).call();
        assert!(matches!(bad, Err(ureq::Error::Status(403, _))));
    }
}
