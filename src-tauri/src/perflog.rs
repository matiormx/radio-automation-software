//! Registro de rendimiento: qué está gastando el procesador.
//!
//! Cada 20 s (en un hilo propio, a prioridad normal pero haciendo muy poco):
//! - CPU del equipo y de OmniCaster por partes (motor, interfaz/WebView,
//!   FFmpeg…).
//! - Los hilos de OmniCaster que más CPU han gastado en ese tiempo (con su
//!   nombre: «ia-fichas», «tokio-runtime-worker», «cpal…»…).
//! - Cuántas veces se ha llamado a cada orden de la interfaz y cuánto han
//!   tardado las operaciones medidas (leer la biblioteca, sincronizar…).
//!
//! Se escribe en `rendimiento.log` (carpeta de datos) cuando OmniCaster pasa
//! del 30 % o alguna orden se repite mucho, y un resumen cada 10 minutos.
//! Máximo ~1 MB (se guarda el anterior como `rendimiento.old.log`).

use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System};

const LOG: &str = "rendimiento.log";
const EVERY: Duration = Duration::from_secs(20);

static DIR: OnceLock<PathBuf> = OnceLock::new();
/// nombre -> (veces, ms totales, ms máximo)
static COUNTS: Mutex<Option<HashMap<String, (u32, u64, u64)>>> = Mutex::new(None);

/// Apunta una orden de la interfaz (se cuenta cuántas veces por intervalo).
pub fn count(name: &str) {
    if let Ok(mut c) = COUNTS.try_lock() {
        let e = c.get_or_insert_with(HashMap::new).entry(name.to_string()).or_insert((0, 0, 0));
        e.0 += 1;
    }
}

/// Apunta una operación medida.
pub fn count_ms(name: &str, took: Duration) {
    let ms = took.as_millis() as u64;
    if let Ok(mut c) = COUNTS.lock() {
        let e = c.get_or_insert_with(HashMap::new).entry(name.to_string()).or_insert((0, 0, 0));
        e.0 += 1;
        e.1 += ms;
        e.2 = e.2.max(ms);
    }
}

fn stamp() -> String {
    use chrono::Local;
    Local::now().format("%Y-%m-%d %H:%M:%S").to_string()
}

fn append(dir: &Path, text: &str) {
    let path = dir.join(LOG);
    if std::fs::metadata(&path).map(|m| m.len() > 1024 * 1024).unwrap_or(false) {
        let _ = std::fs::rename(&path, dir.join("rendimiento.old.log"));
    }
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(f, "{text}");
    }
}

/// Una línea suelta en el registro (arranque, avisos…).
pub fn note(text: &str) {
    if let Some(dir) = DIR.get() {
        append(dir, &format!("[{}] {text}", stamp()));
    }
}

// ------------------------------------------------------------------ hilos

/// (id, nombre, tiempo de CPU acumulado en ms)
#[cfg(target_os = "linux")]
fn threads() -> Vec<(u64, String, u64)> {
    let mut out = Vec::new();
    let tick = 100u64; // USER_HZ casi siempre 100
    let Ok(rd) = std::fs::read_dir("/proc/self/task") else { return out };
    for e in rd.flatten() {
        let tid: u64 = e.file_name().to_string_lossy().parse().unwrap_or(0);
        let Ok(stat) = std::fs::read_to_string(e.path().join("stat")) else { continue };
        // pid (nombre) estado ... campo 14 utime, 15 stime
        let (Some(a), Some(b)) = (stat.find('('), stat.rfind(')')) else { continue };
        let name = stat[a + 1..b].to_string();
        let rest: Vec<&str> = stat[b + 2..].split_whitespace().collect();
        let ut: u64 = rest.get(11).and_then(|x| x.parse().ok()).unwrap_or(0);
        let st: u64 = rest.get(12).and_then(|x| x.parse().ok()).unwrap_or(0);
        out.push((tid, name, (ut + st) * 1000 / tick));
    }
    out
}

