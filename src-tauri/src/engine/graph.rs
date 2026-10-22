//! Mesa de mezclas nativa: canales -> buses o salidas, buses -> salidas.
//!
//! `Plan::build` traduce la configuracion (la misma de Ajustes) a una
//! estructura por indices, con los buffers ya reservados, para que el render
//! del hilo de audio no reserve memoria ni busque por nombre.

use serde::Deserialize;

pub const DEFAULT_DEVICE: &str = "default";
pub const STREAM_DEVICE: &str = "streaming";
pub const MIN_GAIN_DB: f64 = -60.0;
pub const MAX_GAIN_DB: f64 = 12.0;
/// Frames maximos por bloque; bloques mayores se parten.
pub const MAX_BLOCK: usize = 4096;

pub fn db_to_gain(db: f64) -> f32 {
    if !db.is_finite() || db <= MIN_GAIN_DB {
        0.0
    } else {
        10f64.powf(db.min(MAX_GAIN_DB) / 20.0) as f32
    }
}

fn norm_device(id: &str) -> String {
    let s = id.trim();
    if s.is_empty() {
        DEFAULT_DEVICE.to_string()
    } else {
        s.to_string()
    }
}

#[derive(Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct InputCfg {
    pub kind: String,
    pub app: String,
    pub device_id: String,
}

#[derive(Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct OutputCfg {
    pub kind: String,
    pub id: String,
}

#[derive(Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct ChannelCfg {
    pub id: String,
    pub input: InputCfg,
    pub output: OutputCfg,
    pub gain_db: f64,
    pub muted: bool,
}

#[derive(Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct BusCfg {
    pub id: String,
    pub output_device_id: String,
    pub gain_db: f64,
    pub muted: bool,
}

#[derive(Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct MixConfig {
    pub mixer_channels: Vec<ChannelCfg>,
    pub mixer_buses: Vec<BusCfg>,
    pub monitor_bus_id: String,
}

/// Fuente de un canal.
#[derive(Clone, Debug, PartialEq)]
pub enum Source {
    Music,
    Preview,
    Call,
    /// Entrada fisica (id de dispositivo)
    Input(usize),
}

#[derive(Clone, Copy, Debug)]
enum Dest {
    Bus(usize),
    Out(usize),
}

/// Ganancia que se mueve en rampa durante un bloque (sin chasquidos).
#[derive(Clone, Copy, Debug)]
pub struct Smooth {
    pub cur: f32,
    pub target: f32,
}

impl Smooth {
    fn new(v: f32) -> Self {
        Smooth { cur: v, target: v }
    }

    /// Rampa del bloque: (inicio, paso por frame); el ultimo frame llega al objetivo.
    #[inline]
    fn gains(&mut self, frames: usize) -> (f32, f32) {
        let start = self.cur;
        let step = if frames > 0 { (self.target - start) / frames as f32 } else { 0.0 };
        self.cur = self.target;
        (start, step)
    }
}

struct Chan {
    key: String,
    src: Source,
    gain: Smooth,
    dest: Dest,
}

struct Bus {
    key: String,
    gain: Smooth,
    out: usize,
    buf: Vec<f32>,
}

pub struct Out {
    pub device: String,
    pub buf: Vec<f32>,
    /// La salida Streaming no lleva volumen maestro
    pub is_stream: bool,
    vol: Smooth,
}

pub struct Plan {
    chans: Vec<Chan>,
    buses: Vec<Bus>,
    pub outs: Vec<Out>,
    /// Dispositivos de entrada que usa algun canal (indice = Source::Input)
    pub inputs: Vec<String>,
    /// Bus que se mide en el VU (si no, la salida predeterminada)
    monitor_bus: Option<usize>,
    stream_out: Option<usize>,
    default_out: usize,
    music_fallback: bool,
    preview_fallback: bool,
    call_fallback: bool,
    pub monitor: Vec<f32>,
    pub program: Vec<f32>,
}

fn add_scaled(dst: &mut [f32], src: &[f32], g: (f32, f32)) {
    let (mut v, step) = g;
    for (d, s) in dst.chunks_exact_mut(2).zip(src.chunks_exact(2)) {
        v += step;
        d[0] += s[0] * v;
        d[1] += s[1] * v;
    }
}

fn scale(buf: &mut [f32], g: (f32, f32)) {
    let (mut v, step) = g;
    if step == 0.0 && v == 1.0 {
        return;
    }
    for f in buf.chunks_exact_mut(2) {
        v += step;
        f[0] *= v;
        f[1] *= v;
    }
}

