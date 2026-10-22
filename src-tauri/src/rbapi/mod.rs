//! API compatible con RadioBOSS para el worker de ngradio.es.
//!
//! Peticiones GET a la raiz: `/?action=<accion>&user=…&pass=…` o con
//! `Authorization: Bearer <token>`. Respuestas XML como las de RadioBOSS.
//! El estado de la emision lo publica la app (`api_publish`) y se guarda en
//! memoria: `playbackinfo` no toca disco ni red.

pub mod listeners;
pub mod rb;
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
use self::xml::norm;
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
    /// Texto que se envia a las emisiones (CASTTITLE de la actual)
    pub cast_title: String,
    /// Volumen general 0..1
    pub volume: f64,
    /// Nombre de la lista que suena
    pub list_name: String,
    /// Eventos (programador) activados
    pub scheduler: bool,
    /// Salidas de emision, en orden
    pub encoders: Vec<PubEncoder>,
}

#[derive(Deserialize, Serialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct PubEncoder {
    pub name: String,
    /// active | idle | off
    pub status: String,
    pub error: String,
    pub host: String,
    pub port: u16,
    pub mount: String,
    pub tls: bool,
    pub codec: String,
    pub bitrate_kbps: u32,
    pub sample_rate: u32,
    pub channels: u32,
    pub public: bool,
    pub enabled: bool,
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
    started: Instant,
    cache: Mutex<Cache>,
}

/// Biblioteca, historial y etiquetas leidas, recargados solo si cambian.
#[derive(Default)]
struct Cache {
    lib_mtime: Option<SystemTime>,
    lib: Arc<Vec<Track>>,
    hist_mtime: Option<SystemTime>,
    hist: Arc<Vec<crate::settings::HistoryEntry>>,
    extra: HashMap<String, (Option<SystemTime>, rb::Extra)>,
}

