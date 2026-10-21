use lofty::file::{AudioFile, TaggedFileExt};
use lofty::picture::{MimeType, PictureType};
use lofty::read_from_path;
use lofty::tag::Accessor;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};
use tauri::State;
use uuid::Uuid;

use crate::AppState;
use crate::settings::read_settings_public;

pub const LIBRARY_FILE: &str = "library.json";
/// Carpeta interna de la app (compatibilidad con bibliotecas antiguas)
pub const LEGACY_MUSIC_DIR: &str = "music";

const ALLOWED_EXTENSIONS: [&str; 12] = [
    "mp3", "wav", "flac", "ogg", "oga", "opus", "m4a", "aac", "aif", "aiff", "wma", "webm",
];

/// La cancion es un registro de metadatos; el archivo es solo un enlace.
/// Si el archivo se mueve o desaparece, la cancion sigue viva y puede
/// relinkarse a otro archivo.
#[derive(Serialize, Deserialize, Clone, PartialEq, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Track {
    pub id: String,
    pub title: String,
    pub artist: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub album: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub genre: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub year: String,
    pub duration_secs: f64,
    /// Enlace al archivo (ruta absoluta). Puede quedar inaccesible sin que la
    /// cancion muera: el estado `missing` se calcula al listar.
    pub file: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub original_name: String,
    /// Campo del formato antiguo; solo se usa para migrar el enlace.
    #[serde(skip_serializing_if = "String::is_empty")]
    pub file_name: String,
    /// Bloques musicales a los que pertenece
    pub blocks: Vec<String>,
    /// Etiquetas libres del operador (navidad, instrumental, lento...)
    pub tags: Vec<String>,
    /// Biblioteca a la que pertenece la ficha: "a" (principal) o "b".
    #[serde(default = "default_library")]
    pub library: String,
    /// Medición de sonoridad integrada (LUFS) del archivo.
    pub lufs: Option<f64>,
    /// Ganancia calculada para llegar al objetivo, limitada por el pico.
    pub gain_db: Option<f64>,
    /// Pico real medido (dBTP).
    pub true_peak_db: Option<f64>,
    /// La ganancia se recortó para no superar el techo de pico.
    #[serde(default)]
    pub limited: bool,
    /// Inicio efectivo de la pista (segundos).
    #[serde(default)]
    pub trim_start: f64,
    /// Fin efectivo; None = final natural del archivo.
    pub trim_end: Option<f64>,
    /// Recorte automático calculado por el analizador.
    #[serde(default)]
    pub auto_trim_start: f64,
    pub auto_trim_end: Option<f64>,
    /// El operador ajustó el recorte a mano.
    #[serde(default)]
    pub trim_manual: bool,
    /// Punto de mezcla: donde termina la intro y empieza la siguiente cancion.
    /// 0 = sin punto de mezcla.
    #[serde(default)]
    pub mix_point: f64,
    /// Punto donde empieza el fade out hacia el final de la pista.
    /// 0 = sin fade out.
    #[serde(default)]
    pub fade_out_start: f64,
    /// Firma del archivo analizado (tamaño + fecha).
    #[serde(default)]
    pub analysis_sig: String,
    #[serde(default)]
    pub analyzed_at: u64,
    #[serde(default)]
    pub cover: String,
    #[serde(default)]
    pub cover_checked: bool,
}

fn default_library() -> String {
    "a".to_string()
}

pub fn normalize_library(library: Option<&str>) -> String {
    match library.unwrap_or("a").trim().to_ascii_lowercase().as_str() {
        "b" => "b".to_string(),
        _ => "a".to_string(),
    }
}

fn is_allowed(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| {
            let e = e.to_ascii_lowercase();
            ALLOWED_EXTENSIONS.contains(&e.as_str())
        })
        .unwrap_or(false)
}

/// Carpeta de musica predefinida por el operador (settings.music_path).
/// Si no hay ninguna configurada: la carpeta interna de la app.
fn covers_dir(data_dir: &Path) -> PathBuf {
    data_dir.join("covers")
}

fn cover_abs(data_dir: &Path, cover: &str) -> String {
    if cover.trim().is_empty() {
        return String::new();
    }
    let Some(name) = Path::new(cover.trim()).file_name() else {
        return String::new();
    };
    let path = covers_dir(data_dir).join(name);
    if path.is_file() {
        path.to_string_lossy().into_owned()
    } else {
        String::new()
    }
}

fn picture_ext(pic: &lofty::picture::Picture) -> Option<&'static str> {
    match pic.mime_type() {
        Some(MimeType::Png) => Some("png"),
        Some(MimeType::Jpeg) => Some("jpg"),
        Some(MimeType::Gif) => Some("gif"),
        Some(MimeType::Bmp) => Some("bmp"),
        Some(MimeType::Tiff) => Some("tif"),
        Some(MimeType::Unknown(v)) if v.eq_ignore_ascii_case("image/webp") => Some("webp"),
        _ => None,
    }
}

fn sidecar_cover(audio: &Path) -> Option<(Vec<u8>, String)> {
    let dir = audio.parent()?;
    let stem = audio
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    let names = ["cover", "folder", "front", "album", "artwork"];
    let mut entries: Vec<PathBuf> = fs::read_dir(dir)
        .ok()?
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.is_file())
        .collect();
    entries.sort();
    for path in entries {
        let Some(ext) = path.extension().and_then(|e| e.to_str()) else {
            continue;
        };
        let ext = ext.to_ascii_lowercase();
        if !["png", "jpg", "jpeg", "webp", "gif", "bmp"].contains(&ext.as_str()) {
            continue;
        }
        let file_stem = path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or_default()
            .to_ascii_lowercase();
        if file_stem != stem && !names.contains(&file_stem.as_str()) {
            continue;
        }
        if fs::metadata(&path).map(|m| m.len() > 8_000_000).unwrap_or(true) {
            continue;
        }
        if let Ok(data) = fs::read(&path) {
            let ext = if ext == "jpeg" { "jpg" } else { &ext };
            return Some((data, ext.to_string()));
        }
    }
    None
}

