//! API compatible con RadioBOSS para el worker de ngradio.es.
//!
//! Peticiones GET a la raiz: `/?action=<accion>&user=…&pass=…` o con
//! `Authorization: Bearer <token>`. Respuestas XML como las de RadioBOSS.
//! El estado de la emision lo publica la app (`api_publish`) y se guarda en
//! memoria: `playbackinfo` no toca disco ni red.

pub mod listeners;
pub mod tags;
pub mod xml;

use std::collections::HashMap;
use std::io::Cursor;
use std::panic::AssertUnwindSafe;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::State;

use self::listeners::Poller;
use self::xml::{duration, empty_tag, norm};
use crate::library::{cover_abs, read_library_internal, Track};
use crate::AppState;

// ------------------------------------------------------------ estado publicado

#[derive(Deserialize, Serialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct PubTrack {
    pub id: String,
    pub artist: String,
    pub title: String,
    pub album: String,
    pub file: String,
    pub duration_secs: f64,
    pub cover: String,
}

#[derive(Deserialize, Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Published {
    /// play | pause | stop
    pub state: String,
    pub pos_ms: f64,
    pub len_ms: f64,
    pub current: Option<PubTrack>,
    pub next: Option<PubTrack>,
    /// Lista de emision completa y posicion de la actual en ella
    pub queue: Vec<PubTrack>,
    pub current_index: i64,
}

struct Now {
    p: Published,
    at: Instant,
    /// Hora (epoch) en que empezo a sonar la pista actual
    started: Option<SystemTime>,
    identity: String,
}

impl Default for Now {
    fn default() -> Self {
        Now { p: Published { state: "stop".into(), ..Default::default() }, at: Instant::now(), started: None, identity: String::new() }
    }
}

impl Now {
    /// Posicion actual en ms (se extrapola si esta sonando).
    fn pos_ms(&self) -> u64 {
        let mut pos = self.p.pos_ms.max(0.0);
        if self.p.state == "play" {
            pos += self.at.elapsed().as_secs_f64() * 1000.0;
        }
        let len = self.p.len_ms.max(0.0);
        (if len > 0.0 { pos.min(len) } else { pos }).round() as u64
    }
}

// ------------------------------------------------------------ identidad

/// FILENAME estable: la ruta del archivo, en forma Unicode unica y con los
/// espacios unificados.
pub fn filename_of(file: &str) -> String {
    norm(file)
}

/// Identidad de una cancion: FILENAME o, si falta, ARTIST+TITLE.
pub fn identity(t: &PubTrack) -> String {
    let f = filename_of(&t.file);
    if !f.is_empty() {
        return f;
    }
    format!("{} - {}", norm(&t.artist), norm(&t.title))
}

fn local_time(t: SystemTime) -> String {
    let dt: chrono::DateTime<chrono::Local> = t.into();
    dt.format("%Y-%m-%d %H:%M:%S").to_string()
}

fn epoch_time(secs: u64) -> String {
    local_time(UNIX_EPOCH + Duration::from_secs(secs))
}

// ------------------------------------------------------------ secretos

#[derive(Deserialize, Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
struct Secrets {
    user: String,
    pass_salt: String,
    pass_hash: String,
    token_hash: String,
    update_token: String,
}

const SECRETS_FILE: &str = "api_secrets.json";
/// Largo minimo de la clave de la API
const MIN_PASS: usize = 6;

fn sha_hex(parts: &[&[u8]]) -> String {
    let mut h = Sha256::new();
    for p in parts {
        h.update(p);
    }
    h.finalize().iter().map(|b| format!("{b:02x}")).collect()
}