impl Plan {
    /// Construye el plan. `prev` permite conservar las ganancias actuales
    /// para que un cambio de fader se haga en rampa y no a saltos.
    pub fn build(cfg: &MixConfig, volume: f32, prev: Option<&Plan>) -> Plan {
        let buf = || vec![0f32; MAX_BLOCK * 2];
        let mut outs: Vec<Out> = Vec::new();
        let out_index = |dev: &str, outs: &mut Vec<Out>| -> usize {
            let d = norm_device(dev);
            if let Some(i) = outs.iter().position(|o| o.device == d) {
                return i;
            }
            let is_stream = d == STREAM_DEVICE;
            let v = if is_stream { 1.0 } else { volume };
            outs.push(Out { device: d, buf: buf(), is_stream, vol: Smooth::new(v) });
            outs.len() - 1
        };
        let default_out = out_index(DEFAULT_DEVICE, &mut outs);

        let prev_gain = |key: &str, fallback: f32| -> Smooth {
            let cur = prev.and_then(|p| {
                p.chans
                    .iter()
                    .find(|c| c.key == key)
                    .map(|c| c.gain.cur)
                    .or_else(|| p.buses.iter().find(|b| b.key == key).map(|b| b.gain.cur))
            });
            Smooth { cur: cur.unwrap_or(fallback), target: fallback }
        };

        let mut buses = Vec::new();
        for b in &cfg.mixer_buses {
            let g = if b.muted { 0.0 } else { db_to_gain(b.gain_db) };
            let out = out_index(&b.output_device_id, &mut outs);
            let key = format!("bus:{}", b.id);
            buses.push(Bus { gain: prev_gain(&key, g), key, out, buf: buf() });
        }
        let bus_ids: Vec<&str> = cfg.mixer_buses.iter().map(|b| b.id.as_str()).collect();

        let mut inputs: Vec<String> = Vec::new();
        let mut chans = Vec::new();
        let (mut music, mut preview, mut call) = (false, false, false);
        for c in &cfg.mixer_channels {
            let src = if c.input.kind == "app" {
                match c.input.app.as_str() {
                    "preview" => {
                        preview = true;
                        Source::Preview
                    }
                    "call" => {
                        call = true;
                        Source::Call
                    }
                    _ => {
                        music = true;
                        Source::Music
                    }
                }
            } else {
                let d = norm_device(&c.input.device_id);
                let i = inputs.iter().position(|x| *x == d).unwrap_or_else(|| {
                    inputs.push(d);
                    inputs.len() - 1
                });
                Source::Input(i)
            };
            let dest = if c.output.kind == "bus" {
                match bus_ids.iter().position(|id| *id == c.output.id) {
                    Some(i) => Dest::Bus(i),
                    None => Dest::Out(default_out),
                }
            } else {
                Dest::Out(out_index(&c.output.id, &mut outs))
            };
            let g = if c.muted { 0.0 } else { db_to_gain(c.gain_db) };
            let key = format!("ch:{}", c.id);
            chans.push(Chan { gain: prev_gain(&key, g), key, src, dest });
        }

        // Volumen maestro: continua desde el anterior si lo habia.
        if let Some(p) = prev {
            for o in outs.iter_mut() {
                if let Some(po) = p.outs.iter().find(|x| x.device == o.device) {
                    o.vol.cur = po.vol.cur;
                }
            }
        }

        let monitor_bus = if cfg.monitor_bus_id.is_empty() {
            None
        } else {
            cfg.mixer_buses.iter().position(|b| b.id == cfg.monitor_bus_id)
        };
        let stream_out = outs.iter().position(|o| o.is_stream);
        Plan {
            chans,
            buses,
            outs,
            inputs,
            monitor_bus,
            stream_out,
            default_out,
            music_fallback: !music,
            preview_fallback: !preview,
            call_fallback: !call,
            monitor: buf(),
            program: buf(),
        }
    }

    pub fn set_volume(&mut self, v: f32) {
        for o in self.outs.iter_mut() {
            if !o.is_stream {
                o.vol.target = v;
            }
        }
    }

    pub fn out_index(&self, device: &str) -> Option<usize> {
        self.outs.iter().position(|o| o.device == device)
    }

    /// Mezcla un bloque de `frames` (<= MAX_BLOCK). Las fuentes son estereo
    /// entrelazado; `inputs[i]` corresponde a `self.inputs[i]`.
    pub fn render(&mut self, frames: usize, music: &[f32], preview: &[f32], call: &[f32], inputs: &[&[f32]]) {
        let n = frames.min(MAX_BLOCK) * 2;
        for b in self.buses.iter_mut() {
            b.buf[..n].iter_mut().for_each(|x| *x = 0.0);
        }
        for o in self.outs.iter_mut() {
            o.buf[..n].iter_mut().for_each(|x| *x = 0.0);
        }
        let silence: &[f32] = &[];
        for c in self.chans.iter_mut() {
            let src: &[f32] = match c.src {
                Source::Music => music,
                Source::Preview => preview,
                Source::Call => call,
                Source::Input(i) => inputs.get(i).copied().unwrap_or(silence),
            };
            let g = c.gain.gains(frames);
            if src.len() < n {
                continue;
            }
            let dst = match c.dest {
                Dest::Bus(i) => &mut self.buses[i].buf[..n],
                Dest::Out(i) => &mut self.outs[i].buf[..n],
            };
            add_scaled(dst, &src[..n], g);
        }
        // Fuentes de la app sin canal: salen por la predeterminada para no
        // dejar la radio muda por una configuracion a medias.
        let d = self.default_out;
        for (used, src) in [(self.music_fallback, music), (self.preview_fallback, preview), (self.call_fallback, call)] {
            if used && src.len() >= n {
                add_scaled(&mut self.outs[d].buf[..n], &src[..n], (1.0, 0.0));
            }
        }
        for (bi, b) in self.buses.iter_mut().enumerate() {
            let g = b.gain.gains(frames);
            scale(&mut b.buf[..n], g);
            let out = &mut self.outs[b.out].buf[..n];
            for (o, s) in out.iter_mut().zip(b.buf[..n].iter()) {
                *o += *s;
            }
            if self.monitor_bus == Some(bi) {
                self.monitor[..n].copy_from_slice(&b.buf[..n]);
            }
        }
        for o in self.outs.iter_mut() {
            let g = o.vol.gains(frames);
            scale(&mut o.buf[..n], g);
        }
        if self.monitor_bus.is_none() {
            self.monitor[..n].copy_from_slice(&self.outs[d].buf[..n]);
        }
        match self.stream_out {
            Some(s) => self.program[..n].copy_from_slice(&self.outs[s].buf[..n]),
            None => self.program[..n].copy_from_slice(&self.monitor[..n]),
        }
    }
}
