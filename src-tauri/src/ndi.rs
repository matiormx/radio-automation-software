//! NDI nativo, sin FFmpeg especial: se carga la libreria del NDI Runtime
//! (Processing.NDI.Lib.x64.dll en Windows, la instalan NDI Tools / NDI
//! Runtime) y se reciben las fuentes directamente.
//!
//! La imagen llega al WebView como MJPEG por un servidor local
//! (http://127.0.0.1:<puerto>/ndi?src=<nombre>), que un <img> pinta sin mas.

use std::collections::HashMap;
use std::ffi::{c_char, c_void, CStr, CString};
use std::io::{Read, Write};
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant};

use libloading::Library;
use serde::Serialize;

// ------------------------------------------------------------ API de NDI

#[repr(C)]
struct SourceT {
    name: *const c_char,
    url: *const c_char,
}

#[repr(C)]
struct FindCreate {
    show_local_sources: bool,
    groups: *const c_char,
    extra_ips: *const c_char,
}

#[repr(C)]
struct RecvCreateV3 {
    source: SourceT,
    color_format: i32,
    bandwidth: i32,
    allow_video_fields: bool,
    recv_name: *const c_char,
}

#[repr(C)]
struct VideoFrameV2 {
    xres: i32,
    yres: i32,
    fourcc: u32,
    frame_rate_n: i32,
    frame_rate_d: i32,
    aspect: f32,
    frame_format: i32,
    timecode: i64,
    data: *mut u8,
    line_stride: i32,
    metadata: *const c_char,
    timestamp: i64,
}

#[repr(C)]
struct SendCreate {
    name: *const c_char,
    groups: *const c_char,
    clock_video: bool,
    clock_audio: bool,
}

#[repr(C)]
struct AudioFrameV2 {
    sample_rate: i32,
    no_channels: i32,
    no_samples: i32,
    timecode: i64,
    data: *mut f32,
    channel_stride_in_bytes: i32,
    metadata: *const c_char,
    timestamp: i64,
}

/// NDIlib_send_timecode_synthesize: que NDI ponga la marca de tiempo.
const TIMECODE_SYNTH: i64 = i64::MAX;
const FOURCC_BGRA: u32 = (b'B' as u32) | ((b'G' as u32) << 8) | ((b'R' as u32) << 16) | ((b'A' as u32) << 24);
const FORMAT_PROGRESSIVE: i32 = 1;

const COLOR_BGRX_BGRA: i32 = 0;
const BANDWIDTH_HIGHEST: i32 = 100;
/// La version «proxy» que todo emisor NDI manda a la vez (poca red).
const BANDWIDTH_LOWEST: i32 = 0;

static MAX_HEIGHT: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(720);
static LOW_BANDWIDTH: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Tope de altura de la imagen recibida (0 = sin tope) y recepcion ligera.
/// La recepcion ligera se aplica al conectar de nuevo con la fuente.
pub fn set_limits(max_height: u32, low_bandwidth: bool) {
    use std::sync::atomic::Ordering::Relaxed;
    MAX_HEIGHT.store(max_height, Relaxed);
    LOW_BANDWIDTH.store(low_bandwidth, Relaxed);
}

/// Reduce una imagen BGRA compacta a `nh` lineas de alto (misma proporcion),
/// promediando 2x2 pixeles: barato y sin dientes de sierra.
fn downscale_bgra(src: &[u8], w: usize, h: usize, nh: usize, out: &mut Vec<u8>) -> usize {
    let nw = ((w * nh + h / 2) / h).max(2) & !1;
    out.resize(nw * nh * 4, 0);
    for y in 0..nh {
        let sy = y * h / nh;
        let sy2 = (sy + 1).min(h - 1);
        let (r0, r1) = (&src[sy * w * 4..(sy + 1) * w * 4], &src[sy2 * w * 4..(sy2 + 1) * w * 4]);
        let row = &mut out[y * nw * 4..(y + 1) * nw * 4];
        for x in 0..nw {
            let sx = x * w / nw;
            let sx2 = (sx + 1).min(w - 1);
            for c in 0..4 {
                let s = r0[sx * 4 + c] as u32 + r0[sx2 * 4 + c] as u32 + r1[sx * 4 + c] as u32 + r1[sx2 * 4 + c] as u32;
                row[x * 4 + c] = ((s + 2) / 4) as u8;
            }
        }
    }
    nw
}
const FRAME_VIDEO: i32 = 1;
const FRAME_AUDIO: i32 = 2;
const FRAME_ERROR: i32 = 4;
/// Sin nada nuevo por tanto tiempo, el watcher recrea el receptor de NDI.
const RECONNECT_AFTER: Duration = Duration::from_secs(10);

type FnInit = unsafe extern "C" fn() -> bool;
type FnFindCreate = unsafe extern "C" fn(*const FindCreate) -> *mut c_void;
type FnFindWait = unsafe extern "C" fn(*mut c_void, u32) -> bool;
type FnFindSources = unsafe extern "C" fn(*mut c_void, *mut u32) -> *const SourceT;
type FnRecvCreate = unsafe extern "C" fn(*const RecvCreateV3) -> *mut c_void;
type FnRecvDestroy = unsafe extern "C" fn(*mut c_void);
type FnRecvCapture = unsafe extern "C" fn(*mut c_void, *mut VideoFrameV2, *mut AudioFrameV2, *mut c_void, u32) -> i32;
type FnRecvFreeAudio = unsafe extern "C" fn(*mut c_void, *const AudioFrameV2);
type FnRecvFreeVideo = unsafe extern "C" fn(*mut c_void, *const VideoFrameV2);
type FnSendCreate = unsafe extern "C" fn(*const SendCreate) -> *mut c_void;
type FnSendDestroy = unsafe extern "C" fn(*mut c_void);
type FnSendVideo = unsafe extern "C" fn(*mut c_void, *const VideoFrameV2);
type FnSendAudio = unsafe extern "C" fn(*mut c_void, *const AudioFrameV2);

struct Api {
    _lib: Library,
    find_wait: FnFindWait,
    find_sources: FnFindSources,
    recv_create: FnRecvCreate,
    recv_destroy: FnRecvDestroy,
    recv_capture: FnRecvCapture,
    recv_free_video: FnRecvFreeVideo,
    recv_free_audio: FnRecvFreeAudio,
    send_create: FnSendCreate,
    send_destroy: FnSendDestroy,
    send_video: FnSendVideo,
    send_audio: FnSendAudio,
    /// Buscador de fuentes (uno para toda la app)
    finder: Mutex<usize>,
    find_create: FnFindCreate,
}

// Los punteros de NDI se usan desde varios hilos; la libreria lo permite.
unsafe impl Send for Api {}
unsafe impl Sync for Api {}