/// Comparacion en tiempo constante (no revela cuantos caracteres coinciden).
fn same(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

fn random_hex() -> String {
    format!("{}{}", uuid::Uuid::new_v4().simple(), uuid::Uuid::new_v4().simple())
}

impl Secrets {
    fn load(dir: &Path) -> Secrets {
        std::fs::read(dir.join(SECRETS_FILE))
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default()
    }

    fn save(&self, dir: &Path) -> Result<(), String> {
        let json = serde_json::to_vec_pretty(self).map_err(|e| e.to_string())?;
        std::fs::write(dir.join(SECRETS_FILE), json).map_err(|e| format!("No se pudieron guardar las credenciales: {e}"))
    }

    fn check_login(&self, user: &str, pass: &str) -> bool {
        if self.user.is_empty() || self.pass_hash.is_empty() {
            return false;
        }
        let h = sha_hex(&[self.pass_salt.as_bytes(), pass.as_bytes()]);
        // Ambas comparaciones siempre, para no filtrar cual fallo.
        let u = same(&self.user, user);
        let p = same(&self.pass_hash, &h);
        u & p
    }

    fn check_token(&self, token: &str) -> bool {
        !self.token_hash.is_empty() && same(&self.token_hash, &sha_hex(&[token.as_bytes()]))
    }
}

// ------------------------------------------------------------ configuracion

#[derive(Deserialize, Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct ApiConfig {
    pub enabled: bool,
    pub port: u16,
    /// Escuchar en todas las interfaces (si no, solo 127.0.0.1 para el tunel)
    pub bind_all: bool,
    /// status-json.xsl de Icecast (vacio = sin oyentes)
    pub icecast_status_url: String,
    /// Aviso de cambio de cancion al worker (vacio = no se avisa)
    pub update_url: String,
}

impl Default for ApiConfig {
    fn default() -> Self {
        ApiConfig { enabled: false, port: 9000, bind_all: false, icecast_status_url: String::new(), update_url: String::new() }
    }
}

// ------------------------------------------------------------ nucleo compartido

pub struct Core {
    data_dir: PathBuf,
    now: Mutex<Now>,
    secrets: Mutex<Secrets>,
    icecast_url: Arc<Mutex<String>>,
    update_url: Mutex<String>,
    poller: Poller,
    last_notified: Mutex<String>,
    notify_log: Mutex<Option<String>>,
}

impl Core {
    pub fn new(data_dir: PathBuf) -> Arc<Core> {
        let icecast_url = Arc::new(Mutex::new(String::new()));
        let secrets = Secrets::load(&data_dir);
        Arc::new(Core {
            poller: Poller::start(icecast_url.clone()),
            data_dir,
            now: Mutex::new(Now::default()),
            secrets: Mutex::new(secrets),
            icecast_url,
            update_url: Mutex::new(String::new()),
            last_notified: Mutex::new(String::new()),
            notify_log: Mutex::new(None),
        })
    }

    /// Nuevo estado desde la app. Si cambio la cancion que suena, avisa al
    /// worker una sola vez (sin reintentos).
    pub fn publish(self: &Arc<Self>, p: Published) {
        let id = p.current.as_ref().map(identity).unwrap_or_default();
        let mut now = self.now.lock().unwrap_or_else(|e| e.into_inner());
        if id != now.identity {
            now.started = if id.is_empty() {
                None
            } else {
                Some(SystemTime::now() - Duration::from_millis(p.pos_ms.max(0.0) as u64))
            };
            now.identity = id.clone();
        } else if now.started.is_none() && !id.is_empty() {
            now.started = Some(SystemTime::now() - Duration::from_millis(p.pos_ms.max(0.0) as u64));
        }
        let playing = p.state == "play";
        now.p = p;
        now.at = Instant::now();
        drop(now);
        if playing && !id.is_empty() {
            self.notify_change(&id);
        }
    }

    fn notify_change(self: &Arc<Self>, id: &str) {
        {
            let mut last = self.last_notified.lock().unwrap_or_else(|e| e.into_inner());
            if *last == id {
                return;
            }
            *last = id.to_string();
        }
        let base = self.update_url.lock().map(|u| u.clone()).unwrap_or_default();
        let token = self.secrets.lock().map(|s| s.update_token.clone()).unwrap_or_default();
        if base.trim().is_empty() || token.is_empty() {
            return;
        }
        let sep = if base.contains('?') { '&' } else { '?' };
        let enc: String = form_urlencoded::byte_serialize(token.as_bytes()).collect();
        let url = format!("{}{sep}token={enc}", base.trim());
        let me = self.clone();
        let _ = std::thread::Builder::new().name("miradio-api-update".into()).spawn(move || {
            // Un solo intento: si falla queda anotado (sin el token).
            let res = ureq::get(&url).timeout(Duration::from_secs(5)).call();
            let msg = match res {
                Ok(r) => format!("{} · aviso enviado ({})", local_time(SystemTime::now()), r.status()),
                Err(ureq::Error::Status(code, _)) => format!("{} · el worker respondió {code}", local_time(SystemTime::now())),
                Err(_) => format!("{} · no se pudo avisar al worker", local_time(SystemTime::now())),
            };
            if let Ok(mut g) = me.notify_log.lock() {
                *g = Some(msg);
            }
        });
    }

