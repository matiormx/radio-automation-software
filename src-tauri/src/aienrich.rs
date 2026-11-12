//! Fichas IA de la biblioteca: energía (1–5), ánimo y temas de cada canción.
//!
//! Se procesan en segundo plano, de 10 en 10 (una consulta a la IA por
//! grupo), con la letra cuando se encuentra (archivo o LRCLIB). El resultado
//! se guarda en la canción y la sincronización con la nube lo reparte al
//! resto de equipos. Pensado para un puesto de trabajo: el del estudio no
//! gasta nada.
//!
//! El AutoDJ usa la energía para seguir la curva del día (ver settings).

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::library::Track;
use crate::settings::AiSettings;
use crate::AppState;

const BATCH: usize = 10;

const PROMPT: &str = r#"Eres un programador musical de una emisora de radio cristiana y familiar.
Para cada canción numerada (con sus metadatos y, si lo hay, un fragmento de la letra) devuelve su ficha.
Devuelve SOLO un objeto JSON válido, sin texto adicional:
{"items":[{"n":1,"energy":3,"mood":"...","themes":["...","..."]}]}
Reglas:
- energy: entero de 1 a 5 según cómo SUENA (tempo, intensidad, arreglo): 1 = muy tranquila/íntima (para dormir, piano y voz), 2 = suave (balada, adoración pausada), 3 = media (medio tiempo, chill), 4 = animada (pop/rock alegre), 5 = muy enérgica (fiesta, rápida, intensa). Si no conoces la canción, deduce por el estilo, el título y la letra; con «(En Vivo)» de adoración suele ser 2–3.
- mood: ánimo en 1–4 palabras en español (p. ej. «adoración íntima», «alabanza festiva», «reflexiva», «alegre»).
- themes: 1–4 temas de la letra en español, en minúsculas y en una o dos palabras (gratitud, esperanza, entrega, familia, perdón, gozo, fe, amor de Dios…). Vacío si es instrumental o no se sabe.
- Devuelve una entrada por cada canción, con su "n"."#;

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct EnrichStatus {
    pub running: bool,
    /// Canciones con ficha / total (sin inhabilitadas)
    pub done: usize,
    pub total: usize,
    /// Procesadas en esta tanda
    pub session: usize,
    pub error: String,
}

static RUNNING: AtomicBool = AtomicBool::new(false);
static STOP: AtomicBool = AtomicBool::new(false);
static STATUS: Mutex<EnrichStatus> = Mutex::new(EnrichStatus { running: false, done: 0, total: 0, session: 0, error: String::new() });

fn counts(data_dir: &Path) -> (usize, usize) {
    let lib = crate::library::read_library_internal(data_dir);
    let total = lib.iter().filter(|t| !t.disabled).count();
    let done = lib.iter().filter(|t| !t.disabled && t.energy > 0).count();
    (done, total)
}

fn set_status(f: impl FnOnce(&mut EnrichStatus)) {
    let mut s = STATUS.lock().unwrap_or_else(|e| e.into_inner());
    f(&mut s);
}

fn describe(n: usize, t: &Track) -> String {
    let mut s = format!("{n}. «{}» — {}", t.title.trim(), t.artist.trim());
    for (k, v) in [("álbum", t.album.trim()), ("estilo", t.genre.trim()), ("idioma", t.language.trim()), ("año", t.year.trim())] {
        if !v.is_empty() {
            s += &format!(" | {k}: {v}");
        }
    }
    if !t.tags.is_empty() {
        s += &format!(" | etiquetas: {}", t.tags.join(", "));
    }
    s += &format!(" | duración: {}:{:02}", (t.duration_secs as u64) / 60, (t.duration_secs as u64) % 60);
    let (lyrics, _) = crate::ai::lyrics_for(&t.file, &t.title, &t.artist, &t.album, t.duration_secs);
    if lyrics == crate::ai::INSTRUMENTAL {
        s += " | instrumental";
    } else if !lyrics.is_empty() {
        let frag: String = lyrics.split_whitespace().collect::<Vec<_>>().join(" ").chars().take(260).collect();
        s += &format!("\n   letra: {frag}");
    }
    s
}

fn clean_list(v: &Value) -> Vec<String> {
    v.as_array()
        .map(|a| {
            a.iter()
                .filter_map(Value::as_str)
                .map(|s| s.trim().to_lowercase())
                .filter(|s| !s.is_empty() && s.chars().count() <= 30)
                .take(4)
                .collect()
        })
        .unwrap_or_default()
}

