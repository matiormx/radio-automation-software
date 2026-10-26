//! Motor de audio nativo (beta): reproduccion, mesa y tarjetas en Rust.
//!
//! La interfaz manda ordenes con `engine_cmd` y recibe el estado por el
//! evento `engine://state` (posicion, indice, fin, avisos y VU) ~30 veces/s.

pub mod core;
pub mod dsp;
pub mod vst;
pub mod graph;
pub mod io;
pub mod live;
pub mod loader;
pub mod pcm;
pub mod player;
pub mod resamp;
pub mod voices;

#[cfg(test)]
mod tests;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};

use self::graph::{MixConfig, Plan};
use self::io::{lock, Io, SharedRef, ENGINE_RATE};
use self::loader::DecodeCache;
use self::player::{Event, Player, TrackInfo};
use self::voices::Voice;
use crate::streaming::StreamingState;

struct Ctl {
    player: Player,
    loader: DecodeCache,
}

pub struct Engine {
    shared: SharedRef,
    ctl: Arc<Mutex<Ctl>>,
    io: Arc<Io>,
    stop: Arc<AtomicBool>,
    meters: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
    app: AppHandle,
    /// Lector del audio en directo (para pararlo)
    live_stop: Mutex<Option<Arc<AtomicBool>>>,
    /// Anillos del audio que manda el WebView (preescucha, llamadas)
    app_feeds: Mutex<std::collections::HashMap<String, (u32, rtrb::Producer<f32>)>>,
    /// Lector del retorno a los oyentes (mix-minus)
    ret_cons: Mutex<rtrb::Consumer<f32>>,
    /// Ya se han usado plugins VST (para descargarlos si se quitan todos)
    vst_used: AtomicBool,
}

