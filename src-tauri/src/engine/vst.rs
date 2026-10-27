//! Plugins VST3 en los canales y buses del motor nativo.
//!
//! VST3 exige que casi todo (cargar, estado, ventana del editor, descargar)
//! ocurra en un mismo hilo «de control». Aqui ese hilo es propio: recibe
//! ordenes por un canal y atiende las ventanas abiertas. El hilo de audio solo
//! procesa (process_audio), y si el plugin esta ocupado deja pasar la señal
//! tal cual: nunca espera.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use vst3_host::audio::AudioBuffers;
use vst3_host::plugin::Plugin;
use vst3_host::window::PluginWindow;
use vst3_host::Vst3Host;

use super::graph::MAX_BLOCK;

/// Un plugin en un canal o bus, tal como llega de los ajustes.
#[derive(Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct PluginCfg {
    /// Id unico de la ranura (guarda su estado aparte)
    pub id: String,
    /// Ruta del .vst3
    pub path: String,
    pub name: String,
    /// Apagado = la señal pasa sin tocar (bypass)
    pub enabled: bool,
    /// Desactivado: no se carga
    pub off: bool,
}

/// Un plugin cargado.
pub struct Host {
    pub id: String,
    pub path: String,
    pub name: String,
    plugin: Arc<Mutex<Plugin>>,
    bufs: Mutex<AudioBuffers>,
    /// Retardo que mete el plugin (muestras), segun el propio plugin
    latency: AtomicU32,
}

impl Host {
    /// Latencia que declara el plugin, en muestras (48 kHz).
    pub fn latency(&self) -> u32 {
        self.latency.load(Ordering::Relaxed)
    }

    /// Vuelve a leer la latencia (si el plugin no esta ocupado).
    fn refresh_latency(&self) {
        if let Ok(mut p) = self.plugin.try_lock() {
            let _ = p.take_restart_flags();
            self.latency.store(p.latency_samples(), Ordering::Relaxed);
        }
    }

    /// Procesa `frames` (estereo entrelazado) en el sitio. Si el plugin esta
    /// ocupado (el editor lo esta tocando) la señal sigue tal cual.
    pub fn process(&self, buf: &mut [f32], frames: usize) {
        let n = frames.min(MAX_BLOCK);
        let (Ok(mut p), Ok(mut b)) = (self.plugin.try_lock(), self.bufs.try_lock()) else { return };
        // Sin reservar memoria: la capacidad es MAX_BLOCK.
        for ch in b.inputs.iter_mut() {
            ch.resize(n, 0.0);
        }
        for ch in b.outputs.iter_mut() {
            ch.resize(n, 0.0);
        }
        if b.inputs.len() >= 2 {
            for (i, f) in buf[..n * 2].chunks_exact(2).enumerate() {
                b.inputs[0][i] = f[0];
                b.inputs[1][i] = f[1];
            }
        }
        if p.process_audio(&mut b).is_err() || b.outputs.len() < 2 {
            return;
        }
        for (i, f) in buf[..n * 2].chunks_exact_mut(2).enumerate() {
            let (l, r) = (b.outputs[0][i], b.outputs[1][i]);
            // Un plugin roto que devuelve NaN no debe llegar a la tarjeta.
            f[0] = if l.is_finite() { l } else { 0.0 };
            f[1] = if r.is_finite() { r } else { 0.0 };
        }
    }
}

/// Plugin encontrado en el equipo.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Found {
    pub name: String,
    pub vendor: String,
    pub category: String,
    pub path: String,
}

/// Carpeta donde se buscan plugins.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Folder {
    pub path: String,
    /// Carpeta habitual del sistema (las demas las añadio el usuario)
    pub standard: bool,
    pub exists: bool,
    /// Plugins encontrados dentro
    pub count: usize,
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct ScanResult {
    pub folders: Vec<Folder>,
    pub plugins: Vec<Found>,
}

