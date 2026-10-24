//! Reproductor de radio con decks y crossfade (version nativa de audio.ts).
//!
//! Corre en el hilo de control: cada pocos milisegundos `tick` mira donde va
//! la pista y programa cruces, fundidos y saltos sobre las voces del motor.
//! La decodificacion es asincrona: las operaciones que necesitan una pista
//! aun no decodificada quedan pendientes y se completan en un tick posterior.

use std::sync::Arc;

use serde::Deserialize;

use super::pcm::Pcm;
use super::voices::{Env, Voice, Voices};

/// Parte del motor que maneja el reproductor (vive bajo el candado de audio).
pub struct PlayCore {
    pub rate: u32,
    /// Reloj del motor en frames
    pub now: u64,
    pub voices: Voices,
    /// Nivel cuadratico medio reciente de la musica (deteccion de silencio)
    pub music_ms: f32,
    /// Nivel cuadratico medio de lo que recibe el streaming (detector de silencio)
    pub sig_ms: f32,
    /// El detector de silencio solo vale si la musica tiene canal en la mesa
    pub sig_valid: bool,
    /// Audio de internet en directo (eventos de emision)
    pub live: Option<super::live::LiveIn>,
}

impl PlayCore {
    pub fn new(rate: u32) -> Self {
        PlayCore { rate, now: 0, voices: Voices::default(), music_ms: 0.0, sig_ms: 0.0, sig_valid: true, live: None }
    }

    pub fn secs(&self, frames: u64) -> f64 {
        frames as f64 / self.rate as f64
    }

    pub fn frames(&self, secs: f64) -> u64 {
        (secs.max(0.0) * self.rate as f64).round() as u64
    }
}

/// Datos de una pista que el motor necesita (el resto de la ficha se ignora).
#[derive(Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct TrackInfo {
    pub id: String,
    pub file: String,
    pub title: String,
    pub trim_start: f64,
    pub trim_end: Option<f64>,
    pub trim_manual: bool,
    pub gain_db: Option<f64>,
    pub mix_point: f64,
    pub fade_out_start: f64,
    pub duration_secs: f64,
    /// Intro superpuesto (audio de un bloque de intros) sobre esta pista
    pub intro_overlay: Option<Overlay>,
}

/// Audio que suena encima del hueco inicio→intro de una pista.
#[derive(Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Overlay {
    pub file: String,
    /// Segundo del archivo de la pista donde empieza
    pub at: f64,
    pub gain_db: f64,
    #[serde(skip)]
    pub key: String,
}

impl Overlay {
    /// Ficha para pedirlo al cargador (mismo cache que las pistas).
    fn as_track(&self) -> TrackInfo {
        TrackInfo { id: self.key.clone(), file: self.file.clone(), ..Default::default() }
    }
}

/// Pide la pista y su intro, sin esperar.
fn want_all(ld: &mut dyn Loader, t: &TrackInfo) {
    ld.want(t);
    if let Some(o) = &t.intro_overlay {
        ld.want(&o.as_track());
    }
}

fn trim_start_of(t: &TrackInfo) -> f64 {
    t.trim_start.max(0.0)
}

fn trim_end_of(t: &TrackInfo, duration: f64) -> f64 {
    let start = trim_start_of(t);
    let mut raw = t.trim_end.unwrap_or(duration);
    // Un recorte automatico que se come mas de la mitad de la cancion es un
    // error del analisis, no silencio: se ignora. El recorte manual se respeta.
    if !t.trim_manual && t.trim_end.is_some() && raw < duration / 2.0 {
        raw = duration;
    }
    (start + 0.2).max(duration.min(raw))
}

fn norm_gain_of(t: &TrackInfo) -> f32 {
    match t.gain_db {
        Some(db) if db.is_finite() => (10f64.powf(db / 20.0)).clamp(0.01, 16.0) as f32,
        _ => 1.0,
    }
}

pub enum Load {
    Ready(Arc<Pcm>),
    Pending,
    Failed(String),
}