fn normalize_cover_album(album: &str) -> String {
    album
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

fn fnv1a(bytes: &[u8]) -> u64 {
    let mut hash = 0xcbf2_9ce4_8422_2325u64;
    for byte in bytes {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    hash
}

/// La portada pertenece al album, no a la cancion. Todas las pistas del
/// mismo album comparten un unico archivo en `covers/`. Sin album no hay
/// forma de agrupar, asi que se guarda una por cancion.
fn cover_key(track: &Track) -> String {
    let album = normalize_cover_album(&track.album);
    if album.is_empty() {
        format!("track-{}", track.id)
    } else {
        format!("album-{:016x}", fnv1a(album.as_bytes()))
    }
}

fn is_cover_ext(ext: &str) -> bool {
    matches!(
        ext.to_ascii_lowercase().as_str(),
        "jpg" | "jpeg" | "png" | "webp" | "gif" | "bmp" | "tif" | "tiff"
    )
}

const COVER_EXTENSIONS: [&str; 8] = [
    "jpg", "jpeg", "png", "webp", "gif", "bmp", "tif", "tiff",
];

fn find_cover(data_dir: &Path, stem: &str) -> Option<(PathBuf, String)> {
    let dir = covers_dir(data_dir);
    for ext in COVER_EXTENSIONS {
        let name = format!("{stem}.{ext}");
        let path = dir.join(&name);
        if path.is_file() {
            return Some((path, name));
        }
    }
    None
}

fn extract_cover(data_dir: &Path, audio: &Path, stem: &str) -> Option<String> {
    if let Some((_, existing)) = find_cover(data_dir, stem) {
        return Some(existing);
    }
    let mut found: Option<(Vec<u8>, String)> = None;
    let mut fallback: Option<(Vec<u8>, String)> = None;
    if let Ok(tagged) = read_from_path(audio) {
        for tag in tagged.tags() {
            for pic in tag.pictures() {
                if pic.data().is_empty() || pic.data().len() > 8_000_000 {
                    continue;
                }
                let Some(ext) = picture_ext(pic) else {
                    continue;
                };
                if pic.pic_type() == PictureType::CoverFront {
                    found = Some((pic.data().to_vec(), ext.to_string()));
                    break;
                }
                if fallback.is_none() {
                    fallback = Some((pic.data().to_vec(), ext.to_string()));
                }
            }
            if found.is_some() {
                break;
            }
        }
    }
    if found.is_none() {
        found = fallback;
    }
    if found.is_none() {
        found = sidecar_cover(audio);
    }
    let (data, ext) = found?;
    let dir = covers_dir(data_dir);
    fs::create_dir_all(&dir).ok()?;
    let name = format!("{stem}.{ext}");
    fs::write(dir.join(&name), data).ok()?;
    Some(name)
}

/// Copia una portada antigua (guardada por cancion) al nombre del album.
fn copy_cover_to_key(data_dir: &Path, cover: &str, stem: &str) -> Option<String> {
    let source_name = Path::new(cover.trim()).file_name()?.to_str()?;
    let source = covers_dir(data_dir).join(source_name);
    if !source.is_file() {
        return None;
    }
    let ext = source
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if !is_cover_ext(&ext) {
        return None;
    }
    let dir = covers_dir(data_dir);
    fs::create_dir_all(&dir).ok()?;
    let name = format!("{stem}.{ext}");
    let dest = dir.join(&name);
    if source != dest {
        fs::copy(&source, &dest).ok()?;
    }
    Some(name)
}

/// Deja una sola portada para todos los registros del mismo album. Si ya
/// existe una para el album se reutiliza; si no, se recupera de los
/// metadatos de la primera pista que tenga imagen.
fn sync_album_cover(data_dir: &Path, tracks: &mut [Track], key: &str) -> bool {
    let indices: Vec<usize> = tracks
        .iter()
        .enumerate()
        .filter(|(_, track)| cover_key(track) == key)
        .map(|(index, _)| index)
        .collect();
    if indices.is_empty() {
        return false;
    }

    let existing = find_cover(data_dir, key);
    if existing.is_none()
        && indices
            .iter()
            .all(|&index| tracks[index].cover_checked && tracks[index].cover.is_empty())
    {
        return false;
    }

    let chosen = match existing {
        Some((_, name)) => Some(name),
        None => {
            let mut chosen = None;
            for &index in &indices {
                if let Some(name) = copy_cover_to_key(data_dir, &tracks[index].cover, key) {
                    chosen = Some(name);
                    break;
                }
            }
            if chosen.is_none() {
                for &index in &indices {
                    let path = PathBuf::from(tracks[index].file.trim());
                    if !path.is_file() {
                        continue;
                    }
                    if let Some(name) = extract_cover(data_dir, &path, key) {
                        chosen = Some(name);
                        break;
                    }
                }
            }
            chosen
        }
    };

    let mut changed = false;
    for index in indices {
        let next = chosen.clone().unwrap_or_default();
        let track = &mut tracks[index];
        if track.cover != next {
            track.cover = next;
            changed = true;
        }
        if !track.cover_checked {
            track.cover_checked = true;
            changed = true;
        }
    }
    changed
}

/// Elimina portadas que ya no referencia ninguna pista.
fn cleanup_covers(data_dir: &Path, tracks: &[Track]) {
    let referenced: HashSet<String> = tracks
        .iter()
        .filter_map(|track| {
            Path::new(track.cover.trim())
                .file_name()
                .and_then(|name| name.to_str())
                .map(|name| name.to_string())
        })
        .collect();
    let Ok(entries) = fs::read_dir(covers_dir(data_dir)) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        let ext = path
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or_default();
        if is_cover_ext(ext) && !referenced.contains(name) {
            let _ = fs::remove_file(path);
        }
    }
}

fn music_dir(state: &AppState) -> PathBuf {
    let configured = read_settings_public(&state.data_dir).music_path;
    if configured.trim().is_empty() {
        state.data_dir.join(LEGACY_MUSIC_DIR)
    } else {
        PathBuf::from(configured.trim())
    }
}

/// Nombre de archivo seguro: solo letras/digitos y espacios
fn sanitize_name(s: &str) -> String {
    let bad = ['\\', '/', ':', '*', '?', '"', '<', '>', '|', '\0'];
    let mut out = String::new();
    let mut last_space = true;
    for ch in s.trim().chars() {
        if bad.contains(&ch) || (ch as u32) < 32 {
            ch_out(&mut out, &mut last_space);
        } else if ch == ' ' {
            if !last_space {
                out.push(' ');
                last_space = true;
            }
        } else {
            out.push(ch);
            last_space = false;
        }
    }
    let trimmed = out.trim();
    if trimmed.is_empty() {
        "Pista".to_string()
    } else {
        trimmed.chars().take(120).collect()
    }
}

fn ch_out(out: &mut String, last_space: &mut bool) {
    if !*last_space {
        out.push(' ');
        *last_space = true;
    }
}

fn read_metadata(
    path: &Path,
    fallback_title: String,
    fallback_artist: String,
) -> (String, String, String, String, String, f64) {
    match read_from_path(path) {
        Ok(tagged) => {
            let duration = tagged.properties().duration().as_secs_f64();
            let (mut title, mut artist, mut album, mut genre, mut year) =
                (fallback_title, fallback_artist, String::new(), String::new(), String::new());
            if let Some(tag) = tagged.primary_tag().or_else(|| tagged.first_tag()) {
                if let Some(v) = tag.title().filter(|v| !v.trim().is_empty()) {
                    title = v.trim().to_string();
                }
                if let Some(v) = tag.artist().filter(|v| !v.trim().is_empty()) {
                    artist = v.trim().to_string();
                }
                if let Some(v) = tag.album().filter(|v| !v.trim().is_empty()) {
                    album = v.trim().to_string();
                }
                if let Some(v) = tag.genre().filter(|v| !v.trim().is_empty()) {
                    genre = v.trim().to_string();
                }
                if let Some(d) = tag.date() {
                    if d.year > 0 {
                        year = d.year.to_string();
                    }
                }
            }
            (title, artist, album, genre, year, duration)
        }
        Err(_) => (fallback_title, fallback_artist, String::new(), String::new(), String::new(), 0.0),
    }
}

/// Lee el catalogo aplicando la migracion del formato antiguo:
/// sin `file`, el enlace se reconstruye desde el `fileName` de la
/// carpeta interna.
pub fn read_library_internal(data_dir: &Path) -> Vec<Track> {
    let file = data_dir.join(LIBRARY_FILE);
    match fs::read(&file) {
        Ok(bytes) => serde_json::from_slice::<Vec<Track>>(&bytes)
            .unwrap_or_default()
            .into_iter()
            .map(|mut t| {
                if t.file.is_empty() && !t.file_name.is_empty() {
                    t.file = data_dir
                        .join(LEGACY_MUSIC_DIR)
                        .join(&t.file_name)
                        .to_string_lossy()
                        .into_owned();
                }
                t
            })
            .collect(),
        Err(_) => Vec::new(),
    }
}

pub fn read_library_public(data_dir: &Path) -> Vec<Track> {
    read_library_internal(data_dir)
}

static LIBRARY_LOCK: Mutex<()> = Mutex::new(());

pub(crate) fn lock_library() -> MutexGuard<'static, ()> {
    LIBRARY_LOCK.lock().unwrap_or_else(|e| e.into_inner())
}

