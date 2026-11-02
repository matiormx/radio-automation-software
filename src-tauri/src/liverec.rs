//! Grabación de los directos: al activar LIVE se graba lo que sale al aire
//! (el mismo audio que va a los encoders) en un MP3, y se apunta cada cambio
//! de metadatos con su segundo exacto. Al terminar, la grabación entra en la
//! biblioteca con esos tramos: al reproducirla, el título que se emite va
//! cambiando igual que en el directo.
//!
//! - Los tramos se guardan además junto al archivo («X.mp3.tramos.json»),
//!   desde el primer momento: si OmniCaster se cierra a mitad, no se pierden.
//! - Al cerrar, se meten también como capítulos ID3 en el propio MP3.
//! - El tiempo de cada tramo sale del audio grabado (no del reloj), así
//!   coincide aunque el audio llegue a ratos.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{sync_channel, SyncSender};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};

use crate::library::Chapter;
use crate::AppState;

/// Bytes por segundo del PCM (s16le estéreo 48 kHz).
const BYTES_PER_SEC: f64 = 48_000.0 * 4.0;

struct Rec {
    child: Child,
    tx: Option<SyncSender<Vec<u8>>>,
    writer: Option<JoinHandle<()>>,
    bytes: Arc<AtomicU64>,
    path: PathBuf,
    meta: RecMeta,
    chapters: Vec<Chapter>,
}

static ACTIVE: AtomicBool = AtomicBool::new(false);
static REC: Mutex<Option<Rec>> = Mutex::new(None);

/// Datos del programa al empezar (o de un tramo).
#[derive(Deserialize, Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct RecMeta {
    pub title: String,
    pub artist: String,
    pub album: String,
    pub genre: String,
    pub cover: String,
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct RecStatus {
    pub active: bool,
    pub path: String,
    pub secs: f64,
    pub chapters: usize,
}

/// Audio que sale al aire (lo llama el envío a los encoders).
pub fn feed(data: &[u8]) {
    if !ACTIVE.load(Ordering::Relaxed) {
        return;
    }
    if let Ok(g) = REC.try_lock() {
        if let Some(tx) = g.as_ref().and_then(|r| r.tx.as_ref()) {
            // Si el disco no da abasto se pierde un trozo antes que frenar el audio.
            let _ = tx.try_send(data.to_vec());
        }
    }
}

fn sanitize(s: &str) -> String {
    let bad = ['\\', '/', ':', '*', '?', '"', '<', '>', '|'];
    let t: String = s.chars().map(|c| if bad.contains(&c) || (c as u32) < 32 { ' ' } else { c }).collect();
    let t = t.split_whitespace().collect::<Vec<_>>().join(" ");
    if t.is_empty() { "Directo".to_string() } else { t.chars().take(80).collect() }
}

fn sidecar(path: &Path) -> PathBuf {
    let mut p = path.as_os_str().to_owned();
    p.push(".tramos.json");
    PathBuf::from(p)
}

fn write_sidecar(path: &Path, chapters: &[Chapter]) {
    if let Ok(json) = serde_json::to_vec_pretty(chapters) {
        let _ = std::fs::write(sidecar(path), json);
    }
}

fn chapter(at: f64, m: &RecMeta) -> Chapter {
    Chapter {
        at: (at * 1000.0).round() / 1000.0,
        title: m.title.clone(),
        artist: m.artist.clone(),
        album: m.album.clone(),
        genre: m.genre.clone(),
        cover: m.cover.clone(),
    }
}

fn same(c: &Chapter, m: &RecMeta) -> bool {
    c.title == m.title && c.artist == m.artist && c.album == m.album && c.cover == m.cover
}

fn status_of(g: &Option<Rec>) -> RecStatus {
    match g {
        Some(r) => RecStatus {
            active: true,
            path: r.path.to_string_lossy().into_owned(),
            secs: r.bytes.load(Ordering::Relaxed) as f64 / BYTES_PER_SEC,
            chapters: r.chapters.len(),
        },
        None => RecStatus::default(),
    }
}

