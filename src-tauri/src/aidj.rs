//! Asistente de la IA para elegir canción.
//!
//! 1. El operador pide algo en el chat («algo tranquilo sobre la esperanza»).
//!    Opcionalmente se añade lo que se ha dicho en el directo (ver «escucha»).
//! 2. La IA traduce la petición a criterios (estilos, idiomas, etiquetas,
//!    palabras, artistas, duración…) usando lo que de verdad hay en la
//!    biblioteca.
//! 3. Aquí se puntúa toda la biblioteca con esos criterios (al instante, sin
//!    IA) y se quedan unas 80 candidatas que no hayan sonado hace poco.
//! 4. La IA elige de entre esas candidatas (no puede inventar canciones) y
//!    explica por qué.
//!
//! Escucha del directo (opcional, Ajustes > IA): mientras el directo está
//! activo se guarda el audio que sale al aire de los últimos segundos y, cada
//! medio minuto, Whisper (en este equipo, a prioridad mínima) lo pasa a texto.
//! Se guardan los últimos minutos para dárselos a la IA como contexto.

use std::collections::{HashMap, HashSet, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::State;

use crate::library::{read_library_internal, Track};
use crate::settings::AiSettings;
use crate::AppState;

// ------------------------------------------------------------------ chat

#[derive(Deserialize, Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct ChatMsg {
    /// "user" o "assistant"
    pub role: String,
    pub text: String,
}

#[derive(Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct PickRequest {
    pub message: String,
    pub history: Vec<ChatMsg>,
    /// «Título — Artista» de lo que suena
    pub now_playing: String,
    /// Lo que viene después en la lista (para no repetir)
    pub upcoming: Vec<String>,
    /// Canciones que han sonado hace poco (no se proponen)
    pub recent_ids: Vec<String>,
    /// Añadir lo que se ha dicho en el directo
    pub use_transcript: bool,
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Pick {
    pub id: String,
    pub title: String,
    pub artist: String,
    pub duration_secs: f64,
    pub reason: String,
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct PickReply {
    pub reply: String,
    pub picks: Vec<Pick>,
    /// Lo que se usó del directo (vacío si no)
    pub heard: String,
}

const PLAN_PROMPT: &str = r#"Eres el asistente musical del operador de una emisora de radio. Te pide qué canción poner.
Convierte la petición (y, si lo hay, lo que se ha hablado en el directo) en criterios de búsqueda para la biblioteca de la emisora.
Devuelve SOLO un objeto JSON válido, sin texto adicional, con esta forma:
{"genres":["..."],"languages":["es"],"tags":["..."],"keywords":["..."],"artists":["..."],"yearFrom":0,"yearTo":0,"maxSecs":0,"minSecs":0,"energy":0,"mood":"..."}
Reglas:
- genres y tags: elige SOLO de los valores de la biblioteca que se te dan (copiados tal cual). Pocos y relevantes.
- languages: códigos ISO 639-1 de la lista dada.
- keywords: 3 a 10 palabras sueltas en el idioma de la biblioteca que podrían aparecer en títulos, álbumes o etiquetas de canciones adecuadas (temas, sinónimos). Sin frases.
- artists: solo si la petición nombra artistas o los pide parecidos.
- yearFrom/yearTo/maxSecs/minSecs: 0 si no importa.
- energy: energía buscada de 1 (muy tranquila) a 5 (muy enérgica); 0 si no importa.
- mood: una frase corta con el ambiente buscado.
Si algo no se pide, déjalo vacío."#;

const CHOOSE_PROMPT: &str = r#"Eres el asistente musical del operador de una emisora de radio en directo.
Se te da su petición, el contexto y una lista NUMERADA de canciones candidatas de la biblioteca.
Elige entre 3 y 5 canciones de esa lista (las que mejor encajen; variadas, sin repetir artista si se puede) y explica cada una en una frase breve en español.
Devuelve SOLO un objeto JSON válido, sin texto adicional:
{"reply":"una o dos frases para el operador","picks":[{"n":12,"reason":"..."}]}
Reglas: "n" es el número de la lista. No inventes canciones que no estén en la lista. Si ninguna encaja bien, dilo en "reply" y propón las más cercanas."#;

fn fold(s: &str) -> String {
    s.chars()
        .flat_map(|c| c.to_lowercase())
        .map(|c| match c {
            'á' | 'à' | 'ä' | 'â' => 'a',
            'é' | 'è' | 'ë' | 'ê' => 'e',
            'í' | 'ì' | 'ï' | 'î' => 'i',
            'ó' | 'ò' | 'ö' | 'ô' => 'o',
            'ú' | 'ù' | 'ü' | 'û' => 'u',
            'ñ' => 'n',
            'ç' => 'c',
            c => c,
        })
        .collect()
}

fn strs(v: &Value, key: &str) -> Vec<String> {
    v.get(key)
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(Value::as_str).map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).take(20).collect())
        .unwrap_or_default()
}

