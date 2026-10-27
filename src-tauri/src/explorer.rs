//! Explorador de archivos del ordenador: unidades, carpetas y los archivos de
//! audio y video que OmniCaster puede usar (esten o no en la biblioteca).

use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::{AppHandle, Manager};

/// Audio que se reproduce (mismo criterio que la biblioteca).
pub const AUDIO: [&str; 12] = ["mp3", "wav", "flac", "ogg", "oga", "opus", "m4a", "aac", "aif", "aiff", "wma", "webm"];

const MAX_ENTRIES: usize = 5000;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub name: String,
    pub path: String,
    pub dir: bool,
    /// "audio" | "video" | "" (carpetas)
    pub kind: String,
    pub size: u64,
    /// Segundos desde 1970
    pub modified: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Listing {
    pub path: String,
    pub parent: Option<String>,
    pub entries: Vec<Entry>,
    /// Habia mas elementos de los que se muestran
    pub truncated: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Place {
    pub label: String,
    pub path: String,
    /// "drive" | "folder"
    pub kind: String,
}

fn kind_of(path: &Path) -> &'static str {
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
    if crate::video::VIDEO_EXTENSIONS.contains(&ext.as_str()) && ext != "webm" {
        "video"
    } else if AUDIO.contains(&ext.as_str()) {
        "audio"
    } else {
        ""
    }
}

fn hidden(path: &Path, name: &str) -> bool {
    if name.starts_with('.') || name.starts_with('$') {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        // FILE_ATTRIBUTE_HIDDEN | FILE_ATTRIBUTE_SYSTEM
        if let Ok(m) = std::fs::symlink_metadata(path) {
            return m.file_attributes() & 0x6 != 0;
        }
    }
    let _ = path;
    false
}

pub fn list(path: &Path) -> Result<Listing, String> {
    let rd = std::fs::read_dir(path).map_err(|e| format!("No se puede abrir {}: {e}", path.display()))?;
    let mut entries = Vec::new();
    let mut truncated = false;
    for e in rd.flatten() {
        let p = e.path();
        let name = e.file_name().to_string_lossy().into_owned();
        if hidden(&p, &name) {
            continue;
        }
        let Ok(meta) = std::fs::metadata(&p) else { continue };
        let dir = meta.is_dir();
        let kind = if dir { "" } else { kind_of(&p) };
        if !dir && kind.is_empty() {
            continue;
        }
        if entries.len() >= MAX_ENTRIES {
            truncated = true;
            break;
        }
        let modified = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs())
            .unwrap_or(0);
        entries.push(Entry {
            name,
            path: p.to_string_lossy().into_owned(),
            dir,
            kind: kind.into(),
            size: if dir { 0 } else { meta.len() },
            modified,
        });
    }
    entries.sort_by(|a, b| b.dir.cmp(&a.dir).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase())));
    Ok(Listing {
        path: path.to_string_lossy().into_owned(),
        parent: path.parent().map(|p| p.to_string_lossy().into_owned()).filter(|p| !p.is_empty()),
        entries,
        truncated,
    })
}

#[tauri::command]
pub async fn fs_list(app: AppHandle, path: String) -> Result<Listing, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let dir = PathBuf::from(path);
        if cfg!(target_os = "linux") {
            let roots = kiosk_roots(&app);
            if !allowed(&roots, &dir) {
                return Err("Esa carpeta no está disponible".to_string());
            }
            let mut l = list(&dir)?;
            l.parent = l.parent.filter(|p| allowed(&roots, Path::new(p)));
            return Ok(l);
        }
        list(&dir)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Sitios de acceso rapido: carpetas del usuario y unidades. En Linux
/// (quiosco) solo las carpetas de trabajo de OmniCaster.
#[tauri::command]
pub fn fs_places(app: AppHandle) -> Vec<Place> {
    if cfg!(target_os = "linux") {
        return kiosk_roots(&app);
    }
    let mut out = Vec::new();
    let p = app.path();
    let folders: [(&str, Option<PathBuf>); 5] = [
        ("Música", p.audio_dir().ok()),
        ("Vídeos", p.video_dir().ok()),
        ("Escritorio", p.desktop_dir().ok()),
        ("Descargas", p.download_dir().ok()),
        ("Inicio", p.home_dir().ok()),
    ];
    for (label, dir) in folders {
        if let Some(d) = dir.filter(|d| d.is_dir()) {
            out.push(Place { label: label.into(), path: d.to_string_lossy().into_owned(), kind: "folder".into() });
        }
    }
    #[cfg(windows)]
    for c in b'A'..=b'Z' {
        let root = format!("{}:\\", c as char);
        if Path::new(&root).exists() {
            out.push(Place { label: format!("{}:", c as char), path: root, kind: "drive".into() });
        }
    }
    #[cfg(not(windows))]
    out.push(Place { label: "/".into(), path: "/".into(), kind: "drive".into() });
    out
}

/// Carpetas del quiosco (en el inicio del usuario). Plugins, Descargas y
/// Musica se comparten por Samba; Personal no.
pub const KIOSK_FOLDERS: [&str; 3] = ["Plugins", "Descargas", "Personal"];