/// Empieza a grabar (si ya se graba, no hace nada).
#[tauri::command]
pub fn liverec_start(app: AppHandle, state: State<'_, AppState>, folder: String, meta: RecMeta) -> Result<RecStatus, String> {
    let mut g = REC.lock().unwrap_or_else(|e| e.into_inner());
    if g.is_some() {
        return Ok(status_of(&g));
    }
    let ffmpeg = crate::streaming::find_ffmpeg(&app).ok_or_else(crate::ffmpeg_dl::missing_message)?;
    let dir = if folder.trim().is_empty() {
        crate::library::music_dir_of(&state.data_dir).join("Directos")
    } else {
        PathBuf::from(folder.trim())
    };
    std::fs::create_dir_all(&dir).map_err(|e| format!("No se pudo crear la carpeta de grabaciones {}: {e}", dir.display()))?;
    let now = chrono::Local::now();
    let base = format!("{} - {}", sanitize(&meta.title), now.format("%Y-%m-%d %H.%M"));
    let mut path = dir.join(format!("{base}.mp3"));
    let mut n = 2;
    while path.exists() {
        path = dir.join(format!("{base} ({n}).mp3"));
        n += 1;
    }
    let title = format!("{} ({})", if meta.title.trim().is_empty() { "Directo" } else { meta.title.trim() }, now.format("%d/%m/%Y"));
    let mut cmd = Command::new(&ffmpeg);
    cmd.args(["-hide_banner", "-loglevel", "error", "-f", "s16le", "-ar", "48000", "-ac", "2", "-i", "pipe:0"])
        .args(["-c:a", "libmp3lame", "-b:a", "320k", "-id3v2_version", "3"])
        .args(["-metadata", &format!("title={title}")])
        .args(["-metadata", &format!("artist={}", meta.artist.trim())])
        .args(["-metadata", &format!("album={}", if meta.album.trim().is_empty() { "Directos" } else { meta.album.trim() })])
        .args(["-metadata", &format!("genre={}", meta.genre.trim())])
        .args(["-metadata", &format!("date={}", now.format("%Y"))])
        .args(["-y", "-f", "mp3"])
        .arg(&path)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    crate::streaming::configure_no_window(&mut cmd);
    let mut child = cmd.spawn().map_err(|e| format!("No se pudo arrancar FFmpeg para grabar: {e}"))?;
    let mut stdin = child.stdin.take().ok_or("FFmpeg no acepta audio")?;
    // ~10 s de margen por si el disco va lento un momento.
    let (tx, rx) = sync_channel::<Vec<u8>>(500);
    let bytes = Arc::new(AtomicU64::new(0));
    let counted = bytes.clone();
    let writer = std::thread::Builder::new()
        .name("miradio-liverec".into())
        .spawn(move || {
            while let Ok(chunk) = rx.recv() {
                if stdin.write_all(&chunk).is_err() {
                    break;
                }
                counted.fetch_add(chunk.len() as u64, Ordering::Relaxed);
            }
            // Al soltar stdin, FFmpeg cierra el MP3.
        })
        .ok();
    let first = chapter(0.0, &meta);
    write_sidecar(&path, std::slice::from_ref(&first));
    crate::crashlog::note(&format!("Grabando el directo en {}", path.display()));
    *g = Some(Rec { child, tx: Some(tx), writer, bytes, path, meta, chapters: vec![first] });
    ACTIVE.store(true, Ordering::SeqCst);
    Ok(status_of(&g))
}

/// Cambian los metadatos en el directo: nuevo tramo desde este segundo.
#[tauri::command]
pub fn liverec_mark(meta: RecMeta) -> RecStatus {
    let mut g = REC.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(r) = g.as_mut() {
        let at = r.bytes.load(Ordering::Relaxed) as f64 / BYTES_PER_SEC;
        let last_same = r.chapters.last().map(|c| same(c, &meta)).unwrap_or(false);
        if !last_same {
            // Un cambio en los primeros segundos de un tramo lo sustituye
            // (se estaba eligiendo el programa, no es un tramo de verdad).
            if r.chapters.last().map(|c| at - c.at < 3.0).unwrap_or(false) {
                r.chapters.pop();
            }
            let at = if r.chapters.is_empty() { 0.0 } else { at };
            r.chapters.push(chapter(at, &meta));
            write_sidecar(&r.path, &r.chapters);
        }
    }
    status_of(&g)
}

