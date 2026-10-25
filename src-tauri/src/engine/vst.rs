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
    /// Apagado = la señal pasa sin tocar
    pub enabled: bool,
}

/// Un plugin cargado.
pub struct Host {
    pub id: String,
    pub path: String,
    plugin: Arc<Mutex<Plugin>>,
    bufs: Mutex<AudioBuffers>,
}

impl Host {
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

enum Cmd {
    /// Deja cargadas exactamente estas ranuras; responde cuando estan listas.
    Ensure(Vec<PluginCfg>, Sender<Vec<String>>),
    Editor(String, Sender<Result<(), String>>),
    Scan(Sender<Vec<Found>>),
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
pub fn get(id: &str) -> Option<Arc<Host>> {
    control().hosts.lock().ok()?.get(id).cloned()
}

pub fn open_editor(id: &str) -> Result<(), String> {
    let (tx, rx) = mpsc::channel();
    control().tx.send(Cmd::Editor(id.to_string(), tx)).map_err(|_| "Los plugins VST no responden".to_string())?;
    rx.recv_timeout(Duration::from_secs(15)).unwrap_or_else(|_| Err("El editor del plugin no responde".into()))
}

pub fn scan() -> Vec<Found> {
    let (tx, rx) = mpsc::channel();
    if control().tx.send(Cmd::Scan(tx)).is_err() {
        return Vec::new();
    }
    rx.recv_timeout(Duration::from_secs(60)).unwrap_or_default()
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
    if let Ok(data) = p.save_state() {
        let _ = std::fs::write(file, data);
    }
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
    let mut vst = Vst3Host::builder().sample_rate(48_000.0).block_size(MAX_BLOCK).build().ok();
    loop {
        let has_windows = loaded.values().any(|l| l.window.is_some());
        let cmd = rx.recv_timeout(if has_windows { Duration::from_millis(15) } else { Duration::from_millis(500) });
        match cmd {
            Ok(Cmd::Ensure(slots, reply)) => {
                let mut errors = Vec::new();
                let wanted: HashMap<String, PluginCfg> = slots.into_iter().map(|s| (s.id.clone(), s)).collect();
                // Fuera lo que ya no esta (o cambio de archivo)
                let gone: Vec<String> = loaded
                    .iter()
                    .filter(|(id, l)| wanted.get(*id).map(|w| w.path != l.host.path).unwrap_or(true))
                    .map(|(id, _)| id.clone())
                    .collect();
                for id in gone {
                    if let Some(mut l) = loaded.remove(&id) {
                        if let Some(mut w) = l.window.take() {
                            w.close();
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
            Ok(Cmd::Editor(id, reply)) => {
                let res = match loaded.get_mut(&id) {
                    None => Err("El plugin no está cargado (¿motor nativo activo?)".to_string()),
                    Some(l) if l.window.is_some() => Ok(()),
                    Some(l) => {
                        let mut w = PluginWindow::new(l.host.plugin.clone());
                        w.open().map(|_| l.window = Some(w)).map_err(|e| format!("No se pudo abrir el editor: {e}"))
                    }
                };
                let _ = reply.send(res);
            }
            Ok(Cmd::Scan(reply)) => {
                let found = vst3_host::simple::discover_plugins()
                    .map(|list| {
                        list.into_iter()
                            .filter(|p| p.audio_outputs > 0)
                            .map(|p| Found {
                                name: p.name,
                                vendor: p.vendor,
                                category: p.category,
                                path: p.path.to_string_lossy().into_owned(),
                            })
                            .collect()
                    })
                    .unwrap_or_default();
                let _ = reply.send(found);
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => return,
        }
        // Ventanas: sus eventos y, al cerrarlas, se guarda el estado.
        for (id, l) in loaded.iter_mut() {
            let closed = match l.window.as_ref() {
                Some(w) => {
                    let _ = w.service_platform_events();
                    !w.is_open() || w.closed_by_user()
                }
                None => false,
            };
            if closed {
                if let Some(mut w) = l.window.take() {
                    w.close();
                }
                save_state(id, &l.host.plugin);
            }
        }
        graveyard.retain(|h| Arc::strong_count(h) > 1);
        // Copia de seguridad del estado cada minuto (por si se cierra la app).
        if last_save.elapsed() > Duration::from_secs(60) {
            last_save = Instant::now();
            for (id, l) in loaded.iter() {
                save_state(id, &l.host.plugin);
            }
        }
    }
}

fn load_one(vst: &mut Vst3Host, cfg: &PluginCfg) -> Result<Host, String> {
    if !Path::new(cfg.path.trim()).exists() {
        return Err("no se encuentra el archivo del plugin".into());
    }
    let mut plugin = vst.load_plugin(cfg.path.trim()).map_err(|e| e.to_string())?;
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
    Ok(Host { id: cfg.id.clone(), path: cfg.path.trim().to_string(), plugin: Arc::new(Mutex::new(plugin)), bufs: Mutex::new(bufs) })
}