impl Drop for Engine {
    fn drop(&mut self) {
        if let Some(s) = self.live_stop.lock().ok().and_then(|mut g| g.take()) {
            s.store(true, Ordering::SeqCst);
        }
        self.stop.store(true, Ordering::SeqCst);
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

#[derive(Default)]
pub struct EngineState(Mutex<Option<Engine>>);

#[derive(Serialize, Clone)]
#[serde(tag = "type", rename_all = "camelCase")]
enum OutEvent {
    Tick { pos: f64, total: f64 },
    Index { index: i64 },
    Ended,
    Diag { message: String },
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct StatePayload {
    events: Vec<OutEvent>,
    index: i64,
    playing: bool,
    paused: bool,
    level: f32,
    db: f32,
    level_l: f32,
    level_r: f32,
    db_l: f32,
    db_r: f32,
    stream_level: f32,
    stream_db: f32,
    stream_level_l: f32,
    stream_level_r: f32,
    stream_db_l: f32,
    stream_db_r: f32,
}

#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum Op {
    SetPlaylist { tracks: Vec<TrackInfo> },
    PlayAt { index: usize },
    Prepare { index: usize, pos: f64 },
    RestoreAt { index: usize, pos: f64, autoplay: bool },
    Toggle,
    Pause,
    Stop,
    Next,
    Prev,
    Seek { secs: f64 },
    Options { fade_seconds: f64, loop_playlist: bool, silence_skip: bool, silence_threshold_db: f64 },
    Volume { value: f32 },
    Mixer { config: MixConfig },
    /// Activa el envio de medidores por tira (ventana Mixer abierta)
    Meters { on: bool },
    /// Fader en vivo mientras se arrastra ("ch:<id>" o "bus:<id>")
    LiveGain { key: String, db: f64 },
    /// Pausa con fundido (entra un evento en directo)
    FadePause { secs: f64 },
    /// Audio de internet en directo, con fundido de entrada
    LiveStart { url: String, fade_in: f64 },
    /// Termina el directo con fundido de salida
    LiveStop { fade_out: f64 },
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct LiveEvent {
    state: &'static str,
    message: String,
}

#[derive(Serialize, Clone)]
struct StripMeter {
    key: String,
    l: f32,
    r: f32,
}

fn lock_ctl(ctl: &Arc<Mutex<Ctl>>) -> std::sync::MutexGuard<'_, Ctl> {
    ctl.lock().unwrap_or_else(|e| e.into_inner())
}

impl Engine {
    fn start(app: AppHandle) -> Engine {
        if let Ok(dir) = app.path().app_data_dir() {
            vst::set_state_dir(dir.join("vst"));
        }
        let shared = io::new_shared();
        let (ret_prod, ret_cons) = rtrb::RingBuffer::<f32>::new(ENGINE_RATE as usize * 2);
        lock(&shared).ret_tap = Some(ret_prod);
        let sink = app.state::<StreamingState>().sink();
        let io = Arc::new(Io::start(shared.clone(), Box::new(move |pcm: &[u8]| sink.push(pcm))));
        let ctl = Arc::new(Mutex::new(Ctl { player: Player::default(), loader: DecodeCache::new(ENGINE_RATE) }));
        let stop = Arc::new(AtomicBool::new(false));
        let meters = Arc::new(AtomicBool::new(false));
        let thread = {
            let (shared, ctl, io, stop, meters, app) = (shared.clone(), ctl.clone(), io.clone(), stop.clone(), meters.clone(), app.clone());
            std::thread::Builder::new()
                .name("miradio-engine".into())
                .spawn(move || control_loop(app, shared, ctl, io, stop, meters))
                .ok()
        };
        Engine { shared, ctl, io, stop, meters, thread, app, live_stop: Mutex::new(None), app_feeds: Mutex::new(Default::default()), ret_cons: Mutex::new(ret_cons), vst_used: AtomicBool::new(false) }
    }

    fn apply(&self, op: Op) {
        let mut ctl = lock_ctl(&self.ctl);
        let Ctl { player, loader } = &mut *ctl;
        match op {
            Op::Mixer { config } => {
                // Los plugins VST se cargan antes, fuera del candado del audio.
                let slots: Vec<vst::PluginCfg> = config
                    .mixer_channels
                    .iter()
                    .flat_map(|c| c.plugins.iter())
                    .chain(config.mixer_buses.iter().flat_map(|b| b.plugins.iter()))
                    .filter(|p| !p.id.is_empty())
                    .cloned()
                    .collect();
                if !slots.is_empty() || self.vst_used.swap(!slots.is_empty(), Ordering::SeqCst) {
                    for e in vst::ensure(slots) {
                        self.io.errors.lock().unwrap_or_else(|x| x.into_inner()).push(format!("VST: {e}"));
                    }
                }
                let old = {
                    let mut g = lock(&self.shared);
                    let vol = g.core.volume();
                    let plan = Plan::build(&config, vol, Some(&g.core.plan));
                    let devices: Vec<String> = plan.outs.iter().filter(|o| o.device != graph::NONE_DEVICE).map(|o| o.device.clone()).collect();
                    let (sends, returns) = plan.insert_devices();
                    self.io.set_route(devices, sends, returns);
                    g.core.swap_plan(plan)
                };
                drop(old);
            }
            Op::Volume { value } => lock(&self.shared).core.set_volume(value),
            Op::Meters { on } => self.meters.store(on, Ordering::SeqCst),
            Op::LiveGain { key, db } => lock(&self.shared).core.plan.live_gain(&key, db),
            Op::Options { fade_seconds, loop_playlist, silence_skip, silence_threshold_db } => {
                player.fade_seconds = fade_seconds.clamp(0.0, 30.0);
                player.loop_playlist = loop_playlist;
                player.silence_skip = silence_skip;
                player.silence_threshold_db = silence_threshold_db.clamp(-90.0, -10.0);
            }
            Op::SetPlaylist { tracks } => player.set_playlist(tracks, loader),
            Op::LiveStart { url, fade_in } => {
                drop(ctl);
                self.live_start(url, fade_in);
            }
            Op::LiveStop { fade_out } => {
                drop(ctl);
                self.live_stop(fade_out);
            }
            op => {
                let mut g = lock(&self.shared);
                let core = &mut g.core.play;
                match op {
                    Op::PlayAt { index } => player.play_at(index, core, loader),
                    Op::Prepare { index, pos } => player.prepare(index, pos, core, loader),
                    Op::RestoreAt { index, pos, autoplay } => player.restore_at(index, pos, autoplay, core, loader),
                    Op::Toggle => player.toggle(core, loader),
                    Op::Pause => player.pause(core),
                    Op::FadePause { secs } => player.fade_pause(secs, core),
                    Op::Stop => player.stop(core),
                    Op::Next => player.next(core, loader),
                    Op::Prev => player.prev(core, loader),
                    Op::Seek { secs } => player.seek(secs, core, loader),
                    _ => {}
                }
            }
        }
    }
}

impl Engine {
    fn live_start(&self, url: String, fade_in: f64) {
        self.live_stop(0.05);
        let ffmpeg = match crate::netstream::ffmpeg_or_err(&self.app) {
            Ok(f) => f,
            Err(e) => {
                let _ = self.app.emit("engine://live", LiveEvent { state: "error", message: e });
                return;
            }
        };
        let (mut live, mut prod) = live::LiveIn::new(ENGINE_RATE, 8.0, 0.6);
        let stop = Arc::new(AtomicBool::new(false));
        {
            let mut g = lock(&self.shared);
            let now = g.core.play.now;
            let f = g.core.play.frames(fade_in.max(0.02));
            live.gain.schedule(now, 0.0, now + f, 1.0);
            let old = g.core.play.live.replace(live);
            drop(g);
            drop(old);
        }
        if let Ok(mut g) = self.live_stop.lock() {
            *g = Some(stop.clone());
        }
        let app = self.app.clone();
        let _ = std::thread::Builder::new().name("miradio-live".into()).spawn(move || {
            let (mut child, out) = match crate::netstream::spawn(&ffmpeg, &url, ENGINE_RATE) {
                Ok(x) => x,
                Err(e) => {
                    let _ = app.emit("engine://live", LiveEvent { state: "error", message: e });
                    return;
                }
            };
            let _ = app.emit("engine://live", LiveEvent { state: "started", message: String::new() });
            let mut got = false;
            crate::netstream::pump(out, stop.clone(), |s| {
                got = got || !s.is_empty();
                live::push_blocking(&mut prod, s, &stop)
            });
            let _ = child.kill();
            let _ = child.wait();
            if !stop.load(Ordering::SeqCst) {
                let message = if got { "La emisión de internet se ha cortado".to_string() } else { "No se pudo abrir la emisión de internet".to_string() };
                let _ = app.emit("engine://live", LiveEvent { state: "error", message });
            }
        });
    }

    fn live_stop(&self, fade_out: f64) {
        if let Some(s) = self.live_stop.lock().ok().and_then(|mut g| g.take()) {
            // El lector se para al terminar el fundido (se quita en control_loop).
            let mut g = lock(&self.shared);
            let now = g.core.play.now;
            let f = g.core.play.frames(fade_out.max(0.02));
            if let Some(l) = g.core.play.live.as_mut() {
                l.gain.ramp(now, 0.0, f);
                l.stop_at = Some(now + f);
            }
            drop(g);
            let _ = std::thread::Builder::new().spawn(move || {
                std::thread::sleep(Duration::from_secs_f64(fade_out.max(0.02) + 0.2));
                s.store(true, Ordering::SeqCst);
            });
        }
    }
}

fn control_loop(
    app: AppHandle,
    shared: SharedRef,
    ctl: Arc<Mutex<Ctl>>,
    io: Arc<Io>,
    stop: Arc<AtomicBool>,
    meters_on: Arc<AtomicBool>,
) {
    let mut spare: Vec<Voice> = Vec::with_capacity(16);
    let mut last_emit = std::time::Instant::now();
    let mut pending_events: Vec<OutEvent> = Vec::new();
    while !stop.load(Ordering::SeqCst) {
        std::thread::sleep(Duration::from_millis(15));
        let mut strips: Option<Vec<(String, f32, f32)>> = None;
        let (events, index, playing, paused, level, db, lr, slevel, sdb, slr) = {
            let mut c = lock_ctl(&ctl);
            let Ctl { player, loader } = &mut *c;
            let mut g = lock(&shared);
            player.tick(&mut g.core.play, loader);
            // Las voces terminadas se liberan aqui, fuera del hilo de audio.
            std::mem::swap(&mut g.core.play.voices.dead, &mut spare);
            let now = g.core.play.now;
            let ended_live = if g.core.play.live.as_ref().map(|l| l.finished(now)).unwrap_or(false) { g.core.play.live.take() } else { None };
            let (level, db) = g.core.monitor_level();
            let lr = g.core.monitor_level_lr();
            let (slevel, sdb) = g.core.stream_level();
            let slr = g.core.stream_level_lr();
            let playing = player.is_playing(&g.core.play);
            if meters_on.load(Ordering::Relaxed) && last_emit.elapsed() >= Duration::from_millis(33) {
                let mut list = g.core.plan.take_meters();
                let (l, r) = (g.core.monitor_peak_l, g.core.monitor_peak_r);
                list.push(("master".to_string(), l, r));
                strips = Some(list);
            }
            drop(g);
            drop(ended_live); // libera el buffer y deja que el lector termine
            (player.drain_events(), player.index(), playing, player.is_paused(), level, db, lr, slevel, sdb, slr)
        };
        spare.clear();
        for e in events {
            pending_events.push(match e {
                Event::Tick { pos, total } => OutEvent::Tick { pos, total },
                Event::Index(index) => OutEvent::Index { index },
                Event::Ended => OutEvent::Ended,
                Event::Diag(message) => OutEvent::Diag { message },
            });
        }
        for message in io.take_errors() {
            pending_events.push(OutEvent::Diag { message });
        }
        // ~30 actualizaciones por segundo; los ticks intermedios sobran.
        if last_emit.elapsed() >= Duration::from_millis(33) || pending_events.iter().any(|e| !matches!(e, OutEvent::Tick { .. })) {
            let mut out: Vec<OutEvent> = Vec::new();
            let mut last_tick = None;
            for e in pending_events.drain(..) {
                match e {
                    OutEvent::Tick { .. } => last_tick = Some(e),
                    other => {
                        if let Some(t) = last_tick.take() {
                            out.push(t);
                        }
                        out.push(other);
                    }
                }
            }
            if let Some(t) = last_tick {
                out.push(t);
            }
            let ((level_l, db_l), (level_r, db_r)) = lr;
            let ((stream_level_l, stream_db_l), (stream_level_r, stream_db_r)) = slr;
            let _ = app.emit("engine://state", StatePayload {
                events: out,
                index,
                playing,
                paused,
                level,
                db,
                level_l,
                level_r,
                db_l,
                db_r,
                stream_level: slevel,
                stream_db: sdb,
                stream_level_l,
                stream_level_r,
                stream_db_l,
                stream_db_r,
            });
            if let Some(list) = strips.take() {
                let list: Vec<StripMeter> = list.into_iter().map(|(key, l, r)| StripMeter { key, l, r }).collect();
                let _ = app.emit("engine://meters", list);
            }
            last_emit = std::time::Instant::now();
        }
    }
}

#[tauri::command]
pub fn engine_start(app: AppHandle, state: State<'_, EngineState>) -> Result<(), String> {
    let mut g = state.0.lock().map_err(|_| "El motor no responde".to_string())?;
    if g.is_none() {
        *g = Some(Engine::start(app.clone()));
    }
    Ok(())
}

#[tauri::command]
pub fn engine_stop(state: State<'_, EngineState>) -> Result<(), String> {
    let engine = state.0.lock().map_err(|_| "El motor no responde".to_string())?.take();
    drop(engine);
    Ok(())
}

#[tauri::command]
pub fn engine_cmd(state: State<'_, EngineState>, op: Op) -> Result<(), String> {
    let g = state.0.lock().map_err(|_| "El motor no responde".to_string())?;
    let engine = g.as_ref().ok_or_else(|| "El motor nativo no está en marcha".to_string())?;
    engine.apply(op);
    Ok(())
}

#[tauri::command]
pub fn engine_devices() -> Vec<String> {
    io::list_outputs()
}

impl Engine {
    /// Audio s16le estereo que manda el WebView (preescucha o llamadas) a su
    /// frecuencia; el motor lo remuestrea y absorbe la deriva de reloj.
    fn feed(&self, src: &str, rate: u32, data: &[u8]) {
        let key = format!("app:{src}");
        let mut feeds = self.app_feeds.lock().unwrap_or_else(|e| e.into_inner());
        let fresh = feeds.get(&key).map(|(r, _)| *r != rate).unwrap_or(true);
        if fresh {
            let (prod, cons) = rtrb::RingBuffer::<f32>::new((rate.max(8000) as usize) * 2);
            let mut g = lock(&self.shared);
            g.apps.retain(|a| a.device != key);
            g.apps.push(io::InsertReturn::new(key.clone(), cons, rate));
            drop(g);
            feeds.insert(key.clone(), (rate, prod));
        }
        if let Some((_, prod)) = feeds.get_mut(&key) {
            for c in data.chunks_exact(2) {
                let v = i16::from_le_bytes([c[0], c[1]]) as f32 / 32768.0;
                let _ = prod.push(v);
            }
        }
    }
}

/// Retorno para los oyentes de las llamadas: f32 LE estereo a 48 kHz.
/// Si se acumula demasiado (nadie lo leia), se queda con lo ultimo.
#[tauri::command]
pub fn engine_return_pcm(state: State<'_, EngineState>) -> tauri::ipc::Response {
    let mut out: Vec<u8> = Vec::new();
    if let Ok(g) = state.0.lock() {
        if let Some(engine) = g.as_ref() {
            let mut cons = engine.ret_cons.lock().unwrap_or_else(|e| e.into_inner());
            let keep = (ENGINE_RATE as usize / 10) * 2; // 100 ms
            let avail = cons.slots();
            for _ in 0..avail.saturating_sub(keep) / 2 * 2 {
                let _ = cons.pop();
            }
            out.reserve(cons.slots() * 4);
            while let Ok(v) = cons.pop() {
                out.extend_from_slice(&v.to_le_bytes());
            }
        }
    }
    tauri::ipc::Response::new(out)
}

/// Plugins VST3 instalados en el equipo (rutas estandar).
#[tauri::command]
pub async fn vst_scan(state: State<'_, crate::AppState>) -> Result<vst::ScanResult, String> {
    let extra = crate::settings::read_settings_public(&state.data_dir).vst.extra_folders;
    tauri::async_runtime::spawn_blocking(move || vst::scan(extra)).await.map_err(|e| e.to_string())
}

/// Latencia (muestras a 48 kHz) de cada plugin cargado, por id de ranura.
#[tauri::command]
pub fn vst_latencies() -> std::collections::HashMap<String, u32> {
    vst::latencies()
}

/// Abre la ventana del plugin de una ranura (lo carga si hace falta).
#[tauri::command]
pub async fn vst_editor(slot: String, path: String, name: String) -> Result<(), String> {
    let cfg = vst::PluginCfg { id: slot, path, name, enabled: true, off: false };
    tauri::async_runtime::spawn_blocking(move || vst::open_editor(cfg)).await.map_err(|e| e.to_string())?
}

/// Preescucha y llamadas del WebView hacia el motor nativo.
#[tauri::command]
pub fn engine_feed(state: State<'_, EngineState>, src: String, rate: u32, data: Vec<u8>) -> Result<(), String> {
    if src != "preview" && src != "call" {
        return Err("Fuente desconocida".into());
    }
    let g = state.0.lock().map_err(|_| "El motor no responde".to_string())?;
    if let Some(engine) = g.as_ref() {
        engine.feed(&src, rate, &data);
    }
    Ok(())
}

/// Entradas del equipo (para elegir el retorno de un insert).
#[tauri::command]
pub fn engine_inputs() -> Vec<String> {
    io::list_inputs()
}

#[cfg(test)]
mod contract_tests {
    use super::*;

    fn op(j: &str) -> Op {
        serde_json::from_str(j).unwrap_or_else(|e| panic!("{j}: {e}"))
    }

    /// Las ordenes tal como las manda nativeEngine.ts.
    #[test]
    fn ops_from_js() {
        assert!(matches!(op(r#"{"op":"playAt","index":3}"#), Op::PlayAt { index: 3 }));
        assert!(matches!(op(r#"{"op":"restoreAt","index":1,"pos":12.5,"autoplay":true}"#), Op::RestoreAt { index: 1, autoplay: true, .. }));
        assert!(matches!(op(r#"{"op":"seek","secs":30}"#), Op::Seek { .. }));
        assert!(matches!(op(r#"{"op":"toggle"}"#), Op::Toggle));
        assert!(matches!(op(r#"{"op":"volume","value":0.8}"#), Op::Volume { .. }));
        assert!(matches!(
            op(r#"{"op":"options","fadeSeconds":6,"loopPlaylist":false,"silenceSkip":true,"silenceThresholdDb":-55}"#),
            Op::Options { silence_skip: true, .. }
        ));
        let Op::SetPlaylist { tracks } = op(r#"{"op":"setPlaylist","tracks":[{"id":"a","title":"T","artist":"x","file":"C:\\m\\a.flac","trimStart":1.5,"trimEnd":null,"trimManual":false,"gainDb":null,"mixPoint":0,"fadeOutStart":0,"durationSecs":200,"blocks":["b"],"tags":[],"cover":"","lufs":null,"missing":false}]}"#) else { panic!() };
        assert_eq!(tracks[0].trim_start, 1.5);
        assert_eq!(tracks[0].file, "C:\\m\\a.flac");
        let Op::Mixer { config } = op(r##"{"op":"mixer","config":{"mixerChannels":[{"id":"c","name":"Música","color":"#fff","input":{"kind":"app","app":"music","deviceId":""},"output":{"kind":"device","id":"streaming"},"gainDb":-3,"muted":false,"leveler":{"enabled":false,"targetLufs":-16,"maxGainDb":9}}],"mixerBuses":[],"monitorBusId":""}}"##) else { panic!() };
        assert_eq!(config.mixer_channels[0].output.id, "streaming");
    }

    #[test]
    fn state_payload_shape() {
        let p = StatePayload {
            events: vec![OutEvent::Tick { pos: 1.0, total: 2.0 }, OutEvent::Index { index: 2 }, OutEvent::Ended, OutEvent::Diag { message: "x".into() }],
            index: 2,
            playing: true,
            paused: false,
            level: 0.5,
            db: -12.0,
            level_l: 0.4,
            level_r: 0.6,
            db_l: -15.0,
            db_r: -10.0,
            stream_level: 0.25,
            stream_db: -30.0,
            stream_level_l: 0.2,
            stream_level_r: 0.3,
            stream_db_l: -33.0,
            stream_db_r: -28.0,
        };
        let j = serde_json::to_string(&p).unwrap();
        assert_eq!(
            j,
            r#"{"events":[{"type":"tick","pos":1.0,"total":2.0},{"type":"index","index":2},{"type":"ended"},{"type":"diag","message":"x"}],"index":2,"playing":true,"paused":false,"level":0.5,"db":-12.0,"levelL":0.4,"levelR":0.6,"dbL":-15.0,"dbR":-10.0,"streamLevel":0.25,"streamDb":-30.0,"streamLevelL":0.2,"streamLevelR":0.3,"streamDbL":-33.0,"streamDbR":-28.0}"#
        );
    }
}
