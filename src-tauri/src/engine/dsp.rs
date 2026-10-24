//! Procesadores de dinamica del motor nativo: nivelador, compresor y
//! limitador de salida. Todo a 48 kHz, estereo entrelazado.

use serde::Deserialize;

/// Nivelador automatico (igual que el de la mesa web).
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct LevelerCfg {
    pub enabled: bool,
    pub target_lufs: f64,
    pub max_gain_db: f64,
}

impl Default for LevelerCfg {
    fn default() -> Self {
        LevelerCfg { enabled: false, target_lufs: -16.0, max_gain_db: 9.0 }
    }
}

/// Compresor clasico (umbral, ratio, ataque, relajacion, ganancia de salida).
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct CompressorCfg {
    pub enabled: bool,
    pub threshold_db: f64,
    pub ratio: f64,
    pub attack_ms: f64,
    pub release_ms: f64,
    pub makeup_db: f64,
}

impl Default for CompressorCfg {
    fn default() -> Self {
        CompressorCfg { enabled: false, threshold_db: -18.0, ratio: 3.0, attack_ms: 10.0, release_ms: 200.0, makeup_db: 0.0 }
    }
}

/// Biquad estereo (formulas RBJ).
#[derive(Clone, Copy, Default)]
pub struct Biquad {
    b: [f32; 3],
    a: [f32; 2],
    z: [[f32; 2]; 2],
}

impl Biquad {
    fn highpass(rate: f32, f0: f32, q: f32) -> Self {
        let w = 2.0 * std::f32::consts::PI * f0 / rate;
        let (sn, cs) = w.sin_cos();
        let alpha = sn / (2.0 * q);
        let a0 = 1.0 + alpha;
        Biquad {
            b: [(1.0 + cs) / 2.0 / a0, -(1.0 + cs) / a0, (1.0 + cs) / 2.0 / a0],
            a: [-2.0 * cs / a0, (1.0 - alpha) / a0],
            z: [[0.0; 2]; 2],
        }
    }

    fn highshelf(rate: f32, f0: f32, gain_db: f32) -> Self {
        let a = 10f32.powf(gain_db / 40.0);
        let w = 2.0 * std::f32::consts::PI * f0 / rate;
        let (sn, cs) = w.sin_cos();
        let alpha = sn / 2.0 * std::f32::consts::SQRT_2;
        let sa = 2.0 * a.sqrt() * alpha;
        let a0 = (a + 1.0) - (a - 1.0) * cs + sa;
        Biquad {
            b: [
                a * ((a + 1.0) + (a - 1.0) * cs + sa) / a0,
                -2.0 * a * ((a - 1.0) + (a + 1.0) * cs) / a0,
                a * ((a + 1.0) + (a - 1.0) * cs - sa) / a0,
            ],
            a: [2.0 * ((a - 1.0) - (a + 1.0) * cs) / a0, ((a + 1.0) - (a - 1.0) * cs - sa) / a0],
            z: [[0.0; 2]; 2],
        }
    }

    #[inline]
    fn tick(&mut self, ch: usize, x: f32) -> f32 {
        let z = &mut self.z[ch];
        let y = self.b[0] * x + z[0];
        z[0] = self.b[1] * x - self.a[0] * y + z[1];
        z[1] = self.b[2] * x - self.a[1] * y;
        y
    }
}

/// Nivelador como el de la mesa web: mide la sonoridad (filtro K
/// simplificado, ventana de 3 s), mueve despacio la ganancia hacia el
/// objetivo dentro de un margen y detras pone un limitador de pico.
/// Con silencio la ganancia se congela.
#[derive(Clone, Copy)]
pub struct Leveler {
    target_lufs: f32,
    max_gain_db: f32,
    hp: Biquad,
    shelf: Biquad,
    ms: f32,
    primed: bool,
    gain_db: f32,
    gain: f32,
    /// Atenuacion actual del limitador (1 = nada)
    lim: f32,
}

impl Leveler {
    pub fn new(cfg: &LevelerCfg) -> Option<Leveler> {
        if !cfg.enabled {
            return None;
        }
        let rate = 48_000.0;
        Some(Leveler {
            target_lufs: cfg.target_lufs as f32,
            max_gain_db: cfg.max_gain_db.max(0.0) as f32,
            hp: Biquad::highpass(rate, 38.0, 0.5),
            shelf: Biquad::highshelf(rate, 1500.0, 4.0),
            ms: 0.0,
            primed: false,
            gain_db: 0.0,
            gain: 1.0,
            lim: 1.0,
        })
    }

    /// Conserva lo medido al rehacer la mesa (cambiar un fader no lo reinicia).
    pub fn carry(mut self, prev: Option<&Leveler>) -> Leveler {
        if let Some(p) = prev {
            self.hp.z = p.hp.z;
            self.shelf.z = p.shelf.z;
            self.ms = p.ms;
            self.primed = p.primed;
            self.gain_db = p.gain_db.clamp(-self.max_gain_db, self.max_gain_db);
            self.gain = p.gain;
            self.lim = p.lim;
        }
        self
    }

