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
    prebuffer: usize,
}

impl LiveIn {
    /// Buffer de `secs` segundos a `rate` Hz; empieza a sonar con `pre` segundos.
    pub fn new(rate: u32, secs: f64, pre: f64) -> (LiveIn, Producer<f32>) {
        let cap = ((rate as f64 * secs) as usize).max(4096) * 2;
        let (prod, cons) = RingBuffer::new(cap);
        let live = LiveIn {
            cons,
            gain: Env::constant(0.0),
            stop_at: None,
            playing: false,
            prebuffer: ((rate as f64 * pre) as usize).max(256) * 2,
        };
        (live, prod)
    }

    pub fn finished(&self, now: u64) -> bool {
        self.stop_at.map(|s| now >= s).unwrap_or(false)
    }

    /// Suma el audio en directo a `out` (estereo entrelazado) desde `now`.
    pub fn mix(&mut self, now: u64, out: &mut [f32]) {
        if self.finished(now) {
            return;
        }
        if !self.playing {
            if self.cons.slots() < self.prebuffer {
                return;
            }
            self.playing = true;
        }
        let frames = out.len() / 2;
        for i in 0..frames {
            if self.cons.slots() < 2 {
                // Se acabo el colchon (corte de red): se vuelve a esperar.
                self.playing = false;
                break;
            }
            let l = self.cons.pop().unwrap_or(0.0);
            let r = self.cons.pop().unwrap_or(0.0);
            let g = self.gain.value_at(now + i as u64);
            out[i * 2] += l * g;
            out[i * 2 + 1] += r * g;
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
}