    fn set_urls(&self, cfg: &ApiConfig) {
        if let Ok(mut g) = self.icecast_url.lock() {
            *g = cfg.icecast_status_url.trim().to_string();
        }
        if let Ok(mut g) = self.update_url.lock() {
            *g = cfg.update_url.trim().to_string();
        }
    }

    // -------------------------------------------------------- autenticacion

    fn authorized(&self, q: &HashMap<String, String>, bearer: Option<&str>) -> bool {
        let s = self.secrets.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(tok) = bearer {
            if s.check_token(tok) {
                return true;
            }
        }
        match (q.get("user"), q.get("pass")) {
            (Some(u), Some(p)) => s.check_login(u, p),
            _ => false,
        }
    }

    // -------------------------------------------------------- acciones

    fn library(&self) -> Vec<Track> {
        read_library_internal(&self.data_dir)
    }

    pub fn playbackinfo(&self) -> String {
        let now = self.now.lock().unwrap_or_else(|e| e.into_inner());
        let state = match now.p.state.as_str() {
            "play" | "pause" => now.p.state.as_str(),
            _ => "stop",
        };
        let has_track = now.p.current.is_some();
        let state = if has_track { state } else { "stop" };
        let pos = if has_track { now.pos_ms() } else { 0 };
        let len = if has_track { now.p.len_ms.max(0.0).round() as u64 } else { 0 };
        let mut out = String::with_capacity(512);
        out.push_str("<Info>\n  ");
        out.push_str(&empty_tag("Playback", &[("state", state), ("pos", &pos.to_string()), ("len", &len.to_string())]));
        out.push_str("\n  <CurrentTrack>");
        if let Some(t) = &now.p.current {
            let start = now.started.map(local_time).unwrap_or_default();
            let dur = if len > 0 { duration(len as f64 / 1000.0) } else { duration(t.duration_secs) };
            out.push_str(&empty_tag(
                "TRACK",
                &[
                    ("ARTIST", &norm(&t.artist)),
                    ("TITLE", &norm(&t.title)),
                    ("FILENAME", &filename_of(&t.file)),
                    ("ALBUM", &norm(&t.album)),
                    ("DURATION", &dur),
                    ("STARTTIME", &start),
                ],
            ));
        }
        out.push_str("</CurrentTrack>\n  <NextTrack>");
        if let Some(t) = &now.p.next {
            out.push_str(&empty_tag(
                "TRACK",
                &[("ARTIST", &norm(&t.artist)), ("TITLE", &norm(&t.title)), ("FILENAME", &filename_of(&t.file))],
            ));
        }
        out.push_str("</NextTrack>\n  <Listeners>");
        drop(now);
        out.push_str(&self.poller.snapshot().total.to_string());
        out.push_str("</Listeners>\n</Info>");
        out
    }

    pub fn encoderstatus(&self) -> String {
        let snap = self.poller.snapshot();
        let mut out = String::from("<Encoders>");
        for m in &snap.mounts {
            out.push_str("\n  ");
            out.push_str(&empty_tag("Encoder", &[("name", &m.name), ("listeners", &m.listeners.to_string())]));
        }
        out.push_str("\n</Encoders>");
        out
    }

    pub fn getlastplayed(&self, count: usize) -> String {
        let mut hist = crate::settings::read_history_public(&self.data_dir);
        hist.reverse(); // mas recientes primero
        let lib = self.library();
        let by_id: HashMap<&str, &Track> = lib.iter().map(|t| (t.id.as_str(), t)).collect();
        let mut out = String::from("<LastPlayed>");
        for e in hist.iter().take(count) {
            let Some(t) = by_id.get(e.track_id.as_str()) else { continue };
            out.push_str("\n  ");
            out.push_str(&empty_tag(
                "Track",
                &[
                    ("ARTIST", &norm(&t.artist)),
                    ("TITLE", &norm(&t.title)),
                    ("FILENAME", &filename_of(&t.file)),
                    ("LASTPLAYED", &epoch_time(e.played_at)),
                ],
            ));
        }
        out.push_str("\n</LastPlayed>");
        out
    }