/// Fuente de PCM decodificado (cache con decodificacion en segundo plano).
pub trait Loader {
    /// Devuelve la pista si ya esta; si no, la pide y devuelve Pending.
    fn get(&mut self, t: &TrackInfo) -> Load;
    /// Pide la pista sin esperar.
    fn want(&mut self, t: &TrackInfo) {
        let _ = self.get(t);
    }
    /// Indica que pistas conviene conservar en memoria.
    fn keep(&mut self, ids: &[&str]);
}

#[derive(Debug, Clone, PartialEq)]
pub enum Event {
    Tick { pos: f64, total: f64 },
    Index(i64),
    Ended,
    Diag(String),
}

#[derive(Clone, Copy, Debug)]
struct Deck {
    voice: u64,
    start_at: u64,
    /// Segundos del PCM donde empezo esta voz
    from: f64,
    /// Base de la pista (inicio del recorte)
    offset: f64,
    /// Fin de la pista (fin del recorte)
    end: f64,
    /// Duracion total del archivo (diagnostico)
    duration: f64,
    fade_out_set: bool,
}

enum Pending {
    Play { idx: usize, pos: Option<f64>, seek_rel: Option<f64>, fast: bool },
    Prepare { idx: usize, pos_rel: f64 },
    Crossfade { next: usize, keep_current: bool, remaining: f64 },
}

pub struct Player {
    pub fade_seconds: f64,
    pub loop_playlist: bool,
    pub silence_skip: bool,
    pub silence_threshold_db: f64,

    playlist: Vec<TrackInfo>,
    index: i64,
    deck: Option<Deck>,
    paused_offset: Option<f64>,
    fading_until: Option<u64>,
    preloaded_for: i64,
    fade_attempt_for: i64,
    silent_since: Option<u64>,
    pending: Option<Pending>,
    /// Pistas que fallaron seguidas al intentar sonar (evita bucles)
    fail_streak: usize,
    events: Vec<Event>,
}

const SILENCE_SECONDS: f64 = 3.0;
const PRELOAD_LEAD: f64 = 30.0;

impl Default for Player {
    fn default() -> Self {
        Player {
            fade_seconds: 6.0,
            loop_playlist: false,
            silence_skip: false,
            silence_threshold_db: -55.0,
            playlist: Vec::new(),
            index: -1,
            deck: None,
            paused_offset: None,
            fading_until: None,
            preloaded_for: -1,
            fade_attempt_for: -1,
            silent_since: None,
            pending: None,
            fail_streak: 0,
            events: Vec::new(),
        }
    }
}

impl Player {
    pub fn drain_events(&mut self) -> Vec<Event> {
        std::mem::take(&mut self.events)
    }

    pub fn index(&self) -> i64 {
        self.index
    }

    pub fn is_paused(&self) -> bool {
        self.paused_offset.is_some()
    }

    pub fn is_playing(&self, core: &PlayCore) -> bool {
        self.deck.map(|d| core.voices.alive(d.voice)).unwrap_or(false)
            || matches!(self.pending, Some(Pending::Play { .. }))
    }

    pub fn set_playlist(&mut self, tracks: Vec<TrackInfo>, ld: &mut dyn Loader) {
        let prev_id = if self.index >= 0 {
            self.playlist.get(self.index as usize).map(|t| t.id.clone())
        } else {
            None
        };
        self.playlist = tracks;
        for t in self.playlist.iter_mut() {
            if let Some(o) = t.intro_overlay.as_mut() {
                o.key = format!("ovl:{}", o.file);
            }
        }
        for t in self.playlist.iter().take(2) {
            want_all(ld, t);
        }
        if let Some(id) = prev_id {
            self.index = self.playlist.iter().position(|t| t.id == id).map(|i| i as i64).unwrap_or(-1);
        } else if self.index >= self.playlist.len() as i64 {
            self.index = -1;
        }
        self.events.push(Event::Index(self.index));
    }

    pub fn play_at(&mut self, idx: usize, core: &mut PlayCore, ld: &mut dyn Loader) {
        if idx >= self.playlist.len() {
            return;
        }
        self.pending = Some(Pending::Play { idx, pos: None, seek_rel: None, fast: false });
        self.resolve(core, ld);
    }

