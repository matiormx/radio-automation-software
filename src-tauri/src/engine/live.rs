//! Entrada de audio en directo (internet) mezclada con la musica.
//! Un hilo lee FFmpeg y llena un buffer circular; el hilo de audio lo vacia.

use rtrb::{Consumer, Producer, RingBuffer};

use super::voices::Env;

pub struct LiveIn {
    cons: Consumer<f32>,
    pub gain: Env,
    /// Frame del motor en que termina (fundido de salida)
    pub stop_at: Option<u64>,
    /// Se espera a tener colchon antes de sonar (y tras un corte)
    playing: bool,
    /// Colchón (muestras) que se espera antes de sonar; crece tras cada corte
    prebuffer: usize,
    max_prebuffer: usize,
    /// Llenado medio del buffer (muestras), suavizado: las emisiones HLS
    /// llegan a trozos y no hay que reaccionar a cada uno.
    avg_fill: f64,
    /// Interpolación: los dos frames entre los que se lee y la posición.
    prev: [f32; 2],
    cur: [f32; 2],
    frac: f64,
    primed: bool,
    /// Cortes por falta de datos (para el diagnóstico)
    pub underruns: u32,
}

/// Corrección máxima de velocidad para seguir al reloj del servidor:
/// ±0,2 % (unos 3 cents, inaudible).
const MAX_DRIFT: f64 = 0.002;

impl LiveIn {
    /// Buffer de `secs` segundos a `rate` Hz; empieza a sonar con `pre` segundos.
    pub fn new(rate: u32, secs: f64, pre: f64) -> (LiveIn, Producer<f32>) {
        let cap = ((rate as f64 * secs) as usize).max(4096) * 2;
        let (prod, cons) = RingBuffer::new(cap);
        let prebuffer = ((rate as f64 * pre) as usize).max(256) * 2;
        let live = LiveIn {
            cons,
            gain: Env::constant(0.0),
            stop_at: None,
            playing: false,
            prebuffer,
            max_prebuffer: (cap / 2).max(prebuffer),
            avg_fill: prebuffer as f64,
            prev: [0.0; 2],
            cur: [0.0; 2],
            frac: 0.0,
            primed: false,
            underruns: 0,
        };
        (live, prod)
    }

    pub fn finished(&self, now: u64) -> bool {
        self.stop_at.map(|s| now >= s).unwrap_or(false)
    }

    fn next_frame(&mut self) -> Option<[f32; 2]> {
        if self.cons.slots() < 2 {
            return None;
        }
        let l = self.cons.pop().unwrap_or(0.0);
        let r = self.cons.pop().unwrap_or(0.0);
        Some([l, r])
    }

    /// Suma el audio en directo a `out` (estereo entrelazado) desde `now`.
    ///
    /// - Antes de sonar (y tras un corte) espera a tener colchón; cada corte
    ///   lo aumenta en un segundo, para que no se repita.
    /// - El reloj del servidor y el de la tarjeta nunca van exactos: el buffer
    ///   se iría vaciando (cortes cada pocos minutos) o llenando. Se lee un
    ///   pelín más deprisa o más despacio (como mucho ±0,2 %) para mantener el
    ///   colchón en su sitio.
    pub fn mix(&mut self, now: u64, out: &mut [f32]) {
        if self.finished(now) {
            return;
        }
        if !self.playing {
            if self.cons.slots() < self.prebuffer {
                return;
            }
            self.playing = true;
            self.primed = false;
            self.avg_fill = self.cons.slots() as f64;
        }
        let frames = out.len() / 2;
        // Velocidad de lectura según lo lleno que esté (suavizado ~10 s).
        let fill = self.cons.slots() as f64;
        let k = (frames as f64 / 48_000.0 / 10.0).min(1.0);
        self.avg_fill += (fill - self.avg_fill) * k;
        let target = self.prebuffer as f64;
        let err = ((self.avg_fill - target) / target).clamp(-1.0, 1.0);
        let step = 1.0 + err * MAX_DRIFT;
        if !self.primed {
            match (self.next_frame(), self.next_frame()) {
                (Some(a), Some(b)) => {
                    self.prev = a;
                    self.cur = b;
                    self.frac = 0.0;
                    self.primed = true;
                }
                _ => {
                    self.playing = false;
                    return;
                }
            }
        }
        for i in 0..frames {
            while self.frac >= 1.0 {
                match self.next_frame() {
                    Some(f) => {
                        self.prev = self.cur;
                        self.cur = f;
                        self.frac -= 1.0;
                    }
                    None => {
                        // Se acabó el colchón (corte de red): se espera más la próxima vez.
                        self.playing = false;
                        self.underruns += 1;
                        self.prebuffer = (self.prebuffer + self.prebuffer / 3).min(self.max_prebuffer);
                        return;
                    }
                }
            }
            let t = self.frac as f32;
            let l = self.prev[0] + (self.cur[0] - self.prev[0]) * t;
            let r = self.prev[1] + (self.cur[1] - self.prev[1]) * t;
            let g = self.gain.value_at(now + i as u64);
            out[i * 2] += l * g;
            out[i * 2 + 1] += r * g;
            self.frac += step;
        }
    }
}