/// Carpetas habituales de plugins VST3 del sistema.
pub fn standard_folders() -> Vec<PathBuf> {
    let mut v: Vec<PathBuf> = Vec::new();
    #[cfg(windows)]
    {
        if let Some(p) = std::env::var_os("CommonProgramFiles") {
            v.push(PathBuf::from(p).join("VST3"));
        }
        if let Some(p) = std::env::var_os("CommonProgramFiles(x86)") {
            v.push(PathBuf::from(p).join("VST3"));
        }
        v.push(PathBuf::from(r"C:\Program Files\Common Files\VST3"));
        if let Some(p) = std::env::var_os("LOCALAPPDATA") {
            v.push(PathBuf::from(p).join("Programs").join("Common").join("VST3"));
        }
    }
    #[cfg(target_os = "macos")]
    {
        v.push(PathBuf::from("/Library/Audio/Plug-Ins/VST3"));
        if let Some(h) = std::env::var_os("HOME") {
            v.push(PathBuf::from(h).join("Library/Audio/Plug-Ins/VST3"));
        }
    }
    #[cfg(target_os = "linux")]
    {
        v.push(PathBuf::from("/usr/lib/vst3"));
        v.push(PathBuf::from("/usr/local/lib/vst3"));
        if let Some(h) = std::env::var_os("HOME") {
            v.push(PathBuf::from(&h).join(".vst3"));
            // Quiosco: las carpetas compartidas «Plugins» y «Descargas»
            for name in ["Plugins", "Descargas"] {
                let d = PathBuf::from(&h).join(name);
                if d.is_dir() {
                    v.push(d);
                }
            }
        }
    }
    let mut seen = std::collections::HashSet::new();
    v.retain(|p| seen.insert(p.to_string_lossy().to_lowercase()));
    v
}

enum Cmd {
    /// Deja cargadas exactamente estas ranuras; responde cuando estan listas.
    Ensure(Vec<PluginCfg>, Sender<Vec<String>>),
    /// Abre el editor; si el plugin aun no esta cargado se carga ahora.
    Editor(PluginCfg, Sender<Result<(), String>>),
    Scan(Vec<String>, Sender<ScanResult>),
}

struct Control {
    tx: Sender<Cmd>,
    /// Plugins cargados por id de ranura (lo lee el motor al montar la mesa)
    hosts: Arc<Mutex<HashMap<String, Arc<Host>>>>,
}

static CONTROL: OnceLock<Control> = OnceLock::new();
static STATE_DIR: OnceLock<PathBuf> = OnceLock::new();

/// Carpeta donde se guarda el estado de cada ranura (se llama al arrancar).
pub fn set_state_dir(dir: PathBuf) {
    let _ = std::fs::create_dir_all(&dir);
    let _ = STATE_DIR.set(dir);
}

fn control() -> &'static Control {
    CONTROL.get_or_init(|| {
        let (tx, rx) = mpsc::channel();
        let hosts = Arc::new(Mutex::new(HashMap::new()));
        let h = hosts.clone();
        let _ = std::thread::Builder::new().name("miradio-vst".into()).spawn(move || control_loop(rx, h));
        Control { tx, hosts }
    })
}

/// Carga (o descarga) los plugins de la mesa. Espera a que esten listos;
/// devuelve los errores para avisar.
pub fn ensure(slots: Vec<PluginCfg>) -> Vec<String> {
    let (tx, rx) = mpsc::channel();
    if control().tx.send(Cmd::Ensure(slots, tx)).is_err() {
        return vec!["Los plugins VST no responden".into()];
    }
    rx.recv_timeout(Duration::from_secs(30)).unwrap_or_else(|_| vec!["Un plugin VST tarda demasiado en cargar".into()])
}

/// Plugin cargado de una ranura (sin esperar).
/// Latencia de cada plugin cargado (id de ranura -> muestras).
pub fn latencies() -> HashMap<String, u32> {
    control().hosts.lock().map(|m| m.iter().map(|(k, h)| (k.clone(), h.latency())).collect()).unwrap_or_default()
}