fn library_candidates() -> Vec<std::path::PathBuf> {
    let mut out = Vec::new();
    #[cfg(windows)]
    {
        for var in ["NDI_RUNTIME_DIR_V6", "NDI_RUNTIME_DIR_V5", "NDI_RUNTIME_DIR_V4"] {
            if let Ok(dir) = std::env::var(var) {
                out.push(std::path::Path::new(&dir).join("Processing.NDI.Lib.x64.dll"));
            }
        }
        for dir in [
            r"C:\Program Files\NDI\NDI 6 Runtime\v6",
            r"C:\Program Files\NDI\NDI 5 Runtime\v5",
            r"C:\Program Files\NDI\NDI 6 Tools\Runtime",
            r"C:\Program Files\NDI\NDI 5 Tools\Runtime",
        ] {
            out.push(std::path::Path::new(dir).join("Processing.NDI.Lib.x64.dll"));
        }
        // Junto a OmniCaster.exe o en el PATH
        out.push("Processing.NDI.Lib.x64.dll".into());
    }
    #[cfg(target_os = "linux")]
    {
        out.push("libndi.so.6".into());
        out.push("libndi.so.5".into());
        out.push("libndi.so".into());
    }
    #[cfg(target_os = "macos")]
    {
        out.push("/usr/local/lib/libndi.dylib".into());
        out.push("/Library/NDI SDK for Apple/lib/macOS/libndi.dylib".into());
    }
    out
}

fn load() -> Result<Api, String> {
    let mut last = String::from("no se encontró la librería de NDI");
    for path in library_candidates() {
        let is_path = path.components().count() > 1;
        if is_path && !path.is_file() {
            continue;
        }
        // SAFETY: es la libreria oficial de NDI; solo se resuelven simbolos conocidos.
        let lib = match unsafe { Library::new(&path) } {
            Ok(lib) => lib,
            Err(e) => {
                last = format!("{}: {e}", path.display());
                continue;
            }
        };
        unsafe {
            macro_rules! sym {
                ($name:literal, $t:ty) => {
                    match lib.get::<$t>($name) {
                        Ok(s) => *s,
                        Err(e) => {
                            last = format!("{} incompleta: {e}", path.display());
                            continue;
                        }
                    }
                };
            }
            let init: FnInit = sym!(b"NDIlib_initialize\0", FnInit);
            let find_create: FnFindCreate = sym!(b"NDIlib_find_create_v2\0", FnFindCreate);
            let find_wait: FnFindWait = sym!(b"NDIlib_find_wait_for_sources\0", FnFindWait);
            let find_sources: FnFindSources = sym!(b"NDIlib_find_get_current_sources\0", FnFindSources);
            let recv_create: FnRecvCreate = sym!(b"NDIlib_recv_create_v3\0", FnRecvCreate);
            let recv_destroy: FnRecvDestroy = sym!(b"NDIlib_recv_destroy\0", FnRecvDestroy);
            let recv_capture: FnRecvCapture = sym!(b"NDIlib_recv_capture_v2\0", FnRecvCapture);
            let recv_free_video: FnRecvFreeVideo = sym!(b"NDIlib_recv_free_video_v2\0", FnRecvFreeVideo);
            let recv_free_audio: FnRecvFreeAudio = sym!(b"NDIlib_recv_free_audio_v2\0", FnRecvFreeAudio);
            let send_create: FnSendCreate = sym!(b"NDIlib_send_create\0", FnSendCreate);
            let send_destroy: FnSendDestroy = sym!(b"NDIlib_send_destroy\0", FnSendDestroy);
            let send_video: FnSendVideo = sym!(b"NDIlib_send_send_video_v2\0", FnSendVideo);
            let send_audio: FnSendAudio = sym!(b"NDIlib_send_send_audio_v2\0", FnSendAudio);
            if !init() {
                last = "NDI no se pudo iniciar (¿procesador sin soporte?)".into();
                continue;
            }
            return Ok(Api {
                _lib: lib,
                find_wait,
                find_sources,
                recv_create,
                recv_destroy,
                recv_capture,
                recv_free_video,
                recv_free_audio,
                send_create,
                send_destroy,
                send_video,
                send_audio,
                finder: Mutex::new(0),
                find_create,
            });
        }
    }
    Err(format!(
        "NDI Runtime no encontrado ({last}). Instala «NDI Tools» o «NDI Runtime» (gratis, ndi.video)."
    ))
}

fn api() -> Result<&'static Api, String> {
    static API: OnceLock<Result<Api, String>> = OnceLock::new();
    API.get_or_init(load).as_ref().map_err(|e| e.clone())
}

/// Fuentes NDI visibles en la red (espera hasta `wait_ms` a que aparezcan).
pub fn sources(wait_ms: u32) -> Result<Vec<String>, String> {
    let api = api()?;
    let mut finder = api.finder.lock().map_err(|_| "NDI ocupado".to_string())?;
    if *finder == 0 {
        let cfg = FindCreate { show_local_sources: true, groups: std::ptr::null(), extra_ips: std::ptr::null() };
        let f = unsafe { (api.find_create)(&cfg) };
        if f.is_null() {
            return Err("NDI no pudo crear el buscador de fuentes".into());
        }
        *finder = f as usize;
    }
    let f = *finder as *mut c_void;
    let start = Instant::now();
    unsafe { (api.find_wait)(f, wait_ms) };
    // La primera vez tarda en llegar el anuncio de las fuentes.
    let mut list = Vec::new();
    loop {
        let mut n: u32 = 0;
        let ptr = unsafe { (api.find_sources)(f, &mut n) };
        list.clear();
        for i in 0..n as usize {
            let s = unsafe { &*ptr.add(i) };
            if !s.name.is_null() {
                list.push(unsafe { CStr::from_ptr(s.name) }.to_string_lossy().into_owned());
            }
        }
        if !list.is_empty() || start.elapsed() >= Duration::from_millis(wait_ms as u64) {
            break;
        }
        unsafe { (api.find_wait)(f, 250) };
    }
    list.sort();
    Ok(list)
}

// ------------------------------------------------------------ envio

/// Salida NDI: lo que se le da aparece en la red como una fuente NDI.
pub struct Sender {
    api: &'static Api,
    handle: usize,
}

unsafe impl Send for Sender {}
unsafe impl Sync for Sender {}

impl Sender {
    pub fn new(name: &str) -> Result<Sender, String> {
        let api = api()?;
        let cname = CString::new(name).map_err(|_| "nombre NDI no válido".to_string())?;
        let cfg = SendCreate { name: cname.as_ptr(), groups: std::ptr::null(), clock_video: false, clock_audio: false };
        let h = unsafe { (api.send_create)(&cfg) };
        if h.is_null() {
            return Err(format!("NDI no pudo crear la salida «{name}»"));
        }
        Ok(Sender { api, handle: h as usize })
    }

    /// Una imagen BGRA compacta (ancho*4 bytes por linea).
    pub fn video_bgra(&self, data: &mut [u8], width: i32, height: i32, fps: i32) {
        let frame = VideoFrameV2 {
            xres: width,
            yres: height,
            fourcc: FOURCC_BGRA,
            frame_rate_n: fps.max(1) * 1000,
            frame_rate_d: 1000,
            aspect: width as f32 / height.max(1) as f32,
            frame_format: FORMAT_PROGRESSIVE,
            timecode: TIMECODE_SYNTH,
            data: data.as_mut_ptr(),
            line_stride: width * 4,
            metadata: std::ptr::null(),
            timestamp: 0,
        };
        unsafe { (self.api.send_video)(self.handle as *mut c_void, &frame) };
    }