/// Carpetas a las que se puede llegar desde los selectores de archivos en
/// Linux: la musica de OmniCaster, Plugins, Descargas, Personal y los
/// discos USB conectados.
pub fn kiosk_roots(app: &AppHandle) -> Vec<Place> {
    let mut out = Vec::new();
    let folder = |label: &str, d: &Path| Place { label: label.into(), path: d.to_string_lossy().into_owned(), kind: "folder".into() };
    if let Ok(data) = app.path().app_data_dir() {
        let m = crate::library::music_dir_of(&data);
        let _ = std::fs::create_dir_all(&m);
        out.push(folder("Música", &m));
    }
    if let Ok(home) = app.path().home_dir() {
        for name in KIOSK_FOLDERS {
            let d = home.join(name);
            let _ = std::fs::create_dir_all(&d);
            out.push(folder(name, &d));
        }
        // Memorias USB y discos externos (los monta udisks en /media/<usuario>)
        let user = home.file_name().map(|n| n.to_owned()).unwrap_or_default();
        for base in [Path::new("/media").join(&user), Path::new("/run/media").join(&user)] {
            let Ok(rd) = std::fs::read_dir(&base) else { continue };
            let mut v: Vec<PathBuf> = rd.flatten().map(|e| e.path()).filter(|p| p.is_dir()).collect();
            v.sort();
            for d in v {
                let name = d.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
                out.push(Place { label: format!("USB · {name}"), path: d.to_string_lossy().into_owned(), kind: "drive".into() });
            }
        }
    }
    out
}

/// Esta dentro de alguna carpeta permitida (ya resueltos los enlaces y «..»).
fn allowed(roots: &[Place], path: &Path) -> bool {
    let Ok(real) = path.canonicalize() else { return false };
    roots.iter().any(|r| Path::new(&r.path).canonicalize().map(|root| real.starts_with(root)).unwrap_or(false))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PickerRoots {
    /// Solo se puede navegar por estas carpetas (Linux)
    pub restricted: bool,
    pub roots: Vec<Place>,
}

#[tauri::command]
pub fn picker_roots(app: AppHandle) -> PickerRoots {
    PickerRoots { restricted: cfg!(target_os = "linux"), roots: kiosk_roots(&app) }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PickEntry {
    pub name: String,
    pub path: String,
    pub dir: bool,
    pub size: u64,
    pub modified: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PickListing {
    pub path: String,
    /// Carpeta de arriba, si sigue dentro de las permitidas
    pub parent: Option<String>,
    pub entries: Vec<PickEntry>,
}

/// Lista una carpeta para el selector propio. `exts` vacio = todos los
/// archivos. Las carpetas cuyo nombre acaba en una de `exts` (paquetes como
/// los .vst3) salen como archivos que se pueden elegir.
#[tauri::command]
pub async fn picker_list(app: AppHandle, path: String, exts: Vec<String>) -> Result<PickListing, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let roots = kiosk_roots(&app);
        let dir = PathBuf::from(&path);
        if !allowed(&roots, &dir) {
            return Err("Esa carpeta no está disponible".to_string());
        }
        let exts: Vec<String> = exts.iter().map(|e| e.trim_start_matches('.').to_ascii_lowercase()).collect();
        let rd = std::fs::read_dir(&dir).map_err(|e| format!("No se puede abrir {}: {e}", dir.display()))?;
        let mut entries = Vec::new();
        for e in rd.flatten() {
            let p = e.path();
            let name = e.file_name().to_string_lossy().into_owned();
            if hidden(&p, &name) {
                continue;
            }
            let Ok(meta) = std::fs::metadata(&p) else { continue };
            let ext = p.extension().and_then(|x| x.to_str()).unwrap_or("").to_ascii_lowercase();
            let matches = exts.is_empty() || exts.contains(&ext);
            let is_bundle = meta.is_dir() && !exts.is_empty() && matches;
            let dir = meta.is_dir() && !is_bundle;
            if !dir && !matches {
                continue;
            }
            if entries.len() >= MAX_ENTRIES {
                break;
            }
            let modified = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs())
                .unwrap_or(0);
            entries.push(PickEntry { name, path: p.to_string_lossy().into_owned(), dir, size: if meta.is_dir() { 0 } else { meta.len() }, modified });
        }
        entries.sort_by(|a, b| b.dir.cmp(&a.dir).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase())));
        let parent = dir.parent().filter(|p| allowed(&roots, p)).map(|p| p.to_string_lossy().into_owned());
        Ok(PickListing { path: dir.to_string_lossy().into_owned(), parent, entries })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Crea una carpeta nueva dentro de una permitida.
#[tauri::command]
pub fn picker_mkdir(app: AppHandle, parent: String, name: String) -> Result<String, String> {
    let name = name.trim();
    if name.is_empty() || name.contains(['/', '\\']) || name == "." || name == ".." {
        return Err("Nombre de carpeta no válido".into());
    }
    let parent = PathBuf::from(parent);
    if !allowed(&kiosk_roots(&app), &parent) {
        return Err("Esa carpeta no está disponible".into());
    }
    let d = parent.join(name);
    std::fs::create_dir_all(&d).map_err(|e| format!("No se pudo crear la carpeta: {e}"))?;
    Ok(d.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lists_only_folders_and_media() {
        let dir = std::env::temp_dir().join(format!("miradio-exp-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("Sub")).unwrap();
        for f in ["b.mp3", "a.M4V", "nota.txt", ".oculto.mp3", "c.flac"] {
            std::fs::write(dir.join(f), b"x").unwrap();
        }
        let l = list(&dir).unwrap();
        let names: Vec<&str> = l.entries.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, ["Sub", "a.M4V", "b.mp3", "c.flac"]);
        assert_eq!(l.entries[1].kind, "video");
        assert_eq!(l.entries[2].kind, "audio");
        let _ = std::fs::remove_dir_all(dir);
    }
}
