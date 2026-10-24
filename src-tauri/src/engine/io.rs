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
use cpal::{FromSample, Sample, SampleFormat, SizedSample};
use rtrb::{Consumer, Producer, RingBuffer};

use super::core::Core;
use super::graph::{InsertFeed, DEFAULT_DEVICE, STREAM_DEVICE};
use super::resamp::{Drift, Stretch};

/// Frecuencia interna del motor (y del streaming).
pub const ENGINE_RATE: u32 = 48000;
/// Capacidad de los anillos: 1 s de estereo.
const RING_SAMPLES: usize = ENGINE_RATE as usize * 2;

pub struct SecSink {
    pub device: String,
    prod: Producer<f32>,
}

/// Audio que entra por un anillo con otro reloj (retorno de un insert):
/// remuestreo a la frecuencia del motor y colchon para absorber la deriva
/// entre relojes.
pub struct InsertReturn {
    pub device: String,
    cons: Consumer<f32>,
    stretch: Stretch,
    drift: Drift,
    buf: Vec<f32>,
    dev_rate: u32,
    /// Colchon minimo (s)
    min_secs: f64,
    primed: bool,
    active: bool,
}

impl InsertReturn {
    pub fn new(device: String, cons: Consumer<f32>, dev_rate: u32) -> Self {
        Self {
            device,
            cons,
            stretch: Stretch::new(),
            drift: Drift::default(),
            buf: vec![0.0; 4096 * 2],
            dev_rate,
            min_secs: 0.03,
            primed: false,
            active: false,
        }
    }

    /// Genera `n` frames a la frecuencia del motor. Si aun no hay colchon o
    /// el anillo se queda sin datos, el insert queda inactivo y el grafo usa
    /// el seco (no enmudece el canal).
    fn produce(&mut self, n: usize) {
        let base = self.dev_rate.max(1) as f64 / ENGINE_RATE as f64;
        let target = (n as f64 * base * 3.0).max(self.dev_rate.max(1) as f64 * self.min_secs);
        let mut fill = self.cons.slots() as f64 / 2.0 + self.stretch.pending();
        if fill > target * 4.0 {
            let drop = ((fill - target) as usize) * 2;
            for _ in 0..drop.min(self.cons.slots()) {
                let _ = self.cons.pop();
            }
            fill = self.cons.slots() as f64 / 2.0 + self.stretch.pending();
        }
        if !self.primed {
            if fill < target {
                self.active = false;
                return;
            }
            self.primed = true;
        }
        let ratio = self.drift.ratio(base, fill, target);
        let need = n * 2;
        if self.buf.len() < need {
            self.buf.resize(need, 0.0);
        }
        let InsertReturn { cons, stretch, buf, .. } = self;
        let mut starved = false;
        stretch.process(
            n,
            ratio,
            |b, want| {
                for _ in 0..want {
                    match (cons.pop(), cons.pop()) {
                        (Ok(l), Ok(r)) => {
                            b.push(l);
                            b.push(r);
                        }
                        _ => {
                            starved = true;
                            b.push(0.0);
                            b.push(0.0);
                        }
                    }
                }
            },
            |k, l, r| {
                buf[k * 2] = l;
                buf[k * 2 + 1] = r;
            },
        );
        self.active = !starved;
        if starved {
            self.primed = false;
            // Llega a trozos mas grandes que el colchon: se agranda (hasta 300 ms).
            self.min_secs = (self.min_secs * 1.5).min(0.3);
        }
    }
}

/// Lo que protege el candado del motor.
pub struct Shared {
    pub core: Core,
    sinks: Vec<SecSink>,
    stream_tap: Option<Producer<f32>>,
    /// Salidas de envio de los inserts
    insert_sinks: Vec<SecSink>,
    /// Retornos de los inserts (entradas del equipo)
    returns: Vec<InsertReturn>,
    /// Audio que manda el WebView (preescucha y llamadas), con su reloj
    pub apps: Vec<InsertReturn>,
}

pub type SharedRef = Arc<Mutex<Shared>>;