pub(crate) fn write_library(data_dir: &Path, tracks: &[Track]) -> Result<(), String> {
    let tmp = data_dir.join("library.json.tmp");
    let json = serde_json::to_vec_pretty(tracks).map_err(|e| e.to_string())?;
    fs::write(&tmp, json).map_err(|e| e.to_string())?;
    fs::rename(&tmp, data_dir.join(LIBRARY_FILE)).map_err(|e| e.to_string())
}

/// "Artista - Tema.mp3" -> (titulo, artista) por defecto
fn display_name_from_file(path: &Path) -> (String, String) {
    let stem = path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("Pista");
    let parts: Vec<&str> = stem.splitn(2, " - ").collect();
    if parts.len() == 2 && !parts[0].trim().is_empty() && !parts[1].trim().is_empty() {
        (parts[1].trim().to_string(), parts[0].trim().to_string())
    } else {
        (stem.trim().to_string(), "Artista desconocido".to_string())
    }
}

/// Destino sin colisiones: "Artista - Titulo.ext", "... (2).ext", ...
fn unique_dest(dir: &Path, base: &str, ext: &str) -> PathBuf {
    let mut n = 1u32;
    loop {
        let name = if n == 1 {
            format!("{base}.{ext}")
        } else {
            format!("{base} ({n}).{ext}")
        };
        let dest = dir.join(name);
        if !dest.exists() {
            return dest;
        }
        n += 1;
    }
}

/// Estado calculado del registro al listar
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TrackResolved {
    pub id: String,
    pub title: String,
    pub artist: String,
    pub album: String,
    pub genre: String,
    pub year: String,
    pub duration_secs: f64,
    pub file: String,
    pub original_name: String,
    pub blocks: Vec<String>,
    pub tags: Vec<String>,
    pub missing: bool,
    pub library: String,
    pub lufs: Option<f64>,
    pub gain_db: Option<f64>,
    pub true_peak_db: Option<f64>,
    pub limited: bool,
    pub trim_start: f64,
    pub trim_end: Option<f64>,
    pub auto_trim_start: f64,
    pub auto_trim_end: Option<f64>,
    pub trim_manual: bool,
    pub mix_point: f64,
    pub fade_out_start: f64,
    pub analyzed_at: u64,
    pub cover: String,
}

impl TrackResolved {
    fn from(t: Track, data_dir: &Path) -> Self {
        let missing =
            t.file.trim().is_empty() || !Path::new(t.file.trim()).is_file();
        Self {
            id: t.id,
            title: t.title,
            artist: t.artist,
            album: t.album,
            genre: t.genre,
            year: t.year,
            duration_secs: t.duration_secs,
            file: t.file,
            original_name: t.original_name,
            blocks: t.blocks,
            tags: t.tags,
            missing,
            library: t.library,
            lufs: t.lufs,
            gain_db: t.gain_db,
            true_peak_db: t.true_peak_db,
            limited: t.limited,
            trim_start: t.trim_start,
            trim_end: t.trim_end,
            auto_trim_start: t.auto_trim_start,
            auto_trim_end: t.auto_trim_end,
            trim_manual: t.trim_manual,
            mix_point: t.mix_point,
            fade_out_start: t.fade_out_start,
            analyzed_at: t.analyzed_at,
            cover: cover_abs(data_dir, &t.cover),
        }
    }
}

fn resolve_all(tracks: Vec<Track>, data_dir: &Path) -> Vec<TrackResolved> {
    tracks
        .into_iter()
        .map(|t| TrackResolved::from(t, data_dir))
        .collect()
}

