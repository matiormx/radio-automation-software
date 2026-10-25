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

const COLOR_BGRX_BGRA: i32 = 0;
const BANDWIDTH_HIGHEST: i32 = 100;
const FRAME_VIDEO: i32 = 1;
const FRAME_ERROR: i32 = 4;

type FnInit = unsafe extern "C" fn() -> bool;
type FnFindCreate = unsafe extern "C" fn(*const FindCreate) -> *mut c_void;
type FnFindWait = unsafe extern "C" fn(*mut c_void, u32) -> bool;
type FnFindSources = unsafe extern "C" fn(*mut c_void, *mut u32) -> *const SourceT;
type FnRecvCreate = unsafe extern "C" fn(*const RecvCreateV3) -> *mut c_void;
type FnRecvDestroy = unsafe extern "C" fn(*mut c_void);
type FnRecvCapture = unsafe extern "C" fn(*mut c_void, *mut VideoFrameV2, *mut c_void, *mut c_void, u32) -> i32;
type FnRecvFreeVideo = unsafe extern "C" fn(*mut c_void, *const VideoFrameV2);

struct Api {
    _lib: Library,
    find_wait: FnFindWait,
    find_sources: FnFindSources,
    recv_create: FnRecvCreate,
    recv_destroy: FnRecvDestroy,
    recv_capture: FnRecvCapture,
    recv_free_video: FnRecvFreeVideo,
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
        // Junto a MiRadio.exe o en el PATH
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

// ------------------------------------------------------------ recepcion

#[derive(Default)]
struct Latest {
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
    let r = Arc::new(Receiver { latest: Mutex::new(Latest::default()), cv: Condvar::new(), used: Mutex::new(Instant::now()) });
    map.insert(source.to_string(), r.clone());
    let name = source.to_string();
    let rr = r.clone();
    let _ = thread::Builder::new().name("miradio-ndi-recv".into()).spawn(move || run_receiver(&name, rr));
    r
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
    let rname = CString::new("MiRadio").unwrap_or_default();
    let cfg = RecvCreateV3 {
        source: SourceT { name: cname.as_ptr(), url: std::ptr::null() },
        color_format: COLOR_BGRX_BGRA,
        bandwidth: BANDWIDTH_HIGHEST,
        allow_video_fields: false,
        recv_name: rname.as_ptr(),
    };
    let recv = unsafe { (api.recv_create)(&cfg) };
    if recv.is_null() {
        set_error(&r, format!("No se pudo conectar con la fuente NDI «{source}»"));
        receivers().lock().unwrap_or_else(|e| e.into_inner()).remove(source);
        return;
    }
    let min_gap = Duration::from_millis(33); // como mucho ~30 imagenes/s al WebView
    let mut last_sent = Instant::now() - min_gap;
    let mut scratch: Vec<u8> = Vec::new();
    loop {
        // Nadie la mira desde hace 15 s: se cierra.
        if r.used.lock().map(|u| u.elapsed() > Duration::from_secs(15)).unwrap_or(true) {
            break;
        }
        let mut frame: VideoFrameV2 = unsafe { std::mem::zeroed() };
        let kind = unsafe { (api.recv_capture)(recv, &mut frame, std::ptr::null_mut(), std::ptr::null_mut(), 500) };
        if kind == FRAME_ERROR {
            set_error(&r, "La fuente NDI se ha perdido".into());
            thread::sleep(Duration::from_millis(500));
            continue;
        }
        if kind != FRAME_VIDEO {
            continue;
        }
        if last_sent.elapsed() >= min_gap && !frame.data.is_null() && frame.xres > 0 && frame.yres > 0 {
            last_sent = Instant::now();
            let (w, h, stride) = (frame.xres as usize, frame.yres as usize, frame.line_stride.max(0) as usize);
            // Copia compacta (sin el relleno de cada linea) para el codificador.
            scratch.resize(w * h * 4, 0);
            for y in 0..h {
                let src = unsafe { std::slice::from_raw_parts(frame.data.add(y * stride), w * 4) };
                scratch[y * w * 4..(y + 1) * w * 4].copy_from_slice(src);
            }
            unsafe { (api.recv_free_video)(recv, &frame) };
            let mut jpeg = Vec::with_capacity(w * h / 4);
            let enc = jpeg_encoder::Encoder::new(&mut jpeg, 80);
            if enc.encode(&scratch, w as u16, h as u16, jpeg_encoder::ColorType::Bgra).is_ok() {
                let mut l = r.latest.lock().unwrap_or_else(|e| e.into_inner());
                l.jpeg = Arc::new(jpeg);
                l.seq += 1;
                l.at = Some(Instant::now());
                l.width = w as i32;
                l.height = h as i32;
                l.error.clear();
                r.cv.notify_all();
            }
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
                if t.timed_out() && l.seq == self.seq && l.seq > 0 {
                    // Sin imagen nueva: se repite la ultima para mantener viva la conexion.
                    break;
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

fn serve(req: tiny_http::Request) {
    let url = req.url().to_string();
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
    // /ndi?src=… : MJPEG continuo. Se escribe directamente en el socket y se
    // vacia tras cada imagen (con la respuesta normal de tiny_http la imagen se
    // quedaria esperando en un bufer).
    let mut stream = MjpegStream { r, seq: 0, buf: Vec::new(), pos: 0 };
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
        let r = Arc::new(Receiver { latest: Mutex::new(Latest::default()), cv: Condvar::new(), used: Mutex::new(Instant::now()) });
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
}