    /// PCM s16le estereo 48 kHz (lo de los encoders) a float planar de NDI.
    pub fn audio_s16_stereo(&self, pcm: &[u8], planar: &mut Vec<f32>) {
        let n = pcm.len() / 4;
        if n == 0 {
            return;
        }
        planar.resize(n * 2, 0.0);
        for i in 0..n {
            let l = i16::from_le_bytes([pcm[i * 4], pcm[i * 4 + 1]]) as f32 / 32768.0;
            let r = i16::from_le_bytes([pcm[i * 4 + 2], pcm[i * 4 + 3]]) as f32 / 32768.0;
            planar[i] = l;
            planar[n + i] = r;
        }
        let frame = AudioFrameV2 {
            sample_rate: 48_000,
            no_channels: 2,
            no_samples: n as i32,
            timecode: TIMECODE_SYNTH,
            data: planar.as_mut_ptr(),
            channel_stride_in_bytes: (n * 4) as i32,
            metadata: std::ptr::null(),
            timestamp: 0,
        };
        unsafe { (self.api.send_audio)(self.handle as *mut c_void, &frame) };
    }
}

impl Drop for Sender {
    fn drop(&mut self) {
        unsafe { (self.api.send_destroy)(self.handle as *mut c_void) };
    }
}

/// ¿Esta el NDI Runtime? (sin error = si)
pub fn runtime() -> Result<(), String> {
    api().map(|_| ())
}

// ------------------------------------------------------------ recepcion

#[derive(Default)]
struct Latest {
    /// Ultima imagen tal cual (BGRA compacta), para FFmpeg (/raw)
    raw: Arc<Vec<u8>>,
    raw_w: usize,
    raw_h: usize,
    raw_seq: u64,
    jpeg: Arc<Vec<u8>>,
    seq: u64,
    at: Option<Instant>,
    width: i32,
    height: i32,
    error: String,
}

struct Receiver {
    latest: Mutex<Latest>,
    cv: Condvar,
    /// Ultima vez que alguien pidio imagen (si nadie mira, se cierra)
    used: Mutex<Instant>,
    /// Quien escucha el audio (PCM s16le estereo a 48 kHz)
    audio: Mutex<Vec<std::sync::mpsc::SyncSender<Arc<Vec<u8>>>>>,
    /// Lectores MJPEG abiertos: sin ninguno no se comprime nada
    mjpeg_readers: std::sync::atomic::AtomicUsize,
    /// El receptor se cerro (el hilo del JPEG termina)
    closed: std::sync::atomic::AtomicBool,
}

impl Receiver {
    fn new() -> Receiver {
        Receiver {
            latest: Mutex::new(Latest::default()),
            cv: Condvar::new(),
            used: Mutex::new(Instant::now()),
            audio: Mutex::new(Vec::new()),
            mjpeg_readers: std::sync::atomic::AtomicUsize::new(0),
            closed: std::sync::atomic::AtomicBool::new(false),
        }
    }

    /// Reparte un bloque de audio a quien lo escucha.
    fn push_audio(&self, pcm: Vec<u8>) {
        let mut subs = self.audio.lock().unwrap_or_else(|e| e.into_inner());
        if subs.is_empty() {
            return;
        }
        let pcm = Arc::new(pcm);
        subs.retain(|tx| !matches!(tx.try_send(pcm.clone()), Err(std::sync::mpsc::TrySendError::Disconnected(_))));
        *self.used.lock().unwrap_or_else(|e| e.into_inner()) = Instant::now();
    }
}

/// Audio de NDI (float plano, cualquier frecuencia) a s16le estereo 48 kHz.
fn audio_to_s16(frame: &AudioFrameV2, phase: &mut f64) -> Vec<u8> {
    let n = frame.no_samples.max(0) as usize;
    let chans = frame.no_channels.max(0) as usize;
    if frame.data.is_null() || n == 0 || chans == 0 {
        return Vec::new();
    }
    let stride = (frame.channel_stride_in_bytes.max(0) as usize) / 4;
    let stride = if stride == 0 { n } else { stride };
    // SAFETY: NDI entrega `chans` canales de `stride` muestras cada uno.
    let left = unsafe { std::slice::from_raw_parts(frame.data, n) };
    let right = if chans > 1 { unsafe { std::slice::from_raw_parts(frame.data.add(stride), n) } } else { left };
    let rate = if frame.sample_rate > 0 { frame.sample_rate as f64 } else { 48_000.0 };
    let step = rate / 48_000.0;
    let s16 = |v: f32| ((v.clamp(-1.0, 1.0) * 32767.0) as i16).to_le_bytes();
    let mut out = Vec::with_capacity(((n as f64 / step) as usize + 2) * 4);
    if (step - 1.0).abs() < 1e-9 {
        for i in 0..n {
            out.extend_from_slice(&s16(left[i]));
            out.extend_from_slice(&s16(right[i]));
        }
        return out;
    }
    // Otra frecuencia: interpolacion lineal (la fase sigue entre bloques).
    let mut pos = *phase;
    while pos < (n - 1) as f64 {
        let i = pos as usize;
        let t = (pos - i as f64) as f32;
        out.extend_from_slice(&s16(left[i] + (left[i + 1] - left[i]) * t));
        out.extend_from_slice(&s16(right[i] + (right[i + 1] - right[i]) * t));
        pos += step;
    }
    *phase = pos - (n - 1) as f64;
    out
}

fn receivers() -> &'static Mutex<HashMap<String, Arc<Receiver>>> {
    static R: OnceLock<Mutex<HashMap<String, Arc<Receiver>>>> = OnceLock::new();
    R.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Receptor de una fuente (lo crea si no existe).
fn receiver(source: &str) -> Arc<Receiver> {
    let mut map = receivers().lock().unwrap_or_else(|e| e.into_inner());
    if let Some(r) = map.get(source) {
        *r.used.lock().unwrap_or_else(|e| e.into_inner()) = Instant::now();
        return r.clone();
    }
    let r = Arc::new(Receiver::new());
    map.insert(source.to_string(), r.clone());
    let name = source.to_string();
    let rr = r.clone();
    let _ = thread::Builder::new().name("miradio-ndi-recv".into()).spawn(move || {
        run_receiver(&name, rr.clone());
        rr.closed.store(true, std::sync::atomic::Ordering::SeqCst);
        rr.cv.notify_all();
    });
    let rj = r.clone();
    let _ = thread::Builder::new().name("miradio-ndi-jpeg".into()).spawn(move || run_jpeg(rj));
    r
}

