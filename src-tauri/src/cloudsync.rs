//! Sincronización de los datos de la emisora con el maestro (fase 2).
//!
//! Qué se sincroniza: canciones (la ficha, no el archivo), bloques, listas,
//! programas, eventos y campañas. Cada cosa es un «elemento» del maestro.
//!
//! Cómo:
//! - Cada pasada primero trae del maestro lo que ha cambiado desde la última
//!   vez y lo aplica aquí; después mira qué ha cambiado aquí y lo manda.
//! - Para saber qué ha cambiado aquí, se guarda la huella de cada elemento tal
//!   como quedó la última vez que se sincronizó (`maestro-sync.json`).
//! - Canciones y bloques se escriben aquí mismo. Listas, programas, eventos y
//!   campañas los tiene en memoria la ventana principal: se le mandan
//!   (`cloud://apply`) y ella los aplica y guarda.
//! - Un equipo que no es el principal, la primera vez, adopta los datos del
//!   maestro y no sube lo que tuviera antes (no se duplica nada).
//! - Un nodo de relevo solo recibe.
//! - Las canciones que llegan sin archivo aquí se bajan del maestro (R2) a
//!   `<datos>/maestro-musica/<sha256>.<ext>`, en segundo plano.

use std::collections::{HashMap, HashSet};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, State};

use crate::library::Track;
use crate::AppState;

