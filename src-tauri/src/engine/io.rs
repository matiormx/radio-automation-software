//! Tarjetas de sonido (cpal: WASAPI en Windows).
//!
//! La salida predeterminada es el reloj del motor: su callback mezcla y
//! reparte. Las demas tarjetas reciben su parte por anillos sin bloqueo y la
//! remuestrean con un lazo de deriva (cada tarjeta tiene su propio reloj).
//! La salida Streaming va por otro anillo a un hilo que alimenta FFmpeg.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{FromSample, SampleFormat, SizedSample};
use rtrb::{Consumer, Producer, RingBuffer};

use super::core::Core;
use super::graph::{DEFAULT_DEVICE, STREAM_DEVICE};
use super::resamp::{Drift, Stretch};

/// Frecuencia interna del motor (y del streaming).
pub const ENGINE_RATE: u32 = 48000;
/// Capacidad de los anillos: 1 s de estereo.
const RING_SAMPLES: usize = ENGINE_RATE as usize * 2;

pub struct SecSink {
    pub device: String,
    prod: Producer<f32>,
}

/// Lo que protege el candado del motor.
pub struct Shared {
    pub core: Core,
    sinks: Vec<SecSink>,
    stream_tap: Option<Producer<f32>>,
}

pub type SharedRef = Arc<Mutex<Shared>>;

pub fn new_shared() -> SharedRef {
    Arc::new(Mutex::new(Shared { core: Core::new(ENGINE_RATE), sinks: Vec::new(), stream_tap: None }))
}

/// Candado que sobrevive a un panico en otro hilo (la radio no se para).
pub fn lock(shared: &SharedRef) -> MutexGuard<'_, Shared> {
    shared.lock().unwrap_or_else(|e| e.into_inner())
}

fn push_all(prod: &mut Producer<f32>, data: &[f32]) {
    if prod.slots() < data.len() {
        return; // nadie consume (tarjeta parada): se descarta
    }
    for &x in data {
        let _ = prod.push(x);
    }
}

/// Nombres de las tarjetas de salida disponibles.
pub fn list_outputs() -> Vec<String> {
    let host = cpal::default_host();
    let mut names = Vec::new();
    if let Ok(devs) = host.output_devices() {
        for d in devs {
            if let Ok(n) = d.name() {
                if !names.contains(&n) {
                    names.push(n);
                }
            }
        }
    }
    names
}

fn find_output(id: &str) -> Option<cpal::Device> {
    let host = cpal::default_host();
    if id == DEFAULT_DEVICE {
        return host.default_output_device();
    }
    host.output_devices().ok()?.find(|d| d.name().map(|n| n == id).unwrap_or(false))
}

/// Abre una salida; `fill(buf, channels)` rellena f32 entrelazado.
fn open_output<F>(device: &cpal::Device, fill: F, failed: Arc<AtomicBool>) -> Result<(cpal::Stream, u32), String>
where
    F: FnMut(&mut [f32], usize) + Send + 'static,
{
    let supported = device
        .default_output_config()
        .map_err(|e| format!("La tarjeta no da su formato: {e}"))?;
    let rate = supported.sample_rate().0;
    let format = supported.sample_format();
    let config: cpal::StreamConfig = supported.into();
    let stream = match format {
        SampleFormat::F32 => build::<f32, F>(device, &config, fill, failed),
        SampleFormat::I16 => build::<i16, F>(device, &config, fill, failed),
        SampleFormat::I32 => build::<i32, F>(device, &config, fill, failed),
        SampleFormat::U16 => build::<u16, F>(device, &config, fill, failed),
        other => return Err(format!("Formato de tarjeta no soportado: {other}")),
    }?;
    stream.play().map_err(|e| format!("No se pudo arrancar la tarjeta: {e}"))?;
    Ok((stream, rate))
}

fn build<T, F>(device: &cpal::Device, config: &cpal::StreamConfig, mut fill: F, failed: Arc<AtomicBool>) -> Result<cpal::Stream, String>
where
    T: SizedSample + FromSample<f32>,
    F: FnMut(&mut [f32], usize) + Send + 'static,
{
    let channels = config.channels.max(1) as usize;
    let mut scratch: Vec<f32> = vec![0.0; 16384];
    device
        .build_output_stream::<T, _, _>(
            config,
            move |data: &mut [T], _| {
                if scratch.len() < data.len() {
                    scratch.resize(data.len(), 0.0);
                }
                let s = &mut scratch[..data.len()];
                s.iter_mut().for_each(|x| *x = 0.0);
                fill(s, channels);
                for (d, v) in data.iter_mut().zip(s.iter()) {
                    *d = T::from_sample(v.clamp(-1.0, 1.0));
                }
            },
            move |_err| failed.store(true, Ordering::SeqCst),
            None,
        )
        .map_err(|e| format!("No se pudo abrir la tarjeta: {e}"))
}