/// Comprime a JPEG la ultima imagen recibida, solo si alguien la mira por
/// MJPEG (vista previa o pantalla de emision). Va en su propio hilo: el
/// receptor NDI no espera nunca al compresor (antes, comprimir cada imagen en
/// el mismo hilo retrasaba la recepcion y el video iba a tirones).
fn run_jpeg(r: Arc<Receiver>) {
    use std::sync::atomic::Ordering::SeqCst;
    let mut done = 0u64;
    let min_gap = Duration::from_millis(30);
    let mut last = Instant::now() - min_gap;
    loop {
        let (raw, w, h, seq) = {
            let mut l = r.latest.lock().unwrap_or_else(|e| e.into_inner());
            while l.raw_seq == done && !r.closed.load(SeqCst) {
                l = r.cv.wait_timeout(l, Duration::from_millis(500)).unwrap_or_else(|e| e.into_inner()).0;
            }
            if r.closed.load(SeqCst) {
                return;
            }
            (l.raw.clone(), l.raw_w, l.raw_h, l.raw_seq)
        };
        done = seq;
        if r.mjpeg_readers.load(SeqCst) == 0 || w == 0 || h == 0 || raw.len() < w * h * 4 {
            continue;
        }
        let wait = min_gap.saturating_sub(last.elapsed());
        if !wait.is_zero() {
            thread::sleep(wait);
        }
        last = Instant::now();
        let mut jpeg = Vec::with_capacity(w * h / 4);
        let enc = jpeg_encoder::Encoder::new(&mut jpeg, 80);
        if enc.encode(&raw, w as u16, h as u16, jpeg_encoder::ColorType::Bgra).is_ok() {
            let mut l = r.latest.lock().unwrap_or_else(|e| e.into_inner());
            l.jpeg = Arc::new(jpeg);
            l.seq += 1;
            r.cv.notify_all();
        }
    }
}

/// Encaja una imagen BGRA en `dw`x`dh` (con bandas negras), promediando 2x2.
fn fit_bgra(src: &[u8], sw: usize, sh: usize, dw: usize, dh: usize, out: &mut Vec<u8>) {
    out.clear();
    out.resize(dw * dh * 4, 0);
    for px in out.chunks_exact_mut(4) {
        px[3] = 255;
    }
    if sw == 0 || sh == 0 || src.len() < sw * sh * 4 {
        return;
    }
    let k = (dw as f64 / sw as f64).min(dh as f64 / sh as f64);
    let tw = ((sw as f64 * k).round() as usize).clamp(1, dw);
    let th = ((sh as f64 * k).round() as usize).clamp(1, dh);
    let (ox, oy) = ((dw - tw) / 2, (dh - th) / 2);
    for y in 0..th {
        let sy = y * sh / th;
        let sy2 = (sy + 1).min(sh - 1);
        let r0 = &src[sy * sw * 4..(sy + 1) * sw * 4];
        let r1 = &src[sy2 * sw * 4..(sy2 + 1) * sw * 4];
        let row = &mut out[((oy + y) * dw + ox) * 4..((oy + y) * dw + ox + tw) * 4];
        for x in 0..tw {
            let sx = x * sw / tw;
            let sx2 = (sx + 1).min(sw - 1);
            for c in 0..3 {
                let v = r0[sx * 4 + c] as u32 + r0[sx2 * 4 + c] as u32 + r1[sx * 4 + c] as u32 + r1[sx2 * 4 + c] as u32;
                row[x * 4 + c] = ((v + 2) / 4) as u8;
            }
            row[x * 4 + 3] = 255;
        }
    }
}

fn set_error(r: &Receiver, msg: String) {
    let mut l = r.latest.lock().unwrap_or_else(|e| e.into_inner());
    l.error = msg;
    r.cv.notify_all();
}

fn run_receiver(source: &str, r: Arc<Receiver>) {
    let api = match api() {
        Ok(a) => a,
        Err(e) => {
            set_error(&r, e);
            receivers().lock().unwrap_or_else(|e| e.into_inner()).remove(source);
            return;
        }
    };
    let cname = match CString::new(source) {
        Ok(c) => c,
        Err(_) => return,
    };
    let rname = CString::new("OmniCaster").unwrap_or_default();
    let cfg = RecvCreateV3 {
        source: SourceT { name: cname.as_ptr(), url: std::ptr::null() },
        color_format: COLOR_BGRX_BGRA,
        bandwidth: if LOW_BANDWIDTH.load(std::sync::atomic::Ordering::Relaxed) { BANDWIDTH_LOWEST } else { BANDWIDTH_HIGHEST },
        allow_video_fields: false,
        recv_name: rname.as_ptr(),
    };
    let mut recv = unsafe { (api.recv_create)(&cfg) };
    if recv.is_null() {
        set_error(&r, format!("No se pudo conectar con la fuente NDI «{source}»"));
        receivers().lock().unwrap_or_else(|e| e.into_inner()).remove(source);
        return;
    }
    // Como mucho ~30 imagenes/s: de una fuente a 50/60 se manda una de cada
    // dos, siempre la misma cadencia. (Antes se media el tiempo desde la
    // ultima y, con una fuente a 30/29,97, cualquier imagen que llegaba un
    // pelin antes de 33 ms se saltaba: el video iba a tirones.)
    let mut frame_no: u64 = 0;
    // Ultima vez que NDI entrego algo (video o audio): lo vigila el watcher.
    let mut last_data = Instant::now();
    let mut scratch: Vec<u8> = Vec::new();
    let mut small: Vec<u8> = Vec::new();
    let mut phase = 0.0f64;
    loop {
        // Nadie la mira desde hace 15 s: se cierra.
        if r.used.lock().map(|u| u.elapsed() > Duration::from_secs(15)).unwrap_or(true) {
            break;
        }
        let mut frame: VideoFrameV2 = unsafe { std::mem::zeroed() };
        let mut audio: AudioFrameV2 = unsafe { std::mem::zeroed() };
        let kind = unsafe { (api.recv_capture)(recv, &mut frame, &mut audio, std::ptr::null_mut(), 500) };
        if kind == FRAME_AUDIO {
            last_data = Instant::now();
            let pcm = audio_to_s16(&audio, &mut phase);
            unsafe { (api.recv_free_audio)(recv, &audio) };
            if !pcm.is_empty() {
                r.push_audio(pcm);
            }
            continue;
        }
        if kind == FRAME_ERROR {
            set_error(&r, "La fuente NDI se ha perdido".into());
            thread::sleep(Duration::from_millis(500));
        }
        // Watchdog: la reconexion interna de NDI no siempre basta (la fuente
        // puede estar apagada toda la noche y el receptor viejo no vuelve a
        // enlazarse). Sin nada nuevo durante RECONNECT_AFTER se tira el
        // receptor y se crea otro: al reaparecer la fuente vuelve solo.
        if last_data.elapsed() >= RECONNECT_AFTER {
            unsafe { (api.recv_destroy)(recv) };
            recv = unsafe { (api.recv_create)(&cfg) };
            last_data = Instant::now();
            if recv.is_null() {
                set_error(&r, format!("No se pudo reconectar con la fuente NDI «{source}»"));
            } else {
                set_error(&r, format!("Reconectando con la fuente NDI «{source}»…"));
            }
        }
        if kind == FRAME_ERROR {
            continue;
        }
        if kind != FRAME_VIDEO {
            continue;
        }
        last_data = Instant::now();
        let src_fps = if frame.frame_rate_d > 0 { frame.frame_rate_n as f64 / frame.frame_rate_d as f64 } else { 30.0 };
        let every = ((src_fps / 30.0).round() as u64).max(1);
        let keep = frame_no % every == 0;
        frame_no = frame_no.wrapping_add(1);
        if keep && !frame.data.is_null() && frame.xres > 0 && frame.yres > 0 {
            let (w, h, stride) = (frame.xres as usize, frame.yres as usize, frame.line_stride.max(0) as usize);
            // Copia compacta (sin el relleno de cada linea) para el codificador.
            scratch.resize(w * h * 4, 0);
            for y in 0..h {
                let src = unsafe { std::slice::from_raw_parts(frame.data.add(y * stride), w * 4) };
                scratch[y * w * 4..(y + 1) * w * 4].copy_from_slice(src);
            }
            unsafe { (api.recv_free_video)(recv, &frame) };
            // Tope de resolucion: se reduce antes de comprimir (lo caro es el JPEG).
            let max_h = MAX_HEIGHT.load(std::sync::atomic::Ordering::Relaxed) as usize;
            let (img, w, h) = if max_h >= 144 && h > max_h {
                let nw = downscale_bgra(&scratch, w, h, max_h, &mut small);
                (&small, nw, max_h)
            } else {
                (&scratch, w, h)
            };
            // Solo se guarda: el JPEG lo hace otro hilo y FFmpeg lee la imagen tal cual.
            let raw = Arc::new(img[..w * h * 4].to_vec());
            let mut l = r.latest.lock().unwrap_or_else(|e| e.into_inner());
            l.raw = raw;
            l.raw_w = w;
            l.raw_h = h;
            l.raw_seq += 1;
            l.at = Some(Instant::now());
            l.width = w as i32;
            l.height = h as i32;
            l.error.clear();
            r.cv.notify_all();
        } else {
            unsafe { (api.recv_free_video)(recv, &frame) };
        }
    }
    unsafe { (api.recv_destroy)(recv) };
    receivers().lock().unwrap_or_else(|e| e.into_inner()).remove(source);
}