const STATE_FILE: &str = "maestro-sync.json";
const CFG_FILE: &str = "maestro-sync-cfg.json";
pub const MEDIA_DIR: &str = "maestro-musica";
const PASS_SECS: u64 = 20;
/// Campos de la ficha que dependen de cada equipo: no viajan.
const LOCAL_FIELDS: [&str; 7] = ["file", "fileName", "cover", "coverChecked", "audioChecked", "tagsV", "analysisSig"];
/// Elementos que aplica la ventana principal.
const APP_KINDS: [&str; 4] = ["playlist", "program", "event", "campaign"];

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct SyncCfg {
    pub enabled: bool,
    /// Qué música bajar del maestro si falta aquí: "needed" (solo la de las
    /// listas y los eventos), "all" (toda) o "none".
    pub download: String,
}
impl Default for SyncCfg {
    fn default() -> Self {
        SyncCfg { enabled: false, download: "needed".into() }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
struct Shadow {
    /// Huella del contenido acordado ("del" = borrado)
    h: String,
    /// Versión del maestro (0 = solo de este equipo, nunca subido)
    v: u64,
    /// Pendiente de que lo aplique la ventana principal (intentos)
    #[serde(default, skip_serializing_if = "is_zero")]
    p: u8,
}
fn is_zero(n: &u8) -> bool {
    *n == 0
}

#[derive(Serialize, Deserialize, Default)]
struct SyncState {
    /// Nodo con el que se hizo (si cambia, se empieza de cero)
    node: String,
    cursor: u64,
    items: HashMap<String, Shadow>,
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct SyncStatus {
    pub enabled: bool,
    pub download: String,
    /// "off" | "syncing" | "ok" | "error" | "nomaster"
    pub phase: String,
    pub error: String,
    pub last_at: u64,
    pub version: u64,
    /// Elementos al día
    pub items: usize,
    pub sent_total: u64,
    pub received_total: u64,
    /// Música que falta aquí y se está bajando
    pub dl_pending: usize,
    pub dl_done: usize,
    pub dl_bytes: u64,
    pub dl_current: String,
    pub dl_error: String,
}

struct Shared {
    dir: PathBuf,
    app: AppHandle,
    status: Mutex<SyncStatus>,
    cfg: Mutex<SyncCfg>,
    wake: Mutex<bool>,
    cv: Condvar,
    /// Contenido que se mandó a la ventana principal y aún no se ve aplicado
    pending: Mutex<HashMap<String, Value>>,
    downloading: AtomicBool,
}

static SHARED: OnceLock<Arc<Shared>> = OnceLock::new();

fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

fn key(kind: &str, id: &str) -> String {
    format!("{kind}:{id}")
}

/// Huella de un contenido (JSON canónico: claves ordenadas).
fn digest(v: &Value) -> String {
    let mut h = Sha256::new();
    h.update(canonical(v).as_bytes());
    let x = format!("{:x}", h.finalize());
    x[..24].to_string()
}

fn canonical(v: &Value) -> String {
    match v {
        Value::Object(m) => {
            let mut keys: Vec<&String> = m.keys().collect();
            keys.sort();
            let parts: Vec<String> = keys.iter().map(|k| format!("{}:{}", Value::String((*k).clone()), canonical(&m[*k]))).collect();
            format!("{{{}}}", parts.join(","))
        }
        Value::Array(a) => format!("[{}]", a.iter().map(canonical).collect::<Vec<_>>().join(",")),
        other => other.to_string(),
    }
}

pub fn on_startup(app: &AppHandle, dir: &Path) {
    let cfg: SyncCfg = fs::read_to_string(dir.join(CFG_FILE)).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default();
    let sh = Arc::new(Shared {
        dir: dir.to_path_buf(),
        app: app.clone(),
        status: Mutex::new(SyncStatus { enabled: cfg.enabled, download: cfg.download.clone(), phase: "off".into(), ..Default::default() }),
        cfg: Mutex::new(cfg),
        wake: Mutex::new(false),
        cv: Condvar::new(),
        pending: Mutex::new(HashMap::new()),
        downloading: AtomicBool::new(false),
    });
    if SHARED.set(sh.clone()).is_ok() {
        let _ = std::thread::Builder::new().name("miradio-cloudsync".into()).spawn(move || {
            // Que arranque primero la emisión.
            std::thread::sleep(Duration::from_secs(20));
            worker(sh)
        });
    }
}

fn set_status(sh: &Shared, f: impl FnOnce(&mut SyncStatus)) {
    if let Ok(mut g) = sh.status.lock() {
        f(&mut g);
    }
}

fn poke(sh: &Shared) {
    if let Ok(mut w) = sh.wake.lock() {
        *w = true;
    }
    sh.cv.notify_all();
}

fn nap(sh: &Shared, secs: u64) {
    let g = sh.wake.lock().unwrap_or_else(|e| e.into_inner());
    let (mut g, _) = sh.cv.wait_timeout_while(g, Duration::from_secs(secs), |w| !*w).unwrap_or_else(|e| e.into_inner());
    *g = false;
}

fn worker(sh: Arc<Shared>) {
    let mut last_sig = String::new();
    loop {
        let cfg = sh.cfg.lock().map(|c| c.clone()).unwrap_or_default();
        if !cfg.enabled {
            set_status(&sh, |s| s.phase = "off".into());
            nap(&sh, 3600);
            last_sig.clear();
            continue;
        }
        let Some(join) = crate::cloud::read_join(&sh.dir) else {
            set_status(&sh, |s| s.phase = "nomaster".into());
            nap(&sh, 60);
            continue;
        };
        set_status(&sh, |s| s.phase = "syncing".into());
        match pass(&sh, &join, &mut last_sig) {
            Ok(()) => set_status(&sh, |s| {
                s.phase = "ok".into();
                s.error.clear();
                s.last_at = now();
            }),
            Err(e) => {
                crate::crashlog::note(&format!("Sincronización con el maestro: {e}"));
                set_status(&sh, |s| {
                    s.phase = "error".into();
                    s.error = e;
                });
                last_sig.clear();
            }
        }
        if cfg.download != "none" {
            start_downloads(&sh, &join);
        }
        nap(&sh, PASS_SECS);
    }
}

// ------------------------------------------------------------ red

fn agent() -> ureq::Agent {
    ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(15))
        .timeout_read(Duration::from_secs(120))
        .timeout_write(Duration::from_secs(120))
        .user_agent(concat!("OmniCaster/", env!("CARGO_PKG_VERSION")))
        .build()
}

fn net_err(e: ureq::Error) -> String {
    match e {
        ureq::Error::Status(401, _) => "El maestro no reconoce este equipo (¿se dio de baja?)".into(),
        ureq::Error::Status(code, r) => {
            let body = r.into_string().unwrap_or_default();
            let msg = serde_json::from_str::<Value>(&body).ok().and_then(|v| v.get("error").and_then(|x| x.as_str()).map(String::from));
            format!("El maestro respondió {code}{}", msg.map(|m| format!(": {m}")).unwrap_or_default())
        }
        ureq::Error::Transport(t) => format!("Sin conexión con el maestro ({t})"),
    }
}

fn body_json(r: ureq::Response) -> Result<Value, String> {
    let t = r.into_string().map_err(|e| e.to_string())?;
    serde_json::from_str(&t).map_err(|e| format!("Respuesta del maestro no válida: {e}"))
}

// ------------------------------------------------------------ estado

fn load_state(dir: &Path) -> SyncState {
    fs::read_to_string(dir.join(STATE_FILE)).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default()
}

fn save_state(dir: &Path, st: &SyncState) -> Result<(), String> {
    let tmp = dir.join("maestro-sync.json.tmp");
    fs::write(&tmp, serde_json::to_vec(st).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    fs::rename(&tmp, dir.join(STATE_FILE)).map_err(|e| e.to_string())
}

fn mtime(p: &Path) -> u64 {
    fs::metadata(p).ok().and_then(|m| m.modified().ok()).and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_nanos() as u64).unwrap_or(0)
}

/// Firma de los archivos de datos: si no cambia, no hay nada nuevo aquí.
fn sources_sig(dir: &Path) -> String {
    let mut parts = vec![
        mtime(&dir.join(crate::library::LIBRARY_FILE)),
        mtime(&dir.join("blocks.json")),
        mtime(&dir.join("settings.json")),
        mtime(&dir.join("maestro-huellas.json")),
    ];
    if let Ok(rd) = fs::read_dir(dir.join(crate::playlists::PLAYLISTS_DIR)) {
        let mut v: Vec<u64> = rd.flatten().map(|e| mtime(&e.path()) ^ e.file_name().len() as u64).collect();
        v.sort();
        parts.push(v.len() as u64);
        parts.extend(v);
    }
    parts.iter().map(|x| x.to_string()).collect::<Vec<_>>().join(".")
}

// ------------------------------------------------------------ datos locales

fn media_dir(dir: &Path) -> PathBuf {
    dir.join(MEDIA_DIR)
}

/// sha256 del archivo de una canción, si se conoce.
fn media_of(file: &str, mdir: &Path, hashes: &HashMap<String, (u64, u64, String)>) -> String {
    if file.is_empty() {
        return String::new();
    }
    let p = Path::new(file);
    if p.parent() == Some(mdir) {
        if let Some(stem) = p.file_stem().and_then(|s| s.to_str()) {
            if stem.len() == 64 && stem.bytes().all(|b| b.is_ascii_hexdigit()) {
                return stem.to_string();
            }
        }
    }
    let Some((size, mt, h)) = hashes.get(file) else { return String::new() };
    match fs::metadata(p) {
        Ok(m) => {
            let t = m.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_secs()).unwrap_or(0);
            if m.len() == *size && t == *mt {
                h.clone()
            } else {
                String::new()
            }
        }
        // El archivo no está ahora (disco desconectado): vale la última huella.
        Err(_) => h.clone(),
    }
}

fn track_value(t: &Track, mdir: &Path, hashes: &HashMap<String, (u64, u64, String)>) -> Value {
    let mut v = serde_json::to_value(t).unwrap_or(Value::Null);
    if let Value::Object(m) = &mut v {
        for f in LOCAL_FIELDS {
            m.remove(f);
        }
        let media = media_of(&t.file, mdir, hashes);
        if !media.is_empty() {
            let ext = Path::new(&t.file).extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
            m.insert("ext".into(), Value::String(ext));
        }
        m.insert("media".into(), Value::String(media));
    }
    v
}

struct Local {
    kind: &'static str,
    id: String,
    data: Value,
    h: String,
}

fn collect_local(dir: &Path) -> HashMap<String, Local> {
    let mut out = HashMap::new();
    let mut add = |kind: &'static str, id: String, data: Value| {
        if id.is_empty() {
            return;
        }
        let h = digest(&data);
        out.insert(key(kind, &id), Local { kind, id, data, h });
    };
    let mdir = media_dir(dir);
    let hashes = crate::cloudmedia::known_hashes(dir);
    for t in crate::library::read_library_internal(dir) {
        let v = track_value(&t, &mdir, &hashes);
        add("track", t.id.clone(), v);
    }
    for b in crate::library::read_blocks(dir) {
        add("block", b.id.clone(), serde_json::to_value(&b).unwrap_or(Value::Null));
    }
    if let Ok(rd) = fs::read_dir(dir.join(crate::playlists::PLAYLISTS_DIR)) {
        for e in rd.flatten() {
            let p = e.path();
            if p.extension().and_then(|x| x.to_str()) != Some("json") {
                continue;
            }
            if let Some(pl) = fs::read(&p).ok().and_then(|b| serde_json::from_slice::<crate::playlists::Playlist>(&b).ok()) {
                add("playlist", pl.id.clone(), serde_json::to_value(&pl).unwrap_or(Value::Null));
            }
        }
    }
    let s = crate::settings::read_settings_public(&dir.to_path_buf());
    let arr = |v: Value| -> Vec<Value> { if let Value::Array(a) = v { a } else { vec![] } };
    for (kind, list) in [
        ("program", arr(serde_json::to_value(&s.programs).unwrap_or(Value::Null))),
        ("event", arr(serde_json::to_value(&s.events).unwrap_or(Value::Null))),
        ("campaign", arr(serde_json::to_value(&s.campaigns).unwrap_or(Value::Null))),
    ] {
        for it in list {
            let id = it.get("id").and_then(|x| x.as_str()).unwrap_or("").to_string();
            add(kind, id, it);
        }
    }
    out
}

