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
use crate::settings::AiSettings;
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

/// Primer objeto JSON equilibrado del texto (OpenCode puede rodear el JSON
/// con frases). Cuenta llaves sin meterse dentro de las comillas.
fn json_object(text: &str) -> Option<&str> {
    let bytes = text.as_bytes();
    let mut start: Option<usize> = None;
    let mut depth = 0usize;
    let mut in_string = false;
    let mut escaped = false;
    let mut i = 0usize;
    while i < bytes.len() {
        let c = bytes[i];
        if in_string {
            if escaped {
                escaped = false;
            } else if c == b'\\' {
                escaped = true;
            } else if c == b'"' {
                in_string = false;
            }
        } else if c == b'"' {
            in_string = true;
        } else if c == b'{' {
            if depth == 0 {
                start = Some(i);
            }
            depth += 1;
        } else if c == b'}' {
            if depth > 0 {
                depth -= 1;
                if depth == 0 {
                    if let Some(s) = start {
                        return Some(&text[s..i + 1]);
                    }
                }
            }
        }
        i += 1;
    }
    None
}

fn extract_json(content: &str) -> Result<Value, String> {
    let cleaned = json_body(content);
    serde_json::from_str::<Value>(cleaned).or_else(|e| match json_object(cleaned) {
        Some(obj) => serde_json::from_str::<Value>(obj)
            .map_err(|e2| format!("La IA devolvio un JSON no valido: {e} / {e2}")),
        None => Err(format!("La IA devolvio un JSON no valido: {e}")),
    })
}

fn parse_suggestion(parsed: Value) -> AiSuggestion {
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

    AiSuggestion {
        language,
        genre,
        tags,
        confidence,
        reason,
    }
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

fn opencode_command(path: &str) -> String {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        "opencode".to_string()
    } else {
        trimmed.to_string()
    }
}

/// Direccion base de un servicio en la nube compatible con OpenAI.
fn cloud_base(url: &str) -> String {
    let mut base = url.trim().trim_end_matches('/').to_string();
    if base.is_empty() {
        base = "https://api.openai.com/v1".to_string();
    }
    if !base.starts_with("http://") && !base.starts_with("https://") {
        base = format!("https://{base}");
    }
    base
}

/// Peticion chat/completions a un servicio en la nube (OpenAI, Groq, Gemini…).
/// Solo salen los metadatos de la ficha, igual que con Ollama.
fn cloud_chat(
    url: &str,
    key: &str,
    model: &str,
    system: &str,
    user: &str,
) -> Result<String, String> {
    if key.trim().is_empty() {
        return Err("Falta la clave del servicio de IA en la nube (Ajustes > IA)".to_string());
    }
    let model = model.trim();
    if model.is_empty() {
        return Err("Elige un modelo de la nube en Ajustes > IA".to_string());
    }
    let endpoint = format!("{}/chat/completions", cloud_base(url));
    let request = json!({
        "model": model,
        "stream": false,
        "messages": [
            { "role": "system", "content": system },
            { "role": "user", "content": user }
        ],
        "temperature": 0.1
    });
    let response = ureq::post(&endpoint)
        .timeout(Duration::from_secs(180))
        .set("Authorization", &format!("Bearer {}", key.trim()))
        .set("Content-Type", "application/json")
        .send_string(&request.to_string())
        .map_err(http_error)?;
    let body = response
        .into_string()
        .map_err(|e| format!("La IA en la nube devolvio una respuesta no valida: {e}"))?;
    let value: Value = serde_json::from_str(&body)
        .map_err(|e| format!("La IA en la nube devolvio una respuesta no valida: {e}"))?;
    value
        .pointer("/choices/0/message/content")
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| "La IA en la nube no devolvio contenido".to_string())
}

/// Catalogo de modelos de un servicio en la nube compatible con OpenAI.
fn cloud_models(url: &str, key: &str) -> Result<Vec<String>, String> {
    if key.trim().is_empty() {
        return Err("Falta la clave del servicio de IA en la nube (Ajustes > IA)".to_string());
    }
    let endpoint = format!("{}/models", cloud_base(url));
    let response = ureq::get(&endpoint)
        .timeout(Duration::from_secs(20))
        .set("Authorization", &format!("Bearer {}", key.trim()))
        .call()
        .map_err(http_error)?;
    let body = response
        .into_string()
        .map_err(|e| format!("La IA en la nube devolvio una respuesta no valida: {e}"))?;
    let value: Value = serde_json::from_str(&body)
        .map_err(|e| format!("La IA en la nube devolvio una respuesta no valida: {e}"))?;
    let mut models: Vec<String> = value
        .get("data")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.get("id").and_then(Value::as_str))
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();
    models.retain(|model| !model.trim().is_empty());
    models.sort();
    models.dedup();
    if models.is_empty() {
        return Err("El servicio de la nube no devolvio modelos".to_string());
    }
    Ok(models)
}


