//! Subida de la música al maestro (R2), en segundo plano.
//!
//! - Calcula la huella (sha256) de cada archivo de la biblioteca. Las huellas
//!   se guardan en `<datos>/maestro-huellas.json` (por ruta, tamaño y fecha),
//!   así que cada archivo solo se lee una vez.
//! - Pregunta al maestro cuáles le faltan y sube solo esos.
//! - Va con límite de velocidad, para no quitarle ancho de banda a la emisión.
//!   Archivos de más de 90 MB, por partes.
//! - Se puede pausar en cualquier momento. Al reanudar, sigue donde estaba: lo
//!   ya subido no se repite. Cada 15 minutos mira si hay música nueva.

use std::collections::HashMap;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::State;

use crate::AppState;

const CFG_FILE: &str = "maestro-musica.json";
const HASH_FILE: &str = "maestro-huellas.json";
/// Por encima de esto, por partes (Cloudflare admite 100 MB por petición).
const SINGLE_MAX: u64 = 90 * 1024 * 1024;
const PART: u64 = 50 * 1024 * 1024;

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct MediaCfg {
    pub enabled: bool,
    /// Megabits por segundo (0 = sin límite)
    pub limit_mbps: u32,
}
impl Default for MediaCfg {
    fn default() -> Self {
        MediaCfg { enabled: false, limit_mbps: 150 }
    }
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct MediaStatus {
    pub enabled: bool,
    pub limit_mbps: u32,
    /// "idle" | "hashing" | "checking" | "uploading" | "done" | "paused" | "error" | "nomaster"
    pub phase: String,
    /// Archivos de la biblioteca (existentes)
    pub total_files: usize,
    pub total_bytes: u64,
    /// Con huella calculada
    pub hashed: usize,
    /// Ya estaban en la nube
    pub already: usize,
    /// Pendientes de subir (al empezar esta pasada) y lo subido en ella
    pub pending_files: usize,
    pub pending_bytes: u64,
    pub uploaded_files: usize,
    pub uploaded_bytes: u64,
    pub current: String,
    /// Velocidad real de subida (Mb/s)
    pub rate_mbps: f64,
    pub error: String,
    pub failed: usize,
    pub finished_at: u64,
}

struct Shared {
    status: Mutex<MediaStatus>,
    enabled: AtomicBool,
    limit: AtomicU32,
    wake: Mutex<bool>,
    cv: std::sync::Condvar,
    /// Medidor de velocidad real, a lo largo de varios archivos
    meter: Mutex<(Instant, u64)>,
}

static SHARED: std::sync::OnceLock<Arc<Shared>> = std::sync::OnceLock::new();

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
struct HashEntry {
    size: u64,
    mtime: u64,
    hash: String,
}

fn read_cfg(dir: &Path) -> MediaCfg {
    std::fs::read_to_string(dir.join(CFG_FILE)).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default()
}

fn shared(dir: &Path) -> Arc<Shared> {
    SHARED
        .get_or_init(|| {
            let cfg = read_cfg(dir);
            let sh = Arc::new(Shared {
                status: Mutex::new(MediaStatus { enabled: cfg.enabled, limit_mbps: cfg.limit_mbps, phase: "idle".into(), ..Default::default() }),
                enabled: AtomicBool::new(cfg.enabled),
                limit: AtomicU32::new(cfg.limit_mbps),
                wake: Mutex::new(false),
                cv: std::sync::Condvar::new(),
                meter: Mutex::new((Instant::now(), 0)),
            });
            let s2 = sh.clone();
            let d = dir.to_path_buf();
            let _ = std::thread::Builder::new().name("miradio-cloudmedia".into()).spawn(move || worker(d, s2));
            sh
        })
        .clone()
}

fn set_status(sh: &Shared, f: impl FnOnce(&mut MediaStatus)) {
    if let Ok(mut g) = sh.status.lock() {
        f(&mut g);
    }
}

/// Espera `secs` o hasta que se cambie la configuración.
fn nap(sh: &Shared, secs: u64) {
    let g = sh.wake.lock().unwrap_or_else(|e| e.into_inner());
    let (mut g, _) = sh.cv.wait_timeout_while(g, Duration::from_secs(secs), |w| !*w).unwrap_or_else(|e| e.into_inner());
    *g = false;
}

fn worker(dir: PathBuf, sh: Arc<Shared>) {
    loop {
        if !sh.enabled.load(Ordering::Relaxed) {
            set_status(&sh, |s| {
                if s.phase != "done" {
                    s.phase = if s.uploaded_files > 0 || s.hashed > 0 { "paused".into() } else { "idle".into() };
                }
                s.current.clear();
                s.rate_mbps = 0.0;
            });
            nap(&sh, 3600);
            continue;
        }
        let Some(join) = crate::cloud::read_join(&dir) else {
            set_status(&sh, |s| s.phase = "nomaster".into());
            nap(&sh, 60);
            continue;
        };
        match pass(&dir, &sh, &join) {
            Ok(true) => {
                set_status(&sh, |s| {
                    s.phase = "done".into();
                    s.current.clear();
                    s.rate_mbps = 0.0;
                    s.finished_at = std::time::SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
                });
                // Música nueva: se mira cada 15 minutos.
                nap(&sh, 15 * 60);
            }
            Ok(false) => {} // pausado a mitad
            Err(e) => {
                crate::crashlog::note(&format!("Subida de música al maestro: {e}"));
                set_status(&sh, |s| {
                    s.phase = "error".into();
                    s.error = e;
                    s.rate_mbps = 0.0;
                });
                nap(&sh, 120);
            }
        }
    }
}

fn agent() -> ureq::Agent {
    ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(15))
        .timeout_read(Duration::from_secs(180))
        .timeout_write(Duration::from_secs(180))
        .user_agent(concat!("OmniCaster/", env!("CARGO_PKG_VERSION")))
        .build()
}