fn num(v: &Value, key: &str) -> f64 {
    v.get(key).and_then(|x| x.as_f64().or_else(|| x.as_str().and_then(|s| s.parse().ok()))).unwrap_or(0.0)
}

fn mmss(secs: f64) -> String {
    let s = secs.max(0.0).round() as u64;
    format!("{}:{:02}", s / 60, s % 60)
}

/// Valores más frecuentes de un campo (para que la IA use los de verdad).
fn top<'a>(items: impl Iterator<Item = &'a str>, n: usize) -> Vec<String> {
    let mut count: HashMap<String, (String, usize)> = HashMap::new();
    for it in items {
        let t = it.trim();
        if t.is_empty() {
            continue;
        }
        let e = count.entry(fold(t)).or_insert_with(|| (t.to_string(), 0));
        e.1 += 1;
    }
    let mut v: Vec<(String, usize)> = count.into_values().collect();
    v.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
    v.into_iter().take(n).map(|(s, c)| format!("{s} ({c})")).collect()
}

fn context_text(req: &PickRequest, heard: &str) -> String {
    let mut s = String::new();
    if !req.now_playing.trim().is_empty() {
        s += &format!("Suena ahora: {}\n", req.now_playing.trim());
    }
    if !req.upcoming.is_empty() {
        s += &format!("Después en la lista: {}\n", req.upcoming.iter().take(5).cloned().collect::<Vec<_>>().join(" | "));
    }
    if !heard.is_empty() {
        s += &format!("Lo último que se ha dicho en el directo (transcripción automática, puede tener errores):\n«{heard}»\n");
    }
    let hist: Vec<String> = req
        .history
        .iter()
        .rev()
        .take(6)
        .rev()
        .map(|m| format!("{}: {}", if m.role == "assistant" { "Asistente" } else { "Operador" }, m.text.chars().take(400).collect::<String>()))
        .collect();
    if !hist.is_empty() {
        s += &format!("Conversación anterior:\n{}\n", hist.join("\n"));
    }
    s
}

fn score(t: &Track, plan: &Value, kw: &[String], genres: &HashSet<String>, langs: &HashSet<String>, tags: &HashSet<String>, artists: &[String]) -> f64 {
    let mut sc = 0.0;
    if !genres.is_empty() && genres.contains(&fold(t.genre.trim())) {
        sc += 3.0;
    }
    if !langs.is_empty() {
        if langs.contains(&fold(t.language.trim())) {
            sc += 2.0;
        } else if !t.language.trim().is_empty() {
            sc -= 2.0;
        }
    }
    for tg in &t.tags {
        if tags.contains(&fold(tg.trim())) {
            sc += 2.0;
        }
    }
    let hay = fold(&format!("{} {} {} {} {} {} {}", t.title, t.album, t.genre, t.tags.join(" "), t.artist, t.mood, t.themes.join(" ")));
    let themes = fold(&t.themes.join(" "));
    for k in kw {
        if !k.is_empty() && themes.contains(k.as_str()) {
            sc += 2.0; // de qué habla la letra pesa más
        }
    }
    let want = num(plan, "energy").round() as i32;
    if (1..=5).contains(&want) && t.energy > 0 {
        sc += 2.0 - (t.energy as i32 - want).abs() as f64;
    }
    for k in kw {
        if !k.is_empty() && hay.contains(k.as_str()) {
            sc += 2.0;
        }
    }
    let art = fold(&t.artist);
    for a in artists {
        if !a.is_empty() && art.contains(a.as_str()) {
            sc += 4.0;
        }
    }
    let year: i64 = t.year.trim().get(..4).and_then(|y| y.parse().ok()).unwrap_or(0);
    let (yf, yt) = (num(plan, "yearFrom") as i64, num(plan, "yearTo") as i64);
    if year > 0 && (yf > 0 || yt > 0) {
        if (yf == 0 || year >= yf) && (yt == 0 || year <= yt) {
            sc += 1.0;
        } else {
            sc -= 1.0;
        }
    }
    let (mx, mn) = (num(plan, "maxSecs"), num(plan, "minSecs"));
    if (mx > 0.0 && t.duration_secs > mx) || (mn > 0.0 && t.duration_secs < mn) {
        sc -= 3.0;
    }
    sc
}