    pub fn process(&mut self, buf: &mut [f32], frames: usize) {
        let mut sum = 0.0f32;
        for f in buf.chunks_exact(2) {
            let l = self.shelf.tick(0, self.hp.tick(0, f[0]));
            let r = self.shelf.tick(1, self.hp.tick(1, f[1]));
            sum += 0.5 * (l * l + r * r);
        }
        let inst = sum / frames.max(1) as f32;
        let inst_lufs = -0.691 + 10.0 * inst.max(1e-12).log10();
        if inst_lufs >= -50.0 {
            let dt = frames as f32 / 48_000.0;
            if !self.primed {
                self.ms = inst;
                self.primed = true;
            } else {
                self.ms += (1.0 - (-dt / 3.0).exp()) * (inst - self.ms);
            }
            let lufs = -0.691 + 10.0 * self.ms.max(1e-12).log10();
            let wanted = (self.target_lufs - lufs).clamp(-self.max_gain_db, self.max_gain_db);
            let delta = wanted - self.gain_db;
            self.gain_db += if delta > 0.0 { delta.min(2.0 * dt) } else { delta.max(-6.0 * dt) };
        }
        // Rampa de ganancia en el bloque y limitador a -1 dBFS.
        let target = 10f32.powf(self.gain_db / 20.0);
        let step = (target - self.gain) / frames.max(1) as f32;
        let thr = 0.891;
        let release = (-1.0 / (0.12 * 48_000.0f32)).exp();
        let mut g = self.gain;
        for f in buf.chunks_exact_mut(2) {
            g += step;
            let l = f[0] * g;
            let r = f[1] * g;
            let peak = l.abs().max(r.abs());
            let need = if peak > thr { thr / peak } else { 1.0 };
            self.lim = if need < self.lim { need } else { need.min(1.0 - (1.0 - self.lim) * release) };
            f[0] = l * self.lim;
            f[1] = r * self.lim;
        }
        self.gain = target;
    }
}


/// Compresor de pico con rodilla suave (6 dB), detector estereo enlazado.
#[derive(Clone, Copy, Debug)]
pub struct Compressor {
    thr: f32,
    ratio: f32,
    att: f32,
    rel: f32,
    makeup: f32,
    /// Reduccion actual (dB, <= 0)
    gr_db: f32,
}

impl Compressor {
    pub fn new(cfg: &CompressorCfg) -> Option<Compressor> {
        if !cfg.enabled {
            return None;
        }
        let rate = 48_000.0f32;
        let coef = |ms: f64| (-1.0 / (rate * (ms.max(0.1) as f32) / 1000.0)).exp();
        Some(Compressor {
            thr: cfg.threshold_db.clamp(-60.0, 0.0) as f32,
            ratio: cfg.ratio.clamp(1.0, 20.0) as f32,
            att: coef(cfg.attack_ms),
            rel: coef(cfg.release_ms),
            makeup: 10f32.powf(cfg.makeup_db.clamp(0.0, 24.0) as f32 / 20.0),
            gr_db: 0.0,
        })
    }

    pub fn carry(mut self, prev: Option<&Compressor>) -> Compressor {
        if let Some(p) = prev {
            self.gr_db = p.gr_db;
        }
        self
    }

    /// Reduccion de ganancia actual en dB (para mostrarla).
    pub fn reduction_db(&self) -> f32 {
        self.gr_db
    }

    pub fn process(&mut self, buf: &mut [f32]) {
        let knee = 6.0f32;
        let slope = 1.0 - 1.0 / self.ratio;
        for f in buf.chunks_exact_mut(2) {
            let peak = f[0].abs().max(f[1].abs()).max(1e-9);
            let x = 20.0 * peak.log10();
            let over = x - self.thr;
            let want = if over <= -knee / 2.0 {
                0.0
            } else if over >= knee / 2.0 {
                -slope * over
            } else {
                let k = over + knee / 2.0;
                -slope * k * k / (2.0 * knee)
            };
            let c = if want < self.gr_db { self.att } else { self.rel };
            self.gr_db = want + c * (self.gr_db - want);
            let g = 10f32.powf(self.gr_db / 20.0) * self.makeup;
            f[0] *= g;
            f[1] *= g;
        }
    }
}

/// Limitador de seguridad de cada salida: nada pasa de -1 dBFS (evita el
/// recorte duro de la tarjeta, que suena roto).
#[derive(Clone, Copy, Debug)]
pub struct Limiter {
    lim: f32,
}

impl Default for Limiter {
    fn default() -> Self {
        Limiter { lim: 1.0 }
    }
}

impl Limiter {
    pub fn process(&mut self, buf: &mut [f32]) {
        let thr = 0.891f32;
        let release = (-1.0 / (0.08 * 48_000.0f32)).exp();
        for f in buf.chunks_exact_mut(2) {
            let peak = f[0].abs().max(f[1].abs());
            let need = if peak > thr { thr / peak } else { 1.0 };
            self.lim = if need < self.lim { need } else { need.min(1.0 - (1.0 - self.lim) * release) };
            f[0] *= self.lim;
            f[1] *= self.lim;
        }
    }
}