fn content_type(path: &Path) -> &'static str {
    match path.extension().and_then(|e| e.to_str()).map(|e| e.to_ascii_lowercase()).as_deref() {
        Some("flac") => "audio/flac",
        Some("mp3") => "audio/mpeg",
        Some("m4a") | Some("aac") | Some("mp4") => "audio/mp4",
        Some("ogg") | Some("oga") | Some("opus") => "audio/ogg",
        Some("wav") => "audio/wav",
        Some("mkv") | Some("webm") => "video/webm",
        Some("mov") => "video/quicktime",
        _ => "application/octet-stream",
    }
}

/// Una pasada completa. Ok(true) = terminada; Ok(false) = se pausó.
fn pass(dir: &Path, sh: &Arc<Shared>, join: &crate::cloud::JoinFile) -> Result<bool, String> {
    let on = || sh.enabled.load(Ordering::Relaxed);
    // 1. Archivos de la biblioteca (sin repetir).
    let mut files: Vec<(PathBuf, u64, u64)> = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for t in crate::library::read_library_internal(dir) {
        let p = PathBuf::from(t.file.trim());
        if t.file.trim().is_empty() || !seen.insert(p.clone()) {
            continue;
        }
        if let Ok(m) = std::fs::metadata(&p) {
            if m.is_file() {
                let mtime = m.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_secs()).unwrap_or(0);
                files.push((p, m.len(), mtime));
            }
        }
    }
    let total_bytes: u64 = files.iter().map(|f| f.1).sum();
    set_status(sh, |s| {
        s.phase = "hashing".into();
        s.total_files = files.len();
        s.total_bytes = total_bytes;
        s.hashed = 0;
        s.error.clear();
        s.failed = 0;
    });

    // 2. Huellas (las ya calculadas, del archivo de huellas).
    let hash_path = dir.join(HASH_FILE);
    let mut cache: HashMap<String, HashEntry> =
        std::fs::read_to_string(&hash_path).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default();
    let mut dirty = 0usize;
    let mut hashed: Vec<(PathBuf, u64, String)> = Vec::with_capacity(files.len());
    for (i, (p, size, mtime)) in files.iter().enumerate() {
        if !on() {
            save_cache(&hash_path, &cache);
            return Ok(false);
        }
        let key = p.to_string_lossy().into_owned();
        let hash = match cache.get(&key) {
            Some(e) if e.size == *size && e.mtime == *mtime => e.hash.clone(),
            _ => {
                set_status(sh, |s| s.current = p.file_name().and_then(|n| n.to_str()).unwrap_or("").to_string());
                match hash_file(p) {
                    Ok(h) => {
                        cache.insert(key, HashEntry { size: *size, mtime: *mtime, hash: h.clone() });
                        dirty += 1;
                        if dirty % 200 == 0 {
                            save_cache(&hash_path, &cache);
                        }
                        h
                    }
                    Err(_) => continue,
                }
            }
        };
        hashed.push((p.clone(), *size, hash));
        if i % 25 == 0 {
            set_status(sh, |s| s.hashed = i + 1);
        }
    }
    if dirty > 0 {
        save_cache(&hash_path, &cache);
    }
    set_status(sh, |s| {
        s.hashed = hashed.len();
        s.phase = "checking".into();
        s.current.clear();
    });

    // 3. ¿Cuáles faltan en la nube? (un mismo archivo en dos rutas, una vez)
    let ag = agent();
    let auth = format!("Bearer {}", join.token);
    let mut by_hash: HashMap<String, (PathBuf, u64)> = HashMap::new();
    for (p, size, h) in &hashed {
        by_hash.entry(h.clone()).or_insert((p.clone(), *size));
    }
    let hashes: Vec<String> = by_hash.keys().cloned().collect();
    let mut missing: Vec<String> = Vec::new();
    for chunk in hashes.chunks(1000) {
        let resp = ag
            .post(&format!("{}/v1/media/missing", join.api))
            .set("Authorization", &auth)
            .set("Content-Type", "application/json")
            .send_string(&serde_json::json!({ "hashes": chunk }).to_string())
            .map_err(|e| net_err(&e))?;
        let v = body_json(resp)?;
        if let Some(arr) = v.get("missing").and_then(|m| m.as_array()) {
            missing.extend(arr.iter().filter_map(|x| x.as_str().map(|s| s.to_string())));
        }
    }
    let pending_bytes: u64 = missing.iter().filter_map(|h| by_hash.get(h)).map(|x| x.1).sum();
    set_status(sh, |s| {
        s.already = hashes.len() - missing.len();
        s.pending_files = missing.len();
        s.pending_bytes = pending_bytes;
        s.uploaded_files = 0;
        s.uploaded_bytes = 0;
        s.phase = if missing.is_empty() { "done".into() } else { "uploading".into() };
    });

    // 4. Subida, de los más pequeños a los más grandes (se ve avanzar antes).
    missing.sort_by_key(|h| by_hash.get(h).map(|x| x.1).unwrap_or(0));
    let mut failed = 0usize;
    for h in &missing {
        if !on() {
            return Ok(false);
        }
        let Some((p, size)) = by_hash.get(h).cloned() else { continue };
        set_status(sh, |s| s.current = p.file_name().and_then(|n| n.to_str()).unwrap_or("").to_string());
        let mut ok = false;
        for attempt in 0..3 {
            match upload(&ag, &auth, &join.api, h, &p, size, sh) {
                Ok(true) => {
                    ok = true;
                    break;
                }
                Ok(false) => return Ok(false), // pausado
                Err(e) => {
                    set_status(sh, |s| s.error = format!("{}: {e}", p.file_name().and_then(|n| n.to_str()).unwrap_or("")));
                    std::thread::sleep(Duration::from_secs(5 * (attempt + 1)));
                }
            }
        }
        if ok {
            set_status(sh, |s| s.uploaded_files += 1);
        } else {
            failed += 1;
            set_status(sh, |s| s.failed = failed);
        }
    }
    Ok(true)
}