// ------------------------------------------------------------ servidor MJPEG

/// Lector que entrega imagen tras imagen en multipart/x-mixed-replace.
struct MjpegStream {
    r: Arc<Receiver>,
    /// Para FFmpeg: si la fuente deja de mandar imagen, se corta el flujo
    /// (asi FFmpeg se entera y la emision pasa al respaldo).
    strict: bool,
    opened: Instant,
    seq: u64,
    buf: Vec<u8>,
    pos: usize,
}

impl Read for MjpegStream {
    fn read(&mut self, out: &mut [u8]) -> std::io::Result<usize> {
        if self.pos >= self.buf.len() {
            let mut l = self.r.latest.lock().unwrap_or_else(|e| e.into_inner());
            while l.seq == self.seq {
                *self.r.used.lock().unwrap_or_else(|e| e.into_inner()) = Instant::now();
                let (g, t) = self.r.cv.wait_timeout(l, Duration::from_secs(2)).unwrap_or_else(|e| e.into_inner());
                l = g;
                if t.timed_out() && l.seq == self.seq {
                    if self.strict {
                        let stale = match l.at {
                            Some(at) => at.elapsed() > Duration::from_secs(5),
                            None => self.opened.elapsed() > Duration::from_secs(15),
                        };
                        if stale {
                            return Ok(0);
                        }
                    }
                    if l.seq > 0 {
                        // Sin imagen nueva: se repite la ultima para mantener viva la conexion.
                        break;
                    }
                }
            }
            self.seq = l.seq;
            let jpeg = l.jpeg.clone();
            drop(l);
            self.buf.clear();
            self.buf.extend_from_slice(
                format!("--frame\r\nContent-Type: image/jpeg\r\nContent-Length: {}\r\n\r\n", jpeg.len()).as_bytes(),
            );
            self.buf.extend_from_slice(&jpeg);
            self.buf.extend_from_slice(b"\r\n");
            self.pos = 0;
        }
        let n = (self.buf.len() - self.pos).min(out.len());
        out[..n].copy_from_slice(&self.buf[self.pos..self.pos + n]);
        self.pos += n;
        Ok(n)
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Status {
    /// Milisegundos desde la ultima imagen (-1 = ninguna todavia)
    age_ms: i64,
    width: i32,
    height: i32,
    error: String,
}

fn query_src(url: &str) -> String {
    let q = url.split_once('?').map(|(_, q)| q).unwrap_or("");
    form_urlencoded::parse(q.as_bytes())
        .find(|(k, _)| k == "src")
        .map(|(_, v)| v.into_owned())
        .unwrap_or_default()
}

/// Direccion del servidor local de imagen NDI (lo arranca la primera vez).
pub fn server_url() -> Result<String, String> {
    static URL: OnceLock<Result<String, String>> = OnceLock::new();
    URL.get_or_init(|| {
        let server = tiny_http::Server::http("127.0.0.1:0").map_err(|e| e.to_string())?;
        let port = server.server_addr().to_ip().map(|a| a.port()).ok_or("sin puerto")?;
        let server = Arc::new(server);
        thread::Builder::new()
            .name("miradio-ndi-http".into())
            .spawn(move || {
                for req in server.incoming_requests() {
                    thread::spawn(move || serve(req));
                }
            })
            .map_err(|e| e.to_string())?;
        Ok(format!("http://127.0.0.1:{port}"))
    })
    .clone()
}

/// Imagen de «Lo que suena»: la dibuja la propia ventana (vídeo o portada,
/// titulo y artista) y la manda aqui como JPEG; las salidas la leen como
/// MJPEG en /np. Antes FFmpeg capturaba esa ventana escondida y Windows
/// dejaba de entregar imagen con una portada fija (se quedaba el ultimo
/// fotograma del videoclip).
fn np_receiver() -> Arc<Receiver> {
    static NP: OnceLock<Arc<Receiver>> = OnceLock::new();
    NP.get_or_init(|| Arc::new(Receiver::new())).clone()
}

#[tauri::command]
pub fn np_frame(request: tauri::ipc::Request<'_>) -> Result<(), String> {
    let tauri::ipc::InvokeBody::Raw(jpeg) = request.body() else {
        return Err("se esperaba un JPEG".into());
    };
    push_np(jpeg.clone())
}

fn push_np(jpeg: Vec<u8>) -> Result<(), String> {
    if jpeg.len() < 4 || jpeg[0] != 0xFF || jpeg[1] != 0xD8 {
        return Err("no es un JPEG".into());
    }
    let r = np_receiver();
    let mut l = r.latest.lock().unwrap_or_else(|e| e.into_inner());
    l.jpeg = Arc::new(jpeg);
    l.seq += 1;
    l.at = Some(Instant::now());
    l.error.clear();
    r.cv.notify_all();
    Ok(())
}

/// Última imagen (JPEG) de lo que se emite, para el monitor del móvil:
/// «np» = «Lo que suena»; «ndi:NOMBRE» = una fuente NDI que ya se esté
/// recibiendo (no se abre ninguna nueva desde el móvil).
pub fn snapshot_jpeg(src: &str) -> Option<Vec<u8>> {
    if src == "np" {
        let r = np_receiver();
        let l = r.latest.lock().unwrap_or_else(|e| e.into_inner());
        let fresh = l.at.map(|t| t.elapsed() < Duration::from_secs(10)).unwrap_or(false);
        return (l.seq > 0 && fresh).then(|| l.jpeg.as_ref().clone());
    }
    // Miniatura de una salida de vídeo monitorizada (la misma que se ve en
    // la pestaña Streaming): un solo FFmpeg sirve a los dos.
    if let Some(id) = src.strip_prefix("out:") {
        return crate::monitor::latest_jpeg(&format!("monitor:{id}"));
    }
    let name = src.strip_prefix("ndi:")?;
    let r = receivers().lock().unwrap_or_else(|e| e.into_inner()).get(name).cloned()?;
    // El JPEG solo se hace si alguien mira: se mira un momento y se espera
    // a la siguiente imagen (como mucho 1,5 s).
    let _reader = ReaderGuard::new(r.clone());
    let mut l = r.latest.lock().unwrap_or_else(|e| e.into_inner());
    let start_seq = l.seq;
    let deadline = Instant::now() + Duration::from_millis(1500);
    while l.seq == start_seq && Instant::now() < deadline {
        l = r.cv.wait_timeout(l, Duration::from_millis(100)).unwrap_or_else(|e| e.into_inner()).0;
    }
    (l.seq > 0 && !l.jpeg.is_empty()).then(|| l.jpeg.as_ref().clone())
}

/// Entrada de FFmpeg con la imagen de «Lo que suena».
pub fn ffmpeg_np_input() -> Result<Vec<String>, String> {
    let base = server_url()?;
    Ok(vec![
        "-thread_queue_size".into(),
        "512".into(),
        "-use_wallclock_as_timestamps".into(),
        "1".into(),
        "-f".into(),
        "mpjpeg".into(),
        "-i".into(),
        format!("{base}/np"),
    ])
}

fn serve(req: tiny_http::Request) {
    let url = req.url().to_string();
    if url.starts_with("/np") {
        serve_mjpeg(req, np_receiver(), false);
        return;
    }
    let src = query_src(&url);
    let cors = tiny_http::Header::from_bytes(&b"Access-Control-Allow-Origin"[..], &b"*"[..]).ok();
    if src.is_empty() {
        let _ = req.respond(tiny_http::Response::from_string("falta src").with_status_code(400));
        return;
    }
    let r = receiver(&src);
    if url.starts_with("/status") {
        let l = r.latest.lock().unwrap_or_else(|e| e.into_inner());
        let st = Status {
            age_ms: l.at.map(|t| t.elapsed().as_millis() as i64).unwrap_or(-1),
            width: l.width,
            height: l.height,
            error: l.error.clone(),
        };
        drop(l);
        let mut resp = tiny_http::Response::from_string(serde_json::to_string(&st).unwrap_or_default());
        if let Some(h) = cors {
            resp.add_header(h);
        }
        if let Ok(h) = tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]) {
            resp.add_header(h);
        }
        let _ = req.respond(resp);
        return;
    }
    if url.starts_with("/audio") {
        serve_audio(req, r);
        return;
    }
    if url.starts_with("/raw") {
        let w = query_num(&url, "w").unwrap_or(1280).clamp(16, 7680) & !1;
        let h = query_num(&url, "h").unwrap_or(720).clamp(16, 4320) & !1;
        let fps = query_num(&url, "fps").unwrap_or(25).clamp(1, 120);
        serve_raw(req, r, w, h, fps, url.contains("strict=1"));
        return;
    }
    // /ndi?src=… : MJPEG continuo. Se escribe directamente en el socket y se
    // vacia tras cada imagen (con la respuesta normal de tiny_http la imagen se
    // quedaria esperando en un bufer).
    serve_mjpeg(req, r, url.contains("strict=1"));
}