#[cfg(windows)]
fn threads() -> Vec<(u64, String, u64)> {
    use windows_sys::Win32::Foundation::{CloseHandle, FILETIME, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{CreateToolhelp32Snapshot, Thread32First, Thread32Next, TH32CS_SNAPTHREAD, THREADENTRY32};
    use windows_sys::Win32::System::Threading::{GetThreadDescription, GetThreadTimes, OpenThread, THREAD_QUERY_LIMITED_INFORMATION};
    let mut out = Vec::new();
    let me = std::process::id();
    unsafe {
        let snap = CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0);
        if snap == INVALID_HANDLE_VALUE {
            return out;
        }
        let mut te: THREADENTRY32 = std::mem::zeroed();
        te.dwSize = std::mem::size_of::<THREADENTRY32>() as u32;
        let mut ok = Thread32First(snap, &mut te) != 0;
        while ok {
            if te.th32OwnerProcessID == me {
                let h = OpenThread(THREAD_QUERY_LIMITED_INFORMATION, 0, te.th32ThreadID);
                if !h.is_null() {
                    let z = FILETIME { dwLowDateTime: 0, dwHighDateTime: 0 };
                    let (mut c, mut x, mut k, mut u) = (z, z, z, z);
                    let ms = if GetThreadTimes(h, &mut c, &mut x, &mut k, &mut u) != 0 {
                        let f = |t: FILETIME| ((t.dwHighDateTime as u64) << 32 | t.dwLowDateTime as u64) / 10_000;
                        f(k) + f(u)
                    } else {
                        0
                    };
                    let mut name = String::new();
                    let mut p: windows_sys::core::PWSTR = std::ptr::null_mut();
                    if GetThreadDescription(h, &mut p) >= 0 && !p.is_null() {
                        let mut n = 0;
                        while *p.add(n) != 0 && n < 256 {
                            n += 1;
                        }
                        name = String::from_utf16_lossy(std::slice::from_raw_parts(p, n));
                        windows_sys::Win32::Foundation::LocalFree(p as _);
                    }
                    CloseHandle(h);
                    out.push((te.th32ThreadID as u64, name, ms));
                }
            }
            ok = Thread32Next(snap, &mut te) != 0;
        }
        CloseHandle(snap);
    }
    out
}

#[cfg(not(any(windows, target_os = "linux")))]
fn threads() -> Vec<(u64, String, u64)> {
    Vec::new()
}

fn group_of(name: &str) -> &'static str {
    let n = name.to_ascii_lowercase();
    if n.contains("ffmpeg") {
        "ffmpeg"
    } else if n.contains("webview") || n.contains("webkit") {
        "interfaz"
    } else {
        "otros"
    }
}

fn run(dir: PathBuf) {
    let me = Pid::from_u32(std::process::id());
    let mut sys = System::new();
    let ncpu = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(1) as f32;
    let mut prev: HashMap<u64, u64> = threads().into_iter().map(|(t, _, ms)| (t, ms)).collect();
    let mut last = Instant::now();
    let mut last_summary = Instant::now() - Duration::from_secs(600);
    // Primera lectura (sysinfo necesita dos para el %)
    sys.refresh_processes_specifics(ProcessesToUpdate::All, true, ProcessRefreshKind::nothing().with_cpu());
    sys.refresh_cpu_usage();
    loop {
        std::thread::sleep(EVERY);
        let dt = last.elapsed().as_millis().max(1) as u64;
        last = Instant::now();

        sys.refresh_cpu_usage();
        sys.refresh_processes_specifics(ProcessesToUpdate::All, true, ProcessRefreshKind::nothing().with_cpu().with_memory());
        let total = sys.global_cpu_usage();
        let mut parts: HashMap<&'static str, f32> = HashMap::new();
        let mut mem = 0u64;
        let procs = sys.processes();
        let own = procs.get(&me).map(|p| p.cpu_usage() / ncpu).unwrap_or(0.0);
        mem += procs.get(&me).map(|p| p.memory()).unwrap_or(0);
        for (pid, p) in procs {
            if *pid == me {
                continue;
            }
            let mut cur = p.parent();
            let mut depth = 0;
            let mut ours = false;
            while let Some(pp) = cur {
                if pp == me {
                    ours = true;
                    break;
                }
                depth += 1;
                if depth > 6 {
                    break;
                }
                cur = procs.get(&pp).and_then(|x| x.parent());
            }
            if ours {
                *parts.entry(group_of(&p.name().to_string_lossy())).or_insert(0.0) += p.cpu_usage() / ncpu;
                mem += p.memory();
            }
        }
        let app = own + parts.values().sum::<f32>();

        // Hilos propios que más han gastado
        let now_threads = threads();
        let mut busy: Vec<(f32, String)> = now_threads
            .iter()
            .filter_map(|(tid, name, ms)| {
                let d = ms.saturating_sub(*prev.get(tid).unwrap_or(ms));
                (d > 0).then(|| (d as f32 * 100.0 / dt as f32 / ncpu, if name.is_empty() { format!("hilo {tid}") } else { format!("{name} ({tid})") }))
            })
            .collect();
        busy.sort_by(|a, b| b.0.total_cmp(&a.0));
        prev = now_threads.into_iter().map(|(t, _, ms)| (t, ms)).collect();

        let counts = COUNTS.lock().ok().and_then(|mut c| c.take()).unwrap_or_default();
        let mut calls: Vec<(String, (u32, u64, u64))> = counts.into_iter().collect();
        calls.sort_by(|a, b| b.1 .1.cmp(&a.1 .1).then(b.1 .0.cmp(&a.1 .0)));
        let storm = calls.iter().any(|(_, (n, ms, _))| *n >= 60 || *ms >= 3000);

        let alarm = app >= 30.0 || storm;
        if alarm || last_summary.elapsed() >= Duration::from_secs(600) {
            last_summary = Instant::now();
            let mut s = format!(
                "[{}] {}equipo {:.0}% · OmniCaster {:.0}% (motor {:.0}%, interfaz {:.0}%, ffmpeg {:.0}%, otros {:.0}%) · memoria {} MB · audio {:.0}%",
                stamp(),
                if alarm { "ALTO · " } else { "" },
                total,
                app,
                own,
                parts.get("interfaz").copied().unwrap_or(0.0),
                parts.get("ffmpeg").copied().unwrap_or(0.0),
                parts.get("otros").copied().unwrap_or(0.0),
                mem / (1024 * 1024),
                crate::engine::io::audio_load(),
            );
            let top: Vec<String> = busy.iter().take(8).filter(|(c, _)| *c >= 0.5).map(|(c, n)| format!("{n} {c:.1}%")).collect();
            if !top.is_empty() {
                s += &format!("\n    hilos: {}", top.join(" · "));
            }
            let cl: Vec<String> = calls
                .iter()
                .take(12)
                .map(|(n, (k, ms, mx))| if *ms > 0 { format!("{n} ×{k} ({ms} ms, máx {mx})") } else { format!("{n} ×{k}") })
                .collect();
            if !cl.is_empty() {
                s += &format!("\n    órdenes: {}", cl.join(" · "));
            }
            append(&dir, &s);
        }
    }
}

