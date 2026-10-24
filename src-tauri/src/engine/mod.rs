//! Motor de audio nativo (beta): reproduccion, mesa y tarjetas en Rust.
//!
//! La interfaz manda ordenes con `engine_cmd` y recibe el estado por el
//! evento `engine://state` (posicion, indice, fin, avisos y VU) ~30 veces/s.

pub mod core;
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
    /// Llamada y preescucha que manda el WebView: (anillo, frecuencia)
    feeds: Mutex<[Option<(rtrb::Producer<f32>, u32)>; 2]>,
    /// Lector del retorno del que llama (para pararlo)
    ret_stop: Mutex<Option<Arc<AtomicBool>>>,
}

impl Drop for Engine {
    fn drop(&mut self) {
        if let Some(s) = self.live_stop.lock().ok().and_then(|mut g| g.take()) {
            s.store(true, Ordering::SeqCst);
        }
        if let Some(s) = self.ret_stop.lock().ok().and_then(|mut g| g.take()) {
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
    stream_level: f32,
    stream_db: f32,
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
        let shared = io::new_shared();
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
        Engine { shared, ctl, io, stop, meters, thread, app, live_stop: Mutex::new(None), feeds: Mutex::new([None, None]), ret_stop: Mutex::new(None) }
    }

    fn apply(&self, op: Op) {
        let mut ctl = lock_ctl(&self.ctl);
        let Ctl { player, loader } = &mut *ctl;
        match op {
            Op::Mixer { config } => {
                let old = {
                    let mut g = lock(&self.shared);
                    let vol = g.core.volume();
                    let plan = Plan::build(&config, vol, Some(&g.core.plan));
                    let (sends, mut returns) = plan.insert_devices();
                    // Las entradas fisicas de los canales se abren igual que los retornos.
                    for id in &plan.inputs {
                        if !returns.contains(id) {
                            returns.push(id.clone());
                        }
                    }
                    self.io.set_route(
                        plan.output_devices(),
                        sends,
                        returns,
                        plan.master_device(),
                    );
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
        let (events, index, playing, paused, level, db, slevel, sdb) = {
            let mut c = lock_ctl(&ctl);
            let Ctl { player, loader } = &mut *c;
            let mut g = lock(&shared);
            player.tick(&mut g.core.play, loader);
            // Las voces terminadas se liberan aqui, fuera del hilo de audio.
            std::mem::swap(&mut g.core.play.voices.dead, &mut spare);
            let now = g.core.play.now;
            let ended_live = if g.core.play.live.as_ref().map(|l| l.finished(now)).unwrap_or(false) { g.core.play.live.take() } else { None };
            let (level, db) = g.core.monitor_level();
            let (slevel, sdb) = g.core.stream_level();
            let playing = player.is_playing(&g.core.play);
            if meters_on.load(Ordering::Relaxed) && last_emit.elapsed() >= Duration::from_millis(33) {
                let mut list = g.core.plan.take_meters();
                let m = g.core.monitor_peak;
                list.push(("master".to_string(), m, m));
                strips = Some(list);
            }
            drop(g);
            drop(ended_live); // libera el buffer y deja que el lector termine
            (player.drain_events(), player.index(), playing, player.is_paused(), level, db, slevel, sdb)
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
            let _ = app.emit("engine://state", StatePayload { events: out, index, playing, paused, level, db, stream_level: slevel, stream_db: sdb });
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

impl Engine {
    /// Audio de la llamada (0) o la preescucha (1) que llega del WebView.
    fn feed(&self, which: usize, rate: u32, data: &[f32]) {
        let mut feeds = self.feeds.lock().unwrap_or_else(|e| e.into_inner());
        let slot = &mut feeds[which];
        let stale = match slot.as_ref() {
            Some((p, r)) => *r != rate || p.is_abandoned(),
            None => true,
        };
        if stale {
            // 2 s de colchon a la frecuencia del WebView.
            let (prod, cons) = rtrb::RingBuffer::<f32>::new((rate as usize * 4).max(16384));
            let name = if which == 0 { "call" } else { "preview" };
            let feed = io::InsertReturn::with_buffer(name.into(), cons, rate, 0.12);
            let old = {
                let mut g = lock(&self.shared);
                if which == 0 { g.call_feed.replace(feed) } else { g.preview_feed.replace(feed) }
            };
            drop(old);
            *slot = Some((prod, rate));
        }
        if let Some((prod, _)) = slot.as_mut() {
            if prod.slots() >= data.len() {
                for &x in data {
                    let _ = prod.push(x);
                }
            }
        }
    }

    /// Envia al WebView el retorno del que llama (f32le estereo a `rate`).
    fn start_return(&self, rate: u32, channel: tauri::ipc::Channel<tauri::ipc::InvokeResponseBody>) {
        if let Some(s) = self.ret_stop.lock().unwrap_or_else(|e| e.into_inner()).take() {
            s.store(true, Ordering::SeqCst);
        }
        let (prod, mut cons) = rtrb::RingBuffer::<f32>::new(ENGINE_RATE as usize * 2);
        let old = lock(&self.shared).ret_tap.replace(prod);
        drop(old);
        let stop = Arc::new(AtomicBool::new(false));
        *self.ret_stop.lock().unwrap_or_else(|e| e.into_inner()) = Some(stop.clone());
        let _ = std::thread::Builder::new().name("miradio-call-return".into()).spawn(move || {
            let mut rs = LinearResampler::new(ENGINE_RATE, rate.clamp(8000, 192000));
            let mut chunk: Vec<f32> = Vec::with_capacity(8192);
            let mut out: Vec<f32> = Vec::with_capacity(8192);
            let (mut sent, mut last_log) = (0usize, std::time::Instant::now());
            while !stop.load(Ordering::SeqCst) && !cons.is_abandoned() {
                std::thread::sleep(Duration::from_millis(20));
                // Mas de 150 ms acumulados: se recorta para no sumar retardo.
                let max = (ENGINE_RATE as usize * 2 * 15) / 100;
                while cons.slots() > max {
                    let _ = cons.pop();
                }
                chunk.clear();
                while let Ok(v) = cons.pop() {
                    chunk.push(v);
                }
                if chunk.len() < 2 {
                    continue;
                }
                out.clear();
                rs.process(&chunk, &mut out);
                let mut bytes = Vec::with_capacity(out.len() * 4);
                for v in &out {
                    bytes.extend_from_slice(&v.to_le_bytes());
                }
                let len = bytes.len();
                if channel.send(tauri::ipc::InvokeResponseBody::Raw(bytes)).is_err() {
                    break;
                }
                if std::env::var("MIRADIO_DEBUG_IO").is_ok() {
                    sent += len;
                    if last_log.elapsed() >= Duration::from_secs(2) {
                        eprintln!("[ret] {} bytes/s a {rate} Hz", sent / 2);
                        sent = 0;
                        last_log = std::time::Instant::now();
                    }
                }
            }
        });
    }
}

/// Remuestreo lineal estereo (retorno de la llamada: voz, sin exigencias).
struct LinearResampler {
    step: f64,
    pos: f64,
    last: (f32, f32),
}

impl LinearResampler {
    fn new(from: u32, to: u32) -> Self {
        LinearResampler { step: from as f64 / to as f64, pos: 0.0, last: (0.0, 0.0) }
    }

    /// `pos` es la posicion relativa al primer frame del bloque, con el
    /// frame anterior (`last`) en -1.
    fn process(&mut self, input: &[f32], out: &mut Vec<f32>) {
        let frames = input.len() / 2;
        if frames == 0 {
            return;
        }
        let at = |i: isize| -> (f32, f32) {
            if i < 0 {
                self.last
            } else {
                let i = i as usize;
                (input[i * 2], input[i * 2 + 1])
            }
        };
        while self.pos < (frames - 1) as f64 {
            let i = self.pos.floor() as isize;
            let t = (self.pos - i as f64) as f32;
            let (a, b) = (at(i), at(i + 1));
            out.push(a.0 + (b.0 - a.0) * t);
            out.push(a.1 + (b.1 - a.1) * t);
            self.pos += self.step;
        }
        self.pos -= frames as f64;
        self.last = (input[(frames - 1) * 2], input[(frames - 1) * 2 + 1]);
    }
}

/// Audio de la llamada o la preescucha del WebView (f32 estereo entrelazado
/// en el cuerpo; cabeceras `x-src`: call|preview y `x-rate`).
#[tauri::command]
pub fn engine_feed(request: tauri::ipc::Request<'_>, state: State<'_, EngineState>) -> Result<(), String> {
    let tauri::ipc::InvokeBody::Raw(body) = request.body() else {
        return Err("Se esperaba audio binario".into());
    };
    let header = |k: &str| request.headers().get(k).and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
    let which = match header("x-src").as_str() {
        "call" => 0,
        "preview" => 1,
        _ => return Err("Fuente desconocida".into()),
    };
    let rate: u32 = header("x-rate").parse().unwrap_or(48000).clamp(8000, 192000);
    let data: Vec<f32> = body.chunks_exact(4).map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]])).collect();
    let g = state.0.lock().map_err(|_| "El motor no responde".to_string())?;
    if let Some(engine) = g.as_ref() {
        engine.feed(which, rate, &data[..data.len() / 2 * 2]);
    }
    Ok(())
}

/// Abre el retorno del que llama (mix-minus del motor) hacia el WebView.
#[tauri::command]
pub fn engine_call_return(
    state: State<'_, EngineState>,
    rate: u32,
    channel: tauri::ipc::Channel<tauri::ipc::InvokeResponseBody>,
) -> Result<(), String> {
    let g = state.0.lock().map_err(|_| "El motor no responde".to_string())?;
    let engine = g.as_ref().ok_or_else(|| "El motor nativo no está en marcha".to_string())?;
    engine.start_return(rate, channel);
    Ok(())
}

#[tauri::command]
pub fn engine_devices() -> Vec<String> {
    io::list_outputs()
}

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
    fn linear_resampler_keeps_rate_and_continuity() {
        let mut rs = LinearResampler::new(48000, 44100);
        let mut out = Vec::new();
        let ramp: Vec<f32> = (0..9600).flat_map(|i| [i as f32, i as f32]).collect();
        for c in ramp.chunks(960) {
            rs.process(c, &mut out);
        }
        let frames = out.len() / 2;
        assert!((frames as i64 - 8820).abs() <= 2, "{frames}");
        for w in out.chunks_exact(2).collect::<Vec<_>>().windows(2) {
            let d = w[1][0] - w[0][0];
            assert!((d - 48000.0 / 44100.0).abs() < 1e-3, "salto {d}");
        }
    }

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
        let Op::Mixer { config } = op(r##"{"op":"mixer","config":{"mixerChannels":[{"id":"c","name":"Música","color":"#fff","input":{"kind":"app","app":"music","deviceId":""},"output":{"kind":"device","id":"streaming"},"gainDb":-3,"muted":false,"leveler":{"enabled":false,"targetLufs":-16,"maxGainDb":9},"insert":{"enabled":true,"sendDeviceId":"procIn","returnDeviceId":"procOut"}}],"mixerBuses":[{"id":"b","outputDeviceId":"default","gainDb":0,"muted":false,"insert":{"enabled":false,"sendDeviceId":"","returnDeviceId":""}}],"monitorBusId":""}}"##) else { panic!() };
        assert_eq!(config.mixer_channels[0].output.id, "streaming");
        assert_eq!(config.mixer_channels[0].insert.send_device_id, "procIn");
        assert_eq!(config.mixer_channels[0].insert.return_device_id, "procOut");
        assert!(!config.mixer_buses[0].insert.enabled);
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
            stream_level: 0.25,
            stream_db: -30.0,
        };
        let j = serde_json::to_string(&p).unwrap();
        assert_eq!(
            j,
            r#"{"events":[{"type":"tick","pos":1.0,"total":2.0},{"type":"index","index":2},{"type":"ended"},{"type":"diag","message":"x"}],"index":2,"playing":true,"paused":false,"level":0.5,"db":-12.0,"streamLevel":0.25,"streamDb":-30.0}"#
        );
    }
}
