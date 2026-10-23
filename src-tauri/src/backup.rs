//! Copia de seguridad completa (biblioteca, listas, historial, ajustes,
//! caratulas, API…) en un .zip, y su importacion en otro equipo con cambio
//! de rutas (M:\ → D:\Musica\…). Opcionalmente incluye la musica.
//!
//! La importacion se aplica al arrancar, antes de que nada lea los datos:
//! el comando la deja preparada y la app se reinicia.

use std::collections::{BTreeMap, HashSet};
use std::fs::{self, File};
use std::io::{self, BufReader, BufWriter, Read, Write};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager};
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipArchive, ZipWriter};

use crate::AppState;

const MANIFEST: &str = "miradio-backup.json";
const PENDING_ZIP: &str = "pending-import.zip";
const PENDING_JSON: &str = "pending-import.json";
const BACKUPS_DIR: &str = "backups";
const TMP_DIR: &str = ".import-tmp";

/// Carpetas y archivos de la carpeta de datos que no van en la copia.
fn skipped(rel: &str) -> bool {
    let first = rel.split(['/', '\\']).next().unwrap_or("");
    // Ademas de lo nuestro, los datos del navegador interno (WebView2 / WebKit).
    matches!(
        first,
        BACKUPS_DIR
            | TMP_DIR
            | PENDING_ZIP
            | PENDING_JSON
            | "EBWebView"
            | "CacheStorage"
            | "WebKitCache"
            | "localstorage"
            | "storage"
            | "mediakeys"
            | "hsts-storage.sqlite"
            | "databases"
            | "IndexedDB"
            | "audio-cache"
            | "convert-tmp"
    ) || rel.ends_with(".tmp")
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct AudioRoot {
    /// Raiz original ("M:\\" o "/")
    pub original: String,
    /// Carpeta dentro de audio/ en el zip
    pub tag: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Manifest {
    pub format: u32,
    pub app_version: String,
    pub created: String,
    pub tracks: usize,
    pub playlists: usize,
    pub include_audio: bool,
    pub audio_files: usize,
    pub audio_bytes: u64,
    pub audio_roots: Vec<AudioRoot>,
    /// Carpeta de datos del equipo de origen (sus rutas se adaptan solas)
    pub data_dir: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Progress {
    phase: String,
    done: u64,
    total: u64,
}

fn progress(app: &AppHandle, phase: &str, done: u64, total: u64) {
    let _ = app.emit("backup://progress", Progress { phase: phase.into(), done, total });
}

fn walk(dir: &Path, base: &Path, out: &mut Vec<(PathBuf, String)>) {
    let Ok(rd) = fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        let p = e.path();
        let Ok(rel) = p.strip_prefix(base) else { continue };
        let rel = rel.to_string_lossy().replace('\\', "/");
        if skipped(&rel) {
            continue;
        }
        if p.is_dir() {
            walk(&p, base, out);
        } else if p.is_file() {
            out.push((p, rel));
        }
    }
}

/// Raiz de una ruta: "M:\\" para Windows, "/" para el resto.
pub fn root_of(path: &str) -> Option<String> {
    let b = path.as_bytes();
    if b.len() >= 3 && b[0].is_ascii_alphabetic() && b[1] == b':' && (b[2] == b'\\' || b[2] == b'/') {
        return Some(format!("{}:\\", (b[0] as char).to_ascii_uppercase()));
    }
    if path.starts_with("\\\\") {
        // \\servidor\recurso\
        let parts: Vec<&str> = path.trim_start_matches('\\').splitn(3, '\\').collect();
        if parts.len() >= 2 {
            return Some(format!("\\\\{}\\{}\\", parts[0], parts[1]));
        }
    }
    if path.starts_with('/') {
        return Some("/".into());
    }
    None
}

fn root_tag(root: &str) -> String {
    let t: String = root.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '-').collect();
    if t.is_empty() {
        "raiz".into()
    } else {
        t
    }
}

fn is_compressed(name: &str) -> bool {
    let l = name.to_ascii_lowercase();
    [".mp3", ".flac", ".m4a", ".aac", ".ogg", ".opus", ".jpg", ".jpeg", ".png", ".webp", ".mp4", ".zip", ".wma"]
        .iter()
        .any(|e| l.ends_with(e))
}

fn opts(name: &str) -> SimpleFileOptions {
    let m = if is_compressed(name) { CompressionMethod::Stored } else { CompressionMethod::Deflated };
    SimpleFileOptions::default().compression_method(m).large_file(true)
}

fn library_files(data_dir: &Path) -> Vec<String> {
    crate::library::read_library_internal(data_dir).into_iter().map(|t| t.file).filter(|f| !f.trim().is_empty()).collect()
}

// ------------------------------------------------------------ exportar

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportResult {
    path: String,
    files: usize,
    audio_files: usize,
    missing_audio: usize,
    bytes: u64,
}

fn export_to(app: &AppHandle, data_dir: &Path, dest: &Path, include_audio: bool) -> Result<ExportResult, String> {
    export_with(data_dir, dest, include_audio, &|d, t| progress(app, "export", d, t))
}

#[cfg(test)]
fn export_core(data_dir: &Path, dest: &Path, include_audio: bool) -> Result<ExportResult, String> {
    export_with(data_dir, dest, include_audio, &|_, _| {})
}

fn export_with(data_dir: &Path, dest: &Path, include_audio: bool, prog: &dyn Fn(u64, u64)) -> Result<ExportResult, String> {
    let mut files = Vec::new();
    walk(data_dir, data_dir, &mut files);

    // Musica: archivos de la biblioteca que viven fuera de la carpeta de datos.
    let mut audio: Vec<(PathBuf, String)> = Vec::new();
    let mut roots: BTreeMap<String, String> = BTreeMap::new();
    let mut missing = 0usize;
    if include_audio {
        let mut seen = HashSet::new();
        for f in library_files(data_dir) {
            let p = PathBuf::from(f.trim());
            if p.starts_with(data_dir) || !seen.insert(f.clone()) {
                continue;
            }
            if !p.is_file() {
                missing += 1;
                continue;
            }
            let Some(root) = root_of(&f) else { continue };
            let tag = roots.entry(root.clone()).or_insert_with(|| root_tag(&root)).clone();
            let rest = f[root.len()..].replace('\\', "/");
            audio.push((p, format!("audio/{tag}/{rest}")));
        }
    }

    let total: u64 = files.iter().chain(audio.iter()).map(|(p, _)| fs::metadata(p).map(|m| m.len()).unwrap_or(0)).sum();
    let tmp = dest.with_extension("zip.part");
    let out = File::create(&tmp).map_err(|e| format!("No se pudo crear el archivo: {e}"))?;
    let mut zip = ZipWriter::new(BufWriter::new(out));
    let mut done = 0u64;
    let mut buf = vec![0u8; 1 << 20];
    let mut copy = |zip: &mut ZipWriter<BufWriter<File>>, src: &Path, name: &str, done: &mut u64| -> Result<(), String> {
        zip.start_file(name, opts(name)).map_err(|e| e.to_string())?;
        let mut f = BufReader::new(File::open(src).map_err(|e| format!("{}: {e}", src.display()))?);
        loop {
            let n = f.read(&mut buf).map_err(|e| e.to_string())?;
            if n == 0 {
                break;
            }
            zip.write_all(&buf[..n]).map_err(|e| e.to_string())?;
            *done += n as u64;
        }
        prog(*done, total);
        Ok(())
    };
    for (p, rel) in &files {
        copy(&mut zip, p, &format!("data/{rel}"), &mut done)?;
    }
    let mut audio_bytes = 0u64;
    for (p, name) in &audio {
        let before = done;
        copy(&mut zip, p, name, &mut done)?;
        audio_bytes += done - before;
    }
    let playlists = files.iter().filter(|(_, r)| r.starts_with("playlists/")).count();
    let manifest = Manifest {
        format: 1,
        app_version: env!("CARGO_PKG_VERSION").to_string(),
        created: chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string(),
        tracks: crate::library::read_library_internal(data_dir).len(),
        playlists,
        include_audio,
        audio_files: audio.len(),
        audio_bytes,
        audio_roots: roots.into_iter().map(|(original, tag)| AudioRoot { original, tag }).collect(),
        data_dir: data_dir.display().to_string(),
    };
    zip.start_file(MANIFEST, opts(MANIFEST)).map_err(|e| e.to_string())?;
    zip.write_all(&serde_json::to_vec_pretty(&manifest).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    zip.finish().map_err(|e| e.to_string())?.flush().map_err(|e| e.to_string())?;
    fs::rename(&tmp, dest).map_err(|e| e.to_string())?;
    Ok(ExportResult {
        path: dest.display().to_string(),
        files: files.len(),
        audio_files: audio.len(),
        missing_audio: missing,
        bytes: fs::metadata(dest).map(|m| m.len()).unwrap_or(0),
    })
}

#[tauri::command]
pub async fn backup_export(app: AppHandle, dest: String, include_audio: bool) -> Result<ExportResult, String> {
    let data_dir = app.state::<AppState>().data_dir.clone();
    let dest = PathBuf::from(dest);
    tauri::async_runtime::spawn_blocking(move || {
        let r = export_to(&app, &data_dir, &dest, include_audio);
        if r.is_err() {
            let _ = fs::remove_file(dest.with_extension("zip.part"));
        }
        r
    })
    .await
    .map_err(|e| e.to_string())?
}

// ------------------------------------------------------------ inspeccionar

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RootInfo {
    /// Prefijo comun de las rutas de esa unidad ("M:\\" o "R:\\Musica\\")
    pub prefix: String,
    pub tracks: usize,
    /// Esa carpeta existe en este equipo
    pub exists: bool,
    /// Viene incluida en la copia (carpeta audio/)
    pub included: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupInfo {
    manifest: Manifest,
    roots: Vec<RootInfo>,
}

fn open_zip(path: &Path) -> Result<ZipArchive<BufReader<File>>, String> {
    let f = File::open(path).map_err(|e| format!("No se pudo abrir: {e}"))?;
    ZipArchive::new(BufReader::new(f)).map_err(|_| "No es un archivo .zip válido".to_string())
}

fn read_entry(zip: &mut ZipArchive<BufReader<File>>, name: &str) -> Option<Vec<u8>> {
    let mut e = zip.by_name(name).ok()?;
    let mut v = Vec::new();
    e.read_to_end(&mut v).ok()?;
    Some(v)
}

/// Prefijo de carpeta comun de varias rutas (comparando sin distinguir \ y /).
fn common_dir(paths: &[&str]) -> String {
    let Some(first) = paths.first() else { return String::new() };
    let sep = if first.contains('\\') { '\\' } else { '/' };
    let split = |p: &str| p.split(['\\', '/']).map(|s| s.to_string()).collect::<Vec<_>>();
    let mut common = split(first);
    common.pop(); // el nombre del archivo
    for p in &paths[1..] {
        let parts = split(p);
        let n = common.iter().zip(parts.iter()).take_while(|(a, b)| a.eq_ignore_ascii_case(b)).count();
        common.truncate(n.min(parts.len().saturating_sub(1)));
    }
    let mut s = common.join(&sep.to_string());
    if !s.ends_with(sep) {
        s.push(sep);
    }
    s
}

pub fn roots_of(files: &[String], included: &[AudioRoot]) -> Vec<RootInfo> {
    let mut groups: BTreeMap<String, Vec<&str>> = BTreeMap::new();
    for f in files {
        if let Some(r) = root_of(f.trim()) {
            groups.entry(r).or_default().push(f.trim());
        }
    }
    groups
        .into_iter()
        .map(|(root, list)| {
            let prefix = common_dir(&list);
            let prefix = if prefix.len() < root.len() { root.clone() } else { prefix };
            RootInfo {
                exists: Path::new(&prefix).is_dir(),
                included: included.iter().any(|a| a.original == root),
                tracks: list.len(),
                prefix,
            }
        })
        .collect()
}

#[tauri::command]
pub fn backup_inspect(path: String) -> Result<BackupInfo, String> {
    let mut zip = open_zip(Path::new(&path))?;
    let manifest: Manifest = read_entry(&mut zip, MANIFEST)
        .and_then(|b| serde_json::from_slice(&b).ok())
        .ok_or("No es una copia de seguridad de MiRadio")?;
    let lib: Vec<Value> = read_entry(&mut zip, "data/library.json").and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
    let files: Vec<String> = lib.iter().filter_map(|t| t.get("file").and_then(|f| f.as_str()).map(|s| s.to_string())).filter(|s| !s.is_empty()).collect();
    let roots = roots_of(&files, &manifest.audio_roots);
    Ok(BackupInfo { manifest, roots })
}

// ------------------------------------------------------------ importar

#[derive(Deserialize, Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Mapping {
    pub from: String,
    pub to: String,
}

#[derive(Deserialize, Serialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct Pending {
    mappings: Vec<Mapping>,
}

fn norm_path(s: &str) -> String {
    s.replace('/', "\\").to_lowercase()
}

/// Cambia el principio de una ruta segun las equivalencias (la mas larga gana).
pub fn remap(s: &str, maps: &[Mapping]) -> Option<String> {
    let ns = norm_path(s);
    let best = maps
        .iter()
        .filter(|m| !m.from.is_empty() && !m.to.is_empty() && ns.starts_with(&norm_path(&m.from)))
        .max_by_key(|m| m.from.len())?;
    let rest = &s[best.from.len()..];
    let sep = if best.to.contains('\\') || best.to.chars().nth(1) == Some(':') { '\\' } else { '/' };
    let mut to = best.to.clone();
    if !to.ends_with(['\\', '/']) && !rest.is_empty() && !rest.starts_with(['\\', '/']) {
        to.push(sep);
    }
    let rest: String = rest.chars().map(|c| if c == '\\' || c == '/' { sep } else { c }).collect();
    Some(format!("{to}{rest}"))
}

fn remap_value(v: &mut Value, maps: &[Mapping]) -> bool {
    match v {
        Value::String(s) => {
            if let Some(n) = remap(s, maps) {
                *s = n;
                return true;
            }
            false
        }
        Value::Array(a) => a.iter_mut().fold(false, |acc, x| remap_value(x, maps) | acc),
        Value::Object(o) => o.values_mut().fold(false, |acc, x| remap_value(x, maps) | acc),
        _ => false,
    }
}

fn remap_json_files(dir: &Path, maps: &[Mapping]) {
    let mut files = Vec::new();
    walk(dir, dir, &mut files);
    for (p, _) in files {
        if p.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let Ok(bytes) = fs::read(&p) else { continue };
        let Ok(mut v) = serde_json::from_slice::<Value>(&bytes) else { continue };
        if remap_value(&mut v, maps) {
            if let Ok(out) = serde_json::to_vec_pretty(&v) {
                let _ = fs::write(&p, out);
            }
        }
    }
}

/// Nombre seguro dentro del zip (sin .. ni rutas absolutas).
fn safe_rel(name: &str) -> Option<PathBuf> {
    let p = Path::new(name);
    let mut out = PathBuf::new();
    for c in p.components() {
        match c {
            std::path::Component::Normal(x) => out.push(x),
            std::path::Component::CurDir => {}
            _ => return None,
        }
    }
    if out.as_os_str().is_empty() {
        None
    } else {
        Some(out)
    }
}

fn extract_prefix(zip: &mut ZipArchive<BufReader<File>>, prefix: &str, dest: &Path, mut each: impl FnMut(u64)) -> Result<usize, String> {
    let mut n = 0;
    for i in 0..zip.len() {
        let mut e = zip.by_index(i).map_err(|e| e.to_string())?;
        let name = e.name().replace('\\', "/");
        let Some(rel) = name.strip_prefix(prefix) else { continue };
        if e.is_dir() {
            continue;
        }
        let Some(rel) = safe_rel(rel) else { continue };
        let target = dest.join(rel);
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("{}: {e}", parent.display()))?;
        }
        let mut out = BufWriter::new(File::create(&target).map_err(|e| format!("{}: {e}", target.display()))?);
        let copied = io::copy(&mut e, &mut out).map_err(|e| e.to_string())?;
        out.flush().map_err(|e| e.to_string())?;
        each(copied);
        n += 1;
    }
    Ok(n)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportPrepared {
    audio_files: usize,
}