fn pick(data_dir: &Path, ai: &AiSettings, req: &PickRequest) -> Result<PickReply, String> {
    let lib: Vec<Track> = read_library_internal(data_dir).into_iter().filter(|t| !t.disabled && !t.file.trim().is_empty()).collect();
    if lib.is_empty() {
        return Err("La biblioteca está vacía".to_string());
    }
    let heard = if req.use_transcript { transcript_text(240) } else { String::new() };
    let ctx = context_text(req, &heard);
    let ask = if req.message.trim().is_empty() {
        "Propón qué poner ahora según lo que se ha hablado en el directo y lo que está sonando.".to_string()
    } else {
        req.message.trim().chars().take(1500).collect()
    };

    // 1) Criterios
    let genres = top(lib.iter().map(|t| t.genre.as_str()), 60);
    let langs = top(lib.iter().map(|t| t.language.as_str()), 15);
    let tags = top(lib.iter().flat_map(|t| t.tags.iter().map(String::as_str)), 80);
    let plan_user = format!(
        "Petición del operador: {ask}\n{ctx}\nEstilos de la biblioteca (canciones): {}\nIdiomas: {}\nEtiquetas: {}",
        genres.join(", "),
        langs.join(", "),
        tags.join(", ")
    );
    let plan = crate::ai::ask_json(data_dir, ai, PLAN_PROMPT, &plan_user)?;
    let clean = |v: Vec<String>| -> HashSet<String> { v.iter().map(|s| fold(s.split(" (").next().unwrap_or(s).trim())).filter(|s| !s.is_empty()).collect() };
    let g = clean(strs(&plan, "genres"));
    let l = clean(strs(&plan, "languages"));
    let tg = clean(strs(&plan, "tags"));
    let kw: Vec<String> = strs(&plan, "keywords").iter().map(|s| fold(s)).filter(|s| s.chars().count() >= 3).collect();
    let ar: Vec<String> = strs(&plan, "artists").iter().map(|s| fold(s)).collect();

    // 2) Candidatas
    let recent: HashSet<&str> = req.recent_ids.iter().map(String::as_str).collect();
    let mut scored: Vec<(f64, u64, &Track)> = lib
        .iter()
        .filter(|t| !recent.contains(t.id.as_str()))
        .map(|t| {
            // Desempate variado pero estable dentro de esta petición
            let mut h: u64 = 1469598103934665603;
            for b in t.id.bytes().chain(ask.bytes()) {
                h = (h ^ b as u64).wrapping_mul(1099511628211);
            }
            (score(t, &plan, &kw, &g, &l, &tg, &ar), h, t)
        })
        .collect();
    scored.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal).then(a.1.cmp(&b.1)));
    let cands: Vec<&Track> = scored.iter().take(80).map(|x| x.2).collect();
    if cands.is_empty() {
        return Err("No quedan canciones que no hayan sonado hace poco".to_string());
    }
    let list: Vec<String> = cands
        .iter()
        .enumerate()
        .map(|(i, t)| {
            let mut s = format!("{}. {} — {}", i + 1, t.title.trim(), t.artist.trim());
            for (k, v) in [("estilo", t.genre.trim()), ("idioma", t.language.trim()), ("año", t.year.trim())] {
                if !v.is_empty() {
                    s += &format!(" | {k}: {v}");
                }
            }
            if !t.tags.is_empty() {
                s += &format!(" | etiquetas: {}", t.tags.join(", "));
            }
            if t.energy > 0 {
                s += &format!(" | energía {}/5", t.energy);
            }
            if !t.mood.is_empty() {
                s += &format!(" | ánimo: {}", t.mood);
            }
            if !t.themes.is_empty() {
                s += &format!(" | temas: {}", t.themes.join(", "));
            }
            s += &format!(" | {}", mmss(t.duration_secs));
            s
        })
        .collect();

    // 3) Elección
    let mood = plan.get("mood").and_then(Value::as_str).unwrap_or("");
    let choose_user = format!(
        "Petición del operador: {ask}\nAmbiente buscado: {mood}\n{ctx}\nCandidatas:\n{}",
        list.join("\n")
    );
    let out = crate::ai::ask_json(data_dir, ai, CHOOSE_PROMPT, &choose_user)?;
    let mut picks = Vec::new();
    let mut seen = HashSet::new();
    if let Some(arr) = out.get("picks").and_then(Value::as_array) {
        for p in arr {
            let n = num(p, "n") as usize;
            if n == 0 || n > cands.len() || !seen.insert(n) {
                continue;
            }
            let t = cands[n - 1];
            picks.push(Pick {
                id: t.id.clone(),
                title: t.title.clone(),
                artist: t.artist.clone(),
                duration_secs: t.duration_secs,
                reason: p.get("reason").and_then(Value::as_str).unwrap_or("").trim().to_string(),
            });
            if picks.len() >= 6 {
                break;
            }
        }
    }
    let reply = out.get("reply").and_then(Value::as_str).unwrap_or("").trim().to_string();
    if picks.is_empty() && reply.is_empty() {
        return Err("La IA no propuso ninguna canción; prueba a pedirlo de otra forma".to_string());
    }
    Ok(PickReply { reply, picks, heard })
}

