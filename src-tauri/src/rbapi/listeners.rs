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
    /// Servidores de estadísticas con sus datos (lo nuevo; si hay, manda)
    pub list: Vec<StatsSource>,
}

/// Un servidor del que leer los oyentes (como en RadioBOSS: servidor,
/// puerto, contraseña de administración y montaje).
#[derive(Clone, Debug, Default, PartialEq, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase", default)]
pub struct StatsSource {
    /// http(s)://servidor:puerto
    pub base: String,
    /// Usuario de administración (vacío = admin)
    pub user: String,
    /// Contraseña de administración (vacía = solo las estadísticas públicas)
    pub password: String,
    /// Montaje que se cuenta (vacío = todos los del servidor)
    pub mount: String,
}

/// Oyentes de /admin/stats (XML de Icecast): <source mount="/x">…<listeners>N</listeners>…</source>
pub fn parse_admin_xml(xml: &str) -> Snapshot {
    let mut snap = Snapshot::default();
    let mut rest = xml;
    while let Some(i) = rest.find("<source ") {
        rest = &rest[i + 8..];
        let end = rest.find("</source>").unwrap_or(rest.len());
        let block = &rest[..end];
        let mount = block
            .split("mount=\"")
            .nth(1)
            .and_then(|x| x.split('"').next())
            .unwrap_or("stream")
            .to_string();
        let listeners = block
            .split("<listeners>")
            .nth(1)
            .and_then(|x| x.split('<').next())
            .and_then(|x| x.trim().parse::<u64>().ok())
            .unwrap_or(0);
        snap.total += listeners;
        snap.mounts.push(Mount { name: mount, listeners });
        rest = &rest[end.min(rest.len())..];
    }
    snap
}

/// Lee un servidor: primero las estadísticas públicas (status-json.xsl); si
/// no las da y hay contraseña, las de administración (/admin/stats).
fn fetch_source(s: &StatsSource) -> Result<Snapshot, String> {
    let base = s.base.trim().trim_end_matches('/');
    let public = match ureq::get(&format!("{base}/status-json.xsl")).timeout(Duration::from_millis(2500)).call() {
        Ok(r) => r
            .into_string()
            .map_err(|e| e.to_string())
            .and_then(|t| serde_json::from_str::<Value>(&t).map_err(|_| "no da las estadísticas públicas".to_string()))
            .map(|j| parse_status(&j)),
        Err(ureq::Error::Status(code, _)) => Err(format!("el servidor respondió {code}")),
        Err(e) => Err(format!("sin conexión ({e})")),
    };
    let public_err = match public {
        Ok(snap) if !snap.mounts.is_empty() || s.password.is_empty() => return Ok(snap),
        Ok(_) => "sin montajes en las estadísticas públicas".to_string(),
        Err(e) => e,
    };
    if s.password.is_empty() {
        return Err(public_err);
    }
    use base64::Engine;
    let user = if s.user.trim().is_empty() { "admin" } else { s.user.trim() };
    let auth = base64::engine::general_purpose::STANDARD.encode(format!("{user}:{}", s.password));
    match ureq::get(&format!("{base}/admin/stats")).set("Authorization", &format!("Basic {auth}")).timeout(Duration::from_millis(2500)).call() {
        Ok(r) => r.into_string().map(|t| parse_admin_xml(&t)).map_err(|e| e.to_string()),
        Err(ureq::Error::Status(401, _)) => Err("usuario o contraseña de administración incorrectos".to_string()),
        Err(ureq::Error::Status(code, _)) => Err(format!("el servidor respondió {code}")),
        Err(e) => Err(format!("sin conexión ({e})")),
    }
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
                // Lo nuevo: cada servidor con su montaje (y contraseña si hace falta).
                let mut pending_merge: Option<Snapshot> = None;
                if !src.list.is_empty() {
                    let mut parts = Vec::new();
                    for s in &src.list {
                        match fetch_source(s) {
                            Ok(mut snap) => {
                                // Montaje indicado: solo ese (si no está, es que no emite: 0).
                                if !s.mount.trim().is_empty() {
                                    let want = norm_mount(&s.mount);
                                    snap.mounts.retain(|m| m.name == want);
                                    snap.total = snap.mounts.iter().map(|m| m.listeners).sum();
                                }
                                parts.push(snap);
                            }
                            Err(e) => {
                                if err.is_empty() {
                                    err = format!("{}: {e}", s.base);
                                }
                            }
                        }
                    }
                    if !parts.is_empty() {
                        pending_merge = Some(merge(&parts, &[]));
                    }
                }
                let legacy: &[String] = if src.list.is_empty() { &src.urls } else { &[] };
                for target in legacy {
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
                    g.configured = !src.urls.is_empty() || !src.list.is_empty();
                    let merged = match pending_merge {
                        Some(m) => Some(m),
                        None if !got.is_empty() => Some(merge(&got, &src.mounts)),
                        None => None,
                    };
                    if let Some(m) = merged {
                        g.total = m.total;
                        g.mounts = m.mounts;
                        g.updated = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
                        g.error = String::new();
                        super::audience::record(g.total);
                    } else {
                        // Si ningún servidor responde se conserva el último valor conocido.
                        g.error = if g.configured { err } else { String::new() };
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
        let xml = r#"<icestats><source mount="/live"><listeners>7</listeners><title>x</title></source><source mount="/otra"><listeners>3</listeners></source></icestats>"#;
        let a = parse_admin_xml(xml);
        assert_eq!(a.total, 10);
        assert_eq!(merge(&[a], &["/live".into()]).total, 7);
        // Montaje que no aparece: se cuentan todos los del servidor.
        assert_eq!(merge(&[s.clone()], &["/nada".into()]).total, 42);
        let single: Value = serde_json::from_str(r#"{"icestats":{"source":{"listenurl":"http://x/radio","listeners":5}}}"#).unwrap();
        assert_eq!(parse_status(&single).total, 5);
        let none: Value = serde_json::from_str(r#"{"icestats":{}}"#).unwrap();
        assert_eq!(parse_status(&none).total, 0);
    }
}
