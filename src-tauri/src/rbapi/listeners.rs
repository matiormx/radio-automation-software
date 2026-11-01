//! Oyentes desde Icecast (`status-json.xsl`), sondeados en segundo plano
//! para que `playbackinfo` no espere nunca a la red.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde_json::Value;

#[derive(Clone, Debug, Default, PartialEq, serde::Serialize)]
pub struct Mount {
    pub name: String,
    pub listeners: u64,
}

#[derive(Clone, Debug, Default)]
pub struct Snapshot {
    pub total: u64,
    pub mounts: Vec<Mount>,
    /// Última lectura correcta (segundos unix; 0 = nunca)
    pub updated: u64,
    /// Por qué falló la última lectura ("" = bien)
    pub error: String,
    /// Hay servidores de los que leer
    pub configured: bool,
}

/// Lee el JSON de Icecast: `icestats.source` puede ser un objeto o una lista.
pub fn parse_status(json: &Value) -> Snapshot {
    let src = &json["icestats"]["source"];
    let list: Vec<&Value> = match src {
        Value::Array(a) => a.iter().collect(),
        Value::Object(_) => vec![src],
        _ => Vec::new(),
    };
    let mut snap = Snapshot::default();
    for s in list {
        let listeners = s["listeners"].as_u64().unwrap_or_else(|| {
            s["listeners"].as_str().and_then(|x| x.parse().ok()).unwrap_or(0)
        });
        let url = s["listenurl"].as_str().unwrap_or_default();
        let name = url
            .rsplit_once('/')
            .map(|(_, m)| format!("/{m}"))
            .filter(|m| m.len() > 1)
            .or_else(|| s["server_name"].as_str().map(|x| x.to_string()))
            .unwrap_or_else(|| "stream".to_string());
        snap.total += listeners;
        snap.mounts.push(Mount { name, listeners });
    }
    snap
}

/// De dónde se leen los oyentes: las estadísticas de cada servidor de
/// emisión y los montajes propios (para no sumar otras emisoras del mismo
/// servidor).
#[derive(Clone, Debug, Default)]
pub struct Sources {
    pub urls: Vec<String>,
    pub mounts: Vec<String>,
}

fn norm_mount(m: &str) -> String {
    let m = m.trim();
    if m.starts_with('/') { m.to_string() } else { format!("/{m}") }
}

/// Junta las estadísticas de varios servidores, quedándose con los montajes
/// propios. Si en un servidor no aparece ninguno de ellos (montaje con otro
/// nombre), cuenta todos los de ese servidor.
pub fn merge(results: &[Snapshot], mounts: &[String]) -> Snapshot {
    let own: Vec<String> = mounts.iter().filter(|m| !m.trim().is_empty()).map(|m| norm_mount(m)).collect();
    let mut out = Snapshot::default();
    for snap in results {
        let mine: Vec<&Mount> = snap.mounts.iter().filter(|m| own.contains(&m.name)).collect();
        let pick: Vec<&Mount> = if own.is_empty() || mine.is_empty() { snap.mounts.iter().collect() } else { mine };
        for m in pick {
            if out.mounts.iter().any(|x| x.name == m.name) {
                continue;
            }
            out.total += m.listeners;
            out.mounts.push(m.clone());
        }
    }
    out
}

pub struct Poller {
    pub latest: Arc<Mutex<Snapshot>>,
    stop: Arc<AtomicBool>,
}

impl Poller {
    /// `url` se lee en cada vuelta (cambiarlo en Ajustes no exige reiniciar).
    pub fn start(sources: Arc<Mutex<Sources>>, data_dir: std::path::PathBuf) -> Poller {
        super::audience::init(&data_dir);
        let latest = Arc::new(Mutex::new(Snapshot::default()));
        let stop = Arc::new(AtomicBool::new(false));
        let (l, st) = (latest.clone(), stop.clone());
        let _ = std::thread::Builder::new().name("miradio-api-listeners".into()).spawn(move || {
            while !st.load(Ordering::SeqCst) {
                let src = sources.lock().map(|u| u.clone()).unwrap_or_default();
                let mut got = Vec::new();
                let mut err = String::new();
                for target in &src.urls {
                    let res = match ureq::get(target).timeout(Duration::from_millis(2500)).call() {
                        Ok(r) => r.into_string().map_err(|e| e.to_string()).and_then(|t| {
                            serde_json::from_str::<Value>(&t).map_err(|_| "no devuelve las estadísticas de Icecast (status-json.xsl)".to_string())
                        }),
                        Err(ureq::Error::Status(code, _)) => Err(format!("el servidor respondió {code}")),
                        Err(e) => Err(format!("sin conexión ({e})")),
                    };
                    match res {
                        Ok(json) => got.push(parse_status(&json)),
                        Err(e) => {
                            if err.is_empty() {
                                err = format!("{target}: {e}");
                            }
                        }
                    }
                }
                if let Ok(mut g) = l.lock() {
                    g.configured = !src.urls.is_empty();
                    if got.is_empty() {
                        // Si ningún servidor responde se conserva el último valor conocido.
                        g.error = if src.urls.is_empty() { String::new() } else { err };
                    } else {
                        let m = merge(&got, &src.mounts);
                        g.total = m.total;
                        g.mounts = m.mounts;
                        g.updated = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
                        g.error = String::new();
                        super::audience::record(g.total);
                    }
                }
                for _ in 0..50 {
                    if st.load(Ordering::SeqCst) {
                        break;
                    }
                    std::thread::sleep(Duration::from_millis(100));
                }
            }
        });
        Poller { latest, stop }
    }

    pub fn snapshot(&self) -> Snapshot {
        self.latest.lock().map(|g| g.clone()).unwrap_or_default()
    }
}

impl Drop for Poller {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sums_all_mounts() {
        let j: Value = serde_json::from_str(
            r#"{"icestats":{"source":[{"listenurl":"http://x:8000/live.flac","listeners":12},{"listenurl":"http://x:8000/live.aac","listeners":"30"}]}}"#,
        )
        .unwrap();
        let s = parse_status(&j);
        assert_eq!(s.total, 42);
        assert_eq!(s.mounts[0], Mount { name: "/live.flac".into(), listeners: 12 });
        // Solo los montajes propios; los de otras emisoras del servidor no cuentan.
        let other = Snapshot { total: 99, mounts: vec![Mount { name: "/otra".into(), listeners: 99 }, Mount { name: "/live.aac".into(), listeners: 30 }], ..Default::default() };
        let m = merge(&[s.clone(), other], &["live.flac".into(), "/live.aac".into()]);
        assert_eq!(m.total, 42);
        // Montaje que no aparece: se cuentan todos los del servidor.
        assert_eq!(merge(&[s.clone()], &["/nada".into()]).total, 42);
        let single: Value = serde_json::from_str(r#"{"icestats":{"source":{"listenurl":"http://x/radio","listeners":5}}}"#).unwrap();
        assert_eq!(parse_status(&single).total, 5);
        let none: Value = serde_json::from_str(r#"{"icestats":{}}"#).unwrap();
        assert_eq!(parse_status(&none).total, 0);
    }
}