/// Arranca el registro (una vez).
pub fn start(data_dir: PathBuf) {
    if DIR.set(data_dir.clone()).is_err() {
        return;
    }
    append(&data_dir, &format!("[{}] ==== OmniCaster {} arranca ====", stamp(), env!("CARGO_PKG_VERSION")));
    let _ = std::thread::Builder::new().name("registro-rendimiento".into()).spawn(move || run(data_dir));
}

/// Para el botón «Abrir registros»: la carpeta donde están.
#[tauri::command]
pub fn logs_dir(state: tauri::State<'_, crate::AppState>) -> String {
    state.data_dir.to_string_lossy().into_owned()
}

/// Abre la carpeta de los registros en el explorador de archivos.
#[tauri::command]
pub fn logs_open(state: tauri::State<'_, crate::AppState>) -> Result<(), String> {
    let dir = state.data_dir.clone();
    let mut c = if cfg!(windows) {
        let mut c = std::process::Command::new("explorer");
        c.arg(&dir);
        c
    } else if cfg!(target_os = "macos") {
        let mut c = std::process::Command::new("open");
        c.arg(&dir);
        c
    } else {
        let mut c = std::process::Command::new("xdg-open");
        c.arg(&dir);
        c
    };
    c.spawn().map(|_| ()).map_err(|e| format!("No se pudo abrir la carpeta: {e}"))
}

/// Lo último del registro (para copiarlo y mandarlo).
#[tauri::command]
pub async fn logs_tail(state: tauri::State<'_, crate::AppState>) -> Result<String, String> {
    let dir = state.data_dir.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut out = String::new();
        for name in [LOG, "errores.log"] {
            if let Ok(t) = std::fs::read_to_string(dir.join(name)) {
                let lines: Vec<&str> = t.lines().collect();
                let from = lines.len().saturating_sub(if name == LOG { 200 } else { 60 });
                out += &format!("===== {name} =====\n{}\n\n", lines[from..].join("\n"));
            }
        }
        if out.is_empty() {
            out = "Todavía no hay nada en el registro.".into();
        }
        out
    })
    .await
    .map_err(|e| e.to_string())
}


/// Baja la prioridad del hilo actual (sincronización, descargas, análisis,
/// IA…): el procesador y el disco van primero para el audio y la pantalla.
/// En Windows usa el modo «segundo plano» (CPU, disco y memoria).
pub fn background_thread() {
    #[cfg(windows)]
    unsafe {
        use windows_sys::Win32::System::Threading::{GetCurrentThread, SetThreadPriority, THREAD_MODE_BACKGROUND_BEGIN};
        SetThreadPriority(GetCurrentThread(), THREAD_MODE_BACKGROUND_BEGIN);
    }
    #[cfg(target_os = "linux")]
    unsafe {
        let tid = libc::syscall(libc::SYS_gettid) as libc::id_t;
        libc::setpriority(libc::PRIO_PROCESS, tid, 15);
    }
}

/// Como `background_thread`, solo mientras dure (para hilos prestados de un
/// grupo, que luego atienden otras órdenes).
pub struct Background;

impl Background {
    pub fn enter() -> Background {
        // En Linux no se puede volver a subir sin permisos: solo Windows.
        #[cfg(windows)]
        background_thread();
        Background
    }
}

impl Drop for Background {
    fn drop(&mut self) {
        #[cfg(windows)]
        unsafe {
            use windows_sys::Win32::System::Threading::{GetCurrentThread, SetThreadPriority, THREAD_MODE_BACKGROUND_END};
            SetThreadPriority(GetCurrentThread(), THREAD_MODE_BACKGROUND_END);
        }
    }
}