// ------------------------------------------------------------ aplicar

struct Incoming {
    kind: String,
    id: String,
    deleted: bool,
    data: Value,
}

/// Aplica lo que llega del maestro. Devuelve cuántos elementos cambió aquí.
fn apply(sh: &Shared, incoming: Vec<Incoming>) -> Result<(), String> {
    if incoming.is_empty() {
        return Ok(());
    }
    let dir = &sh.dir;
    let mdir = media_dir(dir);
    let mut tracks: Vec<&Incoming> = Vec::new();
    let mut blocks: Vec<&Incoming> = Vec::new();
    let mut app: Vec<Value> = Vec::new();
    for it in &incoming {
        match it.kind.as_str() {
            "track" => tracks.push(it),
            "block" => blocks.push(it),
            k if APP_KINDS.contains(&k) => app.push(json!({ "kind": it.kind, "id": it.id, "deleted": it.deleted, "data": it.data })),
            _ => {}
        }
    }
    let mut lib_changed = false;
    if !tracks.is_empty() || !blocks.is_empty() {
        let _g = crate::library::lock_library();
        if !tracks.is_empty() {
            let hashes = crate::cloudmedia::known_hashes(dir);
            let rename = crate::settings::read_settings_public(&dir.to_path_buf()).rename_files;
            let mut lib = crate::library::read_library_internal(dir);
            let mut pos: HashMap<String, usize> = lib.iter().enumerate().map(|(i, t)| (t.id.clone(), i)).collect();
            let mut remove: HashSet<String> = HashSet::new();
            for it in tracks {
                if it.deleted {
                    remove.insert(it.id.clone());
                    continue;
                }
                let media = it.data.get("media").and_then(|x| x.as_str()).unwrap_or("").to_string();
                let ext = it.data.get("ext").and_then(|x| x.as_str()).unwrap_or("").to_string();
                let Ok(mut t) = serde_json::from_value::<Track>(it.data.clone()) else { continue };
                t.id = it.id.clone();
                let target = if media.len() == 64 {
                    mdir.join(if ext.is_empty() { media.clone() } else { format!("{media}.{ext}") }).to_string_lossy().into_owned()
                } else {
                    String::new()
                };
                match pos.get(&it.id) {
                    Some(&i) => {
                        let old = &lib[i];
                        // Se queda el archivo de aquí si es el mismo (o si no se sabe).
                        let local_media = media_of(&old.file, &mdir, &hashes);
                        let keep = media.is_empty() || local_media.is_empty() && !old.file.is_empty() && Path::new(&old.file).exists() || local_media == media;
                        t.file = if keep { old.file.clone() } else { target };
                        t.file_name = old.file_name.clone();
                        t.cover = old.cover.clone();
                        t.cover_checked = old.cover_checked;
                        t.audio_checked = old.audio_checked;
                        t.tags_v = old.tags_v;
                        t.analysis_sig = if keep { old.analysis_sig.clone() } else { String::new() };
                        // Cambió el título o el artista en otro equipo (o en la web): el
                        // archivo de aquí también se renombra (si está sonando, no).
                        if keep && rename && (old.title != t.title || old.artist != t.artist) {
                            let _ = crate::library::rename_to_metadata(dir, &mut t);
                        }
                        lib[i] = t;
                    }
                    None => {
                        t.file = target;
                        t.file_name.clear();
                        t.cover.clear();
                        t.cover_checked = false;
                        t.audio_checked = false;
                        t.analysis_sig.clear();
                        pos.insert(t.id.clone(), lib.len());
                        lib.push(t);
                    }
                }
            }
            if !remove.is_empty() {
                lib.retain(|t| !remove.contains(&t.id));
            }
            crate::library::write_library(dir, &lib)?;
            lib_changed = true;
        }
        if !blocks.is_empty() {
            let mut bs = crate::library::read_blocks(dir);
            for it in blocks {
                bs.retain(|b| b.id != it.id);
                if !it.deleted {
                    if let Ok(b) = serde_json::from_value::<crate::library::Block>(it.data.clone()) {
                        bs.push(b);
                    }
                }
            }
            crate::library::write_blocks(dir, &bs)?;
            lib_changed = true;
        }
    }
    if lib_changed {
        let _ = sh.app.emit("library://changed", ());
        let _ = sh.app.emit("cloud://library", ());
    }
    if !app.is_empty() {
        if let Ok(mut p) = sh.pending.lock() {
            for a in &app {
                let k = key(a["kind"].as_str().unwrap_or(""), a["id"].as_str().unwrap_or(""));
                p.insert(k, a.clone());
            }
        }
        let _ = sh.app.emit("cloud://apply", Value::Array(app));
    }
    Ok(())
}