/// Mete muestras en el buffer esperando si esta lleno; false si el motor ya no lo lee.
pub fn push_blocking(prod: &mut Producer<f32>, data: &[f32], stop: &std::sync::atomic::AtomicBool) -> bool {
    let mut i = 0;
    while i < data.len() {
        if prod.is_abandoned() || stop.load(std::sync::atomic::Ordering::SeqCst) {
            return false;
        }
        let free = prod.slots();
        if free == 0 {
            std::thread::sleep(std::time::Duration::from_millis(5));
            continue;
        }
        let n = free.min(data.len() - i);
        for &x in &data[i..i + n] {
            let _ = prod.push(x);
        }
        i += n;
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prebuffers_then_plays_and_fades() {
        let (mut live, mut prod) = LiveIn::new(1000, 2.0, 0.1);
        live.gain = Env::constant(1.0);
        let mut out = vec![0f32; 40];
        // Sin colchon: silencio
        for _ in 0..50 {
            let _ = prod.push(0.5);
        }
        live.mix(0, &mut out);
        assert!(out.iter().all(|x| *x == 0.0));
        for _ in 0..600 {
            let _ = prod.push(0.5);
        }
        live.mix(0, &mut out);
        assert!(out.iter().all(|x| (*x - 0.5).abs() < 1e-6));
        live.stop_at = Some(100);
        assert!(live.finished(100));
    }

    #[test]
    fn underrun_grows_cushion_and_drift_is_followed() {
        let (mut live, mut prod) = LiveIn::new(48_000, 30.0, 1.0);
        live.gain = Env::constant(1.0);
        let pre = live.prebuffer;
        for _ in 0..(48_000 * 2 + 200) {
            let _ = prod.push(0.25);
        }
        let mut out = vec![0f32; 2048];
        // Se vacía del todo: corte y el colchón crece.
        for _ in 0..200 {
            out.iter_mut().for_each(|x| *x = 0.0);
            live.mix(0, &mut out);
        }
        assert_eq!(live.underruns, 1);
        assert!(live.prebuffer > pre);
        // Con el buffer muy lleno se lee algo más deprisa (sin pasar del 0,2 %).
        let (mut l2, mut p2) = LiveIn::new(48_000, 30.0, 1.0);
        l2.gain = Env::constant(1.0);
        for _ in 0..(48_000 * 2 * 10) {
            let _ = p2.push(0.1);
        }
        let before = l2.cons.slots();
        for _ in 0..200 {
            l2.mix(0, &mut out);
        }
        let used = (before - l2.cons.slots()) as f64 / 2.0;
        let played = 200.0 * 1024.0;
        assert!(used > played, "lee más deprisa: {used} vs {played}");
        assert!(used < played * (1.0 + MAX_DRIFT) + 4.0);
    }
}
