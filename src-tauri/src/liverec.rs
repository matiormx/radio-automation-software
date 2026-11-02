//! Grabación de los directos: al activar LIVE se graba lo que sale al aire
//! (el mismo audio que va a los encoders) en FLAC o AAC (.m4a), a elegir, y se apunta cada cambio
//! de metadatos con su segundo exacto. Al terminar, la grabación entra en la
//! biblioteca con esos tramos: al reproducirla, el título que se emite va
//! cambiando igual que en el directo.
//!
//! - Los tramos se guardan además junto al archivo («X.flac.tramos.json»),
//!   desde el primer momento: si OmniCaster se cierra a mitad, no se pierden.
//! - Al cerrar, se meten también como capítulos (Vorbis) en el propio FLAC.
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
    config: RecConfig,
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

/// Cómo se graba (Ajustes › Programas › Grabar los directos).
#[derive(Deserialize, Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct RecConfig {
    /// Carpeta; vacío = «Directos» dentro de la carpeta de música
    pub folder: String,
    /// "flac" (sin pérdida) o "aac" (.m4a)
    pub format: String,
    /// AAC: kbps
    pub bitrate_kbps: u32,
    /// 44100 o 48000
    pub sample_rate: u32,
    /// 1 = mono, 2 = estéreo
    pub channels: u8,
    /// FLAC: 0 (rápido) … 8 (más pequeño); el sonido es el mismo
    pub compression: u8,
    /// Nombre del archivo: {programa} {subtitulo} {fecha} {hora}
    pub name_template: String,
    /// Al terminar, añadir la grabación a la biblioteca
    pub add_to_library: bool,
}

impl Default for RecConfig {
    fn default() -> Self {
        RecConfig {
            folder: String::new(),
            format: "flac".into(),
            bitrate_kbps: 256,
            sample_rate: 48_000,
            channels: 2,
            compression: 5,
            name_template: "{programa} - {fecha} {hora}".into(),
            add_to_library: true,
        }
    }
}

impl RecConfig {
    fn is_aac(&self) -> bool {
        self.format.eq_ignore_ascii_case("aac")
    }
    fn ext(&self) -> &'static str {
        if self.is_aac() { "m4a" } else { "flac" }
    }
}

/// Nombre del archivo según la plantilla.
fn file_base(tpl: &str, meta: &RecMeta, now: &chrono::DateTime<chrono::Local>) -> String {
    let tpl = if tpl.trim().is_empty() { "{programa} - {fecha} {hora}" } else { tpl.trim() };
    let prog = if meta.title.trim().is_empty() { "Directo" } else { meta.title.trim() };
    let out = tpl
        .replace("{programa}", prog)
        .replace("{subtitulo}", meta.artist.trim())
        .replace("{fecha}", &now.format("%Y-%m-%d").to_string())
        .replace("{hora}", &now.format("%H.%M").to_string());
    sanitize(&out)
}

/// Empieza a grabar (si ya se graba, no hace nada).
#[tauri::command]
pub fn liverec_start(app: AppHandle, state: State<'_, AppState>, config: RecConfig, meta: RecMeta) -> Result<RecStatus, String> {
    let folder = config.folder.clone();
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
    let base = file_base(&config.name_template, &meta, &now);
    let ext = config.ext();
    let mut path = dir.join(format!("{base}.{ext}"));
    let mut n = 2;
    while path.exists() {
        path = dir.join(format!("{base} ({n}).{ext}"));
        n += 1;
    }
    let rate = if config.sample_rate == 44_100 { 44_100 } else { 48_000 };
    let channels = if config.channels == 1 { "1" } else { "2" };
    let title = format!("{} ({})", if meta.title.trim().is_empty() { "Directo" } else { meta.title.trim() }, now.format("%d/%m/%Y"));
    let mut cmd = Command::new(&ffmpeg);
    cmd.args(["-hide_banner", "-loglevel", "error", "-f", "s16le", "-ar", "48000", "-ac", "2", "-i", "pipe:0"]);
    if config.is_aac() {
        // MP4 fragmentado mientras se graba: si OmniCaster se cierra de golpe
        // el archivo sigue sirviendo. Al terminar se pasa a un .m4a normal.
        cmd.args(["-c:a", "aac", "-b:a", &format!("{}k", config.bitrate_kbps.clamp(64, 512))])
            .args(["-movflags", "+frag_keyframe+empty_moov+default_base_moof"]);
    } else {
        cmd.args(["-c:a", "flac", "-compression_level", &config.compression.min(8).to_string(), "-sample_fmt", "s16"]);
    }
    cmd.args(["-ar", &rate.to_string(), "-ac", channels])
        .args(["-metadata", &format!("title={title}")])
        .args(["-metadata", &format!("artist={}", meta.artist.trim())])
        .args(["-metadata", &format!("album={}", if meta.album.trim().is_empty() { "Directos" } else { meta.album.trim() })])
        .args(["-metadata", &format!("genre={}", meta.genre.trim())])
        .args(["-metadata", &format!("date={}", now.format("%Y"))])
        .args(["-y", "-f", if config.is_aac() { "mp4" } else { "flac" }])
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
            // Al soltar stdin, FFmpeg cierra el FLAC.
        })
        .ok();
    let first = chapter(0.0, &meta);
    write_sidecar(&path, std::slice::from_ref(&first));
    crate::crashlog::note(&format!("Grabando el directo en {}", path.display()));
    *g = Some(Rec { child, tx: Some(tx), writer, bytes, path, meta, chapters: vec![first], config });
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