/// Cuenta los lectores MJPEG mientras dura la conexion.
struct ReaderGuard(Arc<Receiver>);
impl ReaderGuard {
    fn new(r: Arc<Receiver>) -> ReaderGuard {
        r.mjpeg_readers.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        r.cv.notify_all();
        ReaderGuard(r)
    }
}
impl Drop for ReaderGuard {
    fn drop(&mut self) {
        self.0.mjpeg_readers.fetch_sub(1, std::sync::atomic::Ordering::SeqCst);
    }
}

fn query_num(url: &str, key: &str) -> Option<usize> {
    let q = url.split_once('?').map(|(_, q)| q).unwrap_or("");
    form_urlencoded::parse(q.as_bytes()).find(|(k, _)| k == key).and_then(|(_, v)| v.parse().ok())
}

/// /raw?src=…&w=…&h=…&fps=… : imagen BGRA sin comprimir a ritmo fijo, para
/// FFmpeg (-f rawvideo). Cada «tic» manda la ultima imagen recibida (si no
/// llega una nueva se repite la anterior), asi el video sale con marcas de
/// tiempo perfectas aunque la red entregue las imagenes a destiempo. Sin
/// JPEG de ida y vuelta: menos CPU y sin perdida.
fn serve_raw(req: tiny_http::Request, r: Arc<Receiver>, w: usize, h: usize, fps: usize, strict: bool) {
    let mut out = req.into_writer();
    let head = "HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\nCache-Control: no-cache\r\nConnection: close\r\n\r\n";
    if out.write_all(head.as_bytes()).and_then(|_| out.flush()).is_err() {
        return;
    }
    let tick = Duration::from_secs_f64(1.0 / fps.max(1) as f64);
    let opened = Instant::now();
    let mut next = Instant::now();
    let mut frame: Vec<u8> = Vec::new();
    fit_bgra(&[], 0, 0, w, h, &mut frame); // negro hasta la primera imagen
    let mut have = 0u64;
    loop {
        *r.used.lock().unwrap_or_else(|e| e.into_inner()) = Instant::now();
        let (raw, sw, sh, seq, at) = {
            let l = r.latest.lock().unwrap_or_else(|e| e.into_inner());
            (l.raw.clone(), l.raw_w, l.raw_h, l.raw_seq, l.at)
        };
        if strict {
            let stale = match at {
                Some(at) => at.elapsed() > Duration::from_secs(5),
                None => opened.elapsed() > Duration::from_secs(15),
            };
            if stale {
                return; // FFmpeg se entera y la salida pasa al respaldo
            }
        }
        if seq != have && sw > 0 {
            have = seq;
            if sw == w && sh == h && raw.len() >= w * h * 4 {
                frame.clear();
                frame.extend_from_slice(&raw[..w * h * 4]);
            } else {
                fit_bgra(&raw, sw, sh, w, h, &mut frame);
            }
        }
        if out.write_all(&frame).and_then(|_| out.flush()).is_err() {
            return;
        }
        next += tick;
        let now = Instant::now();
        if next > now {
            thread::sleep(next - now);
        } else if now - next > tick * 5 {
            next = now; // FFmpeg se retraso: no se intenta recuperar de golpe
        }
    }
}

