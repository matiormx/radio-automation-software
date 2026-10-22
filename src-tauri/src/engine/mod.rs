//! Motor de audio nativo (beta): reproduccion, mesa y tarjetas en Rust.
//!
//! La interfaz manda ordenes con `engine_cmd` y recibe el estado por el
//! evento `engine://state` (posicion, indice, fin, avisos y VU) ~30 veces/s.

pub mod core;
pub mod graph;
pub mod io;
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
}

impl Drop for Engine {
    fn drop(&mut self) {
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
            let (shared, ctl, io, stop, meters) = (shared.clone(), ctl.clone(), io.clone(), stop.clone(), meters.clone());
            std::thread::Builder::new()
                .name("miradio-engine".into())
                .spawn(move || control_loop(app, shared, ctl, io, stop, meters))
                .ok()
        };
        Engine { shared, ctl, io, stop, meters, thread }
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
                    let devices: Vec<String> = plan.outs.iter().map(|o| o.device.clone()).collect();
                    self.io.set_devices(devices);
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
            op => {
                let mut g = lock(&self.shared);
                let core = &mut g.core.play;
                match op {
                    Op::PlayAt { index } => player.play_at(index, core, loader),
                    Op::Prepare { index, pos } => player.prepare(index, pos, core, loader),
                    Op::RestoreAt { index, pos, autoplay } => player.restore_at(index, pos, autoplay, core, loader),
                    Op::Toggle => player.toggle(core, loader),
                    Op::Pause => player.pause(core),
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
        let (events, index, playing, paused, level, db) = {
            let mut c = lock_ctl(&ctl);
            let Ctl { player, loader } = &mut *c;
            let mut g = lock(&shared);
            player.tick(&mut g.core.play, loader);
            // Las voces terminadas se liberan aqui, fuera del hilo de audio.
            std::mem::swap(&mut g.core.play.voices.dead, &mut spare);
            let (level, db) = g.core.monitor_level();
            let playing = player.is_playing(&g.core.play);
            if meters_on.load(Ordering::Relaxed) && last_emit.elapsed() >= Duration::from_millis(33) {
                let mut list = g.core.plan.take_meters();
                let m = g.core.monitor_peak;
                list.push(("master".to_string(), m, m));
                strips = Some(list);
            }
            drop(g);
            (player.drain_events(), player.index(), playing, player.is_paused(), level, db)
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
            let _ = app.emit("engine://state", StatePayload { events: out, index, playing, paused, level, db });
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
        };
        let j = serde_json::to_string(&p).unwrap();
        assert_eq!(
            j,
            r#"{"events":[{"type":"tick","pos":1.0,"total":2.0},{"type":"index","index":2},{"type":"ended"},{"type":"diag","message":"x"}],"index":2,"playing":true,"paused":false,"level":0.5,"db":-12.0}"#
        );
    }
}
