//! Nucleo del motor: reloj, voces de musica y mesa. Lo protege un candado;
//! el hilo de audio llama a `render` y el de control maneja el reproductor.

use super::graph::{MixConfig, Plan, MAX_BLOCK};
use super::player::PlayCore;

pub struct Core {
    pub play: PlayCore,
    pub plan: Plan,
    volume: f32,
    music: Vec<f32>,
    preview: Vec<f32>,
    call: Vec<f32>,
    /// Nivel cuadratico medio reciente del VU
    pub monitor_ms: f32,
    /// Pico reciente del VU (decae)
    pub monitor_peak: f32,
}

/// Constante de tiempo de los medidores (s).
const METER_TAU: f32 = 0.06;

fn ema(prev: f32, block_ms: f32, frames: usize, rate: u32) -> f32 {
    let a = (-(frames as f32) / (METER_TAU * rate as f32)).exp();
    prev * a + block_ms * (1.0 - a)
}

fn mean_square(buf: &[f32]) -> f32 {
    if buf.is_empty() {
        return 0.0;
    }
    buf.iter().map(|x| x * x).sum::<f32>() / buf.len() as f32
}

impl Core {
    pub fn new(rate: u32) -> Self {
        let cfg = MixConfig::default();
        Core {
            play: PlayCore::new(rate),
            plan: Plan::build(&cfg, 1.0, None),
            volume: 1.0,
            music: vec![0.0; MAX_BLOCK * 2],
            preview: vec![0.0; MAX_BLOCK * 2],
            call: vec![0.0; MAX_BLOCK * 2],
            monitor_ms: 0.0,
            monitor_peak: 0.0,
        }
    }

    pub fn rate(&self) -> u32 {
        self.play.rate
    }

    /// Sustituye la mesa; devuelve la anterior para liberarla fuera del candado.
    pub fn swap_plan(&mut self, plan: Plan) -> Plan {
        std::mem::replace(&mut self.plan, plan)
    }

    pub fn volume(&self) -> f32 {
        self.volume
    }

    pub fn set_volume(&mut self, v: f32) {
        let v = if v.is_finite() { v.clamp(0.0, 1.0) } else { 1.0 };
        self.volume = v;
        self.plan.set_volume(v);
    }

    /// Mezcla `frames` y entrega cada tramo (<= MAX_BLOCK) a `sink` con la
    /// mesa ya calculada. `inputs` da el audio de las entradas fisicas para
    /// el tramo pedido (offset en frames, frames).
    pub fn render<F>(&mut self, frames: usize, mut sink: F)
    where
        F: FnMut(&Plan, usize, usize),
    {
        let mut done = 0;
        while done < frames {
            let n = (frames - done).min(MAX_BLOCK);
            let s = n * 2;
            self.music[..s].iter_mut().for_each(|x| *x = 0.0);
            self.play.voices.render(self.play.now, &mut self.music[..s]);
            let rate = self.play.rate;
            self.play.music_ms = ema(self.play.music_ms, mean_square(&self.music[..s]), n, rate);
            self.plan.render(n, &self.music[..s], &self.preview[..s], &self.call[..s], &[]);
            let mon = &self.plan.monitor[..s];
            self.monitor_ms = ema(self.monitor_ms, mean_square(mon), n, rate);
            let peak = mon.iter().fold(0f32, |a, &b| a.max(b.abs()));
            let decay = (-(n as f32) / (0.3 * rate as f32)).exp();
            self.monitor_peak = (self.monitor_peak * decay).max(peak);
            sink(&self.plan, done, n);
            self.play.now += n as u64;
            done += n;
        }
    }

    /// Nivel del VU como en la version web: 0..1 sobre 48 dB y dBFS.
    pub fn monitor_level(&self) -> (f32, f32) {
        let rms = self.monitor_ms.max(0.0).sqrt();
        let db = 20.0 * rms.max(1e-6).log10();
        (((db + 48.0) / 48.0).clamp(0.0, 1.0), db.max(-60.0))
    }
}