fn net_err(e: &ureq::Error) -> String {
    match e {
        ureq::Error::Status(401, _) => "El maestro no reconoce este equipo (¿se dio de baja?)".into(),
        ureq::Error::Status(code, r) => format!("El maestro respondió {code} ({})", r.status_text()),
        ureq::Error::Transport(t) => format!("Sin conexión con el maestro ({t})"),
    }
}

fn body_json(r: ureq::Response) -> Result<serde_json::Value, String> {
    let t = r.into_string().map_err(|e| e.to_string())?;
    serde_json::from_str(&t).map_err(|e| format!("Respuesta del maestro no válida: {e}"))
}

fn save_cache(path: &Path, cache: &HashMap<String, HashEntry>) {
    if let Ok(t) = serde_json::to_string(cache) {
        let tmp = path.with_extension("tmp");
        if std::fs::write(&tmp, t).is_ok() {
            let _ = std::fs::rename(&tmp, path);
        }
    }
}

fn hash_file(p: &Path) -> std::io::Result<String> {
    let mut f = File::open(p)?;
    let mut h = Sha256::new();
    let mut buf = vec![0u8; 1 << 20];
    loop {
        let n = f.read(&mut buf)?;
        if n == 0 {
            break;
        }
        h.update(&buf[..n]);
    }
    Ok(format!("{:x}", h.finalize()))
}

