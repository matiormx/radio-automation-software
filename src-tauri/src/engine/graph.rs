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

/// Insert por tarjetas: la senal sale por `send_device_id` y vuelve por
/// `return_device_id` (una entrada del equipo).
#[derive(Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct InsertCfg {
    pub enabled: bool,
    pub send_device_id: String,
    pub return_device_id: String,
}

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

#[derive(Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct ChannelCfg {
    pub id: String,
    pub input: InputCfg,
    pub output: OutputCfg,
    /// Ganancia de entrada, antes de inserts y del fader.
    pub input_gain_db: f64,
    /// "off", "slow" o "fast"; si no es "off", ignora input_gain_db.
    pub agc: String,
    pub gain_db: f64,
    pub muted: bool,
    pub pan: f64,
    pub solo: bool,
    pub sends: Vec<SendCfg>,
    pub insert: InsertCfg,
    pub leveler: LevelerCfg,
}

#[derive(Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct SendCfg {
    pub bus_id: String,
    pub gain_db: f64,
    pub pre: bool,
    pub muted: bool,
}

#[derive(Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct BusCfg {
    pub id: String,
    pub output_device_id: String,
    pub gain_db: f64,
    pub muted: bool,
    pub pan: f64,
    pub insert: InsertCfg,
    pub sends: Vec<SendCfg>,
    pub leveler: LevelerCfg,
}

#[derive(Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct MixConfig {
    pub mixer_channels: Vec<ChannelCfg>,
    pub mixer_buses: Vec<BusCfg>,
    pub monitor_bus_id: String,
    /// Tarjeta de salida del Master; vacio = predeterminada.
    pub master_output_device_id: String,
    /// Tarjeta de salida de monitorizacion/preescucha; vacio = predeterminada.
    pub monitor_output_device_id: String,
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

/// Pico por lado desde la ultima lectura (medidores de la mesa).
#[derive(Clone, Copy, Debug, Default)]
pub struct Meter {
    pub l: f32,
    pub r: f32,
}

impl Meter {
    #[inline]
    fn feed(&mut self, buf: &[f32]) {
        for f in buf.chunks_exact(2) {
            self.l = self.l.max(f[0].abs());
            self.r = self.r.max(f[1].abs());
        }
    }
}

struct Send {
    bus: usize,
    /// Ganancia del envio (antes del fader incluye silencio y solo del canal)
    g: Smooth,
    pre: bool,
}

struct Chan {
    key: String,
    src: Source,
    /// Ganancia de entrada fija (si no hay AGC)
    input_gain: f32,
    /// Control automatico de ganancia; si existe, sustituye a input_gain
    agc: Option<Agc>,
    /// Ganancia final por lado: fader, silencio, solo y panorama
    gl: Smooth,
    gr: Smooth,
    dest: Dest,
    sends: Vec<Send>,
    meter: Meter,
    pan: f64,
    open: bool,
    /// Indice en `Plan::inserts`, si el canal tiene insert
    insert: Option<usize>,
    leveler: Option<Leveler>,
}

struct Bus {
    key: String,
    gl: Smooth,
    gr: Smooth,
    out: usize,
    buf: Vec<f32>,
    meter: Meter,
    pan: f64,
    open: bool,
    /// Indice en `Plan::inserts`, si el bus tiene insert
    insert: Option<usize>,
    sends: Vec<Send>,
    leveler: Option<Leveler>,
}

/// Un insert activo de la mesa (canal o bus).
pub struct InsertRoute {
    pub key: String,
    pub send_device: String,
    pub return_device: String,
}

/// Salida de un insert: el audio seco que hay que entregar al procesador.
pub struct InsertSend {
    pub device: String,
    pub buf: Vec<f32>,
}

/// Audio que llega del procesador externo para un insert.
pub struct InsertFeed<'a> {
    pub data: &'a [f32],
    pub active: bool,
}