/// Prepara la importacion: copia la musica (si viene y se eligio carpeta)
/// y deja la copia lista para aplicarse al reiniciar.
#[tauri::command]
pub async fn backup_import(app: AppHandle, path: String, mappings: Vec<Mapping>, audio_dest: Option<String>) -> Result<ImportPrepared, String> {
    let data_dir = app.state::<AppState>().data_dir.clone();
    tauri::async_runtime::spawn_blocking(move || -> Result<ImportPrepared, String> {
        let src = PathBuf::from(&path);
        let mut zip = open_zip(&src)?;
        let manifest: Manifest = read_entry(&mut zip, MANIFEST)
            .and_then(|b| serde_json::from_slice(&b).ok())
            .ok_or("No es una copia de seguridad de MiRadio")?;
        let mut maps = mappings;
        let mut audio_files = 0;
        if let Some(dest) = audio_dest.filter(|d| !d.trim().is_empty() && manifest.include_audio) {
            let dest = PathBuf::from(dest.trim());
            let total = manifest.audio_bytes.max(1);
            let mut done = 0u64;
            for root in &manifest.audio_roots {
                let target = dest.join(&root.tag);
                audio_files += extract_prefix(&mut zip, &format!("audio/{}/", root.tag), &target, |b| {
                    done += b;
                    progress(&app, "audio", done, total);
                })?;
                // Las rutas de esa unidad pasan a la carpeta elegida, salvo que
                // el usuario haya indicado otra cosa para ella.
                if !maps.iter().any(|m| norm_path(&m.from).starts_with(&norm_path(&root.original)) && !m.to.is_empty()) {
                    maps.push(Mapping { from: root.original.clone(), to: target.display().to_string() });
                }
            }
        }
        // Rutas dentro de la carpeta de datos del otro equipo → la de este.
        if !manifest.data_dir.is_empty() {
            maps.push(Mapping { from: manifest.data_dir.clone(), to: data_dir.display().to_string() });
        }
        maps.retain(|m| !m.from.is_empty() && !m.to.is_empty() && norm_path(&m.from) != norm_path(&m.to));
        fs::copy(&src, data_dir.join(PENDING_ZIP)).map_err(|e| format!("No se pudo preparar la importación: {e}"))?;
        let pending = Pending { mappings: maps };
        fs::write(data_dir.join(PENDING_JSON), serde_json::to_vec_pretty(&pending).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
        Ok(ImportPrepared { audio_files })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Al arrancar: si hay una importacion preparada, guarda una copia de lo
/// actual en backups/ y la aplica. Si algo falla, lo deja todo como estaba.
pub fn apply_pending(data_dir: &Path) {
    let pj = data_dir.join(PENDING_JSON);
    let pz = data_dir.join(PENDING_ZIP);
    if !pj.is_file() || !pz.is_file() {
        return;
    }
    let pending: Pending = fs::read(&pj).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
    let backups = data_dir.join(BACKUPS_DIR);
    let _ = fs::create_dir_all(&backups);
    let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S").to_string();
    let log = |msg: &str| {
        let _ = fs::write(backups.join(format!("importacion-{stamp}.txt")), msg);
    };
    // 1. Copia de lo actual.
    let safety = backups.join(format!("antes-de-importar-{stamp}.zip"));
    let res = (|| -> Result<(), String> {
        let mut files = Vec::new();
        walk(data_dir, data_dir, &mut files);
        let mut zip = ZipWriter::new(BufWriter::new(File::create(&safety).map_err(|e| e.to_string())?));
        for (p, rel) in &files {
            zip.start_file(format!("data/{rel}"), opts(rel)).map_err(|e| e.to_string())?;
            io::copy(&mut File::open(p).map_err(|e| e.to_string())?, &mut zip).map_err(|e| e.to_string())?;
        }
        let m = Manifest { format: 1, app_version: env!("CARGO_PKG_VERSION").into(), created: stamp.clone(), ..Default::default() };
        zip.start_file(MANIFEST, opts(MANIFEST)).map_err(|e| e.to_string())?;
        zip.write_all(&serde_json::to_vec_pretty(&m).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        zip.finish().map_err(|e| e.to_string())?;
        // 2. Extraer y adaptar rutas en una carpeta aparte.
        let tmp = data_dir.join(TMP_DIR);
        let _ = fs::remove_dir_all(&tmp);
        let mut z = open_zip(&pz)?;
        extract_prefix(&mut z, "data/", &tmp, |_| {})?;
        if !tmp.join("library.json").is_file() && !tmp.join("settings.json").is_file() {
            return Err("La copia no tiene datos de MiRadio".into());
        }
        remap_json_files(&tmp, &pending.mappings);
        // 3. Sustituir.
        for (p, _) in &files {
            let _ = fs::remove_file(p);
        }
        let mut new_files = Vec::new();
        walk(&tmp, &tmp, &mut new_files);
        for (p, rel) in &new_files {
            let target = data_dir.join(rel);
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            fs::rename(p, &target).or_else(|_| fs::copy(p, &target).map(|_| ())).map_err(|e| e.to_string())?;
        }
        let _ = fs::remove_dir_all(&tmp);
        Ok(())
    })();
    match res {
        Ok(()) => log(&format!("Importación aplicada. Copia de lo anterior: {}\n", safety.display())),
        Err(e) => {
            // Restaurar lo anterior desde la copia de seguridad.
            if let Ok(mut z) = open_zip(&safety) {
                let _ = extract_prefix(&mut z, "data/", data_dir, |_| {});
            }
            let _ = fs::remove_dir_all(data_dir.join(TMP_DIR));
            log(&format!("La importación falló y se restauraron los datos anteriores: {e}\n"));
        }
    }
    let _ = fs::remove_file(&pj);
    let _ = fs::remove_file(&pz);
}

/// Resultado de la ultima importacion (para avisar al usuario al arrancar).
#[tauri::command]
pub fn backup_last_import_log(app: AppHandle) -> Option<String> {
    let dir = app.state::<AppState>().data_dir.join(BACKUPS_DIR);
    let mut logs: Vec<PathBuf> = fs::read_dir(&dir)
        .ok()?
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.file_name().and_then(|n| n.to_str()).map(|n| n.starts_with("importacion-") && n.ends_with(".txt")).unwrap_or(false))
        .collect();
    logs.sort();
    let last = logs.pop()?;
    let text = fs::read_to_string(&last).ok()?;
    // Se muestra una sola vez.
    let _ = fs::rename(&last, last.with_extension("visto.txt"));
    Some(text)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("miradio-backup-{tag}-{}", uuid::Uuid::new_v4().simple()));
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn remaps_paths() {
        let maps = vec![
            Mapping { from: "M:\\".into(), to: "D:\\Musica".into() },
            Mapping { from: "R:\\Programas\\".into(), to: "E:\\Radio\\Programas\\".into() },
        ];
        assert_eq!(remap("M:\\Kyosko\\Real\\a.flac", &maps).unwrap(), "D:\\Musica\\Kyosko\\Real\\a.flac");
        assert_eq!(remap("m:/x/b.mp3", &maps).unwrap(), "D:\\Musica\\x\\b.mp3");
        assert_eq!(remap("R:\\Programas\\EN DIRECTO\\r.mp3", &maps).unwrap(), "E:\\Radio\\Programas\\EN DIRECTO\\r.mp3");
        assert!(remap("R:\\Musica\\c.mp3", &maps).is_none());
        let unix = vec![Mapping { from: "C:\\Música\\".into(), to: "/home/u/Música".into() }];
        assert_eq!(remap("C:\\Música\\a\\b.mp3", &unix).unwrap(), "/home/u/Música/a/b.mp3");
    }

    #[test]
    fn roots_and_common_prefix() {
        let files = vec!["R:\\Musica\\A\\x.mp3".to_string(), "R:\\Musica\\B\\y.mp3".into(), "M:\\K\\z.flac".into(), "M:\\L\\w.flac".into()];
        let r = roots_of(&files, &[]);
        assert_eq!(r.iter().map(|x| (x.prefix.as_str(), x.tracks)).collect::<Vec<_>>(), vec![("M:\\", 2), ("R:\\Musica\\", 2)]);
        assert_eq!(root_of("\\\\nas\\musica\\a.mp3").unwrap(), "\\\\nas\\musica\\");
    }

    #[test]
    fn export_then_import_roundtrip() {
        let src = tmp("src");
        let music = tmp("music");
        let song = music.join("Artista").join("cancion.mp3");
        fs::create_dir_all(song.parent().unwrap()).unwrap();
        fs::write(&song, b"ID3 audio").unwrap();
        let song_s = song.to_string_lossy().to_string();
        fs::write(
            src.join("library.json"),
            serde_json::to_vec(&serde_json::json!([{"id":"t1","title":"T","artist":"A","durationSecs":1.0,"file":song_s,"blocks":[],"tags":[]}])).unwrap(),
        )
        .unwrap();
        fs::write(src.join("settings.json"), serde_json::to_vec(&serde_json::json!({"musicPath": music.to_string_lossy()})).unwrap()).unwrap();
        fs::create_dir_all(src.join("playlists")).unwrap();
        fs::write(src.join("playlists").join("p1.json"), b"{\"name\":\"Lista\"}").unwrap();
        fs::create_dir_all(src.join("backups")).unwrap();
        fs::write(src.join("backups").join("viejo.zip"), b"x").unwrap();

        // Exportar sin AppHandle: misma funcion interna con un emisor nulo.
        let zip_path = src.join("..").join(format!("copia-{}.zip", uuid::Uuid::new_v4().simple()));
        let r = export_core(&src, &zip_path, true).unwrap();
        assert_eq!(r.audio_files, 1);
        let mut z = open_zip(&zip_path).unwrap();
        let names: Vec<String> = (0..z.len()).map(|i| z.by_index(i).unwrap().name().to_string()).collect();
        assert!(names.iter().any(|n| n == "data/library.json"));
        assert!(names.iter().any(|n| n == "data/playlists/p1.json"));
        assert!(!names.iter().any(|n| n.starts_with("data/backups")), "las copias no se copian");
        assert!(names.iter().any(|n| n.starts_with("audio/") && n.ends_with("Artista/cancion.mp3")), "{names:?}");

        // Importar en otro "equipo" con la musica en otra carpeta.
        let dst = tmp("dst");
        fs::write(dst.join("library.json"), b"[]").unwrap();
        fs::write(dst.join("settings.json"), b"{}").unwrap();
        let new_music = tmp("newmusic");
        let manifest: Manifest = serde_json::from_slice(&read_entry(&mut z, MANIFEST).unwrap()).unwrap();
        let mut maps = Vec::new();
        for root in &manifest.audio_roots {
            let target = new_music.join(&root.tag);
            extract_prefix(&mut z, &format!("audio/{}/", root.tag), &target, |_| {}).unwrap();
            maps.push(Mapping { from: root.original.clone(), to: target.display().to_string() });
        }
        fs::copy(&zip_path, dst.join(PENDING_ZIP)).unwrap();
        fs::write(dst.join(PENDING_JSON), serde_json::to_vec(&Pending { mappings: maps }).unwrap()).unwrap();
        apply_pending(&dst);
        assert!(!dst.join(PENDING_ZIP).exists() && !dst.join(PENDING_JSON).exists());
        let lib: Vec<Value> = serde_json::from_slice(&fs::read(dst.join("library.json")).unwrap()).unwrap();
        let f = lib[0]["file"].as_str().unwrap();
        assert!(Path::new(f).is_file(), "la cancion apunta a la nueva carpeta: {f}");
        assert_eq!(fs::read(f).unwrap(), b"ID3 audio");
        let st: Value = serde_json::from_slice(&fs::read(dst.join("settings.json")).unwrap()).unwrap();
        assert!(st["musicPath"].as_str().unwrap().starts_with(&new_music.to_string_lossy().to_string()));
        assert!(dst.join("playlists").join("p1.json").is_file());
        let backups: Vec<_> = fs::read_dir(dst.join("backups")).unwrap().flatten().map(|e| e.file_name().to_string_lossy().to_string()).collect();
        assert!(backups.iter().any(|n| n.starts_with("antes-de-importar-")), "{backups:?}");
    }

    #[test]
    fn bad_backup_restores_previous() {
        let dst = tmp("bad");
        fs::write(dst.join("library.json"), b"[1]").unwrap();
        // Un zip valido pero sin datos de MiRadio.
        let zp = dst.join(PENDING_ZIP);
        {
            let mut z = ZipWriter::new(File::create(&zp).unwrap());
            z.start_file("data/otra.txt", SimpleFileOptions::default()).unwrap();
            z.write_all(b"x").unwrap();
            z.finish().unwrap();
        }
        fs::write(dst.join(PENDING_JSON), b"{}").unwrap();
        apply_pending(&dst);
        assert_eq!(fs::read(dst.join("library.json")).unwrap(), b"[1]");
    }

    #[test]
    fn zip_slip_is_ignored() {
        assert!(safe_rel("../../etc/passwd").is_none());
        assert!(safe_rel("/abs").is_none());
        assert_eq!(safe_rel("a/b.json").unwrap(), PathBuf::from("a/b.json"));
    }
}