pub fn get(id: &str) -> Option<Arc<Host>> {
    control().hosts.lock().ok()?.get(id).cloned()
}

pub fn open_editor(cfg: PluginCfg) -> Result<(), String> {
    let (tx, rx) = mpsc::channel();
    control().tx.send(Cmd::Editor(cfg, tx)).map_err(|_| "Los plugins VST no responden".to_string())?;
    rx.recv_timeout(Duration::from_secs(15)).unwrap_or_else(|_| Err("El editor del plugin no responde".into()))
}

pub fn scan(extra: Vec<String>) -> ScanResult {
    let (tx, rx) = mpsc::channel();
    if control().tx.send(Cmd::Scan(extra, tx)).is_err() {
        return ScanResult::default();
    }
    rx.recv_timeout(Duration::from_secs(120)).unwrap_or_default()
}

/// Miga para el registro de cierres: qué se hace con qué plugin.
fn crumb(what: &str, name: &str, path: &str) {
    let shown = if name.trim().is_empty() {
        Path::new(split_class(path).0).file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| path.to_string())
    } else {
        name.trim().to_string()
    };
    crate::crashlog::crumb(Some(&format!("{what} el plugin «{shown}» ({})", split_class(path).0)));
}

fn crumb_done() {
    crate::crashlog::crumb(None);
}

fn state_file(id: &str) -> Option<PathBuf> {
    let safe: String = id.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_').collect();
    if safe.is_empty() {
        return None;
    }
    Some(STATE_DIR.get()?.join(format!("{safe}.vststate")))
}

fn save_state(id: &str, plugin: &Arc<Mutex<Plugin>>) {
    let Some(file) = state_file(id) else { return };
    let Ok(p) = plugin.lock() else { return };
    crate::crashlog::crumb(Some(&format!("guardando el estado de un plugin (ranura {id})")));
    if let Ok(data) = p.save_state() {
        let _ = std::fs::write(file, data);
    }
    crumb_done();
}

struct Loaded {
    host: Arc<Host>,
    window: Option<PluginWindow>,
}