/// Balance estereo: -1 todo a la izquierda, 1 a la derecha.
fn balance(gain: f32, pan: f64) -> (f32, f32) {
    let p = if pan.is_finite() { pan.clamp(-1.0, 1.0) as f32 } else { 0.0 };
    let l = if p > 0.0 { 1.0 - p } else { 1.0 };
    let r = if p < 0.0 { 1.0 + p } else { 1.0 };
    (gain * l, gain * r)
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
    monitor_out: usize,
    /// Orden de proceso de los buses para que los envios lleguen antes.
    bus_order: Vec<usize>,
    music_fallback: bool,
    preview_fallback: bool,
    call_fallback: bool,
    pub monitor: Vec<f32>,
    pub program: Vec<f32>,
    /// Retorno para el que llama (mix-minus): todo menos su propia voz
    pub ret: Vec<f32>,
    /// Inserts activos, en el mismo orden que `insert_sends`
    pub inserts: Vec<InsertRoute>,
    /// Audio seco de cada insert (se entrega a la tarjeta de envio)
    pub insert_sends: Vec<InsertSend>,
    /// Tramo del canal ya con su fader (para envios y medidor)
    tmp: Vec<f32>,
    /// Tramo de entrada ya con gain/AGC, antes de inserts
    pre: Vec<f32>,
    /// Tramo del canal tras su nivelador
    lv: Vec<f32>,
}

