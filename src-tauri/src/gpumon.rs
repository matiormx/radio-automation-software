//! Uso de la tarjeta gráfica para el monitor del sistema.
//!
//! Se mide en un hilo aparte cada pocos segundos (preguntar a la gráfica
//! puede tardar, y el monitor no debe esperar):
//! - NVIDIA: `nvidia-smi` (viene con el driver, en Windows y en Linux): uso
//!   general, del codificador (NVENC) y del decodificador, y memoria.
//! - Windows con Intel o AMD: contadores «GPU Engine» del sistema (los mismos
//!   del Administrador de tareas), con `typeperf`.
//! - Linux con AMD: /sys/class/drm/card*/device/gpu_busy_percent.

use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;

#[derive(Serialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GpuInfo {
    pub name: String,
    /// % de uso (el motor más ocupado, como el Administrador de tareas)
    pub util: f32,
    /// % del codificador de vídeo (NVENC / Quick Sync / AMF); -1 = no se sabe
    pub encoder: f32,
    /// % del decodificador de vídeo; -1 = no se sabe
    pub decoder: f32,
    /// Memoria de la gráfica en bytes (0 = no se sabe)
    pub mem_used: u64,
    pub mem_total: u64,
}

static LAST: Mutex<Option<GpuInfo>> = Mutex::new(None);
static STARTED: std::sync::Once = std::sync::Once::new();

/// Último dato de la gráfica (None = no hay o no se puede medir).
pub fn latest() -> Option<GpuInfo> {
    STARTED.call_once(|| {
        let _ = std::thread::Builder::new().name("miradio-gpumon".into()).spawn(|| {
            let mut fails = 0u32;
            loop {
                let info = sample();
                if info.is_none() {
                    fails += 1;
                } else {
                    fails = 0;
                }
                if let Ok(mut g) = LAST.lock() {
                    *g = info;
                }
                // Si no hay forma de medir, se deja de insistir tan a menudo.
                std::thread::sleep(Duration::from_secs(if fails > 3 { 60 } else { 3 }));
            }
        });
    });
    LAST.lock().ok().and_then(|g| g.clone())
}

fn quiet(program: &str) -> Command {
    let mut c = Command::new(program);
    c.stdin(Stdio::null()).stderr(Stdio::null());
    crate::streaming::configure_no_window(&mut c);
    c
}

fn sample() -> Option<GpuInfo> {
    nvidia().or_else(windows_counters).or_else(linux_amd)
}

fn nvidia_smi() -> Option<String> {
    if cfg!(windows) {
        let sys = std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".into());
        for p in [format!("{sys}\\System32\\nvidia-smi.exe"), "C:\\Program Files\\NVIDIA Corporation\\NVSMI\\nvidia-smi.exe".into()] {
            if std::path::Path::new(&p).is_file() {
                return Some(p);
            }
        }
        None
    } else {
        ["/usr/bin/nvidia-smi", "/usr/local/bin/nvidia-smi"].iter().find(|p| std::path::Path::new(p).is_file()).map(|s| s.to_string())
    }
}

fn nvidia() -> Option<GpuInfo> {
    let exe = nvidia_smi()?;
    let out = quiet(&exe)
        .args([
            "--query-gpu=name,utilization.gpu,utilization.encoder,utilization.decoder,memory.used,memory.total",
            "--format=csv,noheader,nounits",
        ])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    parse_nvidia(&String::from_utf8_lossy(&out.stdout))
}

/// «NVIDIA GeForce GTX 1060 6GB, 12, 34, 0, 812, 6144» (MiB)
pub fn parse_nvidia(text: &str) -> Option<GpuInfo> {
    let line = text.lines().find(|l| !l.trim().is_empty())?;
    let f: Vec<&str> = line.split(',').map(|x| x.trim()).collect();
    if f.len() < 6 {
        return None;
    }
    let num = |s: &str| s.parse::<f32>().ok();
    Some(GpuInfo {
        name: f[0].to_string(),
        util: num(f[1])?,
        encoder: num(f[2]).unwrap_or(-1.0),
        decoder: num(f[3]).unwrap_or(-1.0),
        mem_used: num(f[4]).map(|m| (m as u64) * 1024 * 1024).unwrap_or(0),
        mem_total: num(f[5]).map(|m| (m as u64) * 1024 * 1024).unwrap_or(0),
    })
}

