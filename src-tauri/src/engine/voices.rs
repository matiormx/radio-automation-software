//! Voces de reproduccion: cada deck es una voz que lee un PCM desde una
//! posicion, con una envolvente de ganancia (fundidos) y un final.
//!
//! El render corre en el hilo de audio: no reserva memoria. Las voces que
//! terminan pasan a `dead` y el hilo de control las libera.

use std::sync::Arc;

use super::pcm::Pcm;

/// Envolvente lineal por tramos en tiempo de motor (frames).
#[derive(Clone, Debug)]
pub struct Env {
    a: (u64, f32),
    b: (u64, f32),
}

impl Env {
    pub fn constant(v: f32) -> Self {
        Env { a: (0, v), b: (0, v) }
    }

    pub fn value_at(&self, t: u64) -> f32 {
        let (t0, v0) = self.a;
        let (t1, v1) = self.b;
        if t <= t0 {
            v0
        } else if t >= t1 {
            v1
        } else {
            let k = (t - t0) as f32 / (t1 - t0) as f32;
            v0 + (v1 - v0) * k
        }
    }

    /// Rampa lineal desde el valor actual en `now` hasta `to` en `frames`.
    pub fn ramp(&mut self, now: u64, to: f32, frames: u64) {
        let cur = self.value_at(now);
        self.a = (now, cur);
        self.b = (now + frames.max(1), to);
    }

    /// Rampa programada: `from` en `t0`, `to` en `t1`.
    pub fn schedule(&mut self, t0: u64, from: f32, t1: u64, to: f32) {
        self.a = (t0, from);
        self.b = (t1.max(t0 + 1), to);
    }
}

pub struct Voice {
    pub id: u64,
    pub pcm: Arc<Pcm>,
    /// Frame de motor en el que empieza a sonar
    pub start_at: u64,
    /// Frame del PCM desde el que empieza
    pub from: usize,
    /// Frame del PCM donde termina (fin del recorte)
    pub end: usize,
    /// Frame de motor en el que se corta (fundidos de salida)
    pub stop_at: Option<u64>,
    pub gain: Env,
    pub norm: f32,
}

impl Voice {
    /// Frame del PCM que suena en el instante `t` del motor.
    pub fn pcm_pos(&self, t: u64) -> usize {
        if t <= self.start_at {
            self.from
        } else {
            self.from + (t - self.start_at) as usize
        }
    }

    pub fn done(&self, t: u64) -> bool {
        self.pcm_pos(t) >= self.end || self.stop_at.map(|s| t >= s).unwrap_or(false)
    }
}

pub struct Voices {
    pub list: Vec<Voice>,
    pub dead: Vec<Voice>,
    next_id: u64,
}

impl Default for Voices {
    fn default() -> Self {
        Voices { list: Vec::with_capacity(8), dead: Vec::with_capacity(16), next_id: 1 }
    }
}

impl Voices {
    pub fn add(&mut self, mut v: Voice) -> u64 {
        v.id = self.next_id;
        self.next_id += 1;
        let id = v.id;
        self.list.push(v);
        id
    }

    pub fn get_mut(&mut self, id: u64) -> Option<&mut Voice> {
        self.list.iter_mut().find(|v| v.id == id)
    }

    pub fn get(&self, id: u64) -> Option<&Voice> {
        self.list.iter().find(|v| v.id == id)
    }

    pub fn alive(&self, id: u64) -> bool {
        self.list.iter().any(|v| v.id == id)
    }

    /// Funde y corta una voz en `frames`.
    pub fn fade_stop(&mut self, id: u64, now: u64, frames: u64) {
        if let Some(v) = self.get_mut(id) {
            v.gain.ramp(now, 0.0, frames);
            let at = now + frames;
            v.stop_at = Some(v.stop_at.map(|s| s.min(at)).unwrap_or(at));
        }
    }

    /// Funde y corta todas las voces.
    pub fn fade_stop_all(&mut self, now: u64, frames: u64) {
        let ids: Vec<u64> = self.list.iter().map(|v| v.id).collect();
        for id in ids {
            self.fade_stop(id, now, frames);
        }
    }

    /// Corta en seco todas las voces (pausa).
    pub fn stop_all_now(&mut self) {
        while let Some(v) = self.list.pop() {
            self.dead.push(v);
        }
    }

    /// Suma las voces en `out` (estereo entrelazado) a partir del instante
    /// `now` y retira las que terminan. No reserva memoria salvo si `dead`
    /// se llena (el hilo de control lo vacia a menudo).
    pub fn render(&mut self, now: u64, out: &mut [f32]) {
        let frames = out.len() / 2;
        for v in self.list.iter() {
            for i in 0..frames {
                let t = now + i as u64;
                if t < v.start_at {
                    continue;
                }
                if v.stop_at.map(|s| t >= s).unwrap_or(false) {
                    break;
                }
                let p = v.from + (t - v.start_at) as usize;
                if p >= v.end {
                    break;
                }
                let g = v.gain.value_at(t) * v.norm;
                let (l, r) = v.pcm.frame(p);
                out[i * 2] += l * g;
                out[i * 2 + 1] += r * g;
            }
        }
        let end = now + frames as u64;
        let mut i = 0;
        while i < self.list.len() {
            if self.list[i].done(end) {
                let v = self.list.swap_remove(i);
                self.dead.push(v);
            } else {
                i += 1;
            }
        }
    }
}
