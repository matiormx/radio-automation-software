//! Control desde el móvil: una página web que sirve OmniCaster en la red del
//! estudio (o por WireGuard). El móvil entra con un PIN, recibe el estado en
//! directo (SSE) y manda órdenes, que ejecuta la ventana principal como si se
//! pulsaran allí: una sola lógica para todo.
//!
//!   GET  /                 la página (todo en un archivo)
//!   POST /api/login        {"pin"} -> {"token"}
//!   GET  /api/events?t=    estado en directo (text/event-stream)
//!   POST /api/cmd?t=       {"cmd": …} -> evento «mobile://cmd» a la ventana principal
//!   GET  /api/cover?t=&f=  portada (solo las del estado publicado)
//!   GET  /api/snap?t=&src= imagen de lo que se emite (np | ndi:NOMBRE)
//!   GET  /api/sys?t=       monitor del sistema

use std::collections::HashSet;
use std::io::{Cursor, Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};

const PAGE: &str = include_str!("mobile/index.html");
const MAX_BODY: usize = 64 * 1024;

#[derive(Deserialize, Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct MobileConfig {
    pub enabled: bool,
    pub port: u16,
    pub pin: String,
}

impl Default for MobileConfig {
    fn default() -> Self {
        MobileConfig { enabled: false, port: 8080, pin: String::new() }
    }
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct MobileStatus {
    running: bool,
    port: u16,
    /// Direcciones para abrir en el móvil
    urls: Vec<String>,
    error: Option<String>,
}

struct Shared {
    /// Último estado publicado por la ventana principal (JSON)
    snapshot: Arc<String>,
    seq: u64,
    /// Portadas que se pueden servir (las del estado)
    covers: HashSet<String>,
    token: String,
    pin: String,
    /// Intentos fallidos seguidos (se espera tras varios)
    fails: u32,
    last_fail: Option<Instant>,
}

struct Running {
    server: Arc<tiny_http::Server>,
    stop: Arc<AtomicBool>,
    threads: Vec<JoinHandle<()>>,
}

impl Running {
    fn shutdown(mut self) {
        self.stop.store(true, Ordering::SeqCst);
        self.server.unblock();
        for t in self.threads.drain(..) {
            let _ = t.join();
        }
    }
}

pub struct MobileState {
    shared: Arc<(Mutex<Shared>, Condvar)>,
    running: Mutex<Option<Running>>,
    config: Mutex<Option<MobileConfig>>,
    error: Mutex<Option<String>>,
}

impl Default for MobileState {
    fn default() -> Self {
        MobileState {
            shared: Arc::new((
                Mutex::new(Shared {
                    snapshot: Arc::new("{}".into()),
                    seq: 0,
                    covers: HashSet::new(),
                    token: new_token(),
                    pin: String::new(),
                    fails: 0,
                    last_fail: None,
                }),
                Condvar::new(),
            )),
            running: Mutex::new(None),
            config: Mutex::new(None),
            error: Mutex::new(None),
        }
    }
}

fn new_token() -> String {
    uuid::Uuid::new_v4().simple().to_string()
}

fn lan_addresses() -> Vec<String> {
    let nets = sysinfo::Networks::new_with_refreshed_list();
    let mut v: Vec<String> = nets
        .list()
        .iter()
        .flat_map(|(_, d)| d.ip_networks().iter().map(|n| n.addr))
        .filter(|a| a.is_ipv4() && !a.is_loopback())
        .map(|a| a.to_string())
        .filter(|a| !a.starts_with("169.254."))
        .collect();
    v.sort();
    v.dedup();
    v
}

fn status_of(state: &MobileState) -> MobileStatus {
    let running = state.running.lock().map(|r| r.is_some()).unwrap_or(false);
    let port = state.config.lock().ok().and_then(|c| c.as_ref().map(|c| c.port)).unwrap_or(0);
    MobileStatus {
        running,
        port,
        urls: if running { lan_addresses().into_iter().map(|a| format!("http://{a}:{port}")).collect() } else { Vec::new() },
        error: state.error.lock().ok().and_then(|e| e.clone()),
    }
}

/// Arranca, para o reinicia el servidor según la configuración.
#[tauri::command]
pub fn mobile_apply(app: AppHandle, state: State<'_, MobileState>, config: MobileConfig) -> MobileStatus {
    let pin = config.pin.trim().to_string();
    {
        let mut sh = state.shared.0.lock().unwrap_or_else(|e| e.into_inner());
        if sh.pin != pin {
            // PIN nuevo: los móviles que ya entraron tienen que volver a entrar.
            sh.pin = pin.clone();
            sh.token = new_token();
        }
    }
    let mut cfg = state.config.lock().unwrap_or_else(|e| e.into_inner());
    let mut running = state.running.lock().unwrap_or_else(|e| e.into_inner());
    let restart = cfg.as_ref().map(|c| c.enabled != config.enabled || c.port != config.port).unwrap_or(true) || (config.enabled && running.is_none());
    if restart {
        if let Some(r) = running.take() {
            r.shutdown();
        }
        let mut err = state.error.lock().unwrap_or_else(|e| e.into_inner());
        *err = None;
        if config.enabled {
            if pin.len() < 4 {
                *err = Some("Pon un PIN de al menos 4 cifras".into());
            } else {
                match start(app, state.shared.clone(), config.port) {
                    Ok(r) => *running = Some(r),
                    Err(e) => *err = Some(e),
                }
            }
        }
    }
    *cfg = Some(config);
    drop(running);
    drop(cfg);
    status_of(&state)
}

#[tauri::command]
pub fn mobile_status(state: State<'_, MobileState>) -> MobileStatus {
    status_of(&state)
}

/// La ventana principal publica su estado (JSON) y las portadas que usa.
#[tauri::command]
pub fn mobile_publish(state: State<'_, MobileState>, snapshot: String, covers: Vec<String>) {
    let (lock, cv) = &*state.shared;
    let mut sh = lock.lock().unwrap_or_else(|e| e.into_inner());
    if *sh.snapshot == snapshot {
        return;
    }
    sh.snapshot = Arc::new(snapshot);
    sh.seq += 1;
    sh.covers = covers.into_iter().collect();
    cv.notify_all();
}

fn start(app: AppHandle, shared: Arc<(Mutex<Shared>, Condvar)>, port: u16) -> Result<Running, String> {
    let server = Arc::new(tiny_http::Server::http(("0.0.0.0", port)).map_err(|e| format!("No se pudo abrir el puerto {port}: {e}"))?);
    let stop = Arc::new(AtomicBool::new(false));
    let mut threads = Vec::new();
    // Un hilo recibe; cada conexión va en su propio hilo (los eventos en directo
    // mantienen la conexión abierta).
    let (srv, st) = (server.clone(), stop.clone());
    let t = std::thread::Builder::new()
        .name("omnicaster-movil".into())
        .spawn(move || {
            while !st.load(Ordering::SeqCst) {
                let req = match srv.recv_timeout(Duration::from_millis(500)) {
                    Ok(Some(r)) => r,
                    Ok(None) => continue,
                    Err(_) => break,
                };
                let (app, shared, st) = (app.clone(), shared.clone(), st.clone());
                let _ = std::thread::Builder::new().name("omnicaster-movil-req".into()).spawn(move || serve(&app, &shared, &st, req));
            }
        })
        .map_err(|e| e.to_string())?;
    threads.push(t);
    Ok(Running { server, stop, threads })
}

fn header(k: &str, v: &str) -> tiny_http::Header {
    tiny_http::Header::from_bytes(k.as_bytes(), v.as_bytes()).expect("cabecera")
}

fn reply(req: tiny_http::Request, status: u16, ct: &str, body: Vec<u8>) {
    let resp = tiny_http::Response::new(
        tiny_http::StatusCode(status),
        vec![header("Content-Type", ct), header("Cache-Control", "no-store"), header("X-Content-Type-Options", "nosniff")],
        Cursor::new(body),
        None,
        None,
    );
    let _ = req.respond(resp);
}

fn json(req: tiny_http::Request, status: u16, v: serde_json::Value) {
    reply(req, status, "application/json; charset=utf-8", v.to_string().into_bytes());
}

fn query(url: &str, key: &str) -> Option<String> {
    let q = url.split_once('?').map(|(_, q)| q).unwrap_or("");
    form_urlencoded::parse(q.as_bytes()).find(|(k, _)| k == key).map(|(_, v)| v.into_owned())
}

fn body_of(req: &mut tiny_http::Request) -> Option<serde_json::Value> {
    let mut buf = Vec::new();
    req.as_reader().take(MAX_BODY as u64 + 1).read_to_end(&mut buf).ok()?;
    if buf.len() > MAX_BODY {
        return None;
    }
    serde_json::from_slice(&buf).ok()
}

/// Compara sin delatar por el tiempo cuántos caracteres coinciden.
fn same(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// Logo de OmniCaster (si la emisora no tiene el suyo).
const APP_LOGO: &[u8] = include_bytes!("../../src/assets/logo.png");

/// Nombre (o «OmniCaster Studio») y ruta del logo de la emisora.
fn brand(app: &AppHandle) -> (String, String) {
    use tauri::Manager;
    let Ok(dir) = app.path().app_data_dir() else { return ("OmniCaster Studio".into(), String::new()) };
    let s = crate::settings::read_settings_public(&dir);
    let name = if s.radio_name.trim().is_empty() { "OmniCaster Studio".to_string() } else { s.radio_name.trim().to_string() };
    (name, s.logo_path.trim().to_string())
}

fn serve(app: &AppHandle, shared: &Arc<(Mutex<Shared>, Condvar)>, stop: &AtomicBool, mut req: tiny_http::Request) {
    let url = req.url().to_string();
    let path = url.split('?').next().unwrap_or("/").to_string();
    let method = req.method().as_str().to_ascii_uppercase();
    if method == "GET" && (path == "/" || path == "/index.html") {
        return reply(req, 200, "text/html; charset=utf-8", PAGE.as_bytes().to_vec());
    }
    if method == "GET" && path == "/manifest.webmanifest" {
        let (name, _) = brand(app);
        let m = serde_json::json!({
            "name": name, "short_name": name, "start_url": "/", "display": "standalone",
            "background_color": "#0e1116", "theme_color": "#0e1116",
            "icons": [{"src": "/logo", "sizes": "512x512", "type": "image/png"}]
        });
        return reply(req, 200, "application/manifest+json", m.to_string().into_bytes());
    }
    // Nombre y logo de la emisora (públicos: se ven antes de entrar)
    if method == "GET" && path == "/api/brand" {
        let (name, _) = brand(app);
        return json(req, 200, serde_json::json!({ "name": name }));
    }
    if method == "GET" && (path == "/logo" || path == "/apple-touch-icon.png") {
        let (_, logo) = brand(app);
        let custom = (!logo.is_empty()).then(|| std::fs::read(&logo).ok()).flatten();
        return match custom {
            Some(bytes) => {
                let ct = match logo.rsplit('.').next().map(|e| e.to_ascii_lowercase()).as_deref() {
                    Some("jpg") | Some("jpeg") => "image/jpeg",
                    Some("webp") => "image/webp",
                    Some("gif") => "image/gif",
                    Some("svg") => "image/svg+xml",
                    _ => "image/png",
                };
                reply(req, 200, ct, bytes)
            }
            None => reply(req, 200, "image/png", APP_LOGO.to_vec()),
        };
    }
    if method == "POST" && path == "/api/login" {
        let pin = body_of(&mut req).and_then(|v| v.get("pin").and_then(|p| p.as_str()).map(String::from)).unwrap_or_default();
        let (lock, _) = &**shared;
        let wait = {
            let sh = lock.lock().unwrap_or_else(|e| e.into_inner());
            // Tras 5 fallos seguidos, 30 s de espera entre intentos.
            sh.fails >= 5 && sh.last_fail.map(|t| t.elapsed() < Duration::from_secs(30)).unwrap_or(false)
        };
        if wait {
            return json(req, 429, serde_json::json!({"error": "Demasiados intentos: espera 30 segundos"}));
        }
        let mut sh = lock.lock().unwrap_or_else(|e| e.into_inner());
        if !sh.pin.is_empty() && same(pin.trim(), &sh.pin) {
            sh.fails = 0;
            let token = sh.token.clone();
            drop(sh);
            return json(req, 200, serde_json::json!({"token": token}));
        }
        sh.fails += 1;
        sh.last_fail = Some(Instant::now());
        drop(sh);
        std::thread::sleep(Duration::from_millis(600));
        return json(req, 401, serde_json::json!({"error": "PIN incorrecto"}));
    }
    // A partir de aquí, con token.
    let token = query(&url, "t").unwrap_or_default();
    let ok = {
        let sh = shared.0.lock().unwrap_or_else(|e| e.into_inner());
        same(&token, &sh.token)
    };
    if !ok {
        return json(req, 401, serde_json::json!({"error": "Vuelve a entrar con el PIN"}));
    }
    match (method.as_str(), path.as_str()) {
        ("GET", "/api/events") => events(shared, stop, req, &token),
        ("POST", "/api/cmd") => match body_of(&mut req) {
            Some(cmd) if cmd.get("cmd").and_then(|c| c.as_str()).is_some() => {
                let _ = app.emit_to("main", "mobile://cmd", cmd);
                json(req, 200, serde_json::json!({"ok": true}))
            }
            _ => json(req, 400, serde_json::json!({"error": "orden no válida"})),
        },
        ("GET", "/api/snap") => {
            let src = query(&url, "src").unwrap_or_default();
            match crate::ndi::snapshot_jpeg(&src) {
                Some(jpeg) => reply(req, 200, "image/jpeg", jpeg),
                None => reply(req, 204, "image/jpeg", Vec::new()),
            }
        }
        ("GET", "/api/cover") => {
            let f = query(&url, "f").unwrap_or_default();
            let allowed = shared.0.lock().map(|sh| sh.covers.contains(&f)).unwrap_or(false);
            if !allowed {
                return reply(req, 404, "text/plain", Vec::new());
            }
            match std::fs::read(&f) {
                Ok(bytes) => {
                    let ct = match f.rsplit('.').next().map(|e| e.to_ascii_lowercase()).as_deref() {
                        Some("png") => "image/png",
                        Some("webp") => "image/webp",
                        Some("gif") => "image/gif",
                        _ => "image/jpeg",
                    };
                    reply(req, 200, ct, bytes)
                }
                Err(_) => reply(req, 404, "text/plain", Vec::new()),
            }
        }
        ("GET", "/api/sys") => {
            let stats = app.try_state::<crate::sysmon::SysMon>().map(|m| crate::sysmon::compute(app, &m, true));
            match stats {
                Some(s) => json(req, 200, serde_json::to_value(s).unwrap_or_default()),
                None => json(req, 503, serde_json::json!({"error": "sin monitor"})),
            }
        }
        _ => reply(req, 404, "text/plain", Vec::new()),
    }
}

/// Estado en directo: se manda al conectar y cada vez que cambia (con un
/// latido cada 15 s para que la conexión no se cierre).
fn events(shared: &Arc<(Mutex<Shared>, Condvar)>, stop: &AtomicBool, req: tiny_http::Request, token: &str) {
    let mut w = req.into_writer();
    let head = "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-store\r\nConnection: keep-alive\r\nX-Accel-Buffering: no\r\n\r\n";
    if w.write_all(head.as_bytes()).and_then(|_| w.flush()).is_err() {
        return;
    }
    let (lock, cv) = &**shared;
    let mut sent = 0u64;
    loop {
        if stop.load(Ordering::SeqCst) {
            return;
        }
        let (snap, seq, current) = {
            let mut sh = lock.lock().unwrap_or_else(|e| e.into_inner());
            if sh.seq == sent {
                sh = cv.wait_timeout(sh, Duration::from_secs(15)).unwrap_or_else(|e| e.into_inner()).0;
            }
            (sh.snapshot.clone(), sh.seq, sh.token.clone())
        };
        // PIN cambiado: este móvil tiene que volver a entrar.
        if !same(&current, token) {
            let _ = w.write_all(b"event: logout\ndata: {}\n\n");
            let _ = w.flush();
            return;
        }
        let msg = if seq != sent {
            sent = seq;
            format!("data: {}\n\n", snap.replace('\n', " "))
        } else {
            ": latido\n\n".to_string()
        };
        if w.write_all(msg.as_bytes()).and_then(|_| w.flush()).is_err() {
            return;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn constant_time_compare() {
        assert!(same("1234", "1234"));
        assert!(!same("1234", "1235"));
        assert!(!same("123", "1234"));
    }

    #[test]
    fn query_values() {
        assert_eq!(query("/api/cover?t=abc&f=%2Fhome%2Fx.jpg", "f").as_deref(), Some("/home/x.jpg"));
        assert_eq!(query("/api/events", "t"), None);
    }
}