fn windows_counters() -> Option<GpuInfo> {
    if !cfg!(windows) {
        return None;
    }
    let out = quiet("typeperf")
        .args(["\\GPU Engine(*)\\Utilization Percentage", "\\GPU Adapter Memory(*)\\Dedicated Usage", "-sc", "1"])
        .output()
        .ok()?;
    parse_typeperf(&String::from_utf8_lossy(&out.stdout))
}

/// Salida CSV de typeperf: cabecera con los contadores y una fila de valores.
/// Se suma por tipo de motor (3D, VideoEncode…) y el uso es el del más ocupado.
pub fn parse_typeperf(text: &str) -> Option<GpuInfo> {
    let rows: Vec<Vec<String>> = text
        .lines()
        .filter(|l| l.starts_with('"'))
        .map(|l| l.split("\",\"").map(|c| c.trim_matches('"').to_string()).collect())
        .collect();
    if rows.len() < 2 {
        return None;
    }
    let (head, vals) = (&rows[0], &rows[1]);
    let mut by_type: Vec<(String, f32)> = Vec::new();
    let mut mem: u64 = 0;
    let mut any = false;
    for (h, v) in head.iter().zip(vals.iter()).skip(1) {
        let Ok(x) = v.trim().parse::<f64>() else { continue };
        let hl = h.to_ascii_lowercase();
        if hl.contains("dedicated usage") {
            mem += x as u64;
            continue;
        }
        if let Some(i) = hl.find("engtype_") {
            any = true;
            let t = hl[i + 8..].split(|c: char| c == ')' || c == '_').next().unwrap_or("").to_string();
            match by_type.iter_mut().find(|(n, _)| *n == t) {
                Some((_, s)) => *s += x as f32,
                None => by_type.push((t, x as f32)),
            }
        }
    }
    if !any {
        return None;
    }
    let get = |n: &str| by_type.iter().find(|(t, _)| t == n).map(|(_, v)| v.min(100.0)).unwrap_or(0.0);
    Some(GpuInfo {
        name: String::new(),
        util: by_type.iter().map(|(_, v)| v.min(100.0)).fold(0.0, f32::max),
        encoder: get("videoencode"),
        decoder: get("videodecode"),
        mem_used: mem,
        mem_total: 0,
    })
}

fn linux_amd() -> Option<GpuInfo> {
    if cfg!(windows) {
        return None;
    }
    for i in 0..4 {
        let dir = format!("/sys/class/drm/card{i}/device");
        let Ok(busy) = std::fs::read_to_string(format!("{dir}/gpu_busy_percent")) else { continue };
        let read = |f: &str| std::fs::read_to_string(format!("{dir}/{f}")).ok().and_then(|s| s.trim().parse::<u64>().ok()).unwrap_or(0);
        return Some(GpuInfo {
            name: "AMD".into(),
            util: busy.trim().parse().unwrap_or(0.0),
            encoder: -1.0,
            decoder: -1.0,
            mem_used: read("mem_info_vram_used"),
            mem_total: read("mem_info_vram_total"),
        });
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nvidia_line() {
        let g = parse_nvidia("NVIDIA GeForce GTX 1060 6GB, 12, 34, 0, 812, 6144\n").unwrap();
        assert_eq!(g.name, "NVIDIA GeForce GTX 1060 6GB");
        assert_eq!(g.util, 12.0);
        assert_eq!(g.encoder, 34.0);
        assert_eq!(g.mem_total, 6144 * 1024 * 1024);
        assert!(parse_nvidia("").is_none());
    }

    #[test]
    fn typeperf_csv() {
        let csv = "\r\n\"(PDH-CSV 4.0)\",\"\\\\PC\\GPU Engine(pid_1_luid_0x0_phys_0_eng_0_engtype_3D)\\Utilization Percentage\",\"\\\\PC\\GPU Engine(pid_2_luid_0x0_phys_0_eng_0_engtype_3D)\\Utilization Percentage\",\"\\\\PC\\GPU Engine(pid_3_luid_0x0_phys_0_eng_4_engtype_VideoEncode)\\Utilization Percentage\",\"\\\\PC\\GPU Adapter Memory(luid_0x0_phys_0)\\Dedicated Usage\"\r\n\"11/05/2026 15:20:00.000\",\"10.5\",\"4.5\",\"30\",\"1073741824\"\r\nEl comando se completó correctamente.\r\n";
        let g = parse_typeperf(csv).unwrap();
        assert!((g.util - 30.0).abs() < 0.01, "{g:?}");
        assert!((g.encoder - 30.0).abs() < 0.01);
        assert_eq!(g.mem_used, 1 << 30);
    }
}