    pub fn prepare(&mut self, idx: usize, pos_rel: f64, core: &mut PlayCore, ld: &mut dyn Loader) {
        if idx >= self.playlist.len() {
            return;
        }
        self.pending = Some(Pending::Prepare { idx, pos_rel });
        self.resolve(core, ld);
    }

    pub fn restore_at(&mut self, idx: usize, pos_rel: f64, autoplay: bool, core: &mut PlayCore, ld: &mut dyn Loader) {
        if !autoplay {
            self.prepare(idx, pos_rel, core, ld);
            return;
        }
        if idx >= self.playlist.len() {
            return;
        }
        let seek = if pos_rel > 0.0 { Some(pos_rel) } else { None };
        self.pending = Some(Pending::Play { idx, pos: None, seek_rel: seek, fast: false });
        self.resolve(core, ld);
    }

    pub fn toggle(&mut self, core: &mut PlayCore, ld: &mut dyn Loader) {
        if self.index < 0 {
            self.play_at(0, core, ld);
            return;
        }
        if let Some(pos) = self.paused_offset {
            let idx = self.index as usize;
            if idx >= self.playlist.len() {
                self.paused_offset = None;
                return;
            }
            self.pending = Some(Pending::Play { idx, pos: Some(pos), seek_rel: None, fast: false });
            self.resolve(core, ld);
            return;
        }
        if self.deck.map(|d| core.voices.alive(d.voice)).unwrap_or(false) {
            self.pause(core);
            return;
        }
        let idx = self.index as usize;
        self.play_at(idx, core, ld);
    }

    pub fn next(&mut self, core: &mut PlayCore, ld: &mut dyn Loader) {
        let n = self.playlist.len();
        if n == 0 {
            return;
        }
        let i = ((self.index + 1).rem_euclid(n as i64)) as usize;
        self.play_at(i, core, ld);
    }

    pub fn prev(&mut self, core: &mut PlayCore, ld: &mut dyn Loader) {
        let n = self.playlist.len();
        if n == 0 {
            return;
        }
        let i = ((self.index - 1).rem_euclid(n as i64)) as usize;
        self.play_at(i, core, ld);
    }

    pub fn seek(&mut self, rel: f64, core: &mut PlayCore, ld: &mut dyn Loader) {
        if self.index < 0 {
            return;
        }
        let idx = self.index as usize;
        let Some(track) = self.playlist.get(idx).cloned() else { return };
        if self.paused_offset.is_some() {
            if let Load::Ready(pcm) = ld.get(&track) {
                let start = trim_start_of(&track);
                let end = trim_end_of(&track, pcm.duration());
                let r = rel.clamp(0.0, (end - start - 0.2).max(0.0));
                self.paused_offset = Some(start + r);
                self.events.push(Event::Tick { pos: r, total: end - start });
            }
            return;
        }
        self.pending = Some(Pending::Play { idx, pos: None, seek_rel: Some(rel), fast: true });
        self.resolve(core, ld);
    }

    pub fn pause(&mut self, core: &mut PlayCore) {
        self.pending = None;
        let Some(d) = self.deck else { return };
        let pos = self.deck_pos(&d, core);
        self.paused_offset = Some(pos.clamp(d.from, d.end));
        self.events.push(Event::Tick { pos: self.paused_offset.unwrap() - d.offset, total: d.end - d.offset });
        core.voices.stop_all_now();
        self.deck = None;
        self.fading_until = None;
    }

    /// Pausa con fundido de `secs` (entrada de un evento en directo).
    pub fn fade_pause(&mut self, secs: f64, core: &mut PlayCore) {
        self.pending = None;
        let Some(d) = self.deck else { return };
        let pos = self.deck_pos(&d, core);
        self.paused_offset = Some(pos.clamp(d.from, d.end));
        self.events.push(Event::Tick { pos: self.paused_offset.unwrap() - d.offset, total: d.end - d.offset });
        core.voices.fade_stop_all(core.now, core.frames(secs.max(0.02)));
        self.deck = None;
        self.fading_until = None;
    }