#[inline]
fn put(out: &mut [f32], channels: usize, k: usize, l: f32, r: f32) {
    let base = k * channels;
    if channels == 1 {
        out[base] = 0.5 * (l + r);
    } else {
        out[base] = l;
        out[base + 1] = r;
    }
}

/// Callback de la tarjeta reloj: mezcla el motor y reparte.
fn master_fill(shared: SharedRef, dev_rate: u32) -> impl FnMut(&mut [f32], usize) + Send + 'static {
    let mut stretch = Stretch::new();
    let ratio = ENGINE_RATE as f64 / dev_rate.max(1) as f64;
    move |out: &mut [f32], channels: usize| {
        let frames = out.len() / channels;
        let mut g = lock(&shared);
        let Shared { core, sinks, stream_tap } = &mut *g;
        stretch.process(
            frames,
            ratio,
            |buf, n| {
                core.render(n, |plan, _off, m| {
                    let s = m * 2;
                    match plan.out_index(DEFAULT_DEVICE) {
                        Some(d) => buf.extend_from_slice(&plan.outs[d].buf[..s]),
                        None => buf.extend(std::iter::repeat(0.0).take(s)),
                    }
                    for sink in sinks.iter_mut() {
                        if let Some(i) = plan.out_index(&sink.device) {
                            push_all(&mut sink.prod, &plan.outs[i].buf[..s]);
                        }
                    }
                    if let Some(tap) = stream_tap.as_mut() {
                        push_all(tap, &plan.program[..s]);
                    }
                });
            },
            |k, l, r| put(out, channels, k, l, r),
        );
    }
}

/// Callback de una tarjeta secundaria: lee su anillo y corrige la deriva.
fn secondary_fill(mut cons: Consumer<f32>, dev_rate: u32) -> impl FnMut(&mut [f32], usize) + Send + 'static {
    let mut stretch = Stretch::new();
    let mut drift = Drift::default();
    let base = ENGINE_RATE as f64 / dev_rate.max(1) as f64;
    let mut primed = false;
    move |out: &mut [f32], channels: usize| {
        let frames = out.len() / channels;
        let target = (frames as f64 * base * 3.0).max(ENGINE_RATE as f64 * 0.03);
        let mut fill = cons.slots() as f64 / 2.0 + stretch.pending();
        // Colchon excesivo (tarjeta recien abierta o atascada): se recorta.
        if fill > target * 4.0 {
            let drop = ((fill - target) as usize) * 2;
            for _ in 0..drop.min(cons.slots()) {
                let _ = cons.pop();
            }
            fill = cons.slots() as f64 / 2.0 + stretch.pending();
        }
        if !primed {
            if fill < target {
                return; // silencio hasta tener colchon
            }
            primed = true;
        }
        let ratio = drift.ratio(base, fill, target);
        let mut starved = false;
        stretch.process(
            frames,
            ratio,
            |buf, n| {
                for _ in 0..n {
                    match (cons.pop(), cons.pop()) {
                        (Ok(l), Ok(r)) => {
                            buf.push(l);
                            buf.push(r);
                        }
                        _ => {
                            starved = true;
                            buf.push(0.0);
                            buf.push(0.0);
                        }
                    }
                }
            },
            |k, l, r| put(out, channels, k, l, r),
        );
        if starved {
            primed = false;
        }
    }
}

enum IoCmd {
    Devices(Vec<String>),
    Shutdown,
}

/// Hilo que posee las tarjetas (los streams no se pueden mover entre hilos).
pub struct Io {
    tx: Sender<IoCmd>,
    thread: Option<JoinHandle<()>>,
    feeder: Option<JoinHandle<()>>,
    feeder_stop: Arc<AtomicBool>,
    pub errors: Arc<Mutex<Vec<String>>>,
}

struct Opened {
    _stream: cpal::Stream,
    failed: Arc<AtomicBool>,
}

impl Io {
    /// Arranca las tarjetas. `stream_out` recibe PCM s16le 48 kHz estereo
    /// de la salida de programa para los encoders.
    pub fn start(shared: SharedRef, stream_out: Box<dyn Fn(&[u8]) + Send>) -> Io {
        let errors = Arc::new(Mutex::new(Vec::new()));
        let (tx, rx) = mpsc::channel();

        // Streaming: anillo + hilo que convierte y envia cada 20 ms.
        let (prod, mut cons) = RingBuffer::<f32>::new(RING_SAMPLES * 2);
        lock(&shared).stream_tap = Some(prod);
        let feeder_stop = Arc::new(AtomicBool::new(false));
        let stop = feeder_stop.clone();
        let feeder = std::thread::Builder::new()
            .name("miradio-stream-feed".into())
            .spawn(move || {
                let mut bytes: Vec<u8> = Vec::with_capacity(16384);
                while !stop.load(Ordering::SeqCst) {
                    std::thread::sleep(Duration::from_millis(20));
                    bytes.clear();
                    while let Ok(v) = cons.pop() {
                        let s = (v.clamp(-1.0, 1.0) * if v < 0.0 { 32768.0 } else { 32767.0 }) as i16;
                        bytes.extend_from_slice(&s.to_le_bytes());
                    }
                    if !bytes.is_empty() {
                        stream_out(&bytes);
                    }
                }
            })
            .ok();

        let errs = errors.clone();
        let thread = std::thread::Builder::new()
            .name("miradio-audio-io".into())
            .spawn(move || io_thread(shared, rx, errs))
            .ok();
        Io { tx, thread, feeder, feeder_stop, errors }
    }