fn serve_mjpeg(req: tiny_http::Request, r: Arc<Receiver>, strict: bool) {
    let _reader = ReaderGuard::new(r.clone());
    let mut stream = MjpegStream { r, strict, opened: Instant::now(), seq: 0, buf: Vec::new(), pos: 0 };
    let mut w = req.into_writer();
    let head = "HTTP/1.1 200 OK\r\nContent-Type: multipart/x-mixed-replace; boundary=frame\r\n\
                Cache-Control: no-cache, no-store\r\nAccess-Control-Allow-Origin: *\r\nConnection: close\r\n\r\n";
    if w.write_all(head.as_bytes()).and_then(|_| w.flush()).is_err() {
        return;
    }
    let mut chunk = vec![0u8; 64 * 1024];
    loop {
        // Una imagen completa por vuelta (el lector la entrega entera).
        let n = match stream.read(&mut chunk) {
            Ok(0) | Err(_) => return,
            Ok(n) => n,
        };
        if w.write_all(&chunk[..n]).is_err() {
            return;
        }
        if stream.pos >= stream.buf.len() && w.flush().is_err() {
            return;
        }
    }
}

/// /audio?src=… : PCM s16le estereo 48 kHz sin fin (para FFmpeg). Si la
/// fuente no manda audio se rellena con silencio para no cortar la emision.
fn serve_audio(req: tiny_http::Request, r: Arc<Receiver>) {
    let (tx, rx) = std::sync::mpsc::sync_channel::<Arc<Vec<u8>>>(64);
    r.audio.lock().unwrap_or_else(|e| e.into_inner()).push(tx);
    let mut w = req.into_writer();
    let head = "HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\n\
                Cache-Control: no-cache, no-store\r\nConnection: close\r\n\r\n";
    if w.write_all(head.as_bytes()).and_then(|_| w.flush()).is_err() {
        return;
    }
    let gap = Duration::from_millis(100);
    let silence = vec![0u8; 48_000 / 10 * 4];
    loop {
        *r.used.lock().unwrap_or_else(|e| e.into_inner()) = Instant::now();
        let ok = match rx.recv_timeout(gap) {
            Ok(pcm) => w.write_all(&pcm),
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => w.write_all(&silence),
            Err(_) => return,
        };
        if ok.and_then(|_| w.flush()).is_err() {
            return;
        }
    }
}

/// Argumentos de FFmpeg para recibir una fuente NDI con el NDI Runtime (sin
/// FFmpeg especial): la imagen como MJPEG y, si se pide, el audio como PCM.
/// Entrada de FFmpeg con una fuente NDI: imagen sin comprimir a ritmo fijo,
/// ya del tamaño y los fps de la salida.
pub fn ffmpeg_video_input(source: &str, width: u32, height: u32, fps: u32) -> Result<Vec<String>, String> {
    runtime()?;
    Ok(ffmpeg_video_input_at(&server_url()?, source, width, height, fps))
}

fn ffmpeg_video_input_at(base: &str, source: &str, width: u32, height: u32, fps: u32) -> Vec<String> {
    let src: String = form_urlencoded::byte_serialize(source.as_bytes()).collect();
    let (w, h, fps) = (width.clamp(16, 7680) & !1, height.clamp(16, 4320) & !1, fps.clamp(1, 120));
    vec![
        "-thread_queue_size".into(),
        "64".into(),
        "-f".into(),
        "rawvideo".into(),
        "-pix_fmt".into(),
        "bgra".into(),
        "-video_size".into(),
        format!("{w}x{h}"),
        "-framerate".into(),
        fps.to_string(),
        "-i".into(),
        format!("{base}/raw?src={src}&w={w}&h={h}&fps={fps}&strict=1"),
    ]
}

pub fn ffmpeg_audio_input(source: &str) -> Result<Vec<String>, String> {
    runtime()?;
    let base = server_url()?;
    let src: String = form_urlencoded::byte_serialize(source.as_bytes()).collect();
    Ok(vec![
        "-thread_queue_size".into(),
        "1024".into(),
        "-f".into(),
        "s16le".into(),
        "-ar".into(),
        "48000".into(),
        "-ac".into(),
        "2".into(),
        "-i".into(),
        format!("{base}/audio?src={src}"),
    ])
}

// ------------------------------------------------------------ comandos

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeNdi {
    pub available: bool,
    pub error: Option<String>,
    pub sources: Vec<String>,
    /// http://127.0.0.1:<puerto> para la imagen y el estado
    pub server: String,
}

#[tauri::command]
pub async fn ndi_native() -> NativeNdi {
    tauri::async_runtime::spawn_blocking(|| match sources(2000) {
        Ok(sources) => NativeNdi { available: true, error: None, sources, server: server_url().unwrap_or_default() },
        Err(error) => NativeNdi { available: false, error: Some(error), sources: Vec::new(), server: String::new() },
    })
    .await
    .unwrap_or(NativeNdi { available: false, error: Some("NDI no responde".into()), sources: Vec::new(), server: String::new() })
}