/// Lector con límite de velocidad (y que se corta al pausar).
struct Throttled<'a, R: Read> {
    inner: R,
    sh: &'a Shared,
    started: Instant,
    sent: u64,
    window_start: Instant,
    window_sent: u64,
}

impl<R: Read> Read for Throttled<'_, R> {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        if !self.sh.enabled.load(Ordering::Relaxed) {
            return Err(std::io::Error::new(std::io::ErrorKind::Interrupted, "pausado"));
        }
        let max = buf.len().min(64 * 1024);
        let n = self.inner.read(&mut buf[..max])?;
        self.sent += n as u64;
        self.window_sent += n as u64;
        let limit = self.sh.limit.load(Ordering::Relaxed) as f64;
        if limit > 0.0 {
            let bytes_per_sec = limit * 1_000_000.0 / 8.0;
            let should = Duration::from_secs_f64(self.window_sent as f64 / bytes_per_sec);
            let el = self.window_start.elapsed();
            if should > el {
                std::thread::sleep(should - el);
            }
        }
        // Ventana nueva cada 5 s, para seguir los cambios de límite.
        if self.window_start.elapsed() > Duration::from_secs(5) {
            self.window_start = Instant::now();
            self.window_sent = 0;
        }
        // Velocidad real: se mide entre archivos (muchos tardan menos de 5 s).
        if let Ok(mut m) = self.sh.meter.lock() {
            m.1 += n as u64;
            let el = m.0.elapsed();
            if el > Duration::from_secs(5) {
                let rate = m.1 as f64 * 8.0 / 1_000_000.0 / el.as_secs_f64();
                set_status(self.sh, |s| s.rate_mbps = (rate * 10.0).round() / 10.0);
                *m = (Instant::now(), 0);
            }
        }
        set_status(self.sh, |s| s.uploaded_bytes += n as u64);
        let _ = self.started;
        Ok(n)
    }
}

fn throttled<R: Read>(inner: R, sh: &Shared) -> Throttled<'_, R> {
    Throttled { inner, sh, started: Instant::now(), sent: 0, window_start: Instant::now(), window_sent: 0 }
}

/// Sube un archivo. Ok(true) = subido; Ok(false) = se pausó.
fn upload(ag: &ureq::Agent, auth: &str, api: &str, hash: &str, path: &Path, size: u64, sh: &Shared) -> Result<bool, String> {
    let ctype = content_type(path);
    let before = sh.status.lock().map(|s| s.uploaded_bytes).unwrap_or(0);
    let undo = |sh: &Shared| set_status(sh, |s| s.uploaded_bytes = before);
    let paused = |e: &str| e.contains("pausado");
    if size <= SINGLE_MAX {
        let f = File::open(path).map_err(|e| e.to_string())?;
        let r = ag
            .put(&format!("{api}/v1/media/{hash}"))
            .set("Authorization", auth)
            .set("Content-Type", ctype)
            .set("Content-Length", &size.to_string())
            .send(throttled(f, sh));
        return match r {
            Ok(_) => Ok(true),
            Err(e) => {
                undo(sh);
                let m = net_err(&e);
                if paused(&m) || !sh.enabled.load(Ordering::Relaxed) { Ok(false) } else { Err(m) }
            }
        };
    }
    // Por partes.
    let start: serde_json::Value = ag
        .post(&format!("{api}/v1/media/{hash}/multipart"))
        .set("Authorization", auth)
        .set("x-content-type", ctype)
        .call()
        .map_err(|e| net_err(&e))
        .and_then(body_json)?;
    let upload_id = start.get("uploadId").and_then(|v| v.as_str()).ok_or("El maestro no abrió la subida por partes")?.to_string();
    let mut parts = Vec::new();
    let mut offset = 0u64;
    let mut n = 1u32;
    while offset < size {
        let len = PART.min(size - offset);
        let mut f = File::open(path).map_err(|e| e.to_string())?;
        f.seek(SeekFrom::Start(offset)).map_err(|e| e.to_string())?;
        let r = ag
            .put(&format!("{api}/v1/media/{hash}/multipart/{n}?uploadId={}", urlenc(&upload_id)))
            .set("Authorization", auth)
            .set("Content-Length", &len.to_string())
            .send(throttled(f.take(len), sh));
        match r {
            Ok(resp) => {
                let v = body_json(resp)?;
                let etag = v.get("etag").and_then(|x| x.as_str()).unwrap_or("").to_string();
                parts.push(serde_json::json!({ "n": n, "etag": etag }));
            }
            Err(e) => {
                undo(sh);
                if !sh.enabled.load(Ordering::Relaxed) {
                    return Ok(false);
                }
                return Err(net_err(&e));
            }
        }
        offset += len;
        n += 1;
    }
    ag.post(&format!("{api}/v1/media/{hash}/multipart/complete?uploadId={}", urlenc(&upload_id)))
        .set("Authorization", auth)
        .set("Content-Type", "application/json")
        .send_string(&serde_json::json!({ "parts": parts, "contentType": ctype }).to_string())
        .map_err(|e| net_err(&e))?;
    Ok(true)
}

