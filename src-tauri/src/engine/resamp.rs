//! Remuestreo en tiempo real (interpolacion cubica Hermite) para llevar el
//! audio del motor a cada tarjeta, con relacion variable para compensar la
//! deriva entre relojes de tarjetas distintas.

pub struct Stretch {
    /// Frames del motor pendientes (estereo entrelazado)
    buf: Vec<f32>,
    /// Posicion fraccionaria en `buf` (en frames)
    pos: f64,
}

impl Default for Stretch {
    fn default() -> Self {
        Self::new()
    }
}

#[inline]
fn hermite(y0: f32, y1: f32, y2: f32, y3: f32, t: f32) -> f32 {
    let c0 = y1;
    let c1 = 0.5 * (y2 - y0);
    let c2 = y0 - 2.5 * y1 + 2.0 * y2 - 0.5 * y3;
    let c3 = 0.5 * (y3 - y0) + 1.5 * (y1 - y2);
    ((c3 * t + c2) * t + c1) * t + c0
}

impl Stretch {
    pub fn new() -> Self {
        let mut buf = Vec::with_capacity(32768);
        // Un frame de historia para la interpolacion.
        buf.extend_from_slice(&[0.0, 0.0]);
        Stretch { buf, pos: 1.0 }
    }

    /// Frames del motor aun sin consumir.
    pub fn pending(&self) -> f64 {
        (self.buf.len() / 2) as f64 - self.pos
    }

    /// Genera `out_frames` frames de salida. `ratio` = frames del motor por
    /// frame de salida. `pull(buf, n)` debe anadir al menos `n` frames al final
    /// de `buf` (silencio si no hay). `write(i, l, r)` recibe cada frame.
    pub fn process<P, W>(&mut self, out_frames: usize, ratio: f64, mut pull: P, mut write: W)
    where
        P: FnMut(&mut Vec<f32>, usize),
        W: FnMut(usize, f32, f32),
    {
        let ratio = if ratio.is_finite() && ratio > 0.0 { ratio } else { 1.0 };
        let need = (self.pos + out_frames as f64 * ratio).ceil() as usize + 3;
        let have = self.buf.len() / 2;
        if need > have {
            pull(&mut self.buf, need - have);
        }
        let frames = self.buf.len() / 2;
        let b = &self.buf;
        let at = |i: usize, c: usize| -> f32 {
            let i = i.min(frames.saturating_sub(1));
            b[i * 2 + c]
        };
        for k in 0..out_frames {
            let i = self.pos.floor() as usize;
            let t = (self.pos - i as f64) as f32;
            let i0 = i.saturating_sub(1);
            let l = hermite(at(i0, 0), at(i, 0), at(i + 1, 0), at(i + 2, 0), t);
            let r = hermite(at(i0, 1), at(i, 1), at(i + 1, 1), at(i + 2, 1), t);
            write(k, l, r);
            self.pos += ratio;
        }
        // Descarta lo consumido dejando un frame de historia.
        let keep_from = (self.pos.floor() as usize).saturating_sub(1).min(frames);
        if keep_from > 0 {
            self.buf.drain(..keep_from * 2);
            self.pos -= keep_from as f64;
        }
    }
}

/// Control de deriva: ajusta la relacion para mantener el colchon de un
/// anillo cerca del objetivo (lazo PI suave, +-0.5 %).
pub struct Drift {
    integral: f64,
}

impl Default for Drift {
    fn default() -> Self {
        Drift { integral: 0.0 }
    }
}

impl Drift {
    pub fn ratio(&mut self, base: f64, fill: f64, target: f64) -> f64 {
        let err = if target > 0.0 { ((fill - target) / target).clamp(-1.0, 1.0) } else { 0.0 };
        self.integral = (self.integral + err * 2e-5).clamp(-0.004, 0.004);
        let adj = (self.integral + err * 1e-3).clamp(-0.005, 0.005);
        base * (1.0 + adj)
    }
}
