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
pub async fn fs_list(path: String) -> Result<Listing, String> {
    tauri::async_runtime::spawn_blocking(move || list(&PathBuf::from(path))).await.map_err(|e| e.to_string())?
}

/// Sitios de acceso rapido: carpetas del usuario y unidades.
#[tauri::command]
pub fn fs_places(app: AppHandle) -> Vec<Place> {
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
