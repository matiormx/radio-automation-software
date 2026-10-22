//! Oyentes desde Icecast (`status-json.xsl`), sondeados en segundo plano
//! para que `playbackinfo` no espere nunca a la red.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::Value;

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Mount {
    pub name: String,
    pub listeners: u64,
}

#[derive(Clone, Debug, Default)]
pub struct Snapshot {
    pub total: u64,
    pub mounts: Vec<Mount>,
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

pub struct Poller {
    pub latest: Arc<Mutex<Snapshot>>,
    stop: Arc<AtomicBool>,
}

impl Poller {
    /// `url` se lee en cada vuelta (cambiarlo en Ajustes no exige reiniciar).
    pub fn start(url: Arc<Mutex<String>>) -> Poller {
        let latest = Arc::new(Mutex::new(Snapshot::default()));
        let stop = Arc::new(AtomicBool::new(false));
        let (l, st) = (latest.clone(), stop.clone());
        let _ = std::thread::Builder::new().name("miradio-api-listeners".into()).spawn(move || {
            while !st.load(Ordering::SeqCst) {
                let target = url.lock().map(|u| u.clone()).unwrap_or_default();
                if !target.is_empty() {
                    let res = ureq::get(&target)
                        .timeout(Duration::from_millis(800))
                        .call()
                        .ok()
                        .and_then(|r| r.into_string().ok())
                        .and_then(|t| serde_json::from_str::<Value>(&t).ok());
                    // Si Icecast no responde se conserva el ultimo valor conocido.
                    if let Some(json) = res {
                        if let Ok(mut g) = l.lock() {
                            *g = parse_status(&json);
                        }
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
        let single: Value = serde_json::from_str(r#"{"icestats":{"source":{"listenurl":"http://x/radio","listeners":5}}}"#).unwrap();
        assert_eq!(parse_status(&single).total, 5);
        let none: Value = serde_json::from_str(r#"{"icestats":{}}"#).unwrap();
        assert_eq!(parse_status(&none).total, 0);
    }
}