// ------------------------------------------------------------ pasada

fn pass(sh: &Shared, join: &crate::cloud::JoinFile, last_sig: &mut String) -> Result<(), String> {
    let dir = &sh.dir;
    let ag = agent();
    let auth = format!("Bearer {}", join.token);
    let role = join.node.role.as_str();
    let mut st = load_state(dir);
    if st.node != join.node.id {
        st = SyncState { node: join.node.id.clone(), ..Default::default() };
    }
    let first = st.cursor == 0 && st.items.is_empty();
    let mut fresh: HashSet<String> = HashSet::new();

    // 1. Traer lo nuevo.
    let mut received = 0u64;
    loop {
        let v = ag
            .get(&format!("{}/v1/sync/items?since={}&limit=1000", join.api, st.cursor))
            .set("Authorization", &auth)
            .call()
            .map_err(net_err)
            .and_then(body_json)?;
        let items = v.get("items").and_then(|x| x.as_array()).cloned().unwrap_or_default();
        let mut incoming = Vec::new();
        for it in &items {
            let kind = it.get("kind").and_then(|x| x.as_str()).unwrap_or("").to_string();
            let id = it.get("id").and_then(|x| x.as_str()).unwrap_or("").to_string();
            let version = it.get("version").and_then(|x| x.as_u64()).unwrap_or(0);
            let deleted = it.get("deleted").and_then(|x| x.as_bool()).unwrap_or(false);
            let data = it.get("data").cloned().unwrap_or(Value::Null);
            let k = key(&kind, &id);
            let h = if deleted { "del".to_string() } else { digest(&data) };
            if let Some(cur) = st.items.get(&k) {
                if cur.v >= version || cur.h == h {
                    if let Some(c) = st.items.get_mut(&k) {
                        c.v = c.v.max(version);
                    }
                    continue;
                }
            }
            let app_kind = APP_KINDS.contains(&kind.as_str());
            if app_kind {
                fresh.insert(k.clone());
            }
            st.items.insert(k, Shadow { h, v: version, p: if app_kind { 1 } else { 0 } });
            incoming.push(Incoming { kind, id, deleted, data });
        }
        received += incoming.len() as u64;
        apply(sh, incoming)?;
        st.cursor = v.get("next").and_then(|x| x.as_u64()).unwrap_or(st.cursor);
        save_state(dir, &st)?;
        if !v.get("more").and_then(|x| x.as_bool()).unwrap_or(false) {
            break;
        }
    }

    // 2. Mirar qué ha cambiado aquí (solo si ha cambiado algún archivo).
    let sig = sources_sig(dir);
    if received == 0 && sig == *last_sig {
        set_status(sh, |s| {
            s.version = st.cursor;
            s.items = st.items.len();
        });
        return Ok(());
    }
    let locals = collect_local(dir);
    let adopt = first && role != "main";
    let mut push: Vec<(String, Value, String)> = Vec::new(); // (clave, elemento, huella)
    let mut reemit: Vec<Value> = Vec::new();
    let pending = sh.pending.lock().map(|p| p.clone()).unwrap_or_default();
    for (k, l) in &locals {
        match st.items.get_mut(k) {
            None => {
                if adopt {
                    st.items.insert(k.clone(), Shadow { h: l.h.clone(), v: 0, p: 0 });
                } else {
                    push.push((k.clone(), json!({ "kind": l.kind, "id": l.id, "data": l.data }), l.h.clone()));
                }
            }
            Some(s) if s.h == l.h => s.p = 0,
            Some(s) if s.p > 0 && !fresh.contains(k) && s.p < 4 && pending.contains_key(k) => {
                s.p += 1;
                reemit.push(pending[k].clone());
            }
            Some(s) if s.p > 0 && fresh.contains(k) => {}
            Some(s) => {
                s.p = 0;
                let mut it = json!({ "kind": l.kind, "id": l.id, "data": l.data });
                if s.v > 0 {
                    it["baseVersion"] = json!(s.v);
                }
                push.push((k.clone(), it, l.h.clone()));
            }
        }
    }
    let gone: Vec<String> = st.items.keys().filter(|k| !locals.contains_key(*k)).cloned().collect();
    for k in gone {
        let s = st.items[&k].clone();
        if s.h == "del" {
            if s.p == 0 || !fresh.contains(&k) {
                st.items.remove(&k);
            }
            continue;
        }
        if s.p > 0 && fresh.contains(&k) {
            continue;
        }
        if s.p > 0 && s.p < 4 && pending.contains_key(&k) {
            if let Some(x) = st.items.get_mut(&k) {
                x.p += 1;
            }
            reemit.push(pending[&k].clone());
            continue;
        }
        if s.v == 0 {
            st.items.remove(&k);
            continue;
        }
        let (kind, id) = k.split_once(':').unwrap_or(("", ""));
        push.push((k.clone(), json!({ "kind": kind, "id": id, "deleted": true, "baseVersion": s.v }), "del".into()));
    }
    // Lo que la ventana principal ya aplicó, fuera de pendientes.
    if let Ok(mut p) = sh.pending.lock() {
        p.retain(|k, _| st.items.get(k).map(|s| s.p > 0).unwrap_or(false));
    }
    if !reemit.is_empty() {
        let _ = sh.app.emit("cloud://apply", Value::Array(reemit));
    }

    // 3. Mandar lo cambiado aquí (el relevo no cambia datos).
    let mut sent = 0u64;
    if role != "backup" && !push.is_empty() {
        // Primero lo pequeño (bloques, programas…), después las canciones.
        push.sort_by_key(|(k, _, _)| if k.starts_with("track:") { 1 } else { 0 });
        let hashes: HashMap<String, String> = push.iter().map(|(k, _, h)| (k.clone(), h.clone())).collect();
        for chunk in push.chunks(500) {
            let body = json!({ "items": chunk.iter().map(|x| x.1.clone()).collect::<Vec<_>>() });
            let v = ag
                .post(&format!("{}/v1/sync/items", join.api))
                .set("Authorization", &auth)
                .set("Content-Type", "application/json")
                .send_string(&body.to_string())
                .map_err(net_err)
                .and_then(body_json)?;
            for it in v.get("items").and_then(|x| x.as_array()).cloned().unwrap_or_default() {
                let k = key(it["kind"].as_str().unwrap_or(""), it["id"].as_str().unwrap_or(""));
                let version = it["version"].as_u64().unwrap_or(0);
                if let Some(h) = hashes.get(&k) {
                    st.items.insert(k, Shadow { h: h.clone(), v: version, p: 0 });
                    sent += 1;
                }
            }
            // Conflicto: otro equipo lo cambió antes. Gana el maestro.
            let mut incoming = Vec::new();
            for c in v.get("conflicts").and_then(|x| x.as_array()).cloned().unwrap_or_default() {
                let kind = c["kind"].as_str().unwrap_or("").to_string();
                let id = c["id"].as_str().unwrap_or("").to_string();
                let deleted = c["deleted"].as_bool().unwrap_or(false);
                let data = c.get("data").cloned().unwrap_or(Value::Null);
                let app_kind = APP_KINDS.contains(&kind.as_str());
                st.items.insert(
                    key(&kind, &id),
                    Shadow { h: if deleted { "del".into() } else { digest(&data) }, v: c["version"].as_u64().unwrap_or(0), p: if app_kind { 1 } else { 0 } },
                );
                incoming.push(Incoming { kind, id, deleted, data });
            }
            apply(sh, incoming)?;
            save_state(dir, &st)?;
        }
    }
    save_state(dir, &st)?;
    *last_sig = sources_sig(dir);
    set_status(sh, |s| {
        s.version = st.cursor;
        s.items = st.items.len();
        s.sent_total += sent;
        s.received_total += received;
    });
    Ok(())
}