#[tauri::command]
pub fn liverec_status() -> RecStatus {
    status_of(&REC.lock().unwrap_or_else(|e| e.into_inner()))
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct RecDone {
    pub path: String,
    pub secs: f64,
    pub chapters: usize,
    /// Id en la biblioteca ("" si no se pudo añadir)
    pub track_id: String,
    pub error: String,
}

/// Termina la grabación: cierra el MP3, le pone los capítulos y la añade a
/// la biblioteca. Devuelve None si no se estaba grabando.
#[tauri::command]
pub async fn liverec_stop(app: AppHandle, state: State<'_, AppState>) -> Result<Option<RecDone>, String> {
    let data_dir = state.data_dir.clone();
    let ffmpeg = crate::streaming::find_ffmpeg(&app);
    tauri::async_runtime::spawn_blocking(move || stop(&data_dir, ffmpeg.as_deref()))
        .await
        .map_err(|e| e.to_string())
}

pub fn stop_now(data_dir: &Path, ffmpeg: Option<&Path>) -> Option<RecDone> {
    stop(data_dir, ffmpeg)
}

fn stop(data_dir: &Path, ffmpeg: Option<&Path>) -> Option<RecDone> {
    ACTIVE.store(false, Ordering::SeqCst);
    let mut r = REC.lock().unwrap_or_else(|e| e.into_inner()).take()?;
    r.tx.take();
    if let Some(w) = r.writer.take() {
        let _ = w.join();
    }
    // FFmpeg termina de escribir el MP3 al ver cerrada la entrada.
    let started = std::time::Instant::now();
    loop {
        match r.child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if started.elapsed() > std::time::Duration::from_secs(20) => {
                let _ = r.child.kill();
                let _ = r.child.wait();
                break;
            }
            Ok(None) => std::thread::sleep(std::time::Duration::from_millis(100)),
            Err(_) => break,
        }
    }
    let secs = r.bytes.load(Ordering::Relaxed) as f64 / BYTES_PER_SEC;
    let mut done = RecDone { path: r.path.to_string_lossy().into_owned(), secs, chapters: r.chapters.len(), ..Default::default() };
    if secs < 1.0 || !r.path.is_file() {
        let _ = std::fs::remove_file(&r.path);
        let _ = std::fs::remove_file(sidecar(&r.path));
        done.error = "No llegó audio a la grabación (¿está en marcha el motor de sonido?)".to_string();
        return Some(done);
    }
    // Tramos que empiezan después del final (por si acaso) fuera.
    r.chapters.retain(|c| c.at < secs);
    write_sidecar(&r.path, &r.chapters);
    if let Some(ff) = ffmpeg {
        if r.chapters.len() > 1 {
            embed_chapters(ff, &r.path, &r.chapters, secs);
        }
    }
    let title = format!(
        "{} ({})",
        if r.meta.title.trim().is_empty() { "Directo" } else { r.meta.title.trim() },
        chrono::Local::now().format("%d/%m/%Y")
    );
    let album = if r.meta.album.trim().is_empty() { "Directos" } else { r.meta.album.trim() };
    match crate::library::add_recorded(data_dir, &r.path, (&title, r.meta.artist.trim(), album, r.meta.genre.trim()), secs, &r.meta.cover, r.chapters.clone()) {
        Ok(id) => done.track_id = id,
        Err(e) => done.error = format!("Grabado, pero no se pudo añadir a la biblioteca: {e}"),
    }
    crate::crashlog::note(&format!("Directo grabado: {} ({:.0} s, {} tramos)", r.path.display(), secs, r.chapters.len()));
    Some(done)
}

/// Mete los tramos como capítulos ID3 (CHAP) en el MP3, sin recomprimir.
fn embed_chapters(ffmpeg: &Path, path: &Path, chapters: &[Chapter], total: f64) {
    let esc = |s: &str| s.replace('\\', "\\\\").replace('=', "\\=").replace(';', "\\;").replace('#', "\\#").replace('\n', " ");
    let mut meta = String::from(";FFMETADATA1\n");
    for (i, c) in chapters.iter().enumerate() {
        let end = chapters.get(i + 1).map(|n| n.at).unwrap_or(total);
        let name = if c.artist.trim().is_empty() { c.title.clone() } else { format!("{} - {}", c.artist, c.title) };
        meta.push_str(&format!("[CHAPTER]\nTIMEBASE=1/1000\nSTART={}\nEND={}\ntitle={}\n", (c.at * 1000.0) as u64, (end * 1000.0) as u64, esc(&name)));
    }
    let meta_file = path.with_extension("ffmeta.txt");
    let tmp = path.with_extension("tmp.mp3");
    if std::fs::write(&meta_file, meta).is_err() {
        return;
    }
    let mut cmd = Command::new(ffmpeg);
    cmd.args(["-hide_banner", "-loglevel", "error", "-i"])
        .arg(path)
        .arg("-i")
        .arg(&meta_file)
        .args(["-map", "0:a", "-map_metadata", "0", "-map_chapters", "1", "-c", "copy", "-id3v2_version", "3", "-y", "-f", "mp3"])
        .arg(&tmp)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    crate::streaming::configure_no_window(&mut cmd);
    let ok = cmd.status().map(|s| s.success()).unwrap_or(false);
    let _ = std::fs::remove_file(&meta_file);
    if ok && std::fs::metadata(&tmp).map(|m| m.len() > 0).unwrap_or(false) {
        if std::fs::rename(&tmp, path).is_err() {
            let _ = std::fs::remove_file(&tmp);
        }
    } else {
        let _ = std::fs::remove_file(&tmp);
    }
}

/// Al cerrar OmniCaster: se cierra bien el MP3 (sin pasarlo a la biblioteca:
/// sus tramos quedan al lado y se recuperan al importarlo).
pub fn shutdown() {
    ACTIVE.store(false, Ordering::SeqCst);
    if let Some(mut r) = REC.lock().unwrap_or_else(|e| e.into_inner()).take() {
        r.tx.take();
        if let Some(w) = r.writer.take() {
            let _ = w.join();
        }
        let _ = r.child.wait();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_are_safe() {
        assert_eq!(sanitize("Nueva Generación: en directo?"), "Nueva Generación en directo");
        assert_eq!(sanitize("  "), "Directo");
    }
}