    pub fn library_xml(&self) -> String {
        let lib = self.library();
        let mut out = String::with_capacity(lib.len() * 160 + 32);
        out.push_str("<Library>");
        for t in &lib {
            out.push_str("\n  ");
            out.push_str(&empty_tag(
                "Track",
                &[
                    ("ARTIST", &norm(&t.artist)),
                    ("TITLE", &norm(&t.title)),
                    ("FILENAME", &filename_of(&t.file)),
                    ("ALBUM", &norm(&t.album)),
                    ("GENRE", &norm(&t.genre)),
                    ("YEAR", &norm(&t.year)),
                    ("DURATION", &duration(t.duration_secs)),
                ],
            ));
        }
        out.push_str("\n</Library>");
        out
    }

    pub fn getplaylist2(&self) -> String {
        let now = self.now.lock().unwrap_or_else(|e| e.into_inner());
        let cur = now.p.current_index;
        let cur_len = now.p.len_ms.max(0.0) / 1000.0;
        // Hora de inicio estimada de cada pista desde la actual.
        let mut next_start: Option<SystemTime> = match (now.p.state.as_str(), now.started) {
            ("play", Some(s)) => Some(s + Duration::from_secs_f64(cur_len)),
            (_, _) if cur >= 0 => Some(SystemTime::now() + Duration::from_secs_f64((cur_len - now.pos_ms() as f64 / 1000.0).max(0.0))),
            _ => None,
        };
        let mut out = String::from("<Playlist>");
        for (i, t) in now.p.queue.iter().enumerate() {
            let i = i as i64;
            let start = if i == cur {
                now.started.map(local_time).unwrap_or_default()
            } else if i > cur && cur >= 0 {
                let s = next_start.map(local_time).unwrap_or_default();
                next_start = next_start.map(|x| x + Duration::from_secs_f64(t.duration_secs.max(0.0)));
                s
            } else {
                String::new()
            };
            out.push_str("\n  ");
            out.push_str(&empty_tag(
                "TRACK",
                &[
                    ("ARTIST", &norm(&t.artist)),
                    ("TITLE", &norm(&t.title)),
                    ("FILENAME", &filename_of(&t.file)),
                    ("ITEMTYPE", "song"),
                    ("STARTTIME", &start),
                ],
            ));
        }
        out.push_str("\n</Playlist>");
        out
    }

    /// Solo se aceptan archivos de la biblioteca: desde fuera no se puede
    /// leer ni escribir ningun otro archivo del equipo.
    fn library_file(&self, fname: &str) -> Result<(PathBuf, Track), ApiError> {
        let want = filename_of(fname).to_lowercase();
        if want.is_empty() {
            return Err(ApiError::bad("Falta el parámetro fn"));
        }
        let t = self
            .library()
            .into_iter()
            .find(|t| !t.file.trim().is_empty() && filename_of(&t.file).to_lowercase() == want)
            .ok_or_else(|| ApiError::not_found("El archivo no está en la biblioteca"))?;
        let p = PathBuf::from(t.file.trim());
        if !p.is_file() {
            return Err(ApiError::not_found("El archivo de la canción no está disponible"));
        }
        Ok((p, t))
    }

    pub fn readtag(&self, fname: &str, artwork: bool) -> Result<String, ApiError> {
        let (p, _) = self.library_file(fname)?;
        tags::read(&p, artwork).map_err(ApiError::internal)
    }

    pub fn writetag(&self, fname: &str, data: &str) -> Result<String, ApiError> {
        let (p, t) = self.library_file(fname)?;
        let attrs = xml::parse_attrs(data, "File")
            .or_else(|| xml::parse_attrs(data, "TagInfo"))
            .ok_or_else(|| ApiError::bad("El parámetro data no es un XML válido (<File ARTIST=\"…\" …/>)"))?;
        let written = tags::write(&p, &attrs).map_err(ApiError::internal)?;
        // La ficha de la biblioteca manda en MiRadio: se actualiza igual.
        let mut patch = crate::library::TrackPatch::default();
        for (k, v) in &written {
            match k.as_str() {
                "ARTIST" => patch.artist = Some(v.clone()),
                "TITLE" => patch.title = Some(v.clone()),
                "ALBUM" => patch.album = Some(v.clone()),
                "GENRE" => patch.genre = Some(v.clone()),
                "YEAR" => patch.year = Some(v.clone()),
                _ => {}
            }
        }
        crate::library::apply_patch(&self.data_dir, &t.id, patch).map_err(ApiError::internal)?;
        Ok("<Result>OK</Result>".to_string())
    }