    /// Detiene todo sin recordar posicion (lista vaciada, cierre).
    pub fn stop(&mut self, core: &mut PlayCore) {
        self.pending = None;
        core.voices.fade_stop_all(core.now, core.frames(0.05));
        self.deck = None;
        self.paused_offset = None;
        self.fading_until = None;
    }

    // ------------------------------------------------------------ internals

    fn deck_pos(&self, d: &Deck, core: &PlayCore) -> f64 {
        if core.now <= d.start_at {
            d.from
        } else {
            d.from + core.secs(core.now - d.start_at)
        }
    }

    fn resolve(&mut self, core: &mut PlayCore, ld: &mut dyn Loader) {
        let Some(p) = self.pending.take() else { return };
        match p {
            Pending::Play { idx, pos, seek_rel, fast } => {
                let Some(track) = self.playlist.get(idx).cloned() else { return };
                match ld.get(&track) {
                    Load::Pending => self.pending = Some(Pending::Play { idx, pos, seek_rel, fast }),
                    Load::Failed(e) => self.load_failed(idx, &track, &e, core, ld),
                    Load::Ready(pcm) => {
                        self.fail_streak = 0;
                        let dur = pcm.duration();
                        let start = trim_start_of(&track).min((dur - 0.2).max(0.0));
                        let end = trim_end_of(&track, dur);
                        let at = match (pos, seek_rel) {
                            (Some(p), _) => p,
                            (None, Some(rel)) => start + rel.clamp(0.0, (end - start - 0.2).max(0.0)),
                            (None, None) => start,
                        };
                        core.voices.fade_stop_all(core.now, core.frames(0.05));
                        self.paused_offset = None;
                        if self.index != idx as i64 {
                            self.index = idx as i64;
                            self.events.push(Event::Index(self.index));
                        } else if pos.is_none() && seek_rel.is_none() {
                            self.events.push(Event::Index(self.index));
                        }
                        let delay = if fast { 0.03 } else { 0.05 };
                        let ovl = track.intro_overlay.as_ref().and_then(|o| match ld.get(&o.as_track()) {
                            Load::Ready(p) => Some(p),
                            _ => None,
                        });
                        self.start_deck(&track, pcm, at, delay, core, ovl);
                        if let Some(next) = self.playlist.get(idx + 1) {
                            want_all(ld, next);
                        }
                    }
                }
            }
            Pending::Prepare { idx, pos_rel } => {
                let Some(track) = self.playlist.get(idx).cloned() else { return };
                match ld.get(&track) {
                    Load::Pending => self.pending = Some(Pending::Prepare { idx, pos_rel }),
                    Load::Failed(e) => self.events.push(Event::Diag(format!("{}: {e}", track.title))),
                    Load::Ready(pcm) => {
                        let dur = pcm.duration();
                        let start = trim_start_of(&track).min((dur - 0.2).max(0.0));
                        let end = trim_end_of(&track, dur);
                        self.index = idx as i64;
                        let off = (start + pos_rel.max(0.0)).min(end - 0.2).max(start);
                        self.paused_offset = Some(off);
                        self.events.push(Event::Index(self.index));
                        self.events.push(Event::Tick { pos: off - start, total: end - start });
                    }
                }
            }
            Pending::Crossfade { next, keep_current, remaining } => {
                self.finish_crossfade(next, keep_current, remaining, core, ld);
            }
        }
    }

    fn load_failed(&mut self, idx: usize, track: &TrackInfo, err: &str, core: &mut PlayCore, ld: &mut dyn Loader) {
        let name = if track.title.is_empty() { "Pista" } else { track.title.as_str() };
        self.events.push(Event::Diag(format!("No se pudo leer «{name}»: {err}. Se pasa a la siguiente.")));
        self.fail_streak += 1;
        if self.fail_streak < self.playlist.len() && idx + 1 < self.playlist.len() {
            self.play_at(idx + 1, core, ld);
        } else {
            self.fail_streak = 0;
            self.deck = None;
            self.events.push(Event::Tick { pos: 0.0, total: 0.0 });
            self.events.push(Event::Ended);
        }
    }

