//! Monitor del sistema: carga general (CPU, memoria, red, motor de audio) y,
//! solo cuando se pide el detalle, núcleos, procesos de OmniCaster (WebView,
//! FFmpeg…) y disco. Cada consulta refresca lo justo: muy poco coste.

use std::sync::Mutex;
use std::time::Instant;

use serde::Serialize;
use sysinfo::{Disks, Networks, Pid, ProcessRefreshKind, ProcessesToUpdate, System};
use tauri::{Manager, State};

pub struct SysMon {
    inner: Mutex<Inner>,
}

struct Inner {
    sys: System,
    nets: Networks,
    last_net: Option<Instant>,
}

impl Default for SysMon {
    fn default() -> Self {
        SysMon {
            inner: Mutex::new(Inner { sys: System::new(), nets: Networks::new_with_refreshed_list(), last_net: None }),
        }
    }
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct NetIf {
    name: String,
    rx_bps: f64,
    tx_bps: f64,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Proc {
    name: String,
    /// % del equipo entero (todos los núcleos = 100)
    cpu: f32,
    mem: u64,
    count: u32,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Stats {
    /// % de CPU del equipo
    cpu: f32,
    mem_used: u64,
    mem_total: u64,
    /// Bits por segundo (todas las tarjetas de red menos la local)
    rx_bps: f64,
    tx_bps: f64,
    /// % del tiempo que el motor de audio usa de cada bloque (100 = al límite)
    audio_load: f32,
    /// OmniCaster entero (con WebView y FFmpeg): % del equipo y memoria
    app_cpu: f32,
    app_mem: u64,
    // Detalle
    cores: Vec<f32>,
    nets: Vec<NetIf>,
    procs: Vec<Proc>,
    disk_free: u64,
    disk_total: u64,
}

fn is_loopback(name: &str) -> bool {
    let n = name.to_ascii_lowercase();
    n == "lo" || n.contains("loopback")
}

/// Grupo al que se suma un proceso hijo de OmniCaster.
fn group_of(name: &str) -> &'static str {
    let n = name.to_ascii_lowercase();
    if n.contains("ffmpeg") {
        "FFmpeg (emisión y vídeo)"
    } else if n.contains("webview") || n.contains("webkit") {
        "Interfaz (WebView)"
    } else {
        "Otros procesos de OmniCaster"
    }
}

#[tauri::command]
pub fn sys_stats(app: tauri::AppHandle, mon: State<'_, SysMon>, detail: bool) -> Stats {
    let mut g = mon.inner.lock().unwrap_or_else(|e| e.into_inner());
    let Inner { sys, nets, last_net } = &mut *g;
    sys.refresh_cpu_usage();
    sys.refresh_memory();
    let ncpu = sys.cpus().len().max(1) as f32;
    let mut s = Stats {
        cpu: sys.global_cpu_usage(),
        mem_used: sys.used_memory(),
        mem_total: sys.total_memory(),
        audio_load: crate::engine::io::audio_load(),
        ..Default::default()
    };

    // Red: diferencia desde la consulta anterior
    nets.refresh(true);
    let dt = last_net.map(|t| t.elapsed().as_secs_f64()).unwrap_or(0.0);
    *last_net = Some(Instant::now());
    for (name, data) in nets.list() {
        if is_loopback(name) {
            continue;
        }
        let (rx, tx) = if dt > 0.05 {
            (data.received() as f64 * 8.0 / dt, data.transmitted() as f64 * 8.0 / dt)
        } else {
            (0.0, 0.0)
        };
        s.rx_bps += rx;
        s.tx_bps += tx;
        if detail && (rx > 0.0 || tx > 0.0 || data.total_received() > 0) {
            s.nets.push(NetIf { name: name.clone(), rx_bps: rx, tx_bps: tx });
        }
    }
    s.nets.sort_by(|a, b| (b.rx_bps + b.tx_bps).total_cmp(&(a.rx_bps + a.tx_bps)));

    // Procesos: en resumen solo el propio; en detalle, también sus hijos.
    let me = Pid::from_u32(std::process::id());
    let kind = ProcessRefreshKind::nothing().with_cpu().with_memory();
    if detail {
        sys.refresh_processes_specifics(ProcessesToUpdate::All, true, kind);
    } else {
        sys.refresh_processes_specifics(ProcessesToUpdate::Some(&[me]), false, kind);
    }
    let mut groups: Vec<Proc> = Vec::new();
    if let Some(p) = sys.process(me) {
        s.app_cpu = p.cpu_usage() / ncpu;
        s.app_mem = p.memory();
        groups.push(Proc { name: "OmniCaster (motor y audio)".into(), cpu: s.app_cpu, mem: s.app_mem, count: 1 });
    }
    if detail {
        // Descendientes (WebView, FFmpeg…): se sube por los padres hasta OmniCaster.
        let procs = sys.processes();
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
            if !ours {
                continue;
            }
            let name = group_of(&p.name().to_string_lossy());
            let cpu = p.cpu_usage() / ncpu;
            match groups.iter_mut().find(|g| g.name == name) {
                Some(g) => {
                    g.cpu += cpu;
                    g.mem += p.memory();
                    g.count += 1;
                }
                None => groups.push(Proc { name: name.into(), cpu, mem: p.memory(), count: 1 }),
            }
            s.app_cpu += cpu;
            s.app_mem += p.memory();
        }
        s.cores = sys.cpus().iter().map(|c| c.cpu_usage()).collect();
        // Disco donde están los datos (biblioteca, copias…)
        if let Ok(dir) = app.path().app_data_dir() {
            let disks = Disks::new_with_refreshed_list();
            if let Some(d) = disks
                .list()
                .iter()
                .filter(|d| dir.starts_with(d.mount_point()))
                .max_by_key(|d| d.mount_point().as_os_str().len())
            {
                s.disk_free = d.available_space();
                s.disk_total = d.total_space();
            }
        }
    }
    groups.sort_by(|a, b| b.cpu.total_cmp(&a.cpu));
    s.procs = groups;
    s
}