// ------------------------------------------------------------ descargas

fn start_downloads(sh: &Arc<Shared>, join: &crate::cloud::JoinFile) {
    if sh.downloading.swap(true, Ordering::SeqCst) {
        return;
    }
    let sh2 = sh.clone();
    let join = join.clone();
    let _ = std::thread::Builder::new().name("miradio-cloudsync-dl".into()).spawn(move || {
        let r = download_missing(&sh2, &join);
        if let Err(e) = r {
            set_status(&sh2, |s| s.dl_error = e);
        }
        set_status(&sh2, |s| s.dl_current.clear());
        sh2.downloading.store(false, Ordering::SeqCst);
    });
}

fn download_missing(sh: &Shared, join: &crate::cloud::JoinFile) -> Result<(), String> {
    let mdir = media_dir(&sh.dir);
    let only = if sh.cfg.lock().map(|c| c.download == "all").unwrap_or(false) { None } else { Some(needed_ids(&sh.dir)) };
    let want: Vec<(String, PathBuf)> = crate::library::read_library_internal(&sh.dir)
        .into_iter()
        .filter(|t| only.as_ref().map(|o| o.contains(&t.id)).unwrap_or(true))
        .filter_map(|t| {
            let p = PathBuf::from(&t.file);
            (p.parent() == Some(mdir.as_path()) && !p.exists()).then_some((t.id, p))
        })
        .collect();
    set_status(sh, |s| {
        s.dl_pending = want.len();
        s.dl_done = 0;
    });
    if want.is_empty() {
        return Ok(());
    }
    fs::create_dir_all(&mdir).map_err(|e| e.to_string())?;
    let ag = agent();
    let auth = format!("Bearer {}", join.token);
    let mut done_ids = Vec::new();
    for (id, path) in want {
        if !sh.cfg.lock().map(|c| c.enabled && c.download != "none").unwrap_or(false) {
            break;
        }
        let Some(hash) = path.file_stem().and_then(|s| s.to_str()).map(String::from) else { continue };
        set_status(sh, |s| s.dl_current = path.file_name().and_then(|n| n.to_str()).unwrap_or("").to_string());
        match download_one(&ag, &auth, &join.api, &hash, &path, sh) {
            Ok(()) => {
                done_ids.push(id);
                set_status(sh, |s| {
                    s.dl_done += 1;
                    s.dl_error.clear();
                });
                if done_ids.len() % 25 == 0 {
                    finish_tracks(sh, &done_ids);
                    done_ids.clear();
                }
            }
            Err(e) => set_status(sh, |s| s.dl_error = e),
        }
    }
    finish_tracks(sh, &done_ids);
    Ok(())
}

