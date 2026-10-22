//! Buscador de metadatos de Deezer (API publica, sin cuenta).
//!
//! Solo consulta datos publicos: titulo, artista, album, fecha, caratula y
//! preview de 30 s. NO descarga audio: el archivo que se importa es siempre
//! uno que el usuario ya tiene (compra, CD, promo...).

use serde::Serialize;
use serde_json::Value;
use std::time::Duration;

const API: &str = "https://api.deezer.com";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeezerTrack {
    pub id: u64,
    pub title: String,
    pub artist: String,
    pub album: String,
    pub duration_secs: u64,
    pub preview: String,
    pub cover: String,
    /// Portada grande (para guardar como caratula)
    pub cover_big: String,
    pub year: String,
    pub genre: String,
}

fn get_json(url: &str, query: &[(&str, &str)]) -> Result<Value, String> {
    let mut req = ureq::get(url).timeout(Duration::from_secs(12));
    for (k, v) in query {
        req = req.query(k, v);
    }
    let body = req
        .call()
        .map_err(|e| format!("No se pudo consultar Deezer: {e}"))?
        .into_string()
        .map_err(|e| e.to_string())?;
    let v: Value = serde_json::from_str(&body).map_err(|e| e.to_string())?;
    if let Some(err) = v.get("error") {
        let msg = err.get("message").and_then(Value::as_str).unwrap_or("error");
        return Err(format!("Deezer: {msg}"));
    }
    Ok(v)
}

fn s(v: &Value, path: &[&str]) -> String {
    let mut cur = v;
    for p in path {
        match cur.get(*p) {
            Some(n) => cur = n,
            None => return String::new(),
        }
    }
    cur.as_str().unwrap_or_default().to_string()
}

fn parse_track(v: &Value) -> DeezerTrack {
    let date = s(v, &["release_date"]);
    DeezerTrack {
        id: v.get("id").and_then(Value::as_u64).unwrap_or(0),
        title: s(v, &["title"]),
        artist: s(v, &["artist", "name"]),
        album: s(v, &["album", "title"]),
        duration_secs: v.get("duration").and_then(Value::as_u64).unwrap_or(0),
        preview: s(v, &["preview"]),
        cover: s(v, &["album", "cover_medium"]),
        cover_big: {
            let xl = s(v, &["album", "cover_xl"]);
            if xl.is_empty() { s(v, &["album", "cover_big"]) } else { xl }
        },
        year: date.get(..4).unwrap_or_default().to_string(),
        genre: String::new(),
    }
}

/// Busca canciones por texto libre (maximo 25 resultados).
#[tauri::command]
pub async fn deezer_search(query: String) -> Result<Vec<DeezerTrack>, String> {
    let q = query.trim().to_string();
    if q.is_empty() {
        return Ok(Vec::new());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let v = get_json(&format!("{API}/search"), &[("q", &q), ("limit", "25")])?;
        Ok(v.get("data")
            .and_then(Value::as_array)
            .map(|a| a.iter().map(parse_track).collect())
            .unwrap_or_default())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Detalle de una cancion: fecha de salida y genero del album.
#[tauri::command]
pub async fn deezer_track(id: u64) -> Result<DeezerTrack, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let v = get_json(&format!("{API}/track/{id}"), &[])?;
        let mut t = parse_track(&v);
        if let Some(album_id) = v.pointer("/album/id").and_then(Value::as_u64) {
            if let Ok(a) = get_json(&format!("{API}/album/{album_id}"), &[]) {
                if t.year.is_empty() {
                    t.year = s(&a, &["release_date"]).get(..4).unwrap_or_default().to_string();
                }
                t.genre = a
                    .pointer("/genres/data/0/name")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string();
            }
        }
        Ok(t)
    })
    .await
    .map_err(|e| e.to_string())?
}