    pub fn artwork(&self, next: bool) -> Result<(Vec<u8>, &'static str), ApiError> {
        let t = {
            let now = self.now.lock().unwrap_or_else(|e| e.into_inner());
            if next { now.p.next.clone() } else { now.p.current.clone() }
        }
        .ok_or_else(|| ApiError::not_found("No hay pista"))?;
        let cover = if t.cover.trim().is_empty() { String::new() } else { cover_abs(&self.data_dir, &t.cover) };
        let cover = if cover.is_empty() && !t.cover.trim().is_empty() && Path::new(t.cover.trim()).is_file() {
            t.cover.trim().to_string()
        } else {
            cover
        };
        if !cover.is_empty() {
            if let Ok(bytes) = std::fs::read(&cover) {
                return Ok((bytes, mime_from_path(&cover)));
            }
        }
        let p = PathBuf::from(t.file.trim());
        tags::embedded_picture(&p).ok_or_else(|| ApiError::not_found("La pista no tiene carátula"))
    }

    pub fn status_line(&self) -> Option<String> {
        self.notify_log.lock().ok().and_then(|g| g.clone())
    }
}

fn mime_from_path(p: &str) -> &'static str {
    let l = p.to_ascii_lowercase();
    if l.ends_with(".png") {
        "image/png"
    } else if l.ends_with(".webp") {
        "image/webp"
    } else if l.ends_with(".gif") {
        "image/gif"
    } else if l.ends_with(".bmp") {
        "image/bmp"
    } else {
        "image/jpeg"
    }
}

// ------------------------------------------------------------ peticiones

#[derive(Debug)]
pub struct ApiError {
    status: u16,
    message: String,
}

impl ApiError {
    fn bad(m: &str) -> Self {
        ApiError { status: 400, message: m.to_string() }
    }
    fn not_found(m: &str) -> Self {
        ApiError { status: 404, message: m.to_string() }
    }
    fn internal(m: String) -> Self {
        ApiError { status: 500, message: m }
    }
}