fn control_loop(rx: Receiver<Cmd>, hosts: Arc<Mutex<HashMap<String, Arc<Host>>>>) {
    let mut loaded: HashMap<String, Loaded> = HashMap::new();
    // Plugins quitados que el audio aun puede estar usando: se sueltan cuando
    // nadie mas los tiene (siempre en este hilo, como pide VST3).
    let mut graveyard: Vec<Arc<Host>> = Vec::new();
    let mut last_save = Instant::now();
    let mut last_latency = Instant::now();
    let mut vst = Vst3Host::builder().sample_rate(48_000.0).block_size(MAX_BLOCK).build().ok();
    loop {
        let has_windows = loaded.values().any(|l| l.window.is_some());
        let cmd = rx.recv_timeout(if has_windows { Duration::from_millis(15) } else { Duration::from_millis(500) });
        match cmd {
            Ok(Cmd::Ensure(slots, reply)) => {
                let mut errors = Vec::new();
                let wanted: HashMap<String, PluginCfg> = slots.into_iter().filter(|s| !s.off).map(|s| (s.id.clone(), s)).collect();
                // Fuera lo que ya no esta (o cambio de archivo)
                let gone: Vec<String> = loaded
                    .iter()
                    .filter(|(id, l)| wanted.get(*id).map(|w| w.path != l.host.path).unwrap_or(true))
                    .map(|(id, _)| id.clone())
                    .collect();
                for id in gone {
                    if let Some(mut l) = loaded.remove(&id) {
                        if let Some(mut w) = l.window.take() {
                            crumb("cerrando la ventana de", &l.host.name, &l.host.path);
                            w.close();
                            crumb_done();
                        }
                        save_state(&id, &l.host.plugin);
                        if let Ok(mut map) = hosts.lock() {
                            map.remove(&id);
                        }
                        graveyard.push(l.host);
                    }
                }
                for (id, cfg) in wanted {
                    if loaded.contains_key(&id) || cfg.path.trim().is_empty() {
                        continue;
                    }
                    let Some(host) = vst.as_mut() else {
                        errors.push("No se pudo iniciar el anfitrión VST3".into());
                        break;
                    };
                    match load_one(host, &cfg) {
                        Ok(h) => {
                            let h = Arc::new(h);
                            if let Ok(mut map) = hosts.lock() {
                                map.insert(id.clone(), h.clone());
                            }
                            loaded.insert(id, Loaded { host: h, window: None });
                        }
                        Err(e) => errors.push(format!("{}: {e}", if cfg.name.is_empty() { &cfg.path } else { &cfg.name })),
                    }
                }
                let _ = reply.send(errors);
            }
            Ok(Cmd::Editor(cfg, reply)) => {
                // Si aun no esta cargado (motor web, o recien añadido) se carga ahora.
                if !loaded.contains_key(&cfg.id) {
                    match vst.as_mut() {
                        None => {
                            let _ = reply.send(Err("No se pudo iniciar el anfitrión VST3".into()));
                            continue;
                        }
                        Some(host) => match load_one(host, &cfg) {
                            Ok(h) => {
                                let h = Arc::new(h);
                                if let Ok(mut map) = hosts.lock() {
                                    map.insert(cfg.id.clone(), h.clone());
                                }
                                loaded.insert(cfg.id.clone(), Loaded { host: h, window: None });
                            }
                            Err(e) => {
                                let _ = reply.send(Err(format!("No se pudo cargar el plugin: {e}")));
                                continue;
                            }
                        },
                    }
                }
                let res = match loaded.get_mut(&cfg.id) {
                    None => Err("El plugin no está cargado".to_string()),
                    Some(l) if l.window.as_ref().map(|w| w.is_open()).unwrap_or(false) => {
                        raise_editor(&l.host);
                        Ok(())
                    }
                    Some(l) => {
                        crumb("abriendo la ventana de", &l.host.name, &l.host.path);
                        let mut w = PluginWindow::new(l.host.plugin.clone());
                        let r = w.open().map(|_| l.window = Some(w)).map_err(|e| format!("No se pudo abrir el editor: {e}"));
                        if r.is_ok() {
                            pump_messages();
                            raise_editor(&l.host);
                        }
                        crumb_done();
                        r
                    }
                };
                let _ = reply.send(res);
            }
            Ok(Cmd::Scan(extra, reply)) => {
                let std_dirs = standard_folders();
                let mut dirs: Vec<(PathBuf, bool)> = std_dirs.iter().map(|p| (p.clone(), true)).collect();
                for e in extra {
                    let p = PathBuf::from(e.trim());
                    if !e.trim().is_empty() && !dirs.iter().any(|(d, _)| d.to_string_lossy().eq_ignore_ascii_case(&p.to_string_lossy())) {
                        dirs.push((p, false));
                    }
                }
                let mut plugins: Vec<Found> = Vec::new();
                let mut folders = Vec::new();
                for (dir, standard) in &dirs {
                    let exists = dir.is_dir();
                    let mut count = 0;
                    if exists {
                        if let Ok(list) = vst3_host::Vst3Host::builder().add_scan_path(dir).build().and_then(|mut h| h.discover_plugins()) {
                            for p in list.into_iter().filter(|p| p.audio_outputs > 0) {
                                let bundle = p.path.to_string_lossy().into_owned();
                                // Un .vst3 puede traer muchos plugins (LSP trae ~200 en
                                // uno): se ofrece cada uno, con su clase en la ruta.
                                let classes: Vec<(String, String)> = vst3_host::discovery::get_detailed_plugin_info(&p.path)
                                    .map(|d| {
                                        d.classes
                                            .into_iter()
                                            .filter(|c| c.category.contains("Audio Module Class"))
                                            .map(|c| (c.name, c.class_id))
                                            .collect()
                                    })
                                    .unwrap_or_default();
                                let entries: Vec<(String, String)> = if classes.len() > 1 {
                                    classes.into_iter().map(|(name, cid)| (name, format!("{bundle}#{cid}"))).collect()
                                } else {
                                    vec![(p.name.clone(), bundle.clone())]
                                };
                                for (name, path) in entries {
                                    if plugins.iter().any(|f| f.path.eq_ignore_ascii_case(&path)) {
                                        continue;
                                    }
                                    count += 1;
                                    plugins.push(Found { name, vendor: p.vendor.clone(), category: p.category.clone(), path });
                                }
                            }
                        }
                    }
                    folders.push(Folder { path: dir.to_string_lossy().into_owned(), standard: *standard, exists, count });
                }
                plugins.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
                let _ = reply.send(ScanResult { folders, plugins });
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => return,
        }
        // En Windows las ventanas de los editores viven en este hilo: sin
        // atender sus mensajes no se pintan ni responden.
        pump_messages();
        // Ventanas: sus eventos y, al cerrarlas, se guarda el estado.
        for (id, l) in loaded.iter_mut() {
            let closed = match l.window.as_ref() {
                Some(w) => {
                    let _ = w.service_platform_events();
                    // Linux: los editores (VSTGUI, LSP…) solo se pintan y
                    // responden si el anfitrión atiende sus temporizadores y
                    // eventos de X11 cada poco. Sin esto se quedan colgados.
                    if let Ok(mut p) = l.host.plugin.try_lock() {
                        p.service_run_loop();
                    }
                    !w.is_open() || w.closed_by_user()
                }
                None => false,
            };
            if closed {
                if let Some(mut w) = l.window.take() {
                    crumb("cerrando la ventana de", &l.host.name, &l.host.path);
                    w.close();
                    crumb_done();
                }
                save_state(id, &l.host.plugin);
            }
        }
        // Se sueltan los que ya nadie usa (descargar el plugin)
        let mut i = 0;
        while i < graveyard.len() {
            if Arc::strong_count(&graveyard[i]) > 1 {
                i += 1;
                continue;
            }
            let h = graveyard.swap_remove(i);
            crumb("quitando", &h.name, &h.path);
            drop(h);
            crumb_done();
        }
        // La latencia cambia si se toca algo en el plugin (oversampling, lookahead…).
        if last_latency.elapsed() > Duration::from_secs(2) {
            last_latency = Instant::now();
            for l in loaded.values() {
                l.host.refresh_latency();
            }
        }
        // Copia de seguridad del estado cada minuto (por si se cierra la app).
        if last_save.elapsed() > Duration::from_secs(60) {
            last_save = Instant::now();
            for (id, l) in loaded.iter() {
                save_state(id, &l.host.plugin);
            }
        }
    }
}

/// Pone la ventana del editor delante de todo (y encima de OmniCaster).
#[cfg(windows)]
fn raise_editor(host: &Host) {
    #[link(name = "user32")]
    extern "system" {
        fn FindWindowW(class: *const u16, title: *const u16) -> isize;
        fn SetWindowPos(hwnd: isize, after: isize, x: i32, y: i32, cx: i32, cy: i32, flags: u32) -> i32;
        fn SetForegroundWindow(hwnd: isize) -> i32;
        fn ShowWindow(hwnd: isize, cmd: i32) -> i32;
        fn IsIconic(hwnd: isize) -> i32;
    }
    let name = match host.plugin.lock() {
        Ok(p) => p.info().name.clone(),
        Err(_) => return,
    };
    let wide = |s: &str| s.encode_utf16().chain(std::iter::once(0)).collect::<Vec<u16>>();
    let class = wide("VST3PluginWindow");
    let title = wide(&format!("{name} - VST3"));
    unsafe {
        let hwnd = FindWindowW(class.as_ptr(), title.as_ptr());
        if hwnd == 0 {
            return;
        }
        if IsIconic(hwnd) != 0 {
            ShowWindow(hwnd, 9); // SW_RESTORE
        }
        // HWND_TOPMOST; SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW
        SetWindowPos(hwnd, -1, 0, 0, 0, 0, 0x0002 | 0x0001 | 0x0040);
        SetForegroundWindow(hwnd);
    }
}

#[cfg(not(windows))]
fn raise_editor(_host: &Host) {}

#[cfg(windows)]
fn pump_messages() {
    #[repr(C)]
    struct Msg {
        hwnd: isize,
        message: u32,
        wparam: usize,
        lparam: isize,
        time: u32,
        pt_x: i32,
        pt_y: i32,
        private: u32,
    }
    #[link(name = "user32")]
    extern "system" {
        fn PeekMessageW(msg: *mut Msg, hwnd: isize, min: u32, max: u32, remove: u32) -> i32;
        fn TranslateMessage(msg: *const Msg) -> i32;
        fn DispatchMessageW(msg: *const Msg) -> isize;
    }
    const PM_REMOVE: u32 = 1;
    let mut msg: Msg = unsafe { std::mem::zeroed() };
    // Se limita por vuelta para no monopolizar el hilo.
    for _ in 0..200 {
        unsafe {
            if PeekMessageW(&mut msg, 0, 0, 0, PM_REMOVE) == 0 {
                break;
            }
            TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
    }
}

#[cfg(not(windows))]
fn pump_messages() {}

/// "ruta.vst3#<clase>" -> (ruta, clase): un plugin concreto de un .vst3 que trae varios.
pub fn split_class(path: &str) -> (&str, Option<&str>) {
    if let Some((bundle, cid)) = path.rsplit_once('#') {
        if cid.len() == 32 && cid.chars().all(|c| c.is_ascii_hexdigit()) {
            return (bundle, Some(cid));
        }
    }
    (path, None)
}

fn load_one(vst: &mut Vst3Host, cfg: &PluginCfg) -> Result<Host, String> {
    crumb("cargando", &cfg.name, &cfg.path);
    let r = load_one_inner(vst, cfg);
    crumb_done();
    r
}

fn load_one_inner(vst: &mut Vst3Host, cfg: &PluginCfg) -> Result<Host, String> {
    let (bundle, class) = split_class(cfg.path.trim());
    if !Path::new(bundle).exists() {
        return Err("no se encuentra el archivo del plugin".into());
    }
    let mut plugin = match class {
        Some(cid) => vst.load_plugin_class(bundle, cid),
        None => vst.load_plugin(bundle),
    }
    .map_err(|e| e.to_string())?;
    if let Some(file) = state_file(&cfg.id) {
        if let Ok(data) = std::fs::read(file) {
            let _ = plugin.load_state(&data);
        }
    }
    plugin.start_processing().map_err(|e| e.to_string())?;
    let mut bufs = AudioBuffers::new(2, 2, MAX_BLOCK, 48_000.0);
    for ch in bufs.inputs.iter_mut() {
        ch.reserve_exact(MAX_BLOCK);
    }
    for ch in bufs.outputs.iter_mut() {
        ch.reserve_exact(MAX_BLOCK);
    }
    let latency = AtomicU32::new(plugin.latency_samples());
    Ok(Host { id: cfg.id.clone(), path: cfg.path.trim().to_string(), name: cfg.name.clone(), plugin: Arc::new(Mutex::new(plugin)), bufs: Mutex::new(bufs), latency })
}

#[cfg(test)]
mod class_tests {
    #[test]
    fn split_class_path() {
        let cid = "0123456789ABCDEF0123456789abcdef";
        assert_eq!(super::split_class(&format!("/usr/lib/vst3/lsp-plugins.vst3#{cid}")), ("/usr/lib/vst3/lsp-plugins.vst3", Some(cid)));
        assert_eq!(super::split_class("C:\\VST3\\Dragonfly.vst3"), ("C:\\VST3\\Dragonfly.vst3", None));
        assert_eq!(super::split_class("/x/a#b.vst3"), ("/x/a#b.vst3", None));
    }
}
