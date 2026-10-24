//! Notificaciones: peticiones GET/POST a una URL cuando ocurre algo
//! (cambio de cancion, servidor, silencio, errores). Sin reintentos.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::settings::read_settings_public;
use crate::AppState;

#[derive(Deserialize, Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Notification {
    pub id: String,
    pub name: String,
    pub enabled: bool,
    pub url: String,
    /// "GET" o "POST"
    pub method: String,
    /// Cuerpo del POST (admite las variables {text}, {title}, {artist}…)
    pub body: String,
    /// "form" | "json" | "text"
    pub body_format: String,
    /// Eventos: "track", "server", "silence", "error"
    pub events: Vec<String>,
    /// Texto del cambio de cancion: "currentsong" o "live"
    pub title_source: String,
}

impl Default for Notification {
    fn default() -> Self {
        Notification {
            id: String::new(),
            name: String::new(),
            enabled: true,
            url: String::new(),
            method: "GET".into(),
            body: String::new(),
            body_format: "form".into(),
            events: vec!["track".into()],
            title_source: "currentsong".into(),
        }
    }
}

#[derive(Default)]
pub struct NotifyState {
    /// Ultimo texto enviado por aviso (evita repetir el mismo cambio)
    last: Mutex<HashMap<String, String>>,
}

fn urlencode(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(b as char),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

fn json_escape(s: &str) -> String {
    let q = serde_json::to_string(s).unwrap_or_default();
    q.trim_matches('"').to_string()
}

/// Sustituye `{nombre}` por su valor aplicando `enc`.
pub fn fill(template: &str, vars: &HashMap<String, String>, enc: &dyn Fn(&str) -> String) -> String {
    let mut out = String::with_capacity(template.len());
    let mut rest = template;
    while let Some(i) = rest.find('{') {
        out.push_str(&rest[..i]);
        let after = &rest[i + 1..];
        match after.find('}') {
            Some(j) if vars.contains_key(&after[..j].to_ascii_lowercase()) => {
                out.push_str(&enc(&vars[&after[..j].to_ascii_lowercase()]));
                rest = &after[j + 1..];
            }
            _ => {
                out.push('{');
                rest = after;
            }
        }
    }
    out.push_str(rest);
    out
}

/// Prepara (url, cuerpo, content-type) de un aviso.
pub fn build(n: &Notification, vars: &HashMap<String, String>) -> (String, Option<(String, &'static str)>) {
    let url = fill(&n.url, vars, &urlencode);
    if n.method.eq_ignore_ascii_case("POST") {
        let (enc, ct): (&dyn Fn(&str) -> String, &'static str) = match n.body_format.as_str() {
            "json" => (&json_escape, "application/json"),
            "text" => (&|s: &str| s.to_string(), "text/plain; charset=utf-8"),
            _ => (&urlencode, "application/x-www-form-urlencoded"),
        };
        (url, Some((fill(&n.body, vars, enc), ct)))
    } else {
        (url, None)
    }
}

fn send(n: &Notification, vars: &HashMap<String, String>) -> Result<u16, String> {
    let (url, body) = build(n, vars);
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err("la URL debe empezar por http:// o https://".into());
    }
    let req = |r: ureq::Request| r.timeout(Duration::from_secs(8));
    let res = match body {
        Some((b, ct)) => req(ureq::post(&url)).set("Content-Type", ct).send_string(&b),
        None => req(ureq::get(&url)).call(),
    };
    match res {
        Ok(r) => Ok(r.status()),
        Err(ureq::Error::Status(c, _)) => Err(format!("el servidor respondió {c}")),
        Err(e) => Err(e.to_string()),
    }
}

fn base_vars(event: &str, vars: HashMap<String, String>) -> HashMap<String, String> {
    let mut v: HashMap<String, String> = vars.into_iter().map(|(k, x)| (k.to_ascii_lowercase(), x)).collect();
    v.insert("event".into(), event.to_string());
    v
}

/// Dispara un evento. Para "track", `currentsong` y `live` van en `vars`.
#[tauri::command]
pub fn notify_fire(
    app: State<'_, AppState>,
    state: State<'_, NotifyState>,
    event: String,
    vars: HashMap<String, String>,
) {
    let list = read_settings_public(&app.data_dir).notifications;
    let vars = base_vars(&event, vars);
    for n in list.into_iter().filter(|n| n.enabled && !n.url.trim().is_empty() && n.events.contains(&event)) {
        let mut v = vars.clone();
        // El LIVE pesa mas que la cancion: con LIVE activo no se avisa de
        // cada cancion (salvo los avisos que usan el texto LIVE, que ya
        // llevan el programa y no cambian con la musica).
        if event == "track" && v.get("live_mode").map(|x| x == "1").unwrap_or(false) && n.title_source != "live" {
            continue;
        }
        if event == "live" || event == "program" {
            let text = v.get("text").cloned().unwrap_or_default();
            if let Ok(mut last) = state.last.lock() {
                // Si el aviso de cancion ya mando este mismo texto, no se repite.
                if n.events.iter().any(|e| e == "track") && last.get(&n.id) == Some(&text) && !text.is_empty() {
                    continue;
                }
                last.insert(n.id.clone(), text);
            }
        }
        if event == "track" {
            let key = if n.title_source == "live" { "live" } else { "currentsong" };
            let text = v.get(key).cloned().unwrap_or_default();
            if text.is_empty() {
                continue;
            }
            // El mismo texto no se envia dos veces seguidas a este aviso.
            if let Ok(mut last) = state.last.lock() {
                if last.get(&n.id) == Some(&text) {
                    continue;
                }
                last.insert(n.id.clone(), text.clone());
            }
            v.insert("text".into(), text);
        }
        let _ = std::thread::Builder::new().name("miradio-notify".into()).spawn(move || {
            let _ = send(&n, &v);
        });
    }
}

/// Envia un aviso de prueba y devuelve el resultado para mostrarlo.
#[tauri::command]
pub fn notify_test(notification: Notification) -> Result<String, String> {
    let mut vars = HashMap::new();
    vars.insert("artist".to_string(), "Artista de prueba".to_string());
    vars.insert("title".to_string(), "Canción de prueba".to_string());
    vars.insert("currentsong".to_string(), "Artista de prueba - Canción de prueba".to_string());
    vars.insert("live".to_string(), "Artista de prueba - Canción de prueba".to_string());
    vars.insert("text".to_string(), "Artista de prueba - Canción de prueba".to_string());
    vars.insert("message".to_string(), "Prueba de notificación".to_string());
    let v = base_vars("test", vars);
    send(&notification, &v).map(|c| format!("Enviado (respuesta {c})"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vars() -> HashMap<String, String> {
        base_vars("track", [("text".to_string(), "Ñu & Co - Año".to_string())].into())
    }

    #[test]
    fn get_encodes_variables() {
        let n = Notification { url: "https://x.es/u?key=1&t={TEXT}&e={event}&z={nope}".into(), ..Default::default() };
        let (u, b) = build(&n, &vars());
        assert_eq!(u, "https://x.es/u?key=1&t=%C3%91u%20%26%20Co%20-%20A%C3%B1o&e=track&z={nope}");
        assert!(b.is_none());
    }

    #[test]
    fn post_json_escapes() {
        let mut v = vars();
        v.insert("text".into(), "dice \"hola\"\n".into());
        let n = Notification { method: "POST".into(), body_format: "json".into(), body: "{\"t\":\"{text}\"}".into(), ..Default::default() };
        let (_, b) = build(&n, &v);
        let (body, ct) = b.unwrap();
        assert_eq!(ct, "application/json");
        assert!(serde_json::from_str::<serde_json::Value>(&body).is_ok(), "{body}");
    }

    #[test]
    fn rejects_non_http() {
        let n = Notification { url: "file:///etc/passwd".into(), ..Default::default() };
        assert!(send(&n, &vars()).is_err());
    }

    #[test]
    fn sends_get_and_post_to_a_server() {
        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let port = server.server_addr().to_ip().unwrap().port();
        let h = std::thread::spawn(move || {
            let mut seen = Vec::new();
            for _ in 0..2 {
                let mut rq = server.recv().unwrap();
                let mut body = String::new();
                rq.as_reader().read_to_string(&mut body).unwrap();
                seen.push((rq.method().to_string(), rq.url().to_string(), body));
                rq.respond(tiny_http::Response::from_string("ok")).unwrap();
            }
            seen
        });
        let g = Notification { url: format!("http://127.0.0.1:{port}/u?s={{text}}"), ..Default::default() };
        assert_eq!(send(&g, &vars()).unwrap(), 200);
        let p = Notification {
            url: format!("http://127.0.0.1:{port}/p"),
            method: "POST".into(),
            body: "song={text}".into(),
            ..Default::default()
        };
        assert_eq!(send(&p, &vars()).unwrap(), 200);
        let seen = h.join().unwrap();
        assert_eq!(seen[0].0, "GET");
        assert!(seen[0].1.contains("s=%C3%91u"));
        assert_eq!(seen[1], ("POST".to_string(), "/p".to_string(), "song=%C3%91u%20%26%20Co%20-%20A%C3%B1o".to_string()));
    }
}