/// Importa archivos: los COPIA a la carpeta de musica predefinida,
/// toma los metadatos del propio archivo y crea el registro. El
/// registro es la cancion: si manana el archivo se mueve, la cancion
/// sigue en la biblioteca y solo se relinkará.
#[tauri::command]
pub fn import_files(
    state: State<'_, AppState>,
    paths: Vec<String>,
    library: Option<String>,
) -> Result<Vec<TrackResolved>, String> {
    let _guard = lock_library();
    let dest_dir = music_dir(&state);
    fs::create_dir_all(&dest_dir).map_err(|e| e.to_string())?;
    let mut tracks = read_library_internal(&state.data_dir);
    let mut imported_ids: Vec<String> = Vec::new();

    for raw in paths {
        let src = PathBuf::from(&raw);
        if !src.is_file() || !is_allowed(&src) {
            continue;
        }

        let (seed_title, seed_artist) = display_name_from_file(&src);
        let (title, artist, album, genre, year, duration) =
            read_metadata(&src, seed_title, seed_artist);

        let ext = src
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("bin")
            .to_ascii_lowercase();
        let base = sanitize_name(&format!("{artist} - {title}"));
        let dest = unique_dest(&dest_dir, &base, &ext);

        if fs::copy(&src, &dest).is_err() {
            eprintln!("No se pudo copiar {raw}");
            continue;
        }

        let id = Uuid::new_v4().simple().to_string();
        let rec = Track {
            id: id.clone(),
            title,
            artist,
            album,
            genre,
            year,
            duration_secs: (duration * 100.0).round() / 100.0,
            file: dest.to_string_lossy().into_owned(),
            original_name: src
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("archivo")
                .to_string(),
            file_name: String::new(),
            blocks: Vec::new(),
            tags: Vec::new(),
            library: normalize_library(library.as_deref()),
            lufs: None,
            gain_db: None,
            true_peak_db: None,
            limited: false,
            trim_start: 0.0,
            trim_end: None,
            auto_trim_start: 0.0,
            auto_trim_end: None,
            trim_manual: false,
            mix_point: 0.0,
            fade_out_start: 0.0,
            analysis_sig: String::new(),
            analyzed_at: 0,
            cover: String::new(),
            cover_checked: false,
        };
        imported_ids.push(id);
        tracks.push(rec);
    }

    let keys: HashSet<String> = imported_ids
        .iter()
        .filter_map(|id| tracks.iter().find(|track| &track.id == id))
        .map(cover_key)
        .collect();
    for key in &keys {
        sync_album_cover(&state.data_dir, &mut tracks, key);
    }
    cleanup_covers(&state.data_dir, &tracks);
    write_library(&state.data_dir, &tracks)?;
    let imported: Vec<Track> = imported_ids
        .iter()
        .filter_map(|id| tracks.iter().find(|track| &track.id == id).cloned())
        .collect();
    Ok(resolve_all(imported, &state.data_dir))
}

/// Cataloga los archivos que ya estan en la carpeta de musica
/// predefinida y no estan en la biblioteca (sin copiar nada):
/// estilo RadioDJ. Utiles tras mover la carpeta o poner canciones
/// a mano. Devuelve cuantas canciones nuevas se catalogaron.
#[tauri::command]
pub fn scan_music_folder(state: State<'_, AppState>) -> Result<usize, String> {
    let _guard = lock_library();
    let dir = music_dir(&state);
    if !dir.is_dir() {
        return Ok(0);
    }
    let mut tracks = read_library_internal(&state.data_dir);
    let known: HashSet<String> = tracks
        .iter()
        .map(|t| normalize_path(&t.file))
        .collect();

    let mut entries: Vec<PathBuf> = fs::read_dir(&dir)
        .map_err(|e| e.to_string())?
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| p.is_file() && is_allowed(p))
        .collect();
    entries.sort();

    let mut added = 0usize;
    let mut added_keys: HashSet<String> = HashSet::new();
    for path in entries {
        let key = normalize_path(&path.to_string_lossy());
        if known.contains(&key) {
            continue;
        }
        let (seed_title, seed_artist) = display_name_from_file(&path);
        let (title, artist, album, genre, year, duration) =
            read_metadata(&path, seed_title, seed_artist);
        let id = Uuid::new_v4().simple().to_string();
        let rec = Track {
            id: id.clone(),
            title,
            artist,
            album,
            genre,
            year,
            duration_secs: (duration * 100.0).round() / 100.0,
            file: path.to_string_lossy().into_owned(),
            original_name: path
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("archivo")
                .to_string(),
            file_name: String::new(),
            blocks: Vec::new(),
            tags: Vec::new(),
            library: "a".to_string(),
            lufs: None,
            gain_db: None,
            true_peak_db: None,
            limited: false,
            trim_start: 0.0,
            trim_end: None,
            auto_trim_start: 0.0,
            auto_trim_end: None,
            trim_manual: false,
            mix_point: 0.0,
            fade_out_start: 0.0,
            analysis_sig: String::new(),
            analyzed_at: 0,
            cover: String::new(),
            cover_checked: false,
        };
        added_keys.insert(cover_key(&rec));
        tracks.push(rec);
        added += 1;
    }

    for key in &added_keys {
        sync_album_cover(&state.data_dir, &mut tracks, key);
    }
    cleanup_covers(&state.data_dir, &tracks);
    write_library(&state.data_dir, &tracks)?;
    Ok(added)
}