/// Termina la grabación: cierra el FLAC, le pone los capítulos y la añade a
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
    // FFmpeg termina de escribir el FLAC al ver cerrada la entrada.
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
        // AAC: siempre (pasa de MP4 fragmentado a .m4a normal); FLAC: si hay tramos.
        if r.chapters.len() > 1 || r.config.is_aac() {
            embed_chapters(ff, &r.path, &r.chapters, secs, r.config.is_aac());
        }
    }
    if !r.config.add_to_library {
        crate::crashlog::note(&format!("Directo grabado: {} ({:.0} s, {} tramos)", r.path.display(), secs, r.chapters.len()));
        return Some(done);
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

/// Mete los tramos como capítulos en el archivo, sin recomprimir (y el AAC
/// pasa de MP4 fragmentado a .m4a normal).
fn embed_chapters(ffmpeg: &Path, path: &Path, chapters: &[Chapter], total: f64, aac: bool) {
    let esc = |s: &str| s.replace('\\', "\\\\").replace('=', "\\=").replace(';', "\\;").replace('#', "\\#").replace('\n', " ");
    let mut meta = String::from(";FFMETADATA1\n");
    for (i, c) in chapters.iter().enumerate() {
        let end = chapters.get(i + 1).map(|n| n.at).unwrap_or(total);
        let name = if c.artist.trim().is_empty() { c.title.clone() } else { format!("{} - {}", c.artist, c.title) };
        meta.push_str(&format!("[CHAPTER]\nTIMEBASE=1/1000\nSTART={}\nEND={}\ntitle={}\n", (c.at * 1000.0) as u64, (end * 1000.0) as u64, esc(&name)));
    }
    let meta_file = path.with_extension("ffmeta.txt");
    let tmp = path.with_extension(if aac { "tmp.m4a" } else { "tmp.flac" });
    if std::fs::write(&meta_file, meta).is_err() {
        return;
    }
    let mut cmd = Command::new(ffmpeg);
    cmd.args(["-hide_banner", "-loglevel", "error", "-i"])
        .arg(path)
        .arg("-i")
        .arg(&meta_file)
        .args(["-map", "0:a", "-map_metadata", "0", "-map_chapters", "1", "-c", "copy"]);
    if aac {
        cmd.args(["-movflags", "+faststart", "-f", "mp4"]);
    } else {
        // El FLAC de FFmpeg no guarda capítulos: van como comentarios Vorbis
        // (CHAPTER001=hh:mm:ss.mmm / CHAPTER001NAME=…), que es el estándar.
        for (i, c) in chapters.iter().enumerate() {
            let ms = (c.at * 1000.0).round() as u64;
            let ts = format!("{:02}:{:02}:{:02}.{:03}", ms / 3_600_000, ms / 60_000 % 60, ms / 1000 % 60, ms % 1000);
            let name = if c.artist.trim().is_empty() { c.title.clone() } else { format!("{} - {}", c.artist, c.title) };
            cmd.arg("-metadata").arg(format!("CHAPTER{:03}={ts}", i + 1));
            cmd.arg("-metadata").arg(format!("CHAPTER{:03}NAME={name}", i + 1));
        }
        cmd.args(["-f", "flac"]);
    }
    cmd.arg("-y")
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

/// Al cerrar OmniCaster: se cierra bien la grabación (sin pasarlo a la biblioteca:
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
    use chrono::TimeZone;

    #[test]
    fn names_are_safe() {
        assert_eq!(sanitize("Nueva Generación: en directo?"), "Nueva Generación en directo");
        assert_eq!(sanitize("  "), "Directo");
    }

    #[test]
    fn file_name_template() {
        let now = chrono::Local.with_ymd_and_hms(2026, 11, 2, 14, 5, 0).single().unwrap();
        let m = RecMeta { title: "Nueva Generación".into(), artist: "NG Málaga".into(), ..Default::default() };
        assert_eq!(file_base("", &m, &now), "Nueva Generación - 2026-11-02 14.05");
        assert_eq!(file_base("{fecha} {programa} ({subtitulo})", &m, &now), "2026-11-02 Nueva Generación (NG Málaga)");
    }
}