    fn start_deck(&mut self, track: &TrackInfo, pcm: Arc<Pcm>, position: f64, delay: f64, core: &mut PlayCore, ovl: Option<Arc<Pcm>>) {
        let dur = pcm.duration();
        let end = trim_end_of(track, dur);
        let start = trim_start_of(track).max((end - 0.3).min(position));
        let start_at = core.now + core.frames(delay);
        let rate = core.rate as f64;
        let voice = core.voices.add(Voice {
            id: 0,
            pcm,
            start_at,
            from: (start * rate) as usize,
            end: (end * rate) as usize,
            stop_at: None,
            gain: Env::constant(1.0),
            norm: norm_gain_of(track),
        });
        self.deck = Some(Deck {
            voice,
            start_at,
            from: start,
            offset: trim_start_of(track),
            end,
            duration: dur,
            fade_out_set: false,
        });
        self.add_overlay(track, ovl, start, start_at, core);
        self.fading_until = None;
        self.preloaded_for = -1;
        self.fade_attempt_for = -1;
        self.silent_since = None;
    }

    /// Programa el intro sobre la pista que arranca en `start_at` desde `from`.
    fn add_overlay(&mut self, track: &TrackInfo, pcm: Option<Arc<Pcm>>, from: f64, start_at: u64, core: &mut PlayCore) {
        let (Some(o), Some(pcm)) = (track.intro_overlay.as_ref(), pcm) else { return };
        let delay = o.at - from;
        if delay < -0.05 {
            return; // ya se paso el momento
        }
        let begin = start_at + core.frames(delay.max(0.0));
        let end = pcm.frames();
        core.voices.add(Voice {
            id: 0,
            pcm,
            start_at: begin,
            from: 0,
            end,
            stop_at: None,
            gain: Env::constant(1.0),
            norm: (10f64.powf(o.gain_db / 20.0)).clamp(0.01, 16.0) as f32,
        });
    }

    fn mix_point_of(&self, idx: i64) -> f64 {
        self.playlist.get(idx.max(0) as usize).map(|t| t.mix_point.max(0.0)).unwrap_or(0.0)
    }

    /// El mix va al final de la pista: en la primera mitad se ignora.
    fn usable_mix_point(&self, d: &Deck) -> f64 {
        let p = self.mix_point_of(self.index);
        if p <= 0.0 {
            return 0.0;
        }
        let middle = d.offset + (d.end - d.offset) / 2.0;
        if p > middle && p < d.end {
            p
        } else {
            0.0
        }
    }

    fn fade_out_of(&self, idx: i64) -> f64 {
        self.playlist.get(idx.max(0) as usize).map(|t| t.fade_out_start.max(0.0)).unwrap_or(0.0)
    }

    fn next_index(&self) -> i64 {
        let n = self.playlist.len() as i64;
        if self.index + 1 < n {
            self.index + 1
        } else if self.loop_playlist && n > 1 {
            0
        } else {
            -1
        }
    }