pub enum Reply {
    Xml(u16, String),
    Bytes(Vec<u8>, &'static str),
}

/// Atiende una peticion (sin red: se puede probar directamente).
pub fn handle(core: &Core, method: &str, url: &str, bearer: Option<&str>) -> Reply {
    if method != "GET" && method != "HEAD" {
        return Reply::Xml(405, "<Error>Solo GET</Error>".into());
    }
    let (path, query) = url.split_once('?').unwrap_or((url, ""));
    if path != "/" && !path.is_empty() {
        return Reply::Xml(404, "<Error>No encontrado</Error>".into());
    }
    let q: HashMap<String, String> = form_urlencoded::parse(query.as_bytes()).into_owned().collect();
    if !core.authorized(&q, bearer) {
        return Reply::Xml(401, "<Error>Credenciales no válidas</Error>".into());
    }
    let action = q.get("action").map(|s| s.to_ascii_lowercase()).unwrap_or_default();
    // Cada accion aislada: un fallo (o un panico) solo afecta a esta peticion.
    let res = std::panic::catch_unwind(AssertUnwindSafe(|| -> Result<Reply, ApiError> {
        let fname = q.get("fn").map(|s| s.as_str()).unwrap_or("");
        Ok(match action.as_str() {
            "playbackinfo" => Reply::Xml(200, core.playbackinfo()),
            "encoderstatus" => Reply::Xml(200, core.encoderstatus()),
            "getlastplayed" => {
                let n = q.get("count").or_else(|| q.get("limit")).and_then(|v| v.parse().ok()).unwrap_or(20usize);
                Reply::Xml(200, core.getlastplayed(n.clamp(1, 500)))
            }
            "library" => Reply::Xml(200, core.library_xml()),
            "getplaylist2" => Reply::Xml(200, core.getplaylist2()),
            "readtag" => {
                let art = matches!(q.get("artwork").map(|s| s.as_str()), Some("1") | Some("true"));
                Reply::Xml(200, core.readtag(fname, art)?)
            }
            "writetag" => Reply::Xml(200, core.writetag(fname, q.get("data").map(|s| s.as_str()).unwrap_or(""))?),
            "trackartwork" => {
                let (b, m) = core.artwork(false)?;
                Reply::Bytes(b, m)
            }
            "nexttrackartwork" => {
                let (b, m) = core.artwork(true)?;
                Reply::Bytes(b, m)
            }
            "songrequestlist" => Reply::Xml(200, "<Requests>\n</Requests>".into()),
            "" => return Err(ApiError::bad("Falta el parámetro action")),
            _ => return Err(ApiError::bad("Acción no soportada")),
        })
    }));
    match res {
        Ok(Ok(r)) => r,
        Ok(Err(e)) => Reply::Xml(e.status, format!("<Error>{}</Error>", xml::esc(&e.message))),
        Err(_) => Reply::Xml(500, "<Error>Error interno</Error>".into()),
    }
}

// ------------------------------------------------------------ servidor

struct Running {
    server: Arc<tiny_http::Server>,
    stop: Arc<AtomicBool>,
    threads: Vec<JoinHandle<()>>,
    addr: String,
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

fn start_server(core: Arc<Core>, cfg: &ApiConfig) -> Result<Running, String> {
    let host = if cfg.bind_all { "0.0.0.0" } else { "127.0.0.1" };
    let addr = format!("{host}:{}", cfg.port);
    let server = Arc::new(
        tiny_http::Server::http(&addr).map_err(|e| format!("No se pudo abrir el puerto {}: {e}", cfg.port))?,
    );
    let stop = Arc::new(AtomicBool::new(false));
    let mut threads = Vec::new();
    for i in 0..4 {
        let (server, stop, core) = (server.clone(), stop.clone(), core.clone());
        let t = std::thread::Builder::new()
            .name(format!("miradio-api-{i}"))
            .spawn(move || {
                while !stop.load(Ordering::SeqCst) {
                    let req = match server.recv_timeout(Duration::from_millis(500)) {
                        Ok(Some(r)) => r,
                        Ok(None) => continue,
                        Err(_) => break,
                    };
                    respond(&core, req);
                }
            })
            .map_err(|e| e.to_string())?;
        threads.push(t);
    }
    Ok(Running { server, stop, threads, addr })
}

fn respond(core: &Core, req: tiny_http::Request) {
    let bearer = req
        .headers()
        .iter()
        .find(|h| h.field.equiv("Authorization"))
        .and_then(|h| {
            let v = h.value.as_str().trim();
            v.strip_prefix("Bearer ").or_else(|| v.strip_prefix("bearer ")).map(|s| s.trim().to_string())
        });
    let method = req.method().as_str().to_string();
    let reply = handle(core, &method, req.url(), bearer.as_deref());
    let header = |k: &str, v: &str| tiny_http::Header::from_bytes(k.as_bytes(), v.as_bytes()).expect("cabecera");
    let resp = match reply {
        Reply::Xml(status, body) => {
            let mut r = tiny_http::Response::new(
                tiny_http::StatusCode(status),
                vec![header("Content-Type", "text/xml; charset=utf-8"), header("Cache-Control", "no-store")],
                Cursor::new(body.into_bytes()),
                None,
                None,
            );
            if status == 401 {
                r.add_header(header("WWW-Authenticate", "Bearer"));
            }
            r
        }
        Reply::Bytes(bytes, mime) => tiny_http::Response::new(
            tiny_http::StatusCode(200),
            vec![header("Content-Type", mime), header("Cache-Control", "no-store")],
            Cursor::new(bytes),
            None,
            None,
        ),
    };
    // La URL (con la clave) no se registra nunca.
    let _ = req.respond(resp);
}

// ------------------------------------------------------------ estado Tauri

pub struct ApiState {
    core: Mutex<Option<Arc<Core>>>,
    running: Mutex<Option<Running>>,
    config: Mutex<Option<ApiConfig>>,
    error: Mutex<Option<String>>,
}

impl Default for ApiState {
    fn default() -> Self {
        ApiState { core: Mutex::new(None), running: Mutex::new(None), config: Mutex::new(None), error: Mutex::new(None) }
    }
}

impl ApiState {
    fn core(&self, data_dir: &Path) -> Arc<Core> {
        let mut g = self.core.lock().unwrap_or_else(|e| e.into_inner());
        g.get_or_insert_with(|| Core::new(data_dir.to_path_buf())).clone()
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiStatus {
    running: bool,
    address: String,
    error: Option<String>,
    last_update: Option<String>,
    user: String,
    has_password: bool,
    has_token: bool,
    has_update_token: bool,
}

fn status_of(state: &ApiState, core: &Core) -> ApiStatus {
    let running = state.running.lock().unwrap_or_else(|e| e.into_inner());
    let s = core.secrets.lock().unwrap_or_else(|e| e.into_inner());
    ApiStatus {
        running: running.is_some(),
        address: running.as_ref().map(|r| r.addr.clone()).unwrap_or_default(),
        error: state.error.lock().ok().and_then(|g| g.clone()),
        last_update: core.status_line(),
        user: s.user.clone(),
        has_password: !s.pass_hash.is_empty(),
        has_token: !s.token_hash.is_empty(),
        has_update_token: !s.update_token.is_empty(),
    }
}

#[tauri::command]
pub fn api_publish(app: State<'_, AppState>, state: State<'_, ApiState>, published: Published) {
    state.core(&app.data_dir).publish(published);
}

/// Aplica la configuracion: arranca, para o reinicia el servidor si hace falta.
#[tauri::command]
pub fn api_apply(app: State<'_, AppState>, state: State<'_, ApiState>, config: ApiConfig) -> ApiStatus {
    let core = state.core(&app.data_dir);
    core.set_urls(&config);
    let mut cfg_g = state.config.lock().unwrap_or_else(|e| e.into_inner());
    let mut running = state.running.lock().unwrap_or_else(|e| e.into_inner());
    let needs_restart = cfg_g.as_ref().map(|c| c.enabled != config.enabled || c.port != config.port || c.bind_all != config.bind_all).unwrap_or(true);
    if needs_restart {
        if let Some(r) = running.take() {
            r.shutdown();
        }
        let mut err = state.error.lock().unwrap_or_else(|e| e.into_inner());
        *err = None;
        if config.enabled {
            match start_server(core.clone(), &config) {
                Ok(r) => *running = Some(r),
                Err(e) => *err = Some(e),
            }
        }
    }
    *cfg_g = Some(config);
    drop(running);
    drop(cfg_g);
    status_of(&state, &core)
}

#[tauri::command]
pub fn api_status(app: State<'_, AppState>, state: State<'_, ApiState>) -> ApiStatus {
    let core = state.core(&app.data_dir);
    status_of(&state, &core)
}

#[tauri::command]
pub fn api_set_login(app: State<'_, AppState>, state: State<'_, ApiState>, user: String, pass: String) -> Result<ApiStatus, String> {
    let user = user.trim().to_string();
    if user.is_empty() || pass.chars().count() < MIN_PASS {
        return Err("Usuario obligatorio y clave de al menos 6 caracteres".into());
    }
    let core = state.core(&app.data_dir);
    {
        let mut s = core.secrets.lock().unwrap_or_else(|e| e.into_inner());
        s.user = user;
        s.pass_salt = random_hex();
        s.pass_hash = sha_hex(&[s.pass_salt.as_bytes(), pass.as_bytes()]);
        s.save(&app.data_dir)?;
    }
    Ok(status_of(&state, &core))
}

/// Genera un token Bearer nuevo. Solo se muestra esta vez.
#[tauri::command]
pub fn api_new_token(app: State<'_, AppState>, state: State<'_, ApiState>) -> Result<String, String> {
    let core = state.core(&app.data_dir);
    let token = random_hex();
    let mut s = core.secrets.lock().unwrap_or_else(|e| e.into_inner());
    s.token_hash = sha_hex(&[token.as_bytes()]);
    s.save(&app.data_dir)?;
    Ok(token)
}

#[tauri::command]
pub fn api_set_update_token(app: State<'_, AppState>, state: State<'_, ApiState>, token: String) -> Result<ApiStatus, String> {
    let core = state.core(&app.data_dir);
    {
        let mut s = core.secrets.lock().unwrap_or_else(|e| e.into_inner());
        s.update_token = token.trim().to_string();
        s.save(&app.data_dir)?;
    }
    Ok(status_of(&state, &core))
}

#[cfg(test)]
mod tests;
