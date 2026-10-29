//! Miniatura de supervisión de las salidas de vídeo monitorizadas.
//!
//! Por cada salida marcada como monitorizada corre un FFmpeg liviano que lee
//! la misma fuente que se emite, baja la imagen a 320 px a 1 fps y deja el
//! JPEG en memoria. La pestaña Streaming lo pide cada segundo a
//! http://127.0.0.1:<puerto>/m/<salida>.jpg — sin ventanas ni decodificadores:
//! el único coste es ese FFmpeg de miniatura.
//!
//! Si FFmpeg se corta (se cae la fuente) se relanza solo, como un watchdog, y
//! al parar la emisión se detiene todo.

use std::collections::HashMap;
use std::io::Read;
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant};

const WIDTH: u32 = 320;

/// Ultima miniatura de cada monitor ("monitor:<salida>").
fn frames() -> &'static Mutex<HashMap<String, Arc<Mutex<Latest>>>> {
    static F: OnceLock<Mutex<HashMap<String, Arc<Mutex<Latest>>>>> = OnceLock::new();
    F.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Señales de paro de los monitores en marcha.
fn live() -> &'static Mutex<HashMap<String, Arc<AtomicBool>>> {
    static L: OnceLock<Mutex<HashMap<String, Arc<AtomicBool>>>> = OnceLock::new();
    L.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Cuando se paró cada monitor a mano (para que el supervisor del respaldo no
/// lo vuelva a encender si lo apagaron después de construirse su fuente).
fn tombstones() -> &'static Mutex<HashMap<String, std::time::Instant>> {
    static T: OnceLock<Mutex<HashMap<String, std::time::Instant>>> = OnceLock::new();
    T.get_or_init(|| Mutex::new(HashMap::new()))
}

#[derive(Default)]
struct Latest {
    jpeg: Vec<u8>,
    at: Option<Instant>,
}

fn clear(id: &str) {
    frames().lock().unwrap_or_else(|e| e.into_inner()).remove(id);
}

/// Pone en marcha (o reemplaza) la miniatura de una salida.
pub fn start(ffmpeg: &Path, input_args: Vec<String>, id: String) {
    let stop = Arc::new(AtomicBool::new(false));
    let mut live = live().lock().unwrap_or_else(|e| e.into_inner());
    if let Some(prev) = live.insert(id.clone(), stop.clone()) {
        prev.store(true, Ordering::SeqCst);
    }
    drop(live);
    tombstones().lock().unwrap_or_else(|e| e.into_inner()).remove(&id);
    let ffmpeg = ffmpeg.to_path_buf();
    let _ = thread::Builder::new().name("miradio-monitor".into()).spawn(move || {
        while !stop.load(Ordering::SeqCst) {
            run_once(&ffmpeg, &input_args, &id, &stop);
            if stop.load(Ordering::SeqCst) {
                break;
            }
            thread::sleep(Duration::from_secs(2));
        }
        clear(&id);
    });
}

/// ¿Puede (re)arrancarse el monitor a partir de una fuente construida en
/// `built`? Si lo pararon a mano DESPUES de construirse esa fuente, no: la
/// decision del operador manda.
pub fn resumable(id: &str, built: std::time::Instant) -> bool {
    match tombstones()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(id)
    {
        Some(stopped_at) => *stopped_at < built,
        None => true,
    }
}

/// Para todas las miniaturas (y borra las imagenes memorizadas).
pub fn stop_all() {
    let stops: Vec<(String, Arc<AtomicBool>)> = {
        let mut live = live().lock().unwrap_or_else(|e| e.into_inner());
        live.drain().collect()
    };
    let now = std::time::Instant::now();
    for (id, stop) in stops {
        stop.store(true, Ordering::SeqCst);
        tombstones().lock().unwrap_or_else(|e| e.into_inner()).insert(id, now);
    }
    frames().lock().unwrap_or_else(|e| e.into_inner()).clear();
}

/// Ids de los monitores vivos ("monitor:<salida>").
pub fn live_ids() -> Vec<String> {
    live().lock()
        .unwrap_or_else(|e| e.into_inner())
        .keys()
        .cloned()
        .collect()
}

/// Para un monitor concreto (y borra su ultima imagen).
pub fn stop_id(id: &str) {
    if let Some(stop) = live().lock().unwrap_or_else(|e| e.into_inner()).remove(id) {
        stop.store(true, Ordering::SeqCst);
        tombstones().lock().unwrap_or_else(|e| e.into_inner()).insert(id.to_string(), std::time::Instant::now());
    }
    frames().lock().unwrap_or_else(|e| e.into_inner()).remove(id);
}