/// Ejecuta `opencode run` con limite de tiempo (el proceso se matara si se
/// cuelga esperando permisos u otro bloqueo). Devuelve el texto de respuesta.
fn run_opencode(command: &str, model: &str, prompt: &str) -> Result<String, String> {
    use std::io::Read;
    use std::process::{Child, Command, Stdio};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, Mutex};

    let mut cmd = Command::new(command);
    cmd.arg("run");
    if !model.trim().is_empty() {
        cmd.arg("--model").arg(model.trim());
    }
    cmd.arg(prompt)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    crate::streaming::configure_no_window(&mut cmd);
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("No se pudo ejecutar OpenCode («{command}»): {e}"))?;
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    // El hijo queda compartido: un hilo lo mata si supera el limite y el
    // principal lo espera al terminar de leer.
    let shared: Arc<Mutex<Option<Child>>> = Arc::new(Mutex::new(Some(child)));
    let stop = Arc::new(AtomicBool::new(false));
    let killer = {
        let shared = shared.clone();
        let stop = stop.clone();
        std::thread::spawn(move || {
            let start = std::time::Instant::now();
            while !stop.load(Ordering::SeqCst) {
                if start.elapsed() > Duration::from_secs(240) {
                    if let Ok(mut guard) = shared.lock() {
                        if let Some(child) = guard.as_mut() {
                            let _ = child.kill();
                            let _ = child.wait();
                        }
                    }
                    return;
                }
                std::thread::sleep(Duration::from_millis(250));
            }
        })
    };
    let stderr_text = std::thread::spawn(move || {
        let mut buf = String::new();
        if let Some(mut s) = stderr {
            let _ = s.read_to_string(&mut buf);
        }
        buf
    });
    let mut out = String::new();
    if let Some(mut s) = stdout {
        let _ = s.read_to_string(&mut out);
    }
    let joined = {
        let mut guard = shared.lock().unwrap_or_else(|e| e.into_inner());
        match guard.as_mut() {
            Some(child) => child.wait().map_err(|e| e.to_string()),
            None => Err("OpenCode terminó de forma inesperada".to_string()),
        }
    };
    stop.store(true, Ordering::SeqCst);
    let _ = killer.join();
    let err = stderr_text.join().unwrap_or_default();
    match joined {
        Ok(status) if status.success() => Ok(out.trim().to_string()),
        Ok(status) => {
            let mut last: Vec<&str> = err.lines().filter(|l| !l.trim().is_empty()).collect();
            if last.len() > 3 {
                last = last.split_off(last.len() - 3);
            }
            let tail = last.join(" | ");
            Err(format!(
                "OpenCode termino con error ({status}){}",
                if tail.is_empty() { String::new() } else { format!(": {}", tail.chars().take(300).collect::<String>()) }
            ))
        }
        Err(e) => Err(format!("No se pudo ejecutar OpenCode: {e}")),
    }
}

fn suggest(
    data_dir: &Path,
    id: &str,
    ai: &crate::settings::AiSettings,
    styles: &[String],
) -> Result<AiSuggestion, String> {
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

    if ai.provider.trim() == "cloud" {
        let content = cloud_chat(&ai.cloud_url, &ai.cloud_key, &ai.cloud_model, SYSTEM_PROMPT, &user_prompt)?;
        let parsed = extract_json(&content)?;
        return Ok(parse_suggestion(parsed));
    }
    if ai.provider.trim() == "opencode" {
        let message = format!("{SYSTEM_PROMPT}\n\n{user_prompt}\n\nRecuerda: responde SOLO el objeto JSON y no uses herramientas.");
        let content = run_opencode(&opencode_command(&ai.opencode_path), &ai.model, &message)?;
        let parsed = extract_json(&content)?;
        return Ok(parse_suggestion(parsed));
    }

    let model = ai.model.trim();
    if model.is_empty() {
        return Err("Elige un modelo de Ollama en Ajustes > IA".to_string());
    }

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
    let endpoint = format!("{}/api/chat", base_url(&ai.url));
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
    let parsed = extract_json(content)?;
    Ok(parse_suggestion(parsed))
}

