//! Mesa de mezclas nativa: canales -> buses o salidas, buses -> salidas.
//!
//! `Plan::build` traduce la configuracion (la misma de Ajustes) a una
//! estructura por indices, con los buffers ya reservados, para que el render
//! del hilo de audio no reserve memoria ni busque por nombre.

use serde::Deserialize;

pub const DEFAULT_DEVICE: &str = "default";
pub const STREAM_DEVICE: &str = "streaming";
/// Salida «Ninguna»: la senal no va a ninguna tarjeta (solo envios).
pub const NONE_DEVICE: &str = "none";
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

/// Id de captura de una entrada: `nombre` (canales 1-2), `nombre#P` (par P) o
/// `nombre!K` (un solo canal K, para canales en mono).
fn input_key(name: &str, channel: u32, mono: bool) -> String {
    if name == NONE_DEVICE {
        return name.to_string();
    }
    if mono && channel > 0 {
        return format!("{name}!{channel}");
    }
    let pair = channel.max(1);
    if pair == 1 {
        name.to_string()
    } else {
        format!("{name}#{pair}")
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
    /// Estereo: par de canales (1 = 1-2...). Mono: canal de la tarjeta (0 = los dos lados)
    pub channel: u32,
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

#[derive(Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct ChannelCfg {
    pub id: String,
    pub input: InputCfg,
    pub output: OutputCfg,
    pub gain_db: f64,
    pub muted: bool,
    pub pan: f64,
    pub solo: bool,
    /// "" (estereo), "sum" (L+R), "left" (solo L) o "right" (solo R), sacado por los dos lados
    pub mono_mode: String,
    pub sends: Vec<SendCfg>,
    pub insert: InsertCfg,
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
    /// Ganancia final por lado: fader, silencio, solo y panorama
    gl: Smooth,
    gr: Smooth,
    dest: Dest,
    sends: Vec<Send>,
    meter: Meter,
    pan: f64,
    open: bool,
    /// 0 estereo, 1 suma L+R, 2 solo L, 3 solo R
    mono: u8,
    /// Indice en `Plan::inserts`, si el canal tiene insert
    insert: Option<usize>,
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
    pub monitor: Vec<f32>,
    pub program: Vec<f32>,
    /// Retorno a los que llaman: todo menos su propia voz (mix-minus)
    pub ret: Vec<f32>,
    /// Tramo del canal ya con su fader (para envios y medidor)
    tmp: Vec<f32>,
    mono: Vec<f32>,
    /// Inserts activos, en el mismo orden que `insert_sends`
    pub inserts: Vec<InsertRoute>,
    /// Audio seco de cada insert (se entrega a la tarjeta de envio)
    pub insert_sends: Vec<InsertSend>,
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
    inserts.push(InsertRoute { key: key.to_string(), send_device: send.to_string(), return_device: ret.to_string() });
    Some(inserts.len() - 1)
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
            let out = out_index(&b.output_device_id, &mut outs);
            let key = format!("bus:{}", b.id);
            let (gl, gr) = prev_lr(&key, l, r);
            let insert = insert_of(&b.insert, &key, &mut inserts);
            buses.push(Bus { gl, gr, key, out, buf: buf(), meter: Meter::default(), pan: b.pan, open: !b.muted, insert });
        }
        let bus_ids: Vec<&str> = cfg.mixer_buses.iter().map(|b| b.id.as_str()).collect();

        let any_solo = cfg.mixer_channels.iter().any(|c| c.solo);
        let mut inputs: Vec<String> = Vec::new();
        let mut chans = Vec::new();
        for c in &cfg.mixer_channels {
            let src = if c.input.kind == "app" {
                match c.input.app.as_str() {
                    "preview" => {
                        Source::Preview
                    }
                    "call" => {
                        Source::Call
                    }
                    _ => {
                        Source::Music
                    }
                }
            } else {
                let name = norm_device(&c.input.device_id);
                let mono = !c.mono_mode.is_empty() && c.mono_mode != "off";
                let d = input_key(&name, c.input.channel, mono);
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
            chans.push(Chan { gl, gr, key, src, dest, sends, meter: Meter::default(), pan: c.pan, open, mono: match c.mono_mode.as_str() { "sum" => 1, "left" => 2, "right" => 3, _ => 0 }, insert });
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
        let insert_sends: Vec<InsertSend> =
            inserts.iter().map(|i| InsertSend { device: i.send_device.clone(), buf: buf() }).collect();
        Plan {
            chans,
            buses,
            outs,
            inputs,
            monitor_bus,
            stream_out,
            default_out,
            monitor: buf(),
            program: buf(),
            ret: buf(),
            tmp: buf(),
            mono: buf(),
            inserts,
            insert_sends,
        }
    }

    /// Hay algun canal con la musica de la app.
    pub fn has_music(&self) -> bool {
        self.chans.iter().any(|c| c.src == Source::Music)
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
        // Las entradas fisicas de los canales se capturan igual que los retornos.
        for i in &self.inputs {
            if i != NONE_DEVICE && !returns.contains(i) {
                returns.push(i.clone());
            }
        }
        (sends, returns)
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
        for s in self.insert_sends.iter_mut() {
            s.buf[..n].iter_mut().for_each(|x| *x = 0.0);
        }
        for b in self.buses.iter_mut() {
            b.buf[..n].iter_mut().for_each(|x| *x = 0.0);
        }
        for o in self.outs.iter_mut() {
            o.buf[..n].iter_mut().for_each(|x| *x = 0.0);
        }
        let silence: &[f32] = &[];
        self.ret[..n].iter_mut().for_each(|x| *x = 0.0);
        for c in self.chans.iter_mut() {
            let mut src: &[f32] = match c.src {
                Source::Music => music,
                Source::Preview => preview,
                Source::Call => call,
                Source::Input(i) => inputs.get(i).copied().unwrap_or(silence),
            };
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
            // Mono: L y R se mezclan y salen iguales por los dos lados.
            if c.mono != 0 && src.len() >= n {
                for (d, s) in self.mono[..n].chunks_exact_mut(2).zip(src[..n].chunks_exact(2)) {
                    let m = match c.mono {
                        2 => s[0],
                        3 => s[1],
                        _ => (s[0] + s[1]) * 0.5,
                    };
                    d[0] = m;
                    d[1] = m;
                }
                src = &self.mono[..n];
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
        // Una fuente de la app sin canal no sale por ningun sitio: la interfaz
        // lo avisa y deja crear el canal (nada de enrutados ocultos).
        for (bi, b) in self.buses.iter_mut().enumerate() {
            // Insert de bus: se envia la suma del bus antes del fader/pan y,
            // cuando hay retorno, este sustituye al seco.
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
            let gl = b.gl.gains(frames);
            let gr = b.gr.gains(frames);
            scale2(&mut b.buf[..n], gl, gr);
            b.meter.feed(&b.buf[..n]);
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
            self.monitor[..n].copy_from_slice(&self.outs[self.default_out].buf[..n]);
        }
        match self.stream_out {
            Some(s) => self.program[..n].copy_from_slice(&self.outs[s].buf[..n]),
            None => self.program[..n].copy_from_slice(&self.outs[self.default_out].buf[..n]),
        }
    }
}