#[tauri::command]
pub async fn ai_pick(state: State<'_, AppState>, ai: AiSettings, req: PickRequest) -> Result<PickReply, String> {
    let data_dir = state.data_dir.clone();
    tauri::async_runtime::spawn_blocking(move || pick(&data_dir, &ai, &req))
        .await
        .map_err(|e| format!("La IA se detuvo: {e}"))?
}

// ------------------------------------------------------------------ escucha del directo

/// Segundos de audio que se guardan (y que se pasan a texto de cada vez).
const CHUNK_SECS: usize = 30;
const RATE: usize = 48_000;
/// Cuánto texto se recuerda.
const KEEP_SECS: u64 = 15 * 60;

static LISTENING: AtomicBool = AtomicBool::new(false);
/// PCM s16le estéreo 48 kHz del último trozo
static RING: Mutex<VecDeque<u8>> = Mutex::new(VecDeque::new());
static TEXT: Mutex<VecDeque<(u64, String)>> = Mutex::new(VecDeque::new());
static WORKER: Mutex<Option<std::thread::JoinHandle<()>>> = Mutex::new(None);
static LAST_ERR: Mutex<String> = Mutex::new(String::new());

fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

/// Audio que sale al aire (lo llama el envío a los encoders). Barato: solo
/// copia si la escucha está activa.
pub fn feed(data: &[u8]) {
    if !LISTENING.load(Ordering::Relaxed) {
        return;
    }
    if let Ok(mut r) = RING.try_lock() {
        r.extend(data.iter().copied());
        let max = CHUNK_SECS * RATE * 4;
        let extra = r.len().saturating_sub(max);
        if extra > 0 {
            r.drain(..extra);
        }
    }
}

/// Últimos `secs` segundos de texto oído.
pub fn transcript_text(secs: u64) -> String {
    let since = now().saturating_sub(secs);
    let t = TEXT.lock().unwrap_or_else(|e| e.into_inner());
    let s: Vec<&str> = t.iter().filter(|(at, _)| *at >= since).map(|(_, s)| s.as_str()).collect();
    let all = s.join(" ");
    // Lo más reciente es lo que cuenta
    let n = all.chars().count();
    all.chars().skip(n.saturating_sub(2500)).collect()
}

/// PCM estéreo 48 kHz -> WAV mono 16 kHz (lo que pide Whisper).
fn write_wav(pcm: &[u8], path: &Path) -> std::io::Result<()> {
    let frames = pcm.len() / 4;
    let mut out: Vec<i16> = Vec::with_capacity(frames / 3 + 1);
    let mut i = 0;
    while i + 3 <= frames {
        let mut acc = 0i32;
        for k in 0..3 {
            let o = (i + k) * 4;
            let l = i16::from_le_bytes([pcm[o], pcm[o + 1]]) as i32;
            let r = i16::from_le_bytes([pcm[o + 2], pcm[o + 3]]) as i32;
            acc += l + r;
        }
        out.push((acc / 6) as i16);
        i += 3;
    }
    let data_len = (out.len() * 2) as u32;
    let mut b: Vec<u8> = Vec::with_capacity(44 + data_len as usize);
    b.extend_from_slice(b"RIFF");
    b.extend_from_slice(&(36 + data_len).to_le_bytes());
    b.extend_from_slice(b"WAVEfmt ");
    b.extend_from_slice(&16u32.to_le_bytes());
    b.extend_from_slice(&1u16.to_le_bytes());
    b.extend_from_slice(&1u16.to_le_bytes());
    b.extend_from_slice(&16_000u32.to_le_bytes());
    b.extend_from_slice(&32_000u32.to_le_bytes());
    b.extend_from_slice(&2u16.to_le_bytes());
    b.extend_from_slice(&16u16.to_le_bytes());
    b.extend_from_slice(b"data");
    b.extend_from_slice(&data_len.to_le_bytes());
    for s in out {
        b.extend_from_slice(&s.to_le_bytes());
    }
    std::fs::write(path, b)
}