/// Biquad estereo (formulas RBJ).
#[derive(Clone, Copy, Default)]
struct Biquad {
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
struct Leveler {
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
    fn new(cfg: &LevelerCfg) -> Option<Leveler> {
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
    fn carry(mut self, prev: Option<&Leveler>) -> Leveler {
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

    fn process(&mut self, buf: &mut [f32], frames: usize) {
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

/// Control automatico de ganancia por bloques, sencillo y estable.
#[derive(Clone, Copy)]
struct Agc {
    target_db: f32,
    max_gain_db: f32,
    up_db_s: f32,
    down_db_s: f32,
    gain_db: f32,
    ms: f32,
    primed: bool,
}

impl Agc {
    fn new(mode: &str) -> Option<Agc> {
        let (up, down) = match mode {
            "slow" => (1.5, 4.0),
            "fast" => (8.0, 16.0),
            _ => return None,
        };
        Some(Agc {
            target_db: -18.0,
            max_gain_db: 18.0,
            up_db_s: up,
            down_db_s: down,
            gain_db: 0.0,
            ms: 0.0,
            primed: false,
        })
    }

    fn gain_for(&mut self, buf: &[f32], frames: usize) -> f32 {
        let mut sum = 0.0f32;
        for f in buf {
            sum += f * f;
        }
        let n = buf.len().max(1) as f32;
        let inst = (sum / n).max(1e-12);
        let inst_db = 10.0 * inst.log10();
        if !inst.is_finite() || inst_db < -50.0 {
            return 10f32.powf(self.gain_db / 20.0);
        }
        let dt = frames as f32 / 48_000.0;
        if !self.primed {
            self.ms = inst;
            self.primed = true;
        } else {
            let coeff = 1.0 - (-dt / 3.0).exp();
            self.ms += coeff * (inst - self.ms);
        }
        let lufs = -0.691 + 10.0 * self.ms.max(1e-12).log10();
        let wanted = (self.target_db - lufs).clamp(-self.max_gain_db, self.max_gain_db);
        let delta = wanted - self.gain_db;
        let rate = if delta > 0.0 { self.up_db_s } else { self.down_db_s };
        self.gain_db += delta.clamp(-rate * dt, rate * dt);
        10f32.powf(self.gain_db / 20.0)
    }
}

/// Suma con ganancias distintas por lado (cada una en rampa).
fn add_scaled2(dst: &mut [f32], src: &[f32], gl: (f32, f32), gr: (f32, f32)) {
    let (mut l, sl) = gl;
    let (mut r, sr) = gr;
    for (d, s) in dst.chunks_exact_mut(2).zip(src.chunks_exact(2)) {
        l += sl;
        r += sr;
        d[0] += s[0] * l;
        d[1] += s[1] * r;
    }
}

fn scale2(buf: &mut [f32], gl: (f32, f32), gr: (f32, f32)) {
    let (mut l, sl) = gl;
    let (mut r, sr) = gr;
    if sl == 0.0 && sr == 0.0 && l == 1.0 && r == 1.0 {
        return;
    }
    for f in buf.chunks_exact_mut(2) {
        l += sl;
        r += sr;
        f[0] *= l;
        f[1] *= r;
    }
}

fn add_scaled(dst: &mut [f32], src: &[f32], g: (f32, f32)) {
    let (mut v, step) = g;
    for (d, s) in dst.chunks_exact_mut(2).zip(src.chunks_exact(2)) {
        v += step;
        d[0] += s[0] * v;
        d[1] += s[1] * v;
    }
}

/// Registra el insert de un canal o bus. Sin envio y retorno elegidos no hay
/// insert (asi el ajuste a medias suena directo).
fn insert_of(cfg: &InsertCfg, key: &str, inserts: &mut Vec<InsertRoute>) -> Option<usize> {
    if !cfg.enabled {
        return None;
    }
    let send = cfg.send_device_id.trim();
    let ret = cfg.return_device_id.trim();
    if send.is_empty() || ret.is_empty() {
        return None;
    }
    inserts.push(InsertRoute {
        key: key.to_string(),
        send_device: send.to_string(),
        return_device: ret.to_string(),
    });
    Some(inserts.len() - 1)
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
        let master_device = norm_device(&cfg.master_output_device_id);
        let default_out = out_index(&master_device, &mut outs);
        let monitor_out = out_index(&cfg.monitor_output_device_id, &mut outs);

        // Ganancias actuales del plan anterior (rampa en vez de salto).
        let prev_lr = |key: &str, l: f32, r: f32| -> (Smooth, Smooth) {
            let cur = prev.and_then(|p| {
                p.chans
                    .iter()
                    .find(|c| c.key == key)
                    .map(|c| (c.gl.cur, c.gr.cur))
                    .or_else(|| p.buses.iter().find(|b| b.key == key).map(|b| (b.gl.cur, b.gr.cur)))
            });
            let (cl, cr) = cur.unwrap_or((l, r));
            (Smooth { cur: cl, target: l }, Smooth { cur: cr, target: r })
        };
        let prev_send = |key: &str, bus: usize, target: f32| -> Smooth {
            let cur = prev
                .and_then(|p| p.chans.iter().find(|c| c.key == key))
                .and_then(|c| c.sends.iter().find(|s| s.bus == bus))
                .map(|s| s.g.cur);
            Smooth { cur: cur.unwrap_or(target), target }
        };

        let mut inserts: Vec<InsertRoute> = Vec::new();
        let mut buses = Vec::new();
        for b in &cfg.mixer_buses {
            let g = if b.muted { 0.0 } else { db_to_gain(b.gain_db) };
            let (l, r) = balance(g, b.pan);
            let out = if norm_device(&b.output_device_id) == DEFAULT_DEVICE {
                default_out
            } else {
                out_index(&b.output_device_id, &mut outs)
            };
            let key = format!("bus:{}", b.id);
            let (gl, gr) = prev_lr(&key, l, r);
            let insert = insert_of(&b.insert, &key, &mut inserts);
            let mut sends = Vec::new();
            for sc in &b.sends {
                let Some(target) = cfg.mixer_buses.iter().position(|x| x.id == sc.bus_id) else { continue };
                if target == buses.len() { continue; }
                let base = if sc.muted { 0.0 } else { db_to_gain(sc.gain_db) };
                let level = if sc.pre { if !b.muted { base } else { 0.0 } } else { base };
                sends.push(Send { bus: target, g: Smooth::new(level), pre: sc.pre });
            }
            let leveler = Leveler::new(&b.leveler).map(|lv| {
                lv.carry(prev.and_then(|p| p.buses.iter().find(|x| x.key == key)).and_then(|x| x.leveler.as_ref()))
            });
            buses.push(Bus {
                leveler,
                gl,
                gr,
                key,
                out,
                buf: buf(),
                meter: Meter::default(),
                pan: b.pan,
                open: !b.muted,
                insert,
                sends,
            });
        }
        let bus_ids: Vec<&str> = cfg.mixer_buses.iter().map(|b| b.id.as_str()).collect();
        let bus_order = {
            let n = buses.len();
            let mut indeg = vec![0usize; n];
            for b in &buses {
                for s in &b.sends {
                    if s.bus < n {
                        indeg[s.bus] += 1;
                    }
                }
            }
            let mut queue: Vec<usize> = (0..n).filter(|i| indeg[*i] == 0).collect();
            let mut order = Vec::with_capacity(n);
            while let Some(i) = queue.pop() {
                order.push(i);
                for s in &buses[i].sends {
                    if s.bus >= n {
                        continue;
                    }
                    indeg[s.bus] -= 1;
                    if indeg[s.bus] == 0 {
                        queue.push(s.bus);
                    }
                }
            }
            if order.len() == n {
                order
            } else {
                (0..n).collect()
            }
        };

        let any_solo = cfg.mixer_channels.iter().any(|c| c.solo);
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
            } else if norm_device(&c.output.id) == DEFAULT_DEVICE {
                Dest::Out(default_out)
            } else {
                Dest::Out(out_index(&c.output.id, &mut outs))
            };
            // Con algun canal en solo, los demas se callan (solo en el sitio).
            let open = !c.muted && (!any_solo || c.solo);
            let g = if open { db_to_gain(c.gain_db) } else { 0.0 };
            let (l, r) = balance(g, c.pan);
            let key = format!("ch:{}", c.id);
            let (gl, gr) = prev_lr(&key, l, r);
            let mut sends = Vec::new();
            for sc in &c.sends {
                let Some(bus) = bus_ids.iter().position(|id| *id == sc.bus_id) else { continue };
                // No se envia a su propio bus de salida (se sumaria dos veces).
                if matches!(dest, Dest::Bus(d) if d == bus) {
                    continue;
                }
                let base = if sc.muted { 0.0 } else { db_to_gain(sc.gain_db) };
                let target = if sc.pre { if open { base } else { 0.0 } } else { base };
                sends.push(Send { bus, g: prev_send(&key, bus, target), pre: sc.pre });
            }
            let insert = insert_of(&c.insert, &key, &mut inserts);
            let input_gain = if c.input_gain_db <= MIN_GAIN_DB {
                0.0
            } else {
                10f64.powf(c.input_gain_db.min(24.0) / 20.0) as f32
            };
            let agc = Agc::new(&c.agc);
            let leveler = Leveler::new(&c.leveler).map(|lv| {
                lv.carry(prev.and_then(|p| p.chans.iter().find(|x| x.key == key)).and_then(|x| x.leveler.as_ref()))
            });
            chans.push(Chan {
                leveler,
                gl,
                gr,
                key,
                src,
                input_gain,
                agc,
                dest,
                sends,
                meter: Meter::default(),
                pan: c.pan,
                open,
                insert,
            });
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
        let insert_sends: Vec<InsertSend> = inserts
            .iter()
            .map(|i| InsertSend { device: i.send_device.clone(), buf: buf() })
            .collect();
        Plan {
            chans,
            buses,
            outs,
            inputs,
            inserts,
            insert_sends,
            monitor_bus,
            stream_out,
            default_out,
            monitor_out,
            bus_order,
            music_fallback: !music,
            preview_fallback: !preview,
            call_fallback: !call,
            monitor: buf(),
            program: buf(),
            ret: buf(),
            lv: buf(),
            tmp: buf(),
            pre: buf(),
        }
    }

    /// Mueve un fader en vivo (mientras se arrastra), sin rehacer la mesa.
    pub fn live_gain(&mut self, key: &str, db: f64) {
        if let Some(c) = self.chans.iter_mut().find(|c| c.key == key) {
            let (l, r) = balance(if c.open { db_to_gain(db) } else { 0.0 }, c.pan);
            c.gl.target = l;
            c.gr.target = r;
        } else if let Some(b) = self.buses.iter_mut().find(|b| b.key == key) {
            let (l, r) = balance(if b.open { db_to_gain(db) } else { 0.0 }, b.pan);
            b.gl.target = l;
            b.gr.target = r;
        }
    }

    /// Picos de cada canal y bus desde la ultima lectura (y los reinicia).
    pub fn take_meters(&mut self) -> Vec<(String, f32, f32)> {
        let mut out = Vec::with_capacity(self.chans.len() + self.buses.len());
        for c in self.chans.iter_mut() {
            out.push((c.key.clone(), c.meter.l, c.meter.r));
            c.meter = Meter::default();
        }
        for b in self.buses.iter_mut() {
            out.push((b.key.clone(), b.meter.l, b.meter.r));
            b.meter = Meter::default();
        }
        out
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

    /// Indice de la salida que usa la tarjeta reloj (Master).
    pub fn master_out_index(&self) -> usize {
        self.default_out
    }

    /// Tarjeta de salida del Master.
    pub fn master_device(&self) -> String {
        self.outs[self.default_out].device.clone()
    }

    /// Tarjetas secundarias que el motor debe abrir (sin la del Master).
    pub fn output_devices(&self) -> Vec<String> {
        self.outs
            .iter()
            .enumerate()
            .filter(|(i, _)| *i != self.default_out)
            .map(|(_, o)| o.device.clone())
            .collect()
    }

    /// Tarjetas de envio y entradas de retorno de los inserts activos.
    pub fn insert_devices(&self) -> (Vec<String>, Vec<String>) {
        let mut sends = Vec::new();
        let mut returns = Vec::new();
        for i in &self.inserts {
            if !sends.contains(&i.send_device) {
                sends.push(i.send_device.clone());
            }
            if !returns.contains(&i.return_device) {
                returns.push(i.return_device.clone());
            }
        }
        (sends, returns)
    }

    /// Mezcla un bloque de `frames` (<= MAX_BLOCK). Las fuentes son estereo
    /// entrelazado; `inputs[i]` corresponde a `self.inputs[i]`.
    pub fn render(&mut self, frames: usize, music: &[f32], preview: &[f32], call: &[f32], inputs: &[&[f32]]) {
        self.render_inserts(frames, music, preview, call, inputs, &[]);
    }

    /// Igual que `render`, pero con el audio que devuelven los procesadores
    /// externos de los inserts (`insert_returns[i]` para `inserts[i]`).
    pub fn render_inserts(
        &mut self,
        frames: usize,
        music: &[f32],
        preview: &[f32],
        call: &[f32],
        inputs: &[&[f32]],
        insert_returns: &[InsertFeed],
    ) {
        let n = frames.min(MAX_BLOCK) * 2;
        for b in self.buses.iter_mut() {
            b.buf[..n].iter_mut().for_each(|x| *x = 0.0);
        }
        for o in self.outs.iter_mut() {
            o.buf[..n].iter_mut().for_each(|x| *x = 0.0);
        }
        for s in self.insert_sends.iter_mut() {
            s.buf[..n].iter_mut().for_each(|x| *x = 0.0);
        }
        self.ret[..n].iter_mut().for_each(|x| *x = 0.0);
        let silence: &[f32] = &[];
        for c in self.chans.iter_mut() {
            let raw: &[f32] = match c.src {
                Source::Music => music,
                Source::Preview => preview,
                Source::Call => call,
                Source::Input(i) => inputs.get(i).copied().unwrap_or(silence),
            };
            let mut src = raw;
            if raw.len() >= n {
                let gain = match c.agc.as_mut() {
                    Some(agc) => agc.gain_for(&raw[..n], frames),
                    None => c.input_gain,
                };
                let pre = &mut self.pre[..n];
                for (d, s) in pre.chunks_exact_mut(2).zip(raw[..n].chunks_exact(2)) {
                    d[0] = s[0] * gain;
                    d[1] = s[1] * gain;
                }
                src = &self.pre[..n];
            }
            // Insert de canal: se envia la senal seca y, si el procesador ya
            // devuelve audio, se usa el retorno en lugar del seco.
            if let Some(ii) = c.insert {
                let has_src = src.len() >= n;
                if let Some(send) = self.insert_sends.get_mut(ii) {
                    if has_src {
                        for (d, s) in send.buf[..n].chunks_exact_mut(2).zip(src[..n].chunks_exact(2)) {
                            d[0] += s[0];
                            d[1] += s[1];
                        }
                    }
                }
                if let Some(feed) = insert_returns.get(ii) {
                    if has_src && feed.active && feed.data.len() >= n {
                        src = &feed.data[..n];
                    }
                }
            }
            if let Some(lv) = c.leveler.as_mut() {
                if src.len() >= n {
                    self.lv[..n].copy_from_slice(&src[..n]);
                    lv.process(&mut self.lv[..n], frames);
                    src = &self.lv[..n];
                }
            }
            let gl = c.gl.gains(frames);
            let gr = c.gr.gains(frames);
            let sends: &mut Vec<Send> = &mut c.sends;
            if src.len() < n {
                for s in sends.iter_mut() {
                    s.g.gains(frames);
                }
                continue;
            }
            // Canal con su fader en `tmp`: salida, envios post y medidor.
            let tmp = &mut self.tmp[..n];
            tmp.iter_mut().for_each(|x| *x = 0.0);
            add_scaled2(tmp, &src[..n], gl, gr);
            c.meter.feed(tmp);
            if c.src != Source::Call {
                for (o, v) in self.ret[..n].iter_mut().zip(tmp.iter()) {
                    *o += *v;
                }
            }
            let dst = match c.dest {
                Dest::Bus(i) => &mut self.buses[i].buf[..n],
                Dest::Out(i) => &mut self.outs[i].buf[..n],
            };
            for (o, v) in dst.iter_mut().zip(tmp.iter()) {
                *o += *v;
            }
            for s in sends.iter_mut() {
                let g = s.g.gains(frames);
                let bus = &mut self.buses[s.bus].buf[..n];
                if s.pre {
                    add_scaled(bus, &src[..n], g);
                } else {
                    add_scaled(bus, tmp, g);
                }
            }
        }
        // Fuentes de la app sin canal: salen por la predeterminada para no
        // dejar la radio muda por una configuracion a medias.
        let d = self.default_out;
        for (used, src, out) in [
            (self.music_fallback, music, d),
            (self.preview_fallback, preview, self.monitor_out),
            (self.call_fallback, call, d),
        ] {
            if used && src.len() >= n {
                add_scaled(&mut self.outs[out].buf[..n], &src[..n], (1.0, 0.0));
            }
        }
        if self.music_fallback && music.len() >= n {
            add_scaled(&mut self.ret[..n], &music[..n], (1.0, 0.0));
        }
        for bi in self.bus_order.clone() {
            let b = &mut self.buses[bi];
            // Insert de bus: se envia la suma del bus antes del fader/pan y,
            // cuando hay retorno, este sustituye al seco (igual que en el web).
            if let Some(ii) = b.insert {
                if let Some(send) = self.insert_sends.get_mut(ii) {
                    for (d, s) in send.buf[..n].chunks_exact_mut(2).zip(b.buf[..n].chunks_exact(2)) {
                        d[0] += s[0];
                        d[1] += s[1];
                    }
                }
                if let Some(feed) = insert_returns.get(ii) {
                    if feed.active && feed.data.len() >= n {
                        b.buf[..n].copy_from_slice(&feed.data[..n]);
                    }
                }
            }
            if let Some(lv) = b.leveler.as_mut() {
                lv.process(&mut b.buf[..n], frames);
            }
            if b.sends.iter().any(|s| s.pre) {
                self.pre[..n].copy_from_slice(&b.buf[..n]);
            }
            let gl = b.gl.gains(frames);
            let gr = b.gr.gains(frames);
            scale2(&mut b.buf[..n], gl, gr);
            b.meter.feed(&b.buf[..n]);
            if !b.sends.is_empty() {
                self.tmp[..n].copy_from_slice(&b.buf[..n]);
            }
            let out = &mut self.outs[b.out].buf[..n];
            for (o, s) in out.iter_mut().zip(b.buf[..n].iter()) {
                *o += *s;
            }
            if self.monitor_bus == Some(bi) {
                self.monitor[..n].copy_from_slice(&b.buf[..n]);
            }
            let mut send_ops: Vec<(usize, (f32, f32), bool)> = Vec::new();
            for s in b.sends.iter_mut() {
                let g = s.g.gains(frames);
                send_ops.push((s.bus, g, s.pre));
            }
            for (target, g, pre) in send_ops {
                if target >= self.buses.len() || target == bi {
                    continue;
                }
                let src = if pre { &self.pre[..n] } else { &self.tmp[..n] };
                add_scaled(&mut self.buses[target].buf[..n], src, g);
            }
        }
        for o in self.outs.iter_mut() {
            let g = o.vol.gains(frames);
            scale(&mut o.buf[..n], g);
        }
        if self.monitor_bus.is_none() {
            self.monitor[..n].copy_from_slice(&self.outs[self.monitor_out].buf[..n]);
        }
        match self.stream_out {
            Some(s) => self.program[..n].copy_from_slice(&self.outs[s].buf[..n]),
            None => self.program[..n].copy_from_slice(&self.monitor[..n]),
        }
    }
}