/// Canciones que hacen falta aquí: las de todas las listas y las que citan
/// los eventos, las campañas y los programas.
fn needed_ids(dir: &Path) -> HashSet<String> {
    let mut ids = HashSet::new();
    if let Ok(rd) = fs::read_dir(dir.join(crate::playlists::PLAYLISTS_DIR)) {
        for e in rd.flatten() {
            if let Some(pl) = fs::read(e.path()).ok().and_then(|b| serde_json::from_slice::<crate::playlists::Playlist>(&b).ok()) {
                ids.extend(pl.track_ids);
            }
        }
    }
    let s = crate::settings::read_settings_public(&dir.to_path_buf());
    fn strings(v: &Value, out: &mut HashSet<String>) {
        match v {
            Value::String(x) => {
                out.insert(x.clone());
            }
            Value::Array(a) => a.iter().for_each(|x| strings(x, out)),
            Value::Object(m) => m.values().for_each(|x| strings(x, out)),
            _ => {}
        }
    }
    let mut refs = HashSet::new();
    for v in [serde_json::to_value(&s.events), serde_json::to_value(&s.campaigns), serde_json::to_value(&s.programs)].into_iter().flatten() {
        strings(&v, &mut refs);
    }
    ids.extend(refs);
    ids
}

/// Canciones ya bajadas: su análisis viene del maestro, así que se da por
/// hecho para este archivo (no se vuelve a analizar).
fn finish_tracks(sh: &Shared, ids: &[String]) {
    if ids.is_empty() {
        return;
    }
    {
        let _g = crate::library::lock_library();
        let mut lib = crate::library::read_library_internal(&sh.dir);
        let set: HashSet<&String> = ids.iter().collect();
        for t in lib.iter_mut().filter(|t| set.contains(&t.id)) {
            if t.lufs.is_some() {
                t.analysis_sig = crate::analysis::file_signature(Path::new(&t.file));
            }
        }
        let _ = crate::library::write_library(&sh.dir, &lib);
    }
    let _ = sh.app.emit("library://changed", ());
    let _ = sh.app.emit("cloud://library", ());
}

