//! Analisis de metadatos con un Ollama local.
//!
//! Solo se envian los metadatos de la ficha (titulo, artista, album, año,
//! estilo y etiquetas) y el nombre del archivo. El audio no sale del equipo.
//! Las propuestas se devuelven a la interfaz y solo se guardan si el operador
//! las acepta.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::Path;
use std::time::Duration;
use tauri::State;

use crate::library::{clean_language, read_library_internal};
use crate::AppState;

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct AiSuggestion {
    pub language: String,
    pub genre: String,
    pub tags: Vec<String>,
    pub confidence: f64,
    pub reason: String,
}

const SYSTEM_PROMPT: &str = r#"Eres un catalogador musical para una emisora de radio.
Analiza los metadatos de una cancion y devuelve SOLO un objeto JSON valido, sin texto adicional, con esta forma:
{"language":"es","genre":"Pop","tags":["balada","acustico"],"confidence":0.8,"reason":"..."}
Reglas:
- language: codigo ISO 639-1 de dos letras del idioma principal de la letra. Si es instrumental o no puedes determinarlo, usa "".
- genre: estilo musical breve en español. Si se ofrecen estilos preferidos, elige uno de ellos cuando encaje.
- tags: entre 0 y 5 etiquetas cortas y utiles (instrumental, bailable, acustico, navidad, etc.).
- confidence: numero entre 0 y 1. Baja la confianza si solo tienes el titulo o no estas seguro.
- reason: una frase breve en español que explique la decision.
No inventes datos que no se puedan deducir de los metadatos."#;

fn base_url(url: &str) -> String {
    let mut base = url.trim().trim_end_matches('/').to_string();
    if base.is_empty() {
        base = "http://127.0.0.1:11434".to_string();
    }
    if !base.starts_with("http://") && !base.starts_with("https://") {
        base = format!("http://{base}");
    }
    base
}

fn http_error(error: ureq::Error) -> String {
    match error {
        ureq::Error::Status(code, response) => {
            let body = response.into_string().unwrap_or_default();
            let body = body.trim();
            if body.is_empty() {
                format!("Ollama respondio {code}")
            } else {
                format!(
                    "Ollama respondio {code}: {}",
                    body.chars().take(300).collect::<String>()
                )
            }
        }
        other => format!("No se pudo conectar con Ollama: {other}"),
    }
}

fn json_body(text: &str) -> &str {
    let mut body = text.trim();
    if let Some(rest) = body.strip_prefix("```json") {
        body = rest.trim();
    } else if let Some(rest) = body.strip_prefix("```") {
        body = rest.trim();
    }
    if let Some(rest) = body.strip_suffix("```") {
        body = rest.trim();
    }
    body
}

fn normalize_language(value: &str) -> String {
    let lower = value.trim().to_ascii_lowercase();
    let primary = lower.split(|c| c == '-' || c == '_').next().unwrap_or("");
    let cleaned = clean_language(primary);
    if !cleaned.is_empty() {
        return cleaned;
    }
    let code = match lower.as_str() {
        "espanol" | "español" | "spanish" => "es",
        "ingles" | "inglés" | "english" => "en",
        "portugues" | "portugués" | "portuguese" => "pt",
        "aleman" | "alemán" | "german" => "de",
        "frances" | "francés" | "french" => "fr",
        "italiano" | "italian" => "it",
        "catalan" | "catalán" => "ca",
        "gallego" => "gl",
        "euskera" | "vasco" => "eu",
        "neerlandes" | "neerlandés" | "dutch" => "nl",
        "sueco" | "swedish" => "sv",
        "noruego" | "norwegian" => "no",
        "danes" | "danés" | "danish" => "da",
        "fines" | "finés" | "finnish" => "fi",
        "polaco" | "polish" => "pl",
        "ruso" | "russian" => "ru",
        "ucraniano" | "ukrainian" => "uk",
        "griego" | "greek" => "el",
        "turco" | "turkish" => "tr",
        "rumano" | "romanian" => "ro",
        "japones" | "japonés" | "japanese" => "ja",
        "coreano" | "korean" => "ko",
        "chino" | "chinese" => "zh",
        "arabe" | "árabe" | "arabic" => "ar",
        "hebreo" | "hebrew" => "he",
        "hindi" => "hi",
        "latin" | "latín" => "la",
        _ => "",
    };
    code.to_string()
}

fn clean_tags(tags: Vec<String>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for tag in tags {
        let tag = tag.trim().to_string();
        if tag.is_empty() {
            continue;
        }
        if !out.iter().any(|x| x.eq_ignore_ascii_case(&tag)) {
            out.push(tag);
        }
        if out.len() >= 8 {
            break;
        }
    }
    out
}