fn mtime(p: &Path) -> Option<SystemTime> {
    std::fs::metadata(p).and_then(|m| m.modified()).ok()
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
            started: Instant::now(),
            cache: Mutex::new(Cache::default()),
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

    // -------------------------------------------------------- datos

    fn library(&self) -> Arc<Vec<Track>> {
        let path = self.data_dir.join("library.json");
        let m = mtime(&path);
        let mut c = self.cache.lock().unwrap_or_else(|e| e.into_inner());
        if c.lib_mtime != m || (m.is_none() && c.lib.is_empty()) {
            c.lib = Arc::new(read_library_internal(&self.data_dir));
            c.lib_mtime = m;
        }
        c.lib.clone()
    }

    fn history(&self) -> Arc<Vec<crate::settings::HistoryEntry>> {
        let path = self.data_dir.join("history.json");
        let m = mtime(&path);
        let mut c = self.cache.lock().unwrap_or_else(|e| e.into_inner());
        if c.hist_mtime != m || m.is_none() {
            c.hist = Arc::new(crate::settings::read_history_public(&self.data_dir));
            c.hist_mtime = m;
        }
        c.hist.clone()
    }

    /// Etiquetas del archivo (comentario, BPM, letra…), con cache por fecha.
    fn extra(&self, file: &str) -> rb::Extra {
        let file = file.trim();
        if file.is_empty() {
            return rb::Extra::default();
        }
        let p = Path::new(file);
        let m = mtime(p);
        if m.is_none() {
            return rb::Extra::default();
        }
        if let Some((t, e)) = self.cache.lock().unwrap_or_else(|e| e.into_inner()).extra.get(file) {
            if *t == m {
                return e.clone();
            }
        }
        let e = rb::read_extra(p);
        let mut c = self.cache.lock().unwrap_or_else(|e| e.into_inner());
        if c.extra.len() > 3000 {
            c.extra.clear();
        }
        c.extra.insert(file.to_string(), (m, e.clone()));
        e
    }

    /// Ficha completa de una pista publicada (por id o por archivo).
    /// `exclude_last` quita la ultima vez que sono (la que esta en curso).
    fn info_of(&self, t: &PubTrack, lib: &[Track], plays: &HashMap<&str, Vec<u64>>, with_extra: bool, upto: Option<u64>) -> rb::Info {
        let found = lib
            .iter()
            .find(|x| !t.id.is_empty() && x.id == t.id)
            .or_else(|| lib.iter().find(|x| !t.file.is_empty() && filename_of(&x.file) == filename_of(&t.file)));
        let empty: Vec<u64> = Vec::new();
        let mut p: Vec<u64> = found.and_then(|x| plays.get(x.id.as_str())).unwrap_or(&empty).clone();
        if let Some(limit) = upto {
            p.retain(|x| *x < limit);
        }
        let mut info = match found {
            Some(x) => rb::info_from_track(x, &p),
            None => rb::Info {
                artist: norm(&t.artist),
                title: norm(&t.title),
                album: norm(&t.album),
                filename: filename_of(&t.file),
                dur: t.duration_secs,
                eff: t.duration_secs,
                rating: "0".into(),
                ..Default::default()
            },
        };
        if with_extra {
            info.extra = self.extra(&t.file);
            if info.language.is_empty() {
                info.language = info.extra.language.clone();
            }
        }
        info
    }

    fn lib_track_by_file(&self, fname: &str) -> Option<Track> {
        let want = filename_of(fname).to_lowercase();
        if want.is_empty() {
            return None;
        }
        self.library().iter().find(|t| !t.file.trim().is_empty() && filename_of(&t.file).to_lowercase() == want).cloned()
    }

    // -------------------------------------------------------- acciones

    pub fn status_xml(&self) -> String {
        rb::doc(
            "<Status>",
            "Status",
            &[rb::tag("Player", &[("version", env!("CARGO_PKG_VERSION").to_string()), ("uptime", self.started.elapsed().as_secs().to_string())])],
        )
    }

    pub fn playbackinfo(&self) -> String {
        let now = self.now.lock().unwrap_or_else(|e| e.into_inner());
        let p = now.p.clone();
        let pos = now.pos_ms();
        let started = now.started;
        drop(now);
        let lib = self.library();
        let hist = self.history();
        let plays = rb::plays_by_track(&hist);
        let listeners = self.poller.snapshot().total;
        let has = p.current.is_some();
        let state = match (has, p.state.as_str()) {
            (true, "play") => "play",
            (true, "pause") => "pause",
            _ => "stop",
        };
        let len = if has { p.len_ms.max(0.0).round() as u64 } else { 0 };
        let pos = if has { pos } else { 0 };
        let mut lines = Vec::new();

        lines.push("<CurrentTrack>".to_string());
        if let Some(t) = &p.current {
            let i = self.info_of(t, &lib, &plays, true, None);
            let mut i2 = i.clone();
            // La que suena cuenta su reproduccion actual.
            if let Some(st) = started {
                let st_epoch = st.duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
                let latest = plays_of(&lib, &plays, t).last().copied().unwrap_or(0);
                if latest + 2 < st_epoch {
                    i2.playcount += 1; // aun no esta en el historial
                }
                i2.lastplayed = rb::local(st);
            }
            let cast = if p.cast_title.trim().is_empty() { i.cast_title() } else { norm(&p.cast_title) };
            let mut a = i2.base_attrs();
            a.push(("CASTTITLE", cast));
            a.push(("LISTENERS", listeners.to_string()));
            a.push(("LYRICS", i.extra.lyrics.clone()));
            a.push(("ITEMTITLE", i.item_title()));
            a.push(("FT_IDX", "1".into()));
            lines.push(rb::track_tag(&a));
        }
        lines.push("</CurrentTrack>".to_string());

        // Tiempo que queda de lista desde ahora.
        let left = if p.current_index >= 0 && has {
            let rest: f64 = p.queue.iter().skip(p.current_index as usize + 1).map(|t| t.duration_secs.max(0.0) * 1000.0).sum();
            (len.saturating_sub(pos) as f64 + rest).round() as u64
        } else {
            0
        };
        lines.push(rb::tag(
            "Playback",
            &[
                ("pos", pos.to_string()),
                ("len", len.to_string()),
                ("state", state.to_string()),
                ("playlistpos", if has && p.current_index >= 0 { (p.current_index + 1).to_string() } else { "0".into() }),
                ("streams", if state == "play" { "1" } else { "0" }.to_string()),
                ("netstream", "n/a".to_string()),
                ("playingtimeleft", left.to_string()),
                ("timestamp", rb::local(SystemTime::now())),
                ("volume", ((p.volume.clamp(0.0, 1.0) * 100.0).round() as u32).to_string()),
            ],
        ));
        lines.push(rb::tag("Options", &[("repeat_list", "0".into()), ("shuffle", "0".into()), ("queuemode", "0".into())]));
        lines.push(rb::tag("Features", &[("scheduler", if p.scheduler { "1" } else { "0" }.to_string())]));
        lines.push(rb::tag("Streaming", &[("listeners", listeners.to_string())]));
        lines.push(rb::tag("Relay", &[("On", "0".into()), ("Active", "0".into())]));

        let neighbour = |t: &PubTrack, exclude_latest: bool| -> String {
            let upto = if exclude_latest {
                plays_of(&lib, &plays, t).last().copied()
            } else {
                None
            };
            let i = self.info_of(t, &lib, &plays, true, upto);
            let mut a = i.base_attrs();
            a.push(("LYRICS", i.extra.lyrics.clone()));
            a.push(("CASTTITLE", i.cast_title()));
            a.push(("ITEMTITLE", i.item_title()));
            a.push(("FT_IDX", "1".into()));
            rb::track_tag(&a)
        };
        lines.push("<PrevTrack>".to_string());
        if let Some(t) = self.previous(&p, &lib, &hist, started) {
            lines.push(neighbour(&t, true));
        }
        lines.push("</PrevTrack>".to_string());
        lines.push("<NextTrack>".to_string());
        if let Some(t) = &p.next {
            lines.push(neighbour(t, false));
        }
        lines.push("</NextTrack>".to_string());
        rb::doc("<Info>", "Info", &lines)
    }

    /// La que sono antes de la actual: la anterior de la lista o, si no hay,
    /// la ultima del historial antes de que empezara la actual.
    fn previous(&self, p: &Published, lib: &[Track], hist: &[crate::settings::HistoryEntry], started: Option<SystemTime>) -> Option<PubTrack> {
        if p.current_index > 0 {
            if let Some(t) = p.queue.get(p.current_index as usize - 1) {
                return Some(t.clone());
            }
        }
        let limit = started.and_then(|s| s.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_secs()).unwrap_or(u64::MAX);
        hist.iter()
            .rev()
            .find(|h| h.played_at.saturating_add(2) < limit)
            .and_then(|h| lib.iter().find(|t| t.id == h.track_id))
            .map(|t| PubTrack { id: t.id.clone(), artist: t.artist.clone(), title: t.title.clone(), album: t.album.clone(), file: t.file.clone(), duration_secs: t.duration_secs, cover: t.cover.clone() })
    }

    pub fn trackinfo(&self, pos: i64) -> String {
        let t = {
            let now = self.now.lock().unwrap_or_else(|e| e.into_inner());
            if pos >= 1 { now.p.queue.get(pos as usize - 1).cloned() } else { None }
        };
        let Some(t) = t else { return rb::doc("<Info>", "Info", &[]) };
        let lib = self.library();
        let hist = self.history();
        let plays = rb::plays_by_track(&hist);
        let i = self.info_of(&t, &lib, &plays, true, None);
        let mut a = i.base_attrs();
        a.push(("LYRICS", i.extra.lyrics.clone()));
        a.push(("FT_IDX", "1".into()));
        rb::doc("<Info>", "Info", &["<Track>".into(), rb::track_tag(&a), "</Track>".into()])
    }

    /// `getplaylist` (antigua): de `from` a `to`, base 1 e inclusivo.
    pub fn getplaylist(&self, from: Option<usize>, to: Option<usize>) -> String {
        let queue = self.now.lock().unwrap_or_else(|e| e.into_inner()).p.queue.clone();
        let lib = self.library();
        let hist = self.history();
        let plays = rb::plays_by_track(&hist);
        let (a, b) = match (from, to) {
            (Some(f), Some(t)) => (f.max(1), t),
            (Some(f), None) => (f.max(1), queue.len()),
            _ => (1, queue.len()),
        };
        let mut lines = Vec::new();
        for t in queue.iter().take(b.min(queue.len())).skip(a - 1) {
            let i = self.info_of(t, &lib, &plays, true, None);
            let mut at = i.base_attrs();
            at.push(("LYRICS", i.extra.lyrics.clone()));
            lines.push(rb::track_tag(&at));
        }
        rb::doc("<Playlist>", "Playlist", &lines)
    }

    pub fn getplaylist2(&self, cnt: usize) -> String {
        let now = self.now.lock().unwrap_or_else(|e| e.into_inner());
        let p = now.p.clone();
        let pos_ms = now.pos_ms() as f64;
        let started = now.started;
        drop(now);
        let lib = self.library();
        let hist = self.history();
        let plays = rb::plays_by_track(&hist);
        let cur = p.current_index;
        let infos: Vec<rb::Info> = p.queue.iter().map(|t| self.info_of(t, &lib, &plays, false, None)).collect();
        // Horas de inicio: hacia atras y hacia delante desde la actual.
        let n = infos.len();
        let mut starts: Vec<Option<SystemTime>> = vec![None; n];
        if cur >= 0 && (cur as usize) < n {
            let c = cur as usize;
            let cur_start = started.unwrap_or_else(|| SystemTime::now() - Duration::from_secs_f64(pos_ms / 1000.0));
            starts[c] = Some(cur_start);
            let mut t = cur_start;
            for i in (0..c).rev() {
                t -= Duration::from_secs_f64(infos[i].eff.max(0.0));
                starts[i] = Some(t);
            }
            let cur_len = if p.len_ms > 0.0 { p.len_ms / 1000.0 } else { infos[c].eff };
            let mut t = cur_start + Duration::from_secs_f64(cur_len.max(0.0));
            for (i, info) in infos.iter().enumerate().skip(c + 1) {
                starts[i] = Some(t);
                t += Duration::from_secs_f64(info.eff.max(0.0));
            }
        } else {
            let mut t = SystemTime::now();
            for (i, info) in infos.iter().enumerate() {
                starts[i] = Some(t);
                t += Duration::from_secs_f64(info.eff.max(0.0));
            }
        }
        let (from, take) = if cnt == 0 || cnt >= n {
            (0, n)
        } else {
            let c = cur.max(0) as usize;
            let before = (cnt - 1) / 2;
            let from = c.saturating_sub(before).min(n.saturating_sub(cnt));
            (from, cnt)
        };
        let mut lines = Vec::new();
        for i in from..(from + take).min(n) {
            let played = cur >= 0 && i as i64 <= cur;
            let st = starts[i].map(rb::clock).unwrap_or_default();
            lines.push(rb::tag("TRACK", &infos[i].playlist2_attrs(&st, i, played)));
        }
        // TS cambia cuando cambia la lista.
        let mut h: u64 = 1469598103934665603;
        for t in &p.queue {
            for b in t.id.bytes().chain(t.file.bytes()) {
                h ^= b as u64;
                h = h.wrapping_mul(1099511628211);
            }
        }
        let open = format!(
            "<Playlist COUNT=\"{n}\" TS=\"{}\" FILE=\"{}\">",
            h % 1_000_000_000,
            rb::esc(&if p.list_name.is_empty() { "MiRadio".to_string() } else { format!("MiRadio\\{}", p.list_name) })
        );
        rb::doc(&open, "Playlist", &lines)
    }

    pub fn getlastplayed(&self, count: usize) -> String {
        let lib = self.library();
        let hist = self.history();
        let plays = rb::plays_by_track(&hist);
        let by_id: HashMap<&str, &Track> = lib.iter().map(|t| (t.id.as_str(), t)).collect();
        let mut lines = Vec::new();
        let total = hist.len();
        for (k, e) in hist.iter().enumerate().rev().take(count) {
            let Some(t) = by_id.get(e.track_id.as_str()) else { continue };
            let before: Vec<u64> = plays.get(t.id.as_str()).map(|v| v.iter().copied().filter(|x| *x < e.played_at).collect()).unwrap_or_default();
            let mut i = rb::info_from_track(t, &before);
            i.extra = self.extra(&t.file);
            if i.language.is_empty() {
                i.language = i.extra.language.clone();
            }
            let mut a = i.base_attrs();
            a.push(("LYRICS", i.extra.lyrics.clone()));
            a.push(("STARTTIME", rb::local_epoch(e.played_at)));
            a.push(("CASTTITLE", i.cast_title()));
            a.push(("TRACKTITLE", i.item_title()));
            a.push(("ARTWORKID", (k + 1).to_string()));
            a.push(("TITLESENT", "True".into()));
            a.push(("FT_IDX", "1".into()));
            lines.push(rb::track_tag(&a));
            let _ = total;
        }
        rb::doc("<LastPlayed>", "LastPlayed", &lines)
    }

    pub fn library_xml(&self) -> String {
        let lib = self.library();
        let hist = self.history();
        let plays = rb::plays_by_track(&hist);
        let empty = Vec::new();
        let lines: Vec<String> = lib
            .iter()
            .map(|t| {
                let i = rb::info_from_track(t, plays.get(t.id.as_str()).unwrap_or(&empty));
                rb::track_tag(&i.base_attrs())
            })
            .collect();
        rb::doc("<Library>", "Library", &lines)
    }

    pub fn encoderstatus(&self) -> String {
        let encs = self.now.lock().unwrap_or_else(|e| e.into_inner()).p.encoders.clone();
        let snap = self.poller.snapshot();
        let lines: Vec<String> = encs
            .iter()
            .enumerate()
            .map(|(i, e)| {
                let mount = if e.mount.starts_with('/') { e.mount.clone() } else { format!("/{}", e.mount) };
                let listeners = snap.mounts.iter().filter(|m| m.name == mount).map(|m| m.listeners).sum::<u64>();
                rb::tag(
                    "Encoder",
                    &[
                        ("index", i.to_string()),
                        ("status", e.status.clone()),
                        ("error", e.error.clone()),
                        ("name", e.name.clone()),
                        ("listeners", listeners.to_string()),
                    ],
                )
            })
            .collect();
        rb::doc("<Encoders>", "Encoders", &lines)
    }

    /// Configuracion de una salida. Las claves nunca se envian.
    pub fn getencoder(&self, id: usize) -> Option<String> {
        let e = self.now.lock().unwrap_or_else(|e| e.into_inner()).p.encoders.get(id).cloned()?;
        let b = |v: bool| if v { "True" } else { "False" }.to_string();
        let mount = e.mount.trim_start_matches('/');
        let attrs = [
            ("Server", format!("{}:{}/{}", e.host, e.port, mount)),
            ("Password", String::new()),
            ("Public", b(e.public)),
            ("Format", e.codec.clone()),
            ("Bitrate", e.bitrate_kbps.to_string()),
            ("Encoding", e.codec.clone()),
            ("SampleRate", e.sample_rate.to_string()),
            ("Channels", e.channels.to_string()),
            ("StatPassword", String::new()),
            ("DisplayName", e.name.clone()),
            ("Enabled", b(e.enabled)),
            ("UseStatsRelay", "False".to_string()),
            ("RelayAddress", ":".to_string()),
            ("RelayType", "0".to_string()),
            ("RelayMount", String::new()),
            ("RelaySSL", b(e.tls)),
        ];
        let mut s = String::from(rb::XML_HEAD);
        s.push_str("<Encoder");
        for (k, v) in attrs {
            s.push_str(&format!(" {k}=\"{}\"", rb::esc(&v)));
        }
        s.push_str(" ></Encoder>\r\n");
        Some(s)
    }

    /// `readtag`: solo archivos de la biblioteca; cualquier otra ruta recibe
    /// la ficha vacia (como RadioBOSS con un archivo que no existe), sin
    /// leer nada del disco.
    pub fn readtag(&self, fname: &str, artwork: bool) -> String {
        let t = self.lib_track_by_file(fname);
        let hist = self.history();
        let plays = rb::plays_by_track(&hist);
        let (info, p): (Option<rb::Info>, Vec<u64>) = match &t {
            Some(t) if Path::new(t.file.trim()).is_file() => {
                let p = plays.get(t.id.as_str()).cloned().unwrap_or_default();
                let mut i = rb::info_from_track(t, &p);
                i.extra = self.extra(&t.file);
                (Some(i), p)
            }
            Some(t) => (None, plays.get(t.id.as_str()).cloned().unwrap_or_default()),
            None => (None, Vec::new()),
        };
        let art = if artwork && info.is_some() {
            t.as_ref().and_then(|t| self.art_of_file(&t.file, &t.cover)).map(|(b, _)| rb::b64(&b)).unwrap_or_default()
        } else {
            String::new()
        };
        let attrs = rb::readtag_attrs(fname, t.as_ref().filter(|_| info.is_some()), info.as_ref(), &p, art);
        rb::doc("<TagInfo>", "TagInfo", &[rb::tag("File", &attrs)])
    }

    pub fn writetag(&self, fname: &str, data: &str) -> Result<String, ApiError> {
        let t = self.lib_track_by_file(fname).ok_or_else(|| ApiError::bad("E010: File not found"))?;
        let p = PathBuf::from(t.file.trim());
        if !p.is_file() {
            return Err(ApiError::bad("E010: File not found"));
        }
        let attrs = xml::parse_attrs(data, "File")
            .or_else(|| xml::parse_attrs(data, "TagInfo"))
            .ok_or_else(|| ApiError::bad("E011: Invalid data"))?;
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
        Ok("OK".to_string())
    }

    fn art_of_file(&self, file: &str, cover: &str) -> Option<(Vec<u8>, &'static str)> {
        let c = cover.trim();
        if !c.is_empty() {
            let abs = cover_abs(&self.data_dir, c);
            for cand in [abs.as_str(), c] {
                if !cand.is_empty() && Path::new(cand).is_file() {
                    if let Ok(bytes) = std::fs::read(cand) {
                        return Some((bytes, mime_from_path(cand)));
                    }
                }
            }
        }
        rb::embedded_art(Path::new(file.trim()))
    }

    /// Caratula de la actual (0), siguiente (1) o anterior (-1).
    pub fn artwork(&self, which: i8) -> Option<(Vec<u8>, &'static str)> {
        let now = self.now.lock().unwrap_or_else(|e| e.into_inner());
        let p = now.p.clone();
        let started = now.started;
        drop(now);
        let t = match which {
            0 => p.current.clone(),
            1 => p.next.clone(),
            _ => {
                let lib = self.library();
                let hist = self.history();
                self.previous(&p, &lib, &hist, started)
            }
        }?;
        let cover = if t.cover.is_empty() {
            self.library().iter().find(|x| x.id == t.id).map(|x| x.cover.clone()).unwrap_or_default()
        } else {
            t.cover.clone()
        };
        self.art_of_file(&t.file, &cover)
    }

    pub fn status_line(&self) -> Option<String> {
        self.notify_log.lock().ok().and_then(|g| g.clone())
    }
}