fn worker(data_dir: PathBuf) {
    let wav = std::env::temp_dir().join(format!("omnicaster-directo-{}.wav", std::process::id()));
    let mut last = Instant::now();
    while LISTENING.load(Ordering::Relaxed) {
        std::thread::sleep(Duration::from_millis(500));
        if last.elapsed() < Duration::from_secs(CHUNK_SECS as u64) {
            continue;
        }
        last = Instant::now();
        let pcm: Vec<u8> = {
            let mut r = RING.lock().unwrap_or_else(|e| e.into_inner());
            let v: Vec<u8> = r.iter().copied().collect();
            r.clear();
            v
        };
        // Menos de 5 s (encoders parados): nada que oír
        if pcm.len() < 5 * RATE * 4 {
            continue;
        }
        if write_wav(&pcm, &wav).is_err() {
            continue;
        }
        match crate::whisper::transcribe(&data_dir, &wav) {
            Ok(text) if text.chars().filter(|c| c.is_alphabetic()).count() >= 8 => {
                let mut t = TEXT.lock().unwrap_or_else(|e| e.into_inner());
                t.push_back((now(), text));
                let since = now().saturating_sub(KEEP_SECS);
                while t.front().is_some_and(|(at, _)| *at < since) {
                    t.pop_front();
                }
                *LAST_ERR.lock().unwrap_or_else(|e| e.into_inner()) = String::new();
            }
            Ok(_) => {}
            Err(e) => {
                let mut le = LAST_ERR.lock().unwrap_or_else(|e| e.into_inner());
                if *le != e {
                    crate::crashlog::note(&format!("Escucha del directo: {e}"));
                }
                *le = e;
            }
        }
        let _ = std::fs::remove_file(&wav);
    }
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct ListenStatus {
    pub active: bool,
    pub text: String,
    pub error: String,
}

/// Enciende o apaga la escucha (la interfaz la enciende con el directo si
/// está activada en Ajustes).
#[tauri::command]
pub fn ai_listen_set(state: State<'_, AppState>, active: bool) -> ListenStatus {
    if active && !LISTENING.swap(true, Ordering::SeqCst) {
        RING.lock().unwrap_or_else(|e| e.into_inner()).clear();
        let dir = state.data_dir.clone();
        let h = std::thread::Builder::new().name("ia-escucha".into()).spawn(move || worker(dir)).ok();
        *WORKER.lock().unwrap_or_else(|e| e.into_inner()) = h;
    } else if !active && LISTENING.swap(false, Ordering::SeqCst) {
        RING.lock().unwrap_or_else(|e| e.into_inner()).clear();
        // El hilo termina solo (no se le espera: puede estar en mitad de Whisper)
        let _ = WORKER.lock().unwrap_or_else(|e| e.into_inner()).take();
    }
    ai_listen_status()
}

#[tauri::command]
pub fn ai_listen_status() -> ListenStatus {
    ListenStatus {
        active: LISTENING.load(Ordering::Relaxed),
        text: transcript_text(KEEP_SECS),
        error: LAST_ERR.lock().map(|e| e.clone()).unwrap_or_default(),
    }
}

#[tauri::command]
pub fn ai_listen_clear() {
    TEXT.lock().unwrap_or_else(|e| e.into_inner()).clear();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn folds_accents() {
        assert_eq!(fold("Canción ÉXITO ñ"), "cancion exito n");
    }

    #[test]
    fn wav_is_mono_16k() {
        let pcm = vec![0u8; 48_000 * 4];
        let p = std::env::temp_dir().join("oc-test-directo.wav");
        write_wav(&pcm, &p).unwrap();
        let b = std::fs::read(&p).unwrap();
        assert_eq!(&b[..4], b"RIFF");
        assert_eq!(b.len(), 44 + 16_000 * 2);
        let _ = std::fs::remove_file(&p);
    }
}