/// Solo la direccion del servidor de imagen (sin buscar fuentes).
#[tauri::command]
pub fn ndi_server() -> Result<String, String> {
    api()?;
    server_url()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// El servidor entrega el estado y el MJPEG de un receptor (sin NDI real).
    #[test]
    fn mjpeg_server_serves_frames() {
        let r = Arc::new(Receiver::new());
        let mut jpeg = Vec::new();
        jpeg_encoder::Encoder::new(&mut jpeg, 80).encode(&[0u8; 16 * 8 * 4], 16, 8, jpeg_encoder::ColorType::Bgra).unwrap();
        {
            let mut l = r.latest.lock().unwrap();
            l.jpeg = Arc::new(jpeg.clone());
            l.seq = 1;
            l.at = Some(Instant::now());
            l.width = 16;
            l.height = 8;
        }
        receivers().lock().unwrap().insert("Prueba (Cam)".into(), r.clone());
        let base = server_url().unwrap();
        let addr = base.trim_start_matches("http://").to_string();
        let get = |path: &str, n: usize| -> String {
            let mut s = std::net::TcpStream::connect(&addr).unwrap();
            s.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
            write!(s, "GET {path} HTTP/1.1\r\nHost: x\r\n\r\n").unwrap();
            let mut buf = vec![0u8; n];
            let mut got = 0;
            while got < n {
                match s.read(&mut buf[got..]) {
                    Ok(0) | Err(_) => break,
                    Ok(k) => got += k,
                }
            }
            String::from_utf8_lossy(&buf[..got]).into_owned()
        };
        let st = get("/status?src=Prueba%20(Cam)", 400);
        assert!(st.contains("\"width\":16"), "{st}");
        let mj = get("/ndi?src=Prueba%20(Cam)", 300);
        assert!(mj.contains("multipart/x-mixed-replace") && mj.contains("--frame") && mj.contains("image/jpeg"), "{mj}");
    }

    /// FFmpeg lee la imagen (mpjpeg) y el audio (s16le) del servidor local.
    #[test]
    fn ffmpeg_reads_video_and_audio() {
        if std::process::Command::new("ffmpeg").arg("-version").output().is_err() {
            return;
        }
        let r = Arc::new(Receiver::new());
        let mut jpeg = Vec::new();
        jpeg_encoder::Encoder::new(&mut jpeg, 80).encode(&[90u8; 64 * 32 * 4], 64, 32, jpeg_encoder::ColorType::Bgra).unwrap();
        receivers().lock().unwrap().insert("Ff Test".into(), r.clone());
        let rr = r.clone();
        std::thread::spawn(move || {
            for i in 0..200u64 {
                {
                    let mut l = rr.latest.lock().unwrap();
                    l.jpeg = Arc::new(jpeg.clone());
                    l.seq = i + 1;
                    l.at = Some(Instant::now());
                    rr.cv.notify_all();
                }
                rr.push_audio(vec![1u8; 1920 * 4]);
                std::thread::sleep(Duration::from_millis(40));
            }
        });
        let base = server_url().unwrap();
        let out = std::process::Command::new("ffmpeg")
            .args(["-hide_banner", "-loglevel", "error", "-use_wallclock_as_timestamps", "1", "-f", "mpjpeg", "-i"])
            .arg(format!("{base}/ndi?src=Ff+Test"))
            .args(["-f", "s16le", "-ar", "48000", "-ac", "2", "-i"])
            .arg(format!("{base}/audio?src=Ff+Test"))
            .args(["-map", "0:v", "-map", "1:a", "-t", "2", "-f", "null", "-"])
            .output()
            .unwrap();
        assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    }

    /// FFmpeg lee la fuente sin comprimir (/raw) a ritmo fijo aunque las
    /// imagenes lleguen a destiempo y de otro tamaño.
    #[test]
    fn ffmpeg_reads_raw_at_steady_rate() {
        if std::process::Command::new("ffmpeg").arg("-version").output().is_err() {
            return;
        }
        let r = Arc::new(Receiver::new());
        receivers().lock().unwrap().insert("Raw Test".into(), r.clone());
        let rr = r.clone();
        std::thread::spawn(move || {
            for i in 0..120u64 {
                {
                    let mut l = rr.latest.lock().unwrap();
                    l.raw = Arc::new(vec![(i % 255) as u8; 96 * 54 * 4]);
                    l.raw_w = 96;
                    l.raw_h = 54;
                    l.raw_seq = i + 1;
                    l.at = Some(Instant::now());
                    rr.cv.notify_all();
                }
                // A destiempo: 20-60 ms
                std::thread::sleep(Duration::from_millis(20 + (i * 17 % 40)));
            }
        });
        let args = ffmpeg_video_input_at(&server_url().unwrap(), "Raw Test", 64, 36, 25);
        let out = std::process::Command::new("ffmpeg")
            .args(["-hide_banner", "-loglevel", "error"])
            .args(&args)
            .args(["-t", "2", "-f", "rawvideo", "-pix_fmt", "bgra", "-"])
            .output()
            .unwrap();
        assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
        let frames = out.stdout.len() / (64 * 36 * 4);
        assert!((48..=52).contains(&frames), "{frames} imagenes");
    }

    /// Si la fuente NDI deja de mandar imagen, FFmpeg recibe fin de flujo y
    /// se cierra (asi la emision pasa al respaldo en lugar de congelarse).
    #[test]
    fn ffmpeg_ends_when_ndi_source_stops() {
        if std::process::Command::new("ffmpeg").arg("-version").output().is_err() {
            return;
        }
        let r = Arc::new(Receiver::new());
        let mut jpeg = Vec::new();
        jpeg_encoder::Encoder::new(&mut jpeg, 80).encode(&[90u8; 64 * 32 * 4], 64, 32, jpeg_encoder::ColorType::Bgra).unwrap();
        receivers().lock().unwrap().insert("Para Test".into(), r.clone());
        let rr = r.clone();
        std::thread::spawn(move || {
            // 2 s de imagen y luego nada.
            for i in 0..50u64 {
                let mut l = rr.latest.lock().unwrap();
                l.jpeg = Arc::new(jpeg.clone());
                l.seq = i + 1;
                l.at = Some(Instant::now());
                rr.cv.notify_all();
                drop(l);
                std::thread::sleep(Duration::from_millis(40));
            }
            // Mantiene vivo el receptor para que no lo cierre el temporizador.
            for _ in 0..40 {
                *rr.used.lock().unwrap() = Instant::now();
                std::thread::sleep(Duration::from_millis(500));
            }
        });
        let base = server_url().unwrap();
        let t0 = Instant::now();
        let out = std::process::Command::new("ffmpeg")
            .args(["-hide_banner", "-loglevel", "error", "-use_wallclock_as_timestamps", "1", "-f", "mpjpeg", "-i"])
            .arg(format!("{base}/ndi?src=Para+Test&strict=1"))
            .args(["-t", "60", "-f", "null", "-"])
            .output()
            .unwrap();
        let _ = out;
        assert!(t0.elapsed() < Duration::from_secs(20), "FFmpeg siguió {:?}", t0.elapsed());
    }
}

#[cfg(test)]
mod scale_tests {
    #[test]
    fn downscale_keeps_aspect_and_colour() {
        let (w, h) = (1920usize, 1080usize);
        let src: Vec<u8> = [10u8, 20, 30, 255].repeat(w * h);
        let mut out = Vec::new();
        let nw = super::downscale_bgra(&src, w, h, 720, &mut out);
        assert_eq!(nw, 1280);
        assert_eq!(out.len(), 1280 * 720 * 4);
        assert_eq!(&out[..4], &[10, 20, 30, 255]);
    }
}

#[cfg(test)]
mod np_tests {
    use std::io::{Read, Write};

    #[test]
    fn np_frames_reach_the_mjpeg_stream() {
        let base = super::server_url().unwrap();
        let addr = base.trim_start_matches("http://").to_string();
        let jpeg = vec![0xFF, 0xD8, 1, 2, 3, 0xFF, 0xD9];
        super::push_np(jpeg.clone()).unwrap();
        assert!(super::push_np(vec![1, 2, 3, 4]).is_err());
        let mut s = std::net::TcpStream::connect(&addr).unwrap();
        s.set_read_timeout(Some(std::time::Duration::from_secs(5))).unwrap();
        write!(s, "GET /np HTTP/1.1\r\nHost: x\r\n\r\n").unwrap();
        // Una imagen nueva mientras se escucha
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(200));
            let _ = super::push_np(vec![0xFF, 0xD8, 9, 9, 0xFF, 0xD9]);
        });
        let mut got = Vec::new();
        let mut buf = [0u8; 4096];
        while got.len() < 400 {
            match s.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => got.extend_from_slice(&buf[..n]),
            }
            if got.windows(4).any(|w| w == [0xFF, 0xD8, 9, 9]) {
                break;
            }
        }
        let text = String::from_utf8_lossy(&got);
        assert!(text.contains("multipart/x-mixed-replace"), "{text}");
        assert!(got.windows(4).any(|w| w == [0xFF, 0xD8, 9, 9]), "{text}");
    }
}