pub fn new_shared() -> SharedRef {
    Arc::new(Mutex::new(Shared { core: Core::new(ENGINE_RATE), sinks: Vec::new(), stream_tap: None, insert_sinks: Vec::new(), returns: Vec::new(), apps: Vec::new() }))
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

/// Un id de dispositivo es el nombre de la tarjeta o `nombre#N`, donde N es el
/// par de canales (1 = canales 1-2, 2 = 3-4...). Sin sufijo es el par 1.
pub fn split_pair(id: &str) -> (&str, usize) {
    if let Some((name, n)) = id.rsplit_once('#') {
        if let Ok(n) = n.parse::<usize>() {
            if n >= 1 && !name.is_empty() {
                return (name, n);
            }
        }
    }
    (id, 1)
}

/// Canales que ofrece una tarjeta (formato por defecto y los soportados).
fn max_channels(dev: &cpal::Device, output: bool) -> usize {
    let mut n = if output {
        dev.default_output_config().map(|c| c.channels() as usize).unwrap_or(2)
    } else {
        dev.default_input_config().map(|c| c.channels() as usize).unwrap_or(2)
    };
    if output {
        if let Ok(cfgs) = dev.supported_output_configs() {
            for c in cfgs {
                n = n.max(c.channels() as usize);
            }
        }
    } else if let Ok(cfgs) = dev.supported_input_configs() {
        for c in cfgs {
            n = n.max(c.channels() as usize);
        }
    }
    n
}

fn list_devices(output: bool) -> Vec<String> {
    let host = cpal::default_host();
    let mut names: Vec<String> = Vec::new();
    let devs = if output { host.output_devices() } else { host.input_devices() };
    if let Ok(devs) = devs {
        for d in devs {
            let Ok(n) = d.name() else { continue };
            if names.contains(&n) {
                continue;
            }
            let pairs = (max_channels(&d, output) / 2).clamp(1, 32);
            names.push(n.clone());
            // Las tarjetas multicanal (p. ej. VB-Matrix VAIO, 8 canales)
            // ofrecen cada par de canales como una salida/entrada.
            for k in 2..=pairs {
                names.push(format!("{n}#{k}"));
            }
        }
    }
    names
}

/// Nombres de las tarjetas de salida disponibles (con sus pares de canales).
pub fn list_outputs() -> Vec<String> {
    list_devices(true)
}

fn find_output(id: &str) -> Option<cpal::Device> {
    let host = cpal::default_host();
    let (id, _) = split_pair(id);
    if id == DEFAULT_DEVICE {
        return host.default_output_device();
    }
    host.output_devices().ok()?.find(|d| d.name().map(|n| n == id).unwrap_or(false))
}

/// Nombres de las entradas disponibles (para el retorno de los inserts).
pub fn list_inputs() -> Vec<String> {
    list_devices(false)
}

/// Id de entrada -> (tarjeta, primer canal, mono). `nombre!K` es el canal K
/// solo; `nombre#P` o `nombre`, el par P.
pub fn parse_input(id: &str) -> (&str, usize, bool) {
    if let Some((name, k)) = id.rsplit_once('!') {
        if let Ok(k) = k.parse::<usize>() {
            if k >= 1 && !name.is_empty() {
                return (name, k - 1, true);
            }
        }
    }
    let (name, pair) = split_pair(id);
    (name, (pair - 1) * 2, false)
}

fn find_input(id: &str) -> Option<cpal::Device> {
    let host = cpal::default_host();
    let (id, _, _) = parse_input(id);
    if id == DEFAULT_DEVICE {
        return host.default_input_device();
    }
    host.input_devices().ok()?.find(|d| d.name().map(|n| n == id).unwrap_or(false))
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
fn open_input<F>(device: &cpal::Device, first: usize, mono: bool, push: F, failed: Arc<AtomicBool>) -> Result<(cpal::Stream, u32), String>
where
    F: FnMut(&[f32]) + Send + 'static,
{
    let supported = device
        .default_input_config()
        .map_err(|e| format!("La entrada no da su formato: {e}"))?;
    let rate = supported.sample_rate().0;
    let format = supported.sample_format();
    let config: cpal::StreamConfig = supported.into();
    let stream = match format {
        SampleFormat::F32 => build_input::<f32, F>(device, &config, first, mono, push, failed),
        SampleFormat::I16 => build_input::<i16, F>(device, &config, first, mono, push, failed),
        SampleFormat::I32 => build_input::<i32, F>(device, &config, first, mono, push, failed),
        SampleFormat::U16 => build_input::<u16, F>(device, &config, first, mono, push, failed),
        SampleFormat::I24 => build_input::<cpal::I24, F>(device, &config, first, mono, push, failed),
        SampleFormat::F64 => build_input::<f64, F>(device, &config, first, mono, push, failed),
        other => return Err(format!("Formato de entrada no soportado: {other}")),
    }?;
    stream.play().map_err(|e| format!("No se pudo arrancar la entrada: {e}"))?;
    Ok((stream, rate))
}

fn build_input<T, F>(device: &cpal::Device, config: &cpal::StreamConfig, first: usize, mono: bool, mut push: F, failed: Arc<AtomicBool>) -> Result<cpal::Stream, String>
where
    T: SizedSample,
    f32: FromSample<T>,
    F: FnMut(&[f32]) + Send + 'static,
{
    let channels = config.channels.max(1) as usize;
    let mut scratch: Vec<f32> = Vec::with_capacity(16384);
    device
        .build_input_stream::<T, _, _>(
            config,
            move |data: &[T], _| {
                let frames = data.len() / channels;
                scratch.clear();
                scratch.reserve(frames * 2);
                // Par de canales elegido (1 = 1-2, 2 = 3-4...); si la tarjeta
                // tiene menos canales, se usa el ultimo.
                let a = first.min(channels - 1);
                for f in data.chunks_exact(channels) {
                    let l = f32::from_sample(f[a]);
                    if !mono && a + 1 < channels {
                        scratch.push(l);
                        scratch.push(f32::from_sample(f[a + 1]));
                    } else {
                        scratch.push(l);
                        scratch.push(l);
                    }
                }
                push(&scratch);
            },
            move |_err| failed.store(true, Ordering::SeqCst),
            None,
        )
        .map_err(|e| format!("No se pudo abrir la entrada: {e}"))
}

#[inline]
fn put(out: &mut [f32], channels: usize, k: usize, l: f32, r: f32) {
    put_at(out, channels, k, 0, l, r);
}

/// Escribe un par estereo a partir del canal `off` (0 = canales 1-2, 2 = 3-4...).
/// Si la tarjeta no llega a ese par, no se escribe nada.
#[inline]
fn put_at(out: &mut [f32], channels: usize, k: usize, off: usize, l: f32, r: f32) {
    let base = k * channels;
    if channels == 1 {
        if off == 0 {
            out[base] = 0.5 * (l + r);
        }
    } else if off + 1 < channels {
        out[base + off] = l;
        out[base + off + 1] = r;
    }
}

/// Callback de la tarjeta reloj: mezcla el motor y reparte.
fn master_fill(shared: SharedRef, dev_rate: u32) -> impl FnMut(&mut [f32], usize) + Send + 'static {
    let mut stretch = Stretch::new();
    let ratio = ENGINE_RATE as f64 / dev_rate.max(1) as f64;
    move |out: &mut [f32], channels: usize| {
        let frames = out.len() / channels;
        let mut g = lock(&shared);
        let Shared { core, sinks, stream_tap, insert_sinks, returns, apps } = &mut *g;
        stretch.process(
            frames,
            ratio,
            |buf, n| {
                // Retornos de los inserts: cada uno se remuestrea al motor.
                for r in returns.iter_mut() {
                    r.produce(n);
                }
                for a in apps.iter_mut() {
                    a.produce(n);
                }
                let app_feeds: Vec<InsertFeed> = ["app:preview", "app:call"]
                    .iter()
                    .map(|k| match apps.iter().find(|a| a.device == *k && a.active) {
                        Some(a) => InsertFeed { data: &a.buf[..n * 2], active: true },
                        None => InsertFeed { data: &[], active: false },
                    })
                    .collect();
                let feeds: Vec<InsertFeed> = core
                    .plan
                    .inserts
                    .iter()
                    .map(|ins| {
                        // Sin salida de envio no se usa el retorno: el canal
                        // sigue seco en vez de quedarse mudo.
                        if !insert_sinks.iter().any(|s| s.device == ins.send_device) {
                            return InsertFeed { data: &[], active: false };
                        }
                        match returns.iter().find(|r| r.device == ins.return_device && r.active) {
                            Some(r) => InsertFeed { data: &r.buf[..n * 2], active: true },
                            None => InsertFeed { data: &[], active: false },
                        }
                    })
                    .collect();
                let in_feeds: Vec<InsertFeed> = core
                    .plan
                    .inputs
                    .iter()
                    .map(|key| match returns.iter().find(|r| r.device == *key && r.active) {
                        Some(r) => InsertFeed { data: &r.buf[..n * 2], active: true },
                        None => InsertFeed { data: &[], active: false },
                    })
                    .collect();
                core.render_apps(n, &feeds, &in_feeds, &app_feeds, |plan, _off, m| {
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
                    for (i, ins) in plan.inserts.iter().enumerate() {
                        let Some(blk) = plan.insert_sends.get(i) else { continue };
                        if let Some(sink) = insert_sinks.iter_mut().find(|s| s.device == ins.send_device) {
                            push_all(&mut sink.prod, &blk.buf[..s]);
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
fn secondary_fill(mut cons: Consumer<f32>, dev_rate: u32, pair: usize) -> impl FnMut(&mut [f32], usize) + Send + 'static {
    let mut stretch = Stretch::new();
    let mut drift = Drift::default();
    let base = ENGINE_RATE as f64 / dev_rate.max(1) as f64;
    let mut primed = false;
    let off = (pair.max(1) - 1) * 2;
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
            |k, l, r| put_at(out, channels, k, off, l, r),
        );
        if starved {
            primed = false;
        }
    }
}

enum IoCmd {
    Route { outputs: Vec<String>, sends: Vec<String>, returns: Vec<String> },
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
                // Cadencia fija por reloj (no `sleep` encadenado): en Windows
                // el sleep de 20 ms puede durar 31 ms y el audio sale a ráfagas.
                let step = Duration::from_millis(20);
                let mut next = std::time::Instant::now() + step;
                while !stop.load(Ordering::SeqCst) {
                    let now = std::time::Instant::now();
                    if next > now {
                        std::thread::sleep(next - now);
                    } else if now - next > step * 5 {
                        next = now;
                    }
                    next += step;
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

    /// Tarjetas que necesita la mesa: salidas, envios y retornos de inserts.
    pub fn set_route(&self, outputs: Vec<String>, sends: Vec<String>, returns: Vec<String>) {
        let _ = self.tx.send(IoCmd::Route { outputs, sends, returns });
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
    let mut wanted_sends: Vec<String> = Vec::new();
    let mut send_secs: HashMap<String, Opened> = HashMap::new();
    let mut send_retry: HashMap<String, Instant> = HashMap::new();
    let mut wanted_returns: Vec<String> = Vec::new();
    let mut ret_secs: HashMap<String, Opened> = HashMap::new();
    let mut ret_retry: HashMap<String, Instant> = HashMap::new();
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
            match open_output(&dev, secondary_fill(cons, rate, split_pair(id).1), failed.clone()) {
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

        // Salidas de envio de los inserts
        send_secs.retain(|id, o| {
            let keep = wanted_sends.contains(id) && !o.failed.load(Ordering::SeqCst);
            if !keep && o.failed.load(Ordering::SeqCst) {
                send_retry.insert(id.clone(), Instant::now() + Duration::from_secs(3));
            }
            keep
        });
        {
            let mut g = lock(&shared);
            g.insert_sinks.retain(|s| send_secs.contains_key(&s.device));
        }
        for id in wanted_sends.iter() {
            if send_secs.contains_key(id) || send_retry.get(id).map(|t| Instant::now() < *t).unwrap_or(false) {
                continue;
            }
            let Some(dev) = find_output(id) else {
                if !send_retry.contains_key(id) {
                    report(format!("Envío de insert «{id}» no disponible"));
                }
                send_retry.insert(id.clone(), Instant::now() + Duration::from_secs(5));
                continue;
            };
            let rate = dev.default_output_config().map(|c| c.sample_rate().0).unwrap_or(ENGINE_RATE);
            let (prod, cons) = RingBuffer::<f32>::new(RING_SAMPLES);
            let failed = Arc::new(AtomicBool::new(false));
            match open_output(&dev, secondary_fill(cons, rate, split_pair(id).1), failed.clone()) {
                Ok((stream, _)) => {
                    lock(&shared).insert_sinks.push(SecSink { device: id.clone(), prod });
                    send_secs.insert(id.clone(), Opened { _stream: stream, failed });
                    send_retry.remove(id);
                }
                Err(e) => {
                    report(format!("Envío de insert «{id}»: {e}"));
                    send_retry.insert(id.clone(), Instant::now() + Duration::from_secs(5));
                }
            }
        }

        // Entradas de retorno de los inserts
        ret_secs.retain(|id, o| {
            let keep = wanted_returns.contains(id) && !o.failed.load(Ordering::SeqCst);
            if !keep && o.failed.load(Ordering::SeqCst) {
                ret_retry.insert(id.clone(), Instant::now() + Duration::from_secs(3));
            }
            keep
        });
        {
            let mut g = lock(&shared);
            g.returns.retain(|r| ret_secs.contains_key(&r.device));
        }
        for id in wanted_returns.iter() {
            if ret_secs.contains_key(id) || ret_retry.get(id).map(|t| Instant::now() < *t).unwrap_or(false) {
                continue;
            }
            let Some(dev) = find_input(id) else {
                if !ret_retry.contains_key(id) {
                    report(format!("Retorno de insert «{id}» no disponible"));
                }
                ret_retry.insert(id.clone(), Instant::now() + Duration::from_secs(5));
                continue;
            };
            // 1 s a la frecuencia de la entrada (puede ser 96/192 kHz).
            let rate_hint = dev.default_input_config().map(|c| c.sample_rate().0).unwrap_or(ENGINE_RATE);
            let (mut prod, cons) = RingBuffer::<f32>::new((rate_hint as usize).saturating_mul(2).max(8192));
            let failed = Arc::new(AtomicBool::new(false));
            match open_input(
                &dev,
                parse_input(id).1,
                parse_input(id).2,
                move |stereo: &[f32]| {
                    for &v in stereo {
                        let _ = prod.push(v);
                    }
                },
                failed.clone(),
            ) {
                Ok((stream, rate)) => {
                    lock(&shared).returns.push(InsertReturn::new(id.clone(), cons, rate));
                    ret_secs.insert(id.clone(), Opened { _stream: stream, failed });
                    ret_retry.remove(id);
                }
                Err(e) => {
                    report(format!("Retorno de insert «{id}»: {e}"));
                    ret_retry.insert(id.clone(), Instant::now() + Duration::from_secs(5));
                }
            }
        }

        match rx.recv_timeout(Duration::from_millis(500)) {
            Ok(IoCmd::Route { outputs, sends, returns }) => {
                wanted = outputs
                    .into_iter()
                    .filter(|d| d != DEFAULT_DEVICE && d != STREAM_DEVICE)
                    .collect();
                wanted_sends = sends
                    .into_iter()
                    .filter(|d| d != DEFAULT_DEVICE && d != STREAM_DEVICE)
                    .collect();
                wanted_returns = returns;
                retry_at.retain(|id, _| wanted.contains(id));
                send_retry.retain(|id, _| wanted_sends.contains(id));
                ret_retry.retain(|id, _| wanted_returns.contains(id));
            }
            Ok(IoCmd::Shutdown) | Err(RecvTimeoutError::Disconnected) => break,
            Err(RecvTimeoutError::Timeout) => {}
        }
    }
    {
        let mut g = lock(&shared);
        g.sinks.clear();
        g.insert_sinks.clear();
        g.returns.clear();
    }
    drop(send_secs);
    drop(ret_secs);
    drop(secs);
    drop(master);
}