fn download_one(ag: &ureq::Agent, auth: &str, api: &str, hash: &str, path: &Path, sh: &Shared) -> Result<(), String> {
    let part = path.with_extension("part");
    let have = fs::metadata(&part).map(|m| m.len()).unwrap_or(0);
    let mut req = ag.get(&format!("{api}/v1/media/{hash}")).set("Authorization", auth);
    if have > 0 {
        req = req.set("Range", &format!("bytes={have}-"));
    }
    let resp = req.call().map_err(net_err)?;
    let append = have > 0 && resp.status() == 206;
    let mut out = if append {
        OpenOptions::new().append(true).open(&part).map_err(|e| e.to_string())?
    } else {
        File::create(&part).map_err(|e| e.to_string())?
    };
    let mut rd = resp.into_reader();
    let mut buf = vec![0u8; 256 * 1024];
    loop {
        let n = rd.read(&mut buf).map_err(|e| format!("Descarga cortada: {e}"))?;
        if n == 0 {
            break;
        }
        out.write_all(&buf[..n]).map_err(|e| e.to_string())?;
        set_status(sh, |s| s.dl_bytes += n as u64);
    }
    drop(out);
    let got = crate::cloudmedia::hash_file_pub(&part).map_err(|e| e.to_string())?;
    if got != hash {
        let _ = fs::remove_file(&part);
        return Err("El archivo bajado no coincide con su huella; se volverá a bajar".into());
    }
    fs::rename(&part, path).map_err(|e| e.to_string())
}