fn plays_of<'a>(lib: &[Track], plays: &'a HashMap<&str, Vec<u64>>, t: &PubTrack) -> &'a [u64] {
    let id = lib
        .iter()
        .find(|x| (!t.id.is_empty() && x.id == t.id) || (!t.file.is_empty() && filename_of(&x.file) == filename_of(&t.file)))
        .map(|x| x.id.as_str())
        .unwrap_or("");
    plays.get(id).map(|v| v.as_slice()).unwrap_or(&[])
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
    fn internal(m: String) -> Self {
        ApiError { status: 500, message: m }
    }
}

pub enum Reply {
    /// XML (text/xml)
    Xml(u16, String),
    /// Texto plano como RadioBOSS: "OK", "0", "E001: Wrong password"…
    Text(u16, String),
    Bytes(Vec<u8>, &'static str),
}

/// Atiende una peticion (sin red: se puede probar directamente).
pub fn handle(core: &Core, method: &str, url: &str, bearer: Option<&str>) -> Reply {
    if method != "GET" && method != "HEAD" && method != "POST" {
        return Reply::Text(405, "E002: Method not allowed".into());
    }
    let (path, query) = url.split_once('?').unwrap_or((url, ""));
    if path != "/" && !path.is_empty() {
        return Reply::Text(404, "E004: Not found".into());
    }
    let q: HashMap<String, String> = form_urlencoded::parse(query.as_bytes()).into_owned().collect();
    if !core.authorized(&q, bearer) {
        return Reply::Text(401, "E001: Wrong password".into());
    }
    let action = q.get("action").map(|s| s.to_ascii_lowercase()).unwrap_or_default();
    if action.is_empty() {
        return if q.contains_key("cmd") {
            // Los comandos de control (play, next…) no estan disponibles.
            Reply::Text(400, "E005: Unknown action".into())
        } else {
            Reply::Text(400, "E003: Nothing to do".into())
        };
    }
    let num = |k: &str| q.get(k).and_then(|v| v.trim().parse::<i64>().ok());
    // Cada accion aislada: un fallo (o un panico) solo afecta a esta peticion.
    let res = std::panic::catch_unwind(AssertUnwindSafe(|| -> Result<Reply, ApiError> {
        let fname = q.get("fn").map(|s| s.as_str()).unwrap_or("");
        let art = |r: Option<(Vec<u8>, &'static str)>| match r {
            Some((b, m)) => Reply::Bytes(b, m),
            None => Reply::Text(200, String::new()),
        };
        Ok(match action.as_str() {
            "playbackinfo" => Reply::Xml(200, core.playbackinfo()),
            "status" => Reply::Xml(200, core.status_xml()),
            "trackinfo" => Reply::Xml(200, core.trackinfo(num("pos").unwrap_or(0))),
            "getplaylist2" => Reply::Xml(200, core.getplaylist2(num("cnt").unwrap_or(0).max(0) as usize)),
            "getplaylist" => Reply::Xml(
                200,
                core.getplaylist(num("from").map(|v| v.max(1) as usize), num("to").map(|v| v.max(0) as usize)),
            ),
            "getlastplayed" => {
                let n = num("count").or_else(|| num("cnt")).unwrap_or(101).clamp(1, 1000) as usize;
                Reply::Xml(200, core.getlastplayed(n))
            }
            "library" => Reply::Xml(200, core.library_xml()),
            "readtag" => {
                let want_art = matches!(q.get("artwork").map(|s| s.as_str()), Some("1") | Some("true"));
                Reply::Xml(200, core.readtag(fname, want_art))
            }
            "writetag" => Reply::Text(200, core.writetag(fname, q.get("data").map(|s| s.as_str()).unwrap_or(""))?),
            "trackartwork" => art(core.artwork(0)),
            "nexttrackartwork" => art(core.artwork(1)),
            "prevtrackartwork" => art(core.artwork(-1)),
            "encoderstatus" => Reply::Xml(200, core.encoderstatus()),
            "getencoder" => match core.getencoder(num("id").unwrap_or(0).max(0) as usize) {
                Some(x) => Reply::Xml(200, x),
                None => Reply::Text(400, "E009: Encoder not found".into()),
            },
            "songrequestlist" => Reply::Xml(200, rb::doc("<SongRequest>", "SongRequest", &[])),
            "mic" if !q.contains_key("on") => Reply::Text(200, "0".into()),
            "streamarchivestatus" => Reply::Text(200, "0".into()),
            "schedulecontrol" if q.get("type").map(|s| s.as_str()) == Some("state") && !q.contains_key("set") => {
                let on = core.now.lock().unwrap_or_else(|e| e.into_inner()).p.scheduler;
                Reply::Text(200, if on { "on" } else { "off" }.into())
            }
            _ => return Err(ApiError::bad("E005: Unknown action")),
        })
    }));
    match res {
        Ok(Ok(r)) => r,
        Ok(Err(e)) => Reply::Text(e.status, e.message),
        Err(_) => Reply::Text(500, "E999: Internal error".into()),
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
    let text = |status: u16, ct: &str, body: Vec<u8>| {
        tiny_http::Response::new(
            tiny_http::StatusCode(status),
            vec![header("Content-Type", ct), header("Cache-Control", "no-store")],
            Cursor::new(body),
            None,
            None,
        )
    };
    let resp = match reply {
        Reply::Xml(status, body) => text(status, "text/xml; charset=UTF-8", body.into_bytes()),
        Reply::Text(status, body) => {
            let mut r = text(status, "text/html; charset=UTF-8", body.into_bytes());
            if status == 401 {
                r.add_header(header("WWW-Authenticate", "Bearer"));
            }
            r
        }
        Reply::Bytes(bytes, mime) => text(200, mime, bytes),
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