    /// Tarjetas que necesita la mesa (sin contar la predeterminada).
    pub fn set_devices(&self, devices: Vec<String>) {
        let _ = self.tx.send(IoCmd::Devices(devices));
    }

    pub fn take_errors(&self) -> Vec<String> {
        std::mem::take(&mut *self.errors.lock().unwrap_or_else(|e| e.into_inner()))
    }
}

impl Drop for Io {
    fn drop(&mut self) {
        let _ = self.tx.send(IoCmd::Shutdown);
        self.feeder_stop.store(true, Ordering::SeqCst);
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
        if let Some(t) = self.feeder.take() {
            let _ = t.join();
        }
    }
}

fn io_thread(shared: SharedRef, rx: Receiver<IoCmd>, errors: Arc<Mutex<Vec<String>>>) {
    let report = |m: String| errors.lock().unwrap_or_else(|e| e.into_inner()).push(m);
    let mut master: Option<Opened> = None;
    let mut master_retry = Instant::now();
    let mut wanted: Vec<String> = Vec::new();
    let mut secs: HashMap<String, Opened> = HashMap::new();
    let mut retry_at: HashMap<String, Instant> = HashMap::new();
    let mut master_warned = false;

    loop {
        // Tarjeta reloj
        if master.as_ref().map(|m| m.failed.load(Ordering::SeqCst)).unwrap_or(true) && Instant::now() >= master_retry {
            master = None;
            match find_output(DEFAULT_DEVICE) {
                Some(dev) => {
                    let failed = Arc::new(AtomicBool::new(false));
                    // La frecuencia real se conoce al abrir: se pide antes.
                    let rate = dev.default_output_config().map(|c| c.sample_rate().0).unwrap_or(ENGINE_RATE);
                    match open_output(&dev, master_fill(shared.clone(), rate), failed.clone()) {
                        Ok((stream, _)) => {
                            master = Some(Opened { _stream: stream, failed });
                            master_warned = false;
                        }
                        Err(e) => {
                            if !master_warned {
                                report(format!("Salida predeterminada: {e}"));
                                master_warned = true;
                            }
                        }
                    }
                }
                None => {
                    if !master_warned {
                        report("No hay salida de audio predeterminada".into());
                        master_warned = true;
                    }
                }
            }
            master_retry = Instant::now() + Duration::from_secs(2);
        }

        // Tarjetas secundarias
        secs.retain(|id, o| {
            let keep = wanted.contains(id) && !o.failed.load(Ordering::SeqCst);
            if !keep && o.failed.load(Ordering::SeqCst) {
                retry_at.insert(id.clone(), Instant::now() + Duration::from_secs(3));
            }
            keep
        });
        {
            let mut g = lock(&shared);
            g.sinks.retain(|s| secs.contains_key(&s.device));
        }
        for id in wanted.iter() {
            if secs.contains_key(id) || retry_at.get(id).map(|t| Instant::now() < *t).unwrap_or(false) {
                continue;
            }
            let Some(dev) = find_output(id) else {
                if !retry_at.contains_key(id) {
                    report(format!("La tarjeta «{id}» no está disponible"));
                }
                retry_at.insert(id.clone(), Instant::now() + Duration::from_secs(5));
                continue;
            };
            let rate = dev.default_output_config().map(|c| c.sample_rate().0).unwrap_or(ENGINE_RATE);
            let (prod, cons) = RingBuffer::<f32>::new(RING_SAMPLES);
            let failed = Arc::new(AtomicBool::new(false));
            match open_output(&dev, secondary_fill(cons, rate), failed.clone()) {
                Ok((stream, _)) => {
                    lock(&shared).sinks.push(SecSink { device: id.clone(), prod });
                    secs.insert(id.clone(), Opened { _stream: stream, failed });
                    retry_at.remove(id);
                }
                Err(e) => {
                    report(format!("«{id}»: {e}"));
                    retry_at.insert(id.clone(), Instant::now() + Duration::from_secs(5));
                }
            }
        }

        match rx.recv_timeout(Duration::from_millis(500)) {
            Ok(IoCmd::Devices(list)) => {
                wanted = list
                    .into_iter()
                    .filter(|d| d != DEFAULT_DEVICE && d != STREAM_DEVICE)
                    .collect();
                retry_at.retain(|id, _| wanted.contains(id));
            }
            Ok(IoCmd::Shutdown) | Err(RecvTimeoutError::Disconnected) => break,
            Err(RecvTimeoutError::Timeout) => {}
        }
    }
    lock(&shared).sinks.clear();
    drop(secs);
    drop(master);
}