    pub fn tick(&mut self, core: &mut PlayCore, ld: &mut dyn Loader) {
        if self.pending.is_some() {
            self.resolve(core, ld);
        }
        self.keep_cache(ld);
        let Some(mut d) = self.deck else { return };
        let total = d.end - d.offset;
        let pos = self.deck_pos(&d, core);
        let remaining = d.end - pos;

        if pos < d.offset {
            self.events.push(Event::Tick { pos: 0.0, total });
            return;
        }

        if self.silence_skip && core.sig_valid && core.now > d.start_at {
            let threshold = 10f64.powf(self.silence_threshold_db / 20.0);
            let rms = (core.sig_ms.max(0.0) as f64).sqrt();
            if rms < threshold {
                match self.silent_since {
                    None => self.silent_since = Some(core.now),
                    Some(since) if core.secs(core.now - since) >= SILENCE_SECONDS => {
                        self.silent_since = None;
                        self.report_early(&d, "Silencio detectado", pos);
                        let next = self.next_index();
                        if next >= 0 && next != self.index {
                            self.play_at(next as usize, core, ld);
                        } else {
                            self.finish(core, ld);
                        }
                        return;
                    }
                    _ => {}
                }
            } else {
                self.silent_since = None;
            }
        }

        let next = self.next_index();
        if next >= 0 && next != self.index && remaining <= PRELOAD_LEAD.max(self.fade_seconds + 15.0) && self.preloaded_for != next {
            self.preloaded_for = next;
            if let Some(t) = self.playlist.get(next as usize) {
                want_all(ld, t);
            }
        }

        if let Some(until) = self.fading_until {
            if core.now > until {
                self.fading_until = None;
            }
        }
        let fading = self.fading_until.is_some() || matches!(self.pending, Some(Pending::Crossfade { .. }));

        if pos >= d.end || !core.voices.alive(d.voice) && core.now > d.start_at {
            self.report_early(&d, "Fin de pista", pos);
            self.finish(core, ld);
            return;
        }

        // Fade out: desde su punto hasta el final, la pista baja al silencio.
        let fade_out = self.fade_out_of(self.index);
        if !fading && !d.fade_out_set && fade_out > 0.0 && pos >= fade_out && pos < d.end {
            let now = core.now;
            let until = now + core.frames(d.end - pos);
            if let Some(v) = core.voices.get_mut(d.voice) {
                let cur = v.gain.value_at(now);
                v.gain.schedule(now, cur, until, 0.0);
            }
            d.fade_out_set = true;
            self.deck = Some(d);
        }

        // Punto de mezcla: la siguiente entra ahi y la actual sigue sonando.
        let mix = self.usable_mix_point(&d);
        let cross_at = if mix > 0.0 { mix } else { d.end - self.fade_seconds };
        if !fading && self.index >= 0 && self.fade_seconds > 0.0 && pos >= cross_at && next >= 0 && next != self.index {
            self.report_early(&d, if mix > 0.0 { "Cruce por punto Mix" } else { "Cruce" }, pos);
            self.begin_crossfade(next as usize, mix > 0.0, remaining, core, ld);
            return;
        }

        self.events.push(Event::Tick { pos: pos - d.offset, total });
    }

    fn begin_crossfade(&mut self, next: usize, keep_current: bool, remaining: f64, core: &mut PlayCore, ld: &mut dyn Loader) {
        if self.fade_attempt_for == next as i64 {
            return;
        }
        self.fade_attempt_for = next as i64;
        self.preloaded_for = -1;
        self.pending = Some(Pending::Crossfade { next, keep_current, remaining });
        self.resolve(core, ld);
    }