fn urlenc(s: &str) -> String {
    s.bytes()
        .map(|b| if b.is_ascii_alphanumeric() || b"-_.~".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") })
        .collect()
}

/// Al arrancar: si la subida estaba activada, sigue (con un minuto de margen
/// para que la emisión arranque primero).
pub fn on_startup(dir: &Path) {
    if read_cfg(dir).enabled {
        let d = dir.to_path_buf();
        let _ = std::thread::Builder::new().name("miradio-cloudmedia-start".into()).spawn(move || {
            std::thread::sleep(Duration::from_secs(60));
            shared(&d);
        });
    }
}

/// Huellas ya calculadas: ruta -> (tamaño, fecha, sha256).
pub fn known_hashes(dir: &Path) -> HashMap<String, (u64, u64, String)> {
    let cache: HashMap<String, HashEntry> =
        std::fs::read_to_string(dir.join(HASH_FILE)).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default();
    cache.into_iter().map(|(k, e)| (k, (e.size, e.mtime, e.hash))).collect()
}

/// Un archivo cambió de nombre: su huella sigue valiendo (mismo contenido).
pub fn moved(dir: &Path, from: &Path, to: &Path) {
    let path = dir.join(HASH_FILE);
    let mut cache: HashMap<String, HashEntry> =
        std::fs::read_to_string(&path).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default();
    if let Some(e) = cache.remove(&from.to_string_lossy().into_owned()) {
        cache.insert(to.to_string_lossy().into_owned(), e);
        save_cache(&path, &cache);
    }
}

pub fn hash_file_pub(p: &Path) -> std::io::Result<String> {
    hash_file(p)
}

// ------------------------------------------------------------------ comandos

#[tauri::command]
pub fn cloud_media_status(state: State<'_, AppState>) -> MediaStatus {
    let sh = shared(&state.data_dir);
    let s = sh.status.lock().map(|g| g.clone()).unwrap_or_default();
    s
}

#[tauri::command]
pub fn cloud_media_set(state: State<'_, AppState>, enabled: bool, limit_mbps: u32) -> Result<MediaStatus, String> {
    let sh = shared(&state.data_dir);
    let cfg = MediaCfg { enabled, limit_mbps: limit_mbps.min(10_000) };
    std::fs::write(state.data_dir.join(CFG_FILE), serde_json::to_string_pretty(&cfg).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    sh.enabled.store(cfg.enabled, Ordering::Relaxed);
    sh.limit.store(cfg.limit_mbps, Ordering::Relaxed);
    set_status(&sh, |s| {
        s.enabled = cfg.enabled;
        s.limit_mbps = cfg.limit_mbps;
        if cfg.enabled && (s.phase == "paused" || s.phase == "idle" || s.phase == "error" || s.phase == "done") {
            s.phase = "checking".into();
        }
    });
    if let Ok(mut w) = sh.wake.lock() {
        *w = true;
    }
    sh.cv.notify_all();
    Ok(sh.status.lock().map(|g| g.clone()).unwrap_or_default())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encodes_and_types() {
        assert_eq!(urlenc("a b/c"), "a%20b%2Fc");
        assert_eq!(content_type(Path::new("x.FLAC")), "audio/flac");
    }
}