/// Modelos disponibles segun el motor configurado: Ollama lista su servidor;
/// OpenCode ejecuta `opencode models` y la nube pide el catalogo al servicio.
#[tauri::command]
pub async fn ai_models(ai: AiSettings) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || match ai.provider.trim() {
        "opencode" => opencode_models(&opencode_command(&ai.opencode_path)),
        "cloud" => cloud_models(&ai.cloud_url, &ai.cloud_key),
        _ => list_models(&ai.url),
    })
    .await
    .map_err(|e| format!("No se pudo consultar el proveedor de IA: {e}"))?
}

/// Lista de modelos del catalogo de OpenCode (una por linea, "proveedor/modelo").
fn opencode_models(command: &str) -> Result<Vec<String>, String> {
    use std::process::{Command, Stdio};
    let mut cmd = Command::new(command);
    cmd.arg("models").stdout(Stdio::piped()).stderr(Stdio::null());
    crate::streaming::configure_no_window(&mut cmd);
    let out = cmd
        .output()
        .map_err(|e| format!("No se pudo ejecutar OpenCode («{command}»): {e}"))?;
    let text = String::from_utf8_lossy(&out.stdout);
    let mut models: Vec<String> = text
        .lines()
        .map(str::trim)
        .filter(|line| line.contains('/') && line.chars().all(|c| c.is_alphanumeric() || "/.-_ :".contains(c)))
        .map(str::to_string)
        .collect();
    models.sort();
    models.dedup();
    if models.is_empty() {
        return Err("OpenCode no devolvio modelos (¿hay proveedores configurados con «opencode auth login»?)".to_string());
    }
    Ok(models)
}

/// Pide al motor configurado una propuesta de idioma, estilo y etiquetas.
#[tauri::command]
pub async fn ai_suggest_metadata(
    state: State<'_, AppState>,
    id: String,
    ai: AiSettings,
    styles: Vec<String>,
) -> Result<AiSuggestion, String> {
    let data_dir = state.data_dir.clone();
    tauri::async_runtime::spawn_blocking(move || suggest(&data_dir, &id, &ai, &styles))
        .await
        .map_err(|e| format!("La IA se detuvo: {e}"))?
}

/// ¿Responde el orden de OpenCode? Devuelve su version.
#[tauri::command]
pub async fn ai_opencode_version(opencode_path: Option<String>) -> Result<String, String> {
    use std::process::{Command, Stdio};
    let command = opencode_command(&opencode_path.unwrap_or_default());
    tauri::async_runtime::spawn_blocking(move || {
        let mut cmd = Command::new(&command);
        cmd.arg("--version").stdout(Stdio::piped()).stderr(Stdio::null());
        crate::streaming::configure_no_window(&mut cmd);
        let out = cmd
            .output()
            .map_err(|e| format!("No se encontro OpenCode («{command}»): {e}"))?;
        let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
        if !out.status.success() || text.is_empty() {
            return Err("OpenCode no respondió a --version (¿instalado y con proveedor configurado?)".to_string());
        }
        Ok(text)
    })
    .await
    .map_err(|e| format!("No se pudo comprobar OpenCode: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    /// JSON limpio y JSON con charlas al rededor (OpenCode puede decir mas).
    #[test]
    fn json_extracts_from_noise() {
        let s = r#"{"language":"es","genre":"Pop","tags":["bailable"],"confidence":0.9,"reason":"claro"}"#;
        assert!(extract_json(s).is_ok());
        assert_eq!(json_object(s), Some(s), "con JSON puro se ve todo el objeto");
        let noisy = format!("Vale, te lo lleno:\n```json\n{s}\n```\nY fuera un saludo");
        let parsed = extract_json(&noisy).unwrap();
        assert_eq!(parsed["language"], "es");
        assert_eq!(parsed["tags"][0], "bailable");
        // Los llaves anidadas no despistan al scanner.
        let nested = "op he: {\"reason\": \"precio {1} del disco\"} queda a tu cargo";
        assert_eq!(json_object(nested).unwrap(), r#"{"reason": "precio {1} del disco"}"#);
    }

    /// El idioma se normaliza y la sugerencia sale limpia igual con cualquier proveedor.
    #[test]
    fn language_and_suggestion() {
        let v = serde_json::json!({
            "language": "SPANISH",
            "genre": "Pop",
            "tags": ["bailable", "", "BAILABLE"],
            "confidence": "0.75",
            "reason": "ritmo alto"
        });
        let s = parse_suggestion(v);
        assert_eq!(s.language, "es");
        assert_eq!(s.tags, vec!["bailable".to_string()]);
        assert!((s.confidence - 0.75).abs() < 1e-9);
    }
}