/// Lanza un FFmpeg de miniatura y va dejando los JPEG que suelta. Termina
/// cuando FFmpeg se corta (y el llamador lo relanza) o cuando llega la señal
/// de paro (con la que además mata al FFmpeg, porque la lectura se bloquea).
fn run_once(ffmpeg: &Path, input_args: &[String], id: &str, stop: &Arc<AtomicBool>) {
    let mut cmd = Command::new(ffmpeg);
    cmd.args(["-hide_banner", "-nostdin", "-loglevel", "error"])
        .args(input_args)
        .args(["-map", "0:v", "-vf", &format!("fps=1,scale={WIDTH}:-2"), "-q:v", "4"])
        .args(["-f", "mjpeg", "pipe:1"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    crate::streaming::configure_no_window(&mut cmd);
    let mut child = match cmd.spawn() {
        Ok(child) => child,
        Err(_) => return,
    };
    let stdout = child.stdout.take();
    let shared_child = Arc::new(Mutex::new(child));
    let killer_child = shared_child.clone();
    let killer_stop = stop.clone();
    let killer = thread::spawn(move || {
        while !killer_stop.load(Ordering::SeqCst) {
            thread::sleep(Duration::from_millis(100));
        }
        if let Ok(mut child) = killer_child.lock() {
            let _ = child.kill();
            let _ = child.wait();
        }
    });
    let Some(mut stdout) = stdout else {
        drop(killer);
        return;
    };
    let mut buf: Vec<u8> = Vec::new();
    let mut chunk = [0u8; 32 * 1024];
    loop {
        let n = match stdout.read(&mut chunk) {
            Ok(0) | Err(_) => break,
            Ok(n) => n,
        };
        buf.extend_from_slice(&chunk[..n]);
        while let Some(frame) = take_first_jpeg(&mut buf) {
            update(id, frame);
        }
        // Un FFmpeg que responde sin soltar imagen no golpea la memoria.
        if buf.len() > 8 * 1024 * 1024 {
            buf.clear();
        }
    }
    drop(stdout);
    let _ = shared_child.lock().map(|mut child| child.wait());
}

/// Suelta el primer JPEG del bufer. El MJPEG pega los cuadros uno tras otro:
/// el corte es entre la marca de inicio del cuadro que está bufando y la del
/// siguiente — lo que queda en el bufer arranca en el siguiente JPEG.
fn take_first_jpeg(buf: &mut Vec<u8>) -> Option<Vec<u8>> {
    let mut soi: Option<usize> = None;
    let mut i = 0;
    while i + 1 < buf.len() {
        if buf[i] == 0xFF && buf[i + 1] == 0xD8 {
            if let Some(start) = soi {
                let frame = buf[start..i].to_vec();
                buf.drain(..i);
                return Some(frame);
            }
            soi = Some(i);
            i += 2;
        } else {
            i += 1;
        }
    }
    None
}

fn update(id: &str, jpeg: Vec<u8>) {
    let mut slots = frames().lock().unwrap_or_else(|e| e.into_inner());
    let slot = slots.entry(id.to_string()).or_default();
    let mut latest = slot.lock().unwrap_or_else(|e| e.into_inner());
    latest.jpeg = jpeg;
    latest.at = Some(Instant::now());
}

/// Ultima miniatura de un monitor si es fresca (para el acceso remoto, que
/// consulta poco a poco: usa el mismo FFmpeg que la pestaña Streaming).
pub fn latest_jpeg(id: &str) -> Option<Vec<u8>> {
    let slots = frames().lock().unwrap_or_else(|e| e.into_inner());
    let slot = slots.get(id)?;
    let latest = slot.lock().unwrap_or_else(|e| e.into_inner());
    let fresh = latest.at.map(|t| t.elapsed() < Duration::from_secs(10)).unwrap_or(false);
    (fresh && !latest.jpeg.is_empty()).then(|| latest.jpeg.clone())
}

/// Ultima miniatura en base64, para el <img> de la app (mismo camino que el
/// móvil: directo del registro, sin servidor HTTP de por medio).
#[tauri::command]
pub fn monitor_thumbnail(id: String) -> Option<String> {
    use base64::Engine as _;
    let id = format!("monitor:{id}");
    let jpeg = frames()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(&id)
        .and_then(|slot| {
            let latest = slot.lock().unwrap_or_else(|e| e.into_inner());
            let fresh = latest.at.map(|t| t.elapsed() < Duration::from_secs(15)).unwrap_or(false);
            (fresh && !latest.jpeg.is_empty()).then(|| latest.jpeg.clone())
        })?;
    Some(base64::engine::general_purpose::STANDARD.encode(jpeg))
}

// ------------------------------------------------------------ servidor local

/// Direccion del servidor de miniaturas (lo arranca la primera vez).
pub fn server_url() -> Result<String, String> {
    static URL: OnceLock<Result<String, String>> = OnceLock::new();
    URL.get_or_init(|| {
        let server = tiny_http::Server::http("127.0.0.1:0").map_err(|e| e.to_string())?;
        let port = server.server_addr().to_ip().map(|a| a.port()).ok_or("sin puerto")?;
        let server = Arc::new(server);
        thread::Builder::new()
            .name("miradio-monitor-http".into())
            .spawn(move || {
                for req in server.incoming_requests() {
                    thread::spawn(move || serve(req));
                }
            })
            .map_err(|e| e.to_string())?;
        Ok(format!("http://127.0.0.1:{port}"))
    })
    .clone()
}

fn serve(req: tiny_http::Request) {
    let url = req.url().to_string();
    // El navegador por lo general deja ":" tal cual; si lo escapa sera %3A.
    let key = url
        .strip_prefix("/m/")
        .and_then(|r| r.strip_suffix(".jpg"))
        .map(|id| id.replace("%3A", ":").replace("%3a", ":"));
    let Some(id) = key else {
        let _ = req.respond(tiny_http::Response::from_string("ruta invalida").with_status_code(404));
        return;
    };
    let jpeg = frames()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(id.as_str())
        .and_then(|slot| {
            let latest = slot.lock().unwrap_or_else(|e| e.into_inner());
            if latest.jpeg.is_empty() {
                None
            } else {
                Some(latest.jpeg.clone())
            }
        });
    let Some(jpeg) = jpeg else {
        let _ = req.respond(tiny_http::Response::from_string("sin miniatura").with_status_code(503));
        return;
    };
    let mut resp = tiny_http::Response::from_data(jpeg);
    if let Ok(h) = tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"image/jpeg"[..]) {
        resp.add_header(h);
    }
    if let Ok(h) = tiny_http::Header::from_bytes(&b"Cache-Control"[..], &b"no-store"[..]) {
        resp.add_header(h);
    }
    if let Ok(h) = tiny_http::Header::from_bytes(&b"Access-Control-Allow-Origin"[..], &b"*"[..]) {
        resp.add_header(h);
    }
    let _ = req.respond(resp);
}

#[tauri::command]
pub fn monitor_server() -> Result<String, String> {
    server_url()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_jpeg_frames() {
        // El MJPEG pega los cuadros: el corte por el SOI siguiente deja el
        // primero completo y guarda el segundo hasta que llegue el tercero.
        let mut jpeg = Vec::new();
        jpeg_encoder::Encoder::new(&mut jpeg, 80)
            .encode(&[8u8; 8 * 6 * 4], 8, 6, jpeg_encoder::ColorType::Bgra)
            .unwrap();
        let mut buf = jpeg.clone();
        buf.extend_from_slice(&jpeg);
        let first = take_first_jpeg(&mut buf).unwrap();
        assert_eq!(first, jpeg);
        assert_eq!(take_first_jpeg(&mut buf), None, "con un SOI solo no sale nada");
        buf.extend_from_slice(&jpeg);
        let second = take_first_jpeg(&mut buf).unwrap();
        assert_eq!(second, jpeg);
        assert_eq!(buf.len(), jpeg.len(), "quedo esperando al tercero");
        assert_eq!(take_first_jpeg(&mut buf), None);
    }

    #[test]
    fn keeps_last_frame_per_id() {
        update("monitor:pruebas", vec![1, 2, 3]);
        update("monitor:pruebas", vec![9]);
        let slots = frames().lock().unwrap();
        let slot = slots.get("monitor:pruebas").unwrap();
        assert_eq!(slot.lock().unwrap().jpeg, vec![9]);
        drop(slots);
        stop_all();
        assert!(frames().lock().unwrap().get("monitor:pruebas").is_none());
    }
}