fn run(app: AppHandle, data_dir: PathBuf, ai: AiSettings) {
    let mut fails = 0;
    loop {
        if STOP.load(Ordering::Relaxed) {
            break;
        }
        let lib = crate::library::read_library_internal(&data_dir);
        let todo: Vec<Track> = lib.into_iter().filter(|t| !t.disabled && t.energy == 0 && !t.title.trim().is_empty()).take(BATCH).collect();
        if todo.is_empty() {
            break;
        }
        let list: Vec<String> = todo.iter().enumerate().map(|(i, t)| describe(i + 1, t)).collect();
        let user = format!("Canciones:\n{}", list.join("\n"));
        match crate::ai::ask_json(&data_dir, &ai, PROMPT, &user) {
            Ok(out) => {
                fails = 0;
                let mut got: HashMap<String, (u8, String, Vec<String>)> = HashMap::new();
                if let Some(items) = out.get("items").and_then(Value::as_array) {
                    for it in items {
                        let n = it.get("n").and_then(Value::as_u64).unwrap_or(0) as usize;
                        let e = it.get("energy").and_then(|x| x.as_f64().or_else(|| x.as_str().and_then(|s| s.parse().ok()))).unwrap_or(0.0);
                        if n == 0 || n > todo.len() || !(1.0..=5.0).contains(&e.round()) {
                            continue;
                        }
                        let mood: String = it.get("mood").and_then(Value::as_str).unwrap_or("").trim().chars().take(40).collect();
                        got.insert(todo[n - 1].id.clone(), (e.round() as u8, mood, clean_list(it.get("themes").unwrap_or(&Value::Null))));
                    }
                }
                if got.is_empty() {
                    set_status(|s| s.error = "La IA no devolvió fichas válidas; se reintenta".into());
                    fails += 1;
                } else {
                    {
                        let _g = crate::library::lock_library();
                        let mut lib = crate::library::read_library_internal(&data_dir);
                        for t in lib.iter_mut() {
                            if let Some((e, m, th)) = got.get(&t.id) {
                                t.energy = *e;
                                t.mood = m.clone();
                                t.themes = th.clone();
                            }
                        }
                        if let Err(e) = crate::library::write_library(&data_dir, &lib) {
                            set_status(|s| s.error = format!("No se pudo guardar: {e}"));
                            break;
                        }
                    }
                    let _ = app.emit("library://changed", ());
                    crate::cloudsync::cloud_sync_now();
                    let (done, total) = counts(&data_dir);
                    set_status(|s| {
                        s.session += got.len();
                        s.done = done;
                        s.total = total;
                        s.error.clear();
                    });
                }
            }
            Err(e) => {
                fails += 1;
                set_status(|s| s.error = e.clone());
            }
        }
        if fails >= 5 {
            // Algo va mal (sin clave, sin conexión…): se para y se avisa.
            break;
        }
        // Un respiro entre consultas (y más si falla)
        let wait = if fails > 0 { 20 * fails as u64 } else { 1 };
        for _ in 0..wait * 4 {
            if STOP.load(Ordering::Relaxed) {
                break;
            }
            std::thread::sleep(Duration::from_millis(250));
        }
    }
    RUNNING.store(false, Ordering::SeqCst);
    set_status(|s| s.running = false);
    let _ = app.emit("aienrich://status", ());
}

/// Empieza a rellenar las fichas que faltan (si no está ya en marcha).
pub fn start(app: &AppHandle, data_dir: PathBuf, ai: AiSettings) {
    if RUNNING.swap(true, Ordering::SeqCst) {
        return;
    }
    STOP.store(false, Ordering::SeqCst);
    let (done, total) = counts(&data_dir);
    set_status(|s| {
        *s = EnrichStatus { running: true, done, total, session: 0, error: String::new() };
    });
    let app = app.clone();
    let _ = std::thread::Builder::new().name("ia-fichas".into()).spawn(move || run(app, data_dir, ai));
}

#[tauri::command]
pub fn ai_enrich_start(app: AppHandle, state: State<'_, AppState>, ai: AiSettings) -> EnrichStatus {
    start(&app, state.data_dir.clone(), ai);
    ai_enrich_status(state)
}

#[tauri::command]
pub fn ai_enrich_stop() {
    STOP.store(true, Ordering::SeqCst);
}

#[tauri::command]
pub fn ai_enrich_status(state: State<'_, AppState>) -> EnrichStatus {
    let mut s = STATUS.lock().unwrap_or_else(|e| e.into_inner()).clone();
    s.running = RUNNING.load(Ordering::Relaxed);
    if !s.running {
        let (done, total) = counts(&state.data_dir);
        s.done = done;
        s.total = total;
    }
    s
}

/// Al arrancar y cada 30 min: si está activado «procesar solo», rellena las
/// fichas de las canciones nuevas.
pub fn on_startup(app: AppHandle) {
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_secs(90));
        let Some(state) = app.try_state::<AppState>() else { continue };
        let dir = state.data_dir.clone();
        let s = crate::settings::read_settings_public(&dir.to_path_buf());
        if s.ai.enrich_auto && !RUNNING.load(Ordering::Relaxed) {
            let (done, total) = counts(&dir);
            if done < total {
                start(&app, dir, s.ai.clone());
            }
        }
        std::thread::sleep(Duration::from_secs(30 * 60));
    });
}