fn normalize_path(p: &str) -> String {
    let mut s = p.trim_start_matches(r"\\?\").to_lowercase();
    if !s.contains('\\') && s.contains('/') {
        s = s.replace('/', "\\");
    }
    s
}

#[tauri::command]
pub fn list_tracks(state: State<'_, AppState>) -> Result<Vec<TrackResolved>, String> {
    Ok(resolve_all(
        read_library_internal(&state.data_dir),
        &state.data_dir,
    ))
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct TrackPatch {
    pub title: Option<String>,
    pub artist: Option<String>,
    pub album: Option<String>,
    pub genre: Option<String>,
    pub year: Option<String>,
    pub tags: Option<Vec<String>>,
}

/// Edita los metadatos de una cancion. El archivo queda intacto:
/// los metadatos de la biblioteca son los que mandan.
#[tauri::command]
pub fn update_track(
    state: State<'_, AppState>,
    id: String,
    patch: TrackPatch,
) -> Result<(), String> {
    let _guard = lock_library();
    let mut tracks = read_library_internal(&state.data_dir);
    let mut keys: HashSet<String> = HashSet::new();
    if let Some(t) = tracks.iter_mut().find(|t| t.id == id) {
        keys.insert(cover_key(t));
        if let Some(v) = patch.title.map(|v| v.trim().to_string()) {
            if !v.is_empty() {
                t.title = v;
            }
        }
        if let Some(v) = patch.artist {
            t.artist = v.trim().to_string();
        }
        if let Some(v) = patch.album {
            t.album = v.trim().to_string();
        }
        if let Some(v) = patch.genre {
            t.genre = v.trim().to_string();
        }
        if let Some(v) = patch.year {
            t.year = v.trim().to_string();
        }
        if let Some(tags) = patch.tags {
            t.tags = clean_tags(tags);
        }
        keys.insert(cover_key(t));
    } else {
        return Err("La cancion ya no existe en la biblioteca".to_string());
    }
    for key in &keys {
        sync_album_cover(&state.data_dir, &mut tracks, key);
    }
    cleanup_covers(&state.data_dir, &tracks);
    write_library(&state.data_dir, &tracks)
}

fn clean_tags(tags: Vec<String>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for t in tags {
        let t = t.trim().to_string();
        if t.is_empty() {
            continue;
        }
        if !out.iter().any(|x| x.eq_ignore_ascii_case(&t)) {
            out.push(t);
        }
    }
    out
}

/// Ficha completa para el dialogo de propiedades: metadatos de la
/// biblioteca + datos leidos del propio archivo (formato, bitrate...).
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TrackDetails {
    pub id: String,
    pub title: String,
    pub artist: String,
    pub album: String,
    pub genre: String,
    pub year: String,
    pub duration_secs: f64,
    pub file: String,
    pub original_name: String,
    pub blocks: Vec<String>,
    pub block_names: Vec<String>,
    pub tags: Vec<String>,
    pub missing: bool,
    pub file_size: u64,
    pub format: String,
    pub bitrate_kbps: Option<u32>,
    pub sample_rate: Option<u32>,
    pub channels: Option<u8>,
    pub bit_depth: Option<u8>,
    pub library: String,
    pub lufs: Option<f64>,
    pub gain_db: Option<f64>,
    pub true_peak_db: Option<f64>,
    pub trim_start: f64,
    pub trim_end: Option<f64>,
    pub cover: String,
}

#[tauri::command]
pub fn track_details(state: State<'_, AppState>, id: String) -> Result<TrackDetails, String> {
    let tracks = read_library_internal(&state.data_dir);
    let t = tracks
        .iter()
        .find(|t| t.id == id)
        .ok_or_else(|| "La cancion ya no existe en la biblioteca".to_string())?;
    let path = PathBuf::from(t.file.trim());
    let missing = t.file.trim().is_empty() || !path.is_file();

    let mut file_size = 0u64;
    let mut bitrate_kbps = None;
    let mut sample_rate = None;
    let mut channels = None;
    let mut bit_depth = None;
    let mut duration = t.duration_secs;

    if !missing {
        if let Ok(meta) = fs::metadata(&path) {
            file_size = meta.len();
        }
        if let Ok(tagged) = read_from_path(&path) {
            let p = tagged.properties();
            bitrate_kbps = p.audio_bitrate().or_else(|| p.overall_bitrate());
            sample_rate = p.sample_rate();
            channels = p.channels();
            bit_depth = p.bit_depth();
            let d = p.duration().as_secs_f64();
            if d > 0.0 {
                duration = d;
            }
        }
    }

    let format = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_uppercase())
        .unwrap_or_else(|| "—".to_string());

    let blocks = read_blocks(&state.data_dir);
    let block_names = t
        .blocks
        .iter()
        .map(|id| {
            blocks
                .iter()
                .find(|b| &b.id == id)
                .map(|b| b.name.clone())
                .unwrap_or_else(|| "Bloque eliminado".to_string())
        })
        .collect();

    Ok(TrackDetails {
        id: t.id.clone(),
        title: t.title.clone(),
        artist: t.artist.clone(),
        album: t.album.clone(),
        genre: t.genre.clone(),
        year: t.year.clone(),
        duration_secs: (duration * 100.0).round() / 100.0,
        file: t.file.clone(),
        original_name: t.original_name.clone(),
        blocks: t.blocks.clone(),
        block_names,
        tags: t.tags.clone(),
        missing,
        file_size,
        format,
        bitrate_kbps,
        sample_rate,
        channels,
        bit_depth,
        library: t.library.clone(),
        lufs: t.lufs,
        gain_db: t.gain_db,
        true_peak_db: t.true_peak_db,
        trim_start: t.trim_start,
        trim_end: t.trim_end,
        cover: cover_abs(&state.data_dir, &t.cover),
    })
}

/// Relinkar: apunta la cancion a un nuevo archivo.
#[tauri::command]
pub fn relink_track(state: State<'_, AppState>, id: String, new_path: String) -> Result<(), String> {
    let p = PathBuf::from(&new_path);
    if !p.is_file() || !is_allowed(&p) {
        return Err("El archivo no existe o no es de audio".to_string());
    }
    let _guard = lock_library();
    let mut tracks = read_library_internal(&state.data_dir);
    let mut keys: HashSet<String> = HashSet::new();
    if let Some(t) = tracks.iter_mut().find(|t| t.id == id) {
        keys.insert(cover_key(t));
        t.cover.clear();
        t.cover_checked = false;
        t.file = p.to_string_lossy().into_owned();
        t.original_name = p
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("")
            .to_string();
        keys.insert(cover_key(t));
    } else {
        return Err("La cancion ya no existe en la biblioteca".to_string());
    }
    for key in &keys {
        sync_album_cover(&state.data_dir, &mut tracks, key);
    }
    cleanup_covers(&state.data_dir, &tracks);
    write_library(&state.data_dir, &tracks)
}

#[tauri::command]
pub async fn backfill_covers(state: State<'_, AppState>) -> Result<usize, String> {
    let data_dir = state.data_dir.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = lock_library();
        let mut tracks = read_library_internal(&data_dir);
        let mut keys: Vec<String> = {
            let unique: HashSet<String> = tracks.iter().map(cover_key).collect();
            unique.into_iter().collect()
        };
        keys.sort();
        let mut changed = 0usize;
        for key in &keys {
            if sync_album_cover(&data_dir, &mut tracks, key) {
                changed += 1;
            }
        }
        cleanup_covers(&data_dir, &tracks);
        if changed > 0 {
            write_library(&data_dir, &tracks)?;
        }
        Ok::<usize, String>(changed)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Borra el registro (el archivo fisico no se toca).
#[tauri::command]
pub fn delete_track(state: State<'_, AppState>, id: String) -> Result<(), String> {
    let _guard = lock_library();
    let tracks = read_library_internal(&state.data_dir);
    let remaining: Vec<Track> = tracks.into_iter().filter(|t| t.id != id).collect();
    cleanup_covers(&state.data_dir, &remaining);
    write_library(&state.data_dir, &remaining)
}

/// Mueve fichas entre la biblioteca A y la B. No toca los archivos:
/// solo cambia a que coleccion pertenece el registro.
#[tauri::command]
pub fn set_track_library(
    state: State<'_, AppState>,
    ids: Vec<String>,
    library: String,
) -> Result<usize, String> {
    let _guard = lock_library();
    let target = normalize_library(Some(&library));
    let mut tracks = read_library_internal(&state.data_dir);
    let wanted: HashSet<&str> = ids.iter().map(|s| s.as_str()).collect();
    let mut moved = 0usize;
    for t in tracks.iter_mut() {
        if wanted.contains(t.id.as_str()) && t.library != target {
            t.library = target.clone();
            moved += 1;
        }
    }
    write_library(&state.data_dir, &tracks)?;
    Ok(moved)
}

/// Guarda un recorte manual (segundos). El archivo no se modifica.
#[tauri::command]
pub fn save_track_trim(
    state: State<'_, AppState>,
    id: String,
    start: f64,
    end: f64,
) -> Result<(), String> {
    if !start.is_finite() || !end.is_finite() {
        return Err("Marcas de recorte no validas".to_string());
    }
    let _guard = lock_library();
    let mut tracks = read_library_internal(&state.data_dir);
    let Some(t) = tracks.iter_mut().find(|t| t.id == id) else {
        return Err("La cancion ya no existe en la biblioteca".to_string());
    };
    let duration = if t.duration_secs > 0.0 { t.duration_secs } else { end };
    let start = start.max(0.0).min((duration - 0.3).max(0.0));
    let end = end.min(duration);
    if end - start < 0.3 {
        return Err("El recorte deja menos de 0,3 s de musica".to_string());
    }
    t.trim_start = (start * 1000.0).round() / 1000.0;
    t.trim_end = if end >= duration - 0.02 {
        None
    } else {
        Some((end * 1000.0).round() / 1000.0)
    };
    t.trim_manual = true;
    write_library(&state.data_dir, &tracks)
}

/// Guarda los puntos de mezcla y de fade out de una pista.
#[tauri::command]
pub fn save_track_markers(
    state: State<'_, AppState>,
    id: String,
    mix_point: f64,
    fade_out_start: f64,
) -> Result<(), String> {
    if !mix_point.is_finite() || !fade_out_start.is_finite() {
        return Err("Puntos no validos".to_string());
    }
    let _guard = lock_library();
    let mut tracks = read_library_internal(&state.data_dir);
    let Some(t) = tracks.iter_mut().find(|t| t.id == id) else {
        return Err("La cancion ya no existe en la biblioteca".to_string());
    };
    let duration = if t.duration_secs > 0.0 { t.duration_secs } else { 0.0 };
    t.mix_point = if mix_point > 0.0 {
        (mix_point.min(duration) * 1000.0).round() / 1000.0
    } else {
        0.0
    };
    t.fade_out_start = if fade_out_start > 0.0 {
        (fade_out_start.min(duration) * 1000.0).round() / 1000.0
    } else {
        0.0
    };
    write_library(&state.data_dir, &tracks)
}

/// Vuelve al recorte automático del último análisis.
#[tauri::command]
pub fn auto_track_trim(state: State<'_, AppState>, id: String) -> Result<(), String> {
    let _guard = lock_library();
    let mut tracks = read_library_internal(&state.data_dir);
    let Some(t) = tracks.iter_mut().find(|t| t.id == id) else {
        return Err("La cancion ya no existe en la biblioteca".to_string());
    };
    if t.analyzed_at == 0 {
        return Err("Analiza la pista antes de usar el recorte automatico".to_string());
    }
    t.trim_start = t.auto_trim_start;
    t.trim_end = t.auto_trim_end;
    t.trim_manual = false;
    write_library(&state.data_dir, &tracks)
}

/// ---- Bloques musicales ----

const BLOCKS_FILE: &str = "blocks.json";

#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Block {
    pub id: String,
    pub name: String,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct BlockInfo {
    pub id: String,
    pub name: String,
    pub track_count: usize,
}

fn read_blocks(data_dir: &Path) -> Vec<Block> {
    fs::read(data_dir.join(BLOCKS_FILE))
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default()
}

fn write_blocks(data_dir: &Path, b: &[Block]) -> Result<(), String> {
    let json = serde_json::to_vec_pretty(b).map_err(|e| e.to_string())?;
    fs::write(data_dir.join(BLOCKS_FILE), json).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn list_blocks(state: State<'_, AppState>) -> Result<Vec<BlockInfo>, String> {
    let blocks = read_blocks(&state.data_dir);
    let tracks = read_library_internal(&state.data_dir);
    Ok(blocks
        .into_iter()
        .map(|b| BlockInfo {
            track_count: tracks.iter().filter(|t| t.blocks.contains(&b.id)).count(),
            id: b.id,
            name: b.name,
        })
        .collect())
}

#[tauri::command]
pub fn create_block(state: State<'_, AppState>, name: String) -> Result<BlockInfo, String> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("El nombre del bloque no puede estar vacio".to_string());
    }
    let mut blocks = read_blocks(&state.data_dir);
    if blocks.iter().any(|b| b.name.eq_ignore_ascii_case(&name)) {
        return Err("Ya existe un bloque con ese nombre".to_string());
    }
    let b = Block {
        id: Uuid::new_v4().simple().to_string(),
        name,
    };
    blocks.push(b.clone());
    write_blocks(&state.data_dir, &blocks)?;
    Ok(BlockInfo {
        id: b.id,
        name: b.name,
        track_count: 0,
    })
}

#[tauri::command]
pub fn rename_block(state: State<'_, AppState>, id: String, name: String) -> Result<(), String> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("El nombre no puede estar vacio".to_string());
    }
    let mut blocks = read_blocks(&state.data_dir);
    if let Some(b) = blocks.iter_mut().find(|b| b.id == id) {
        b.name = name;
        write_blocks(&state.data_dir, &blocks)
    } else {
        Err("Bloque no encontrado".to_string())
    }
}

#[tauri::command]
pub fn delete_block(state: State<'_, AppState>, id: String) -> Result<(), String> {
    let _guard = lock_library();
    let blocks: Vec<Block> = read_blocks(&state.data_dir)
        .into_iter()
        .filter(|b| b.id != id)
        .collect();
    write_blocks(&state.data_dir, &blocks)?;
    let mut tracks = read_library_internal(&state.data_dir);
    for t in tracks.iter_mut() {
        t.blocks.retain(|x| x != &id);
    }
    write_library(&state.data_dir, &tracks)
}

/// Sustituye los bloques de una cancion.
#[tauri::command]
pub fn set_track_blocks(
    state: State<'_, AppState>,
    id: String,
    block_ids: Vec<String>,
) -> Result<(), String> {
    let _guard = lock_library();
    let mut tracks = read_library_internal(&state.data_dir);
    if let Some(t) = tracks.iter_mut().find(|t| t.id == id) {
        t.blocks = block_ids;
        write_library(&state.data_dir, &tracks)
    } else {
        Err("La cancion ya no existe en la biblioteca".to_string())
    }
}

/// ---- Listas M3U / M3U8 ----

/// Entradas de una lista M3U/M3U8: se ignoran comentarios y directivas
/// (#EXTM3U, #EXTINF...), se quita el BOM y se respetan rutas absolutas
/// de Windows (R:\Musica\...) y rutas relativas a la propia lista.
pub fn parse_m3u_entries(text: &str) -> Vec<String> {
    text.trim_start_matches('\u{feff}')
        .lines()
        .map(|l| l.trim().trim_matches('"'))
        .filter(|l| !l.is_empty() && !l.starts_with('#'))
        .map(|l| {
            // file:///R:/Musica/... -> R:/Musica/...
            if let Some(rest) = l.strip_prefix("file:///") {
                percent_decode(rest)
            } else if let Some(rest) = l.strip_prefix("file://") {
                percent_decode(rest)
            } else {
                l.to_string()
            }
        })
        .collect()
}

fn hex_val(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let (Some(h), Some(l)) = (hex_val(bytes[i + 1]), hex_val(bytes[i + 2])) {
                out.push(h * 16 + l);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn resolve_playlist_entry(playlist_dir: &Path, raw: &str) -> PathBuf {
    let candidate = PathBuf::from(raw);
    if candidate.is_absolute() {
        candidate
    } else {
        playlist_dir.join(candidate)
    }
}

fn playlist_block_name(path: &Path) -> String {
    path.file_stem()
        .and_then(|s| s.to_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "Lista importada".to_string())
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PlaylistImportReport {
    pub block_id: String,
    pub block_name: String,
    /// Entradas utiles de la lista (sin duplicados ni streams)
    pub total: usize,
    /// Canciones que ya estaban en la biblioteca y se han metido al bloque
    pub matched: usize,
    /// Canciones nuevas catalogadas (copiadas o en su sitio)
    pub added: usize,
    /// Rutas de la lista que no existen en el disco
    pub missing: Vec<String>,
    /// Entradas http(s) ignoradas (streams, no archivos)
    pub streams: usize,
}

/// Importa una lista .m3u/.m3u8 a un bloque musical.
/// Las canciones que ya estan en la biblioteca solo se asignan al bloque;
/// las que no estan se catalogan (copiando a la carpeta de musica o
/// enlazando el archivo en su sitio). Las rutas inexistentes se informan
/// en `missing` sin abortar la importacion.
#[tauri::command]
pub fn import_playlist(
    state: State<'_, AppState>,
    path: String,
    block_id: Option<String>,
    block_name: Option<String>,
    copy_files: bool,
) -> Result<PlaylistImportReport, String> {
    let _guard = lock_library();
    let playlist_path = PathBuf::from(&path);
    let text = fs::read_to_string(&playlist_path)
        .map_err(|e| format!("No se pudo leer la lista: {e}"))?;
    let playlist_dir = playlist_path
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from("."));

    let mut seen: HashSet<String> = HashSet::new();
    let mut entries: Vec<String> = Vec::new();
    let mut streams = 0usize;
    for raw in parse_m3u_entries(&text) {
        let lower = raw.to_ascii_lowercase();
        if lower.starts_with("http://") || lower.starts_with("https://") {
            streams += 1;
            continue;
        }
        if seen.insert(lower.clone()) {
            entries.push(raw);
        }
    }
    if entries.is_empty() {
        return Err("La lista no contiene archivos de audio".to_string());
    }

    // Bloque destino: uno existente o uno nuevo con el nombre de la lista
    let mut blocks = read_blocks(&state.data_dir);
    let (block, created_block) = match block_id.filter(|id| blocks.iter().any(|b| &b.id == id)) {
        Some(id) => {
            let b = blocks.iter().find(|b| b.id == id).unwrap().clone();
            (b, false)
        }
        None => {
            let name = block_name
                .map(|n| n.trim().to_string())
                .filter(|n| !n.is_empty())
                .unwrap_or_else(|| playlist_block_name(&playlist_path));
            let existing = blocks.iter().find(|b| b.name.eq_ignore_ascii_case(&name)).cloned();
            match existing {
                Some(b) => (b, false),
                None => {
                    let b = Block {
                        id: Uuid::new_v4().simple().to_string(),
                        name,
                    };
                    blocks.push(b.clone());
                    (b, true)
                }
            }
        }
    };

    let dest_dir = music_dir(&state);
    if copy_files {
        fs::create_dir_all(&dest_dir).map_err(|e| e.to_string())?;
    }

    let mut tracks = read_library_internal(&state.data_dir);
    let mut index: HashMap<String, usize> = tracks
        .iter()
        .enumerate()
        .map(|(i, t)| (normalize_path(&t.file), i))
        .collect();

    let mut matched = 0usize;
    let mut added = 0usize;
    let mut missing = Vec::new();
    let mut added_keys: HashSet<String> = HashSet::new();

    for raw in &entries {
        let src = resolve_playlist_entry(&playlist_dir, raw);
        if !src.is_file() {
            missing.push(raw.clone());
            continue;
        }
        let key = normalize_path(&src.to_string_lossy());
        if let Some(&i) = index.get(&key) {
            if !tracks[i].blocks.contains(&block.id) {
                tracks[i].blocks.push(block.id.clone());
            }
            matched += 1;
            continue;
        }

        let (seed_title, seed_artist) = display_name_from_file(&src);
        let (title, artist, album, genre, year, duration) =
            read_metadata(&src, seed_title, seed_artist);

        let file = if copy_files {
            let ext = src
                .extension()
                .and_then(|e| e.to_str())
                .unwrap_or("bin")
                .to_ascii_lowercase();
            let base = sanitize_name(&format!("{artist} - {title}"));
            let dest = unique_dest(&dest_dir, &base, &ext);
            if fs::copy(&src, &dest).is_err() {
                missing.push(raw.clone());
                continue;
            }
            dest
        } else {
            src.clone()
        };

        let id = Uuid::new_v4().simple().to_string();
        let rec = Track {
            id: id.clone(),
            title,
            artist,
            album,
            genre,
            year,
            duration_secs: (duration * 100.0).round() / 100.0,
            file: file.to_string_lossy().into_owned(),
            original_name: src
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("archivo")
                .to_string(),
            file_name: String::new(),
            blocks: vec![block.id.clone()],
            tags: Vec::new(),
            library: "a".to_string(),
            lufs: None,
            gain_db: None,
            true_peak_db: None,
            limited: false,
            trim_start: 0.0,
            trim_end: None,
            auto_trim_start: 0.0,
            auto_trim_end: None,
            trim_manual: false,
            mix_point: 0.0,
            fade_out_start: 0.0,
            analysis_sig: String::new(),
            analyzed_at: 0,
            cover: String::new(),
            cover_checked: false,
        };
        added_keys.insert(cover_key(&rec));
        index.insert(normalize_path(&rec.file), tracks.len());
        tracks.push(rec);
        added += 1;
    }

    for key in &added_keys {
        sync_album_cover(&state.data_dir, &mut tracks, key);
    }
    cleanup_covers(&state.data_dir, &tracks);
    write_library(&state.data_dir, &tracks)?;
    if created_block {
        write_blocks(&state.data_dir, &blocks)?;
    }

    Ok(PlaylistImportReport {
        block_id: block.id,
        block_name: block.name,
        total: entries.len(),
        matched,
        added,
        missing,
        streams,
    })
}

#[cfg(test)]
mod tests {
    use super::{
        cleanup_covers, cover_key, parse_m3u_entries, sync_album_cover, Track,
    };
    use std::fs;
    use std::path::PathBuf;
    use uuid::Uuid;

    fn cover_test_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "miradio-cover-test-{tag}-{}",
            Uuid::new_v4().simple()
        ));
        fs::create_dir_all(dir.join("covers")).unwrap();
        dir
    }

    fn track(id: &str, album: &str, cover: &str) -> Track {
        Track {
            id: id.to_string(),
            album: album.to_string(),
            cover: cover.to_string(),
            cover_checked: true,
            ..Track::default()
        }
    }

    #[test]
    fn parsea_bom_crlf_y_comentarios() {
        let text = "\u{feff}#EXTM3U\r\n#EXTINF:123,Artista - Tema\r\nR:\\Musica\\Pop\\tema.mp3\r\n\r\nM:/Otra/ruta.flac\r\n";
        let entries = parse_m3u_entries(text);
        assert_eq!(entries, vec![r"R:\Musica\Pop\tema.mp3", "M:/Otra/ruta.flac"]);
    }

    #[test]
    fn acepta_file_urls_y_comillas() {
        let text = "file:///R:/Musica/a%20b.mp3\n\"M:/x y.flac\"\n";
        let entries = parse_m3u_entries(text);
        assert_eq!(entries, vec!["R:/Musica/a b.mp3", "M:/x y.flac"]);
    }

    #[test]
    fn ignora_lineas_vacias() {
        assert!(parse_m3u_entries("#EXTM3U\n\n\n").is_empty());
    }

    #[test]
    fn agrupa_la_portada_por_album_y_no_por_cancion() {
        let data = cover_test_dir("album");
        let covers = data.join("covers");
        fs::write(covers.join("uno.jpg"), b"uno").unwrap();
        fs::write(covers.join("dos.png"), b"dos").unwrap();

        let mut tracks = vec![
            track("uno", "Abbey Road", "uno.jpg"),
            track("dos", "  abbey   ROAD ", "dos.png"),
        ];
        let key = cover_key(&tracks[0]);
        assert_eq!(key, cover_key(&tracks[1]));
        assert!(sync_album_cover(&data, &mut tracks, &key));
        assert_eq!(tracks[0].cover, tracks[1].cover);
        assert!(covers.join(&tracks[0].cover).is_file());

        cleanup_covers(&data, &tracks);
        let mut files: Vec<String> = fs::read_dir(&covers)
            .unwrap()
            .flatten()
            .filter_map(|entry| entry.file_name().to_str().map(|s| s.to_string()))
            .collect();
        files.sort();
        assert_eq!(files, vec![tracks[0].cover.clone()]);
        fs::remove_dir_all(data).unwrap();
    }

    #[test]
    fn sin_album_cada_cancion_conserva_su_portada() {
        let uno = track("uno", "", "uno.jpg");
        let dos = track("dos", "", "dos.jpg");
        assert_ne!(cover_key(&uno), cover_key(&dos));
    }

    #[test]
    fn reutiliza_la_portada_que_ya_existe_para_el_album() {
        let data = cover_test_dir("reuse");
        let covers = data.join("covers");
        fs::write(covers.join("vieja.jpg"), b"vieja").unwrap();

        let mut tracks = vec![track("uno", "Disco", "vieja.jpg")];
        let key = cover_key(&tracks[0]);
        let target = format!("{key}.png");
        fs::write(covers.join(&target), b"album").unwrap();

        assert!(sync_album_cover(&data, &mut tracks, &key));
        assert_eq!(tracks[0].cover, target);
        assert_eq!(fs::read(covers.join(&target)).unwrap(), b"album");
        cleanup_covers(&data, &tracks);
        assert!(!covers.join("vieja.jpg").exists());
        fs::remove_dir_all(data).unwrap();
    }
}