// ------------------------------------------------------------ comandos

fn shared() -> Result<Arc<Shared>, String> {
    SHARED.get().cloned().ok_or_else(|| "La sincronización aún no ha arrancado".to_string())
}

#[tauri::command]
pub fn cloud_sync_status() -> SyncStatus {
    shared().ok().and_then(|s| s.status.lock().ok().map(|g| g.clone())).unwrap_or_default()
}

#[tauri::command]
pub fn cloud_sync_set(state: State<'_, AppState>, enabled: bool, download: String) -> Result<SyncStatus, String> {
    let sh = shared()?;
    let download = if ["all", "needed", "none"].contains(&download.as_str()) { download } else { "needed".into() };
    let cfg = SyncCfg { enabled, download };
    fs::write(state.data_dir.join(CFG_FILE), serde_json::to_string_pretty(&cfg).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    if let Ok(mut c) = sh.cfg.lock() {
        *c = cfg.clone();
    }
    set_status(&sh, |s| {
        s.enabled = cfg.enabled;
        s.download = cfg.download.clone();
    });
    poke(&sh);
    Ok(cloud_sync_status())
}

/// El maestro avisa de cambios (WebSocket): pasada ya.
#[tauri::command]
pub fn cloud_sync_now() {
    if let Ok(sh) = shared() {
        poke(&sh);
    }
}

/// Al dejar el maestro se olvida lo sincronizado (otro maestro, de cero).
pub fn forget(dir: &Path) {
    let _ = fs::remove_file(dir.join(STATE_FILE));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn digest_ignores_key_order() {
        let a: Value = serde_json::from_str(r#"{"b":1,"a":{"y":[1,2],"x":"s"}}"#).unwrap();
        let b: Value = serde_json::from_str(r#"{"a":{"x":"s","y":[1,2]},"b":1}"#).unwrap();
        assert_eq!(digest(&a), digest(&b));
        assert_ne!(digest(&a), digest(&json!({"b":2})));
    }

    #[test]
    fn track_round_trip_keeps_digest() {
        let mdir = PathBuf::from("/datos/maestro-musica");
        let sha = "a".repeat(64);
        let t = Track { id: "t1".into(), title: "Hola".into(), file: format!("/musica/x.flac"), lufs: Some(-14.2), ..Default::default() };
        let mut hashes = HashMap::new();
        hashes.insert("/musica/x.flac".to_string(), (0u64, 0u64, sha.clone()));
        let v = track_value(&t, &mdir, &hashes);
        assert_eq!(v["media"], json!(sha));
        assert_eq!(v["ext"], json!("flac"));
        assert!(v.get("file").is_none());
        // Otro equipo: mismo contenido, archivo en la carpeta de la nube.
        let mut t2: Track = serde_json::from_value(v.clone()).unwrap();
        t2.file = mdir.join(format!("{sha}.flac")).to_string_lossy().into_owned();
        let v2 = track_value(&t2, &mdir, &HashMap::new());
        assert_eq!(digest(&v), digest(&v2));
    }
}