fn list_models(url: &str) -> Result<Vec<String>, String> {
    let endpoint = format!("{}/api/tags", base_url(url));
    let response = ureq::get(&endpoint)
        .timeout(Duration::from_secs(15))
        .call()
        .map_err(http_error)?;
    let body = response
        .into_string()
        .map_err(|e| format!("Ollama devolvio una respuesta no valida: {e}"))?;
    let value: Value = serde_json::from_str(&body)
        .map_err(|e| format!("Ollama devolvio una respuesta no valida: {e}"))?;
    let mut models: Vec<String> = value
        .get("models")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.get("name").and_then(Value::as_str))
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();
    models.sort();
    models.dedup();
    Ok(models)
}

fn suggest(
    data_dir: &Path,
    id: &str,
    url: &str,
    model: &str,
    styles: &[String],
) -> Result<AiSuggestion, String> {
    let model = model.trim();
    if model.is_empty() {
        return Err("Elige un modelo de Ollama en Ajustes > IA".to_string());
    }
    let tracks = read_library_internal(data_dir);
    let track = tracks
        .iter()
        .find(|t| t.id == id)
        .ok_or_else(|| "La cancion ya no existe en la biblioteca".to_string())?;

    let file_name = Path::new(&track.file)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("");
    let current_tags = track.tags.join(", ");
    let styles_text = styles
        .iter()
        .map(|style| style.trim())
        .filter(|style| !style.is_empty())
        .take(80)
        .collect::<Vec<_>>()
        .join(", ");
    let user_prompt = format!(
        "Titulo: {}\nArtista: {}\nAlbum: {}\nAño: {}\nEstilo actual: {}\nEtiquetas actuales: {}\nArchivo: {}\nEstilos preferidos: {}",
        track.title,
        track.artist,
        track.album,
        track.year,
        track.genre,
        current_tags,
        file_name,
        styles_text
    );

    let request = json!({
        "model": model,
        "stream": false,
        "format": "json",
        "messages": [
            { "role": "system", "content": SYSTEM_PROMPT },
            { "role": "user", "content": user_prompt }
        ],
        "options": { "temperature": 0.1 }
    });
    let endpoint = format!("{}/api/chat", base_url(url));
    let response = ureq::post(&endpoint)
        .timeout(Duration::from_secs(180))
        .set("Content-Type", "application/json")
        .send_string(&request.to_string())
        .map_err(http_error)?;
    let body = response
        .into_string()
        .map_err(|e| format!("Ollama devolvio una respuesta no valida: {e}"))?;
    let value: Value = serde_json::from_str(&body)
        .map_err(|e| format!("Ollama devolvio una respuesta no valida: {e}"))?;
    let content = value
        .pointer("/message/content")
        .and_then(Value::as_str)
        .or_else(|| value.get("response").and_then(Value::as_str))
        .ok_or_else(|| "Ollama no devolvio contenido".to_string())?;
    let parsed: Value = serde_json::from_str(json_body(content))
        .map_err(|e| format!("La IA devolvio un JSON no valido: {e}"))?;

    let language = normalize_language(parsed.get("language").and_then(Value::as_str).unwrap_or(""));
    let genre = parsed
        .get("genre")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .chars()
        .take(80)
        .collect::<String>();
    let tags = clean_tags(
        parsed
            .get("tags")
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default(),
    );
    let confidence = parsed
        .get("confidence")
        .and_then(|v| {
            v.as_f64()
                .or_else(|| v.as_str().and_then(|s| s.parse::<f64>().ok()))
        })
        .unwrap_or(0.0)
        .clamp(0.0, 1.0);
    let reason = parsed
        .get("reason")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .chars()
        .take(300)
        .collect::<String>();

    Ok(AiSuggestion {
        language,
        genre,
        tags,
        confidence,
        reason,
    })
}

/// Devuelve los modelos instalados en el Ollama configurado.
#[tauri::command]
pub async fn ai_models(url: String) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || list_models(&url))
        .await
        .map_err(|e| format!("No se pudo consultar Ollama: {e}"))?
}

/// Pide a Ollama una propuesta de idioma, estilo y etiquetas para una pista.
#[tauri::command]
pub async fn ai_suggest_metadata(
    state: State<'_, AppState>,
    id: String,
    url: String,
    model: String,
    styles: Vec<String>,
) -> Result<AiSuggestion, String> {
    let data_dir = state.data_dir.clone();
    tauri::async_runtime::spawn_blocking(move || {
        suggest(&data_dir, &id, &url, &model, &styles)
    })
    .await
    .map_err(|e| format!("La IA se detuvo: {e}"))?
}