    fn finish_crossfade(&mut self, next: usize, keep_current: bool, remaining: f64, core: &mut PlayCore, ld: &mut dyn Loader) {
        let Some(track) = self.playlist.get(next).cloned() else { return };
        let Some(d) = self.deck else { return };
        let pcm = match ld.get(&track) {
            Load::Pending => {
                self.pending = Some(Pending::Crossfade { next, keep_current, remaining });
                return;
            }
            Load::Failed(e) => {
                let name = if track.title.is_empty() { "Pista" } else { track.title.as_str() };
                self.events.push(Event::Diag(format!("No se pudo leer «{name}»: {e}")));
                // Se salta la que falla: el siguiente cruce ira a la de despues.
                if next + 1 < self.playlist.len() {
                    self.fade_attempt_for = -1;
                    self.begin_crossfade(next + 1, keep_current, remaining, core, ld);
                }
                return;
            }
            Load::Ready(p) => p,
        };
        let now = core.now;
        let fade_target = self.fade_seconds.min(remaining).max(0.3);
        let available = d.end - self.deck_pos(&d, core);
        let dur = pcm.duration();
        let next_start = trim_start_of(&track).min((dur - 0.2).max(0.0));
        let next_end = trim_end_of(&track, dur);
        let start_at = now + core.frames(0.02);
        let rate = core.rate as f64;
        let mut gain = Env::constant(1.0);
        let overlap;
        if available <= 0.05 {
            // La decodificacion tardo mas que la pista: empalme limpio.
            core.voices.fade_stop(d.voice, now, core.frames(0.01));
            overlap = 0.0;
        } else {
            overlap = fade_target.min(available);
            gain.schedule(start_at, 0.001, start_at + core.frames(overlap), 1.0);
            if !keep_current {
                let fade_end = now + core.frames(overlap);
                let stop = now + core.frames(overlap + 0.1);
                if let Some(v) = core.voices.get_mut(d.voice) {
                    let cur = v.gain.value_at(now);
                    v.gain.schedule(now, cur.max(0.001), fade_end, 0.0);
                    v.stop_at = Some(v.stop_at.map(|s| s.min(stop)).unwrap_or(stop));
                }
            }
            // Con punto de mezcla la actual sigue hasta su final (se corta sola).
        }
        let voice = core.voices.add(Voice {
            id: 0,
            pcm,
            start_at,
            from: (next_start * rate) as usize,
            end: (next_end * rate) as usize,
            stop_at: None,
            gain,
            norm: norm_gain_of(&track),
        });
        self.deck = Some(Deck {
            voice,
            start_at,
            from: next_start,
            offset: trim_start_of(&track),
            end: next_end,
            duration: dur,
            fade_out_set: false,
        });
        let ovl = track.intro_overlay.as_ref().and_then(|o| match ld.get(&o.as_track()) {
            Load::Ready(p) => Some(p),
            _ => None,
        });
        self.add_overlay(&track, ovl, next_start, start_at, core);
        self.fading_until = Some(start_at + core.frames(overlap + 0.2));
        self.index = next as i64;
        self.fade_attempt_for = -1;
        self.silent_since = None;
        self.events.push(Event::Index(self.index));
        if let Some(t) = self.playlist.get(next + 1) {
            want_all(ld, t);
        }
    }

    fn finish(&mut self, core: &mut PlayCore, ld: &mut dyn Loader) {
        core.voices.fade_stop_all(core.now, core.frames(0.01));
        self.deck = None;
        self.fading_until = None;
        self.pending = None;
        let n = self.playlist.len() as i64;
        if self.index >= 0 && self.index + 1 < n {
            self.play_at((self.index + 1) as usize, core, ld);
            return;
        }
        if self.loop_playlist && self.index >= 0 && n > 1 {
            self.play_at(0, core, ld);
            return;
        }
        self.events.push(Event::Tick { pos: 0.0, total: 0.0 });
        self.events.push(Event::Ended);
    }

    /// Si la pista no llega al 80 % de su duracion, explica por que se cambio.
    fn report_early(&mut self, d: &Deck, reason: &str, pos: f64) {
        let total = d.duration;
        if !(total > 0.0) || pos >= total * 0.8 {
            return;
        }
        let Some(t) = self.playlist.get(self.index.max(0) as usize) else { return };
        let f = |s: f64| format!("{s:.1} s");
        let msg = format!(
            "{}: {reason} a los {} de {} · recorte {}–{}{} · mix {} · fade {} · ficha {}",
            if t.title.is_empty() { "Pista" } else { t.title.as_str() },
            f(pos),
            f(total),
            f(t.trim_start),
            t.trim_end.map(f).unwrap_or_else(|| "fin".into()),
            if t.trim_manual { " (manual)" } else { " (auto)" },
            f(t.mix_point),
            f(t.fade_out_start),
            f(t.duration_secs),
        );
        self.events.push(Event::Diag(msg));
    }

    fn keep_cache(&self, ld: &mut dyn Loader) {
        let mut ids: Vec<&str> = Vec::with_capacity(3);
        if self.index >= 0 {
            let i = self.index as usize;
            for t in self.playlist.iter().skip(i).take(2) {
                ids.push(t.id.as_str());
                if let Some(o) = &t.intro_overlay {
                    ids.push(o.key.as_str());
                }
            }
        }
        if let Some(t) = self.playlist.first() {
            if ids.is_empty() {
                ids.push(t.id.as_str());
            }
        }
        ld.keep(&ids);
    }
}
