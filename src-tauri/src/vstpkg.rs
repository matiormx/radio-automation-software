//! Plugins recomendados: un catalogo de plugins VST3 gratuitos y de codigo
//! abierto que MiRadio instala en la carpeta VST3 del usuario y mantiene al
//! dia. Se descargan del espejo de este repositorio (Release «plugins»), donde
//! un flujo semanal los prepara desde su pagina oficial (y compila LSP para
//! Windows, que no publica binarios).
//!
//! - Windows: %LOCALAPPDATA%\Programs\Common\VST3 (sin permisos de administrador)
//! - Linux: ~/.vst3
//!
//! Si al actualizar un plugin esta en uso (Windows bloquea sus archivos), la
//! version nueva queda preparada y se coloca en el siguiente arranque, antes
//! de cargar la mesa.

use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CatalogItem {
    pub id: &'static str,
    pub name: &'static str,
    pub vendor: &'static str,
    pub description: &'static str,
    /// "dinamica", "eq", "reverb", "varios", "medidor"
    pub category: &'static str,
    pub license: &'static str,
    pub homepage: &'static str,
    /// owner/repo en GitHub (vacio = solo enlace, se instala a mano)
    pub repo: &'static str,
    /// Sistemas con version: "windows", "linux"
    pub platforms: &'static [&'static str],
}

/// Catalogo. Los de `repo` vacio son gratuitos pero cerrados: su licencia no
/// permite que otro programa los descargue; se enlaza su pagina.
pub const CATALOG: &[CatalogItem] = &[
    CatalogItem {
        id: "lsp",
        name: "LSP Plugins",
        vendor: "Linux Studio Plugins",
        description: "Compresores, limitadores, multibanda, ecualizadores, puerta de ruido, de-esser… Casi un procesador de emisora completo.",
        category: "dinamica",
        license: "LGPL",
        homepage: "https://lsp-plug.in",
        repo: "lsp-plugins/lsp-plugins",
        platforms: &["windows", "linux"],
    },
    CatalogItem {
        id: "airwindows",
        name: "Airwindows Consolidated",
        vendor: "Airwindows",
        description: "Cientos de procesadores en un solo plugin: saturación, consolas, limitadores, ecualizadores, reverbs.",
        category: "varios",
        license: "MIT",
        homepage: "https://www.airwindows.com/consolidated/",
        repo: "baconpaul/airwin2rack",
        platforms: &["windows", "linux"],
    },
    CatalogItem {
        id: "dragonfly",
        name: "Dragonfly Reverb",
        vendor: "Michael Willis",
        description: "Reverbs de sala, placa, habitación y reflexiones tempranas, de muy buena calidad.",
        category: "reverb",
        license: "GPL",
        homepage: "https://michaelwillis.github.io/dragonfly-reverb/",
        repo: "michaelwillis/dragonfly-reverb",
        platforms: &["windows", "linux"],
    },
    CatalogItem {
        id: "zl-eq",
        name: "ZL Equalizer",
        vendor: "ZL Audio",
        description: "Ecualizador paramétrico moderno con analizador, modo dinámico y M/S.",
        category: "eq",
        license: "AGPL",
        homepage: "https://zl-audio.github.io/",
        repo: "ZL-Audio/ZLEqualizer",
        platforms: &["windows", "linux"],
    },
    CatalogItem {
        id: "zl-comp",
        name: "ZL Compressor",
        vendor: "ZL Audio",
        description: "Compresor flexible con curva visible, sidechain y varios estilos.",
        category: "dinamica",
        license: "AGPL",
        homepage: "https://zl-audio.github.io/",
        repo: "ZL-Audio/ZLCompressor",
        platforms: &["windows", "linux"],
    },
    CatalogItem {
        id: "youlean",
        name: "Youlean Loudness Meter 2",
        vendor: "Youlean",
        description: "Medidor de sonoridad (LUFS) de referencia. Gratuito; se descarga en su página.",
        category: "medidor",
        license: "Freeware",
        homepage: "https://youlean.co/youlean-loudness-meter/",
        repo: "",
        platforms: &["windows", "linux"],
    },
    CatalogItem {
        id: "tdr-nova",
        name: "TDR Nova",
        vendor: "Tokyo Dawn Records",
        description: "Ecualizador dinámico muy usado en voz. Gratuito; se descarga en su página.",
        category: "eq",
        license: "Freeware",
        homepage: "https://www.tokyodawn.net/tdr-nova/",
        repo: "",
        platforms: &["windows"],
    },
];

const STATE_FILE: &str = "vstpkgs.json";
const CHECK_EVERY: Duration = Duration::from_secs(7 * 24 * 3600);

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Installed {
    /// Etiqueta de la version instalada
    pub version: String,
    /// Bundles .vst3 instalados (rutas)
    pub files: Vec<String>,
    pub installed_at: u64,
    /// Version preparada que se colocara en el siguiente arranque
    pub pending: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
struct State {
    installed: HashMap<String, Installed>,
    /// Ultima version publicada que se ha visto (por id)
    latest: HashMap<String, String>,
    last_check: u64,
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub id: String,
    pub busy: bool,
    pub phase: String,
    pub fraction: f64,
    pub error: Option<String>,
    pub done: Option<String>,
}

static BUSY: Mutex<Vec<String>> = Mutex::new(Vec::new());
static STATE_LOCK: Mutex<()> = Mutex::new(());

fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

fn os() -> &'static str {
    if cfg!(windows) {
        "windows"
    } else if cfg!(target_os = "linux") {
        "linux"
    } else {
        "mac"
    }
}

/// Carpeta VST3 del usuario.
pub fn user_vst3_dir() -> Option<PathBuf> {
    #[cfg(windows)]
    {
        std::env::var_os("LOCALAPPDATA").map(|p| PathBuf::from(p).join("Programs").join("Common").join("VST3"))
    }
    #[cfg(not(windows))]
    {
        std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".vst3"))
    }
}

fn state_path(data_dir: &Path) -> PathBuf {
    data_dir.join(STATE_FILE)
}

fn read_state(data_dir: &Path) -> State {
    std::fs::read(state_path(data_dir)).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
}

fn write_state(data_dir: &Path, st: &State) {
    if let Ok(json) = serde_json::to_vec_pretty(st) {
        let _ = std::fs::write(state_path(data_dir), json);
    }
}

fn agent() -> ureq::Agent {
    ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(20))
        .timeout_read(Duration::from_secs(60))
        .redirects(8)
        .user_agent("MiRadio")
        .build()
}

/// Espejo de MiRadio: los VST3 de cada plugin ya preparados por sistema
/// (los publica el flujo «Plugins recomendados» de este repositorio).
const MIRROR: &str = "https://github.com/matiormx/radio-automation-software/releases/download/plugins";

#[derive(Deserialize)]
struct MFile {
    file: String,
    sha256: String,
}

#[derive(Deserialize)]
struct MEntry {
    version: String,
    windows: Option<MFile>,
    linux: Option<MFile>,
}

#[derive(Deserialize)]
struct Manifest {
    plugins: HashMap<String, MEntry>,
}

fn manifest() -> Result<Manifest, String> {
    let text = agent()
        .get(&format!("{MIRROR}/plugins.json"))
        .call()
        .map_err(|e| format!("No se pudo consultar la lista de plugins: {e}"))?
        .into_string()
        .map_err(|e| e.to_string())?;
    serde_json::from_str(&text).map_err(|e| format!("Lista de plugins dañada: {e}"))
}

fn emit(app: &AppHandle, p: &Progress) {
    let _ = app.emit("vstpkg://progress", p.clone());
}

/// Lista los bundles .vst3 de un archivo y los extrae a `dest`. Devuelve los
/// nombres de los bundles.
fn extract_vst3(archive: &Path, name: &str, dest: &Path) -> Result<Vec<String>, String> {
    std::fs::create_dir_all(dest).map_err(|e| e.to_string())?;
    let lower = name.to_lowercase();
    // Ruta dentro del archivo -> (bundle, resto)
    fn split(path: &str) -> Option<(String, String)> {
        let parts: Vec<&str> = path.split('/').filter(|p| !p.is_empty()).collect();
        let i = parts.iter().position(|p| p.to_lowercase().ends_with(".vst3"))?;
        Some((parts[i].to_string(), parts[i + 1..].join("/")))
    }
    let mut bundles: Vec<String> = Vec::new();
    let mut write = |inner: &str, is_dir: bool, reader: &mut dyn Read| -> Result<(), String> {
        let Some((bundle, rest)) = split(inner) else { return Ok(()) };
        if rest.split('/').any(|p| p == "..") {
            return Ok(());
        }
        if !bundles.contains(&bundle) {
            bundles.push(bundle.clone());
        }
        let target = if rest.is_empty() { dest.join(&bundle) } else { dest.join(&bundle).join(&rest) };
        if is_dir {
            std::fs::create_dir_all(&target).map_err(|e| e.to_string())?;
            return Ok(());
        }
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let mut out = std::fs::File::create(&target).map_err(|e| format!("{}: {e}", target.display()))?;
        std::io::copy(reader, &mut out).map_err(|e| e.to_string())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if target.extension().map(|e| e == "so").unwrap_or(false) {
                let _ = std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o755));
            }
        }
        Ok(())
    };
    let file = std::fs::File::open(archive).map_err(|e| e.to_string())?;
    if lower.ends_with(".zip") {
        let mut zip = zip::ZipArchive::new(file).map_err(|e| format!("Archivo dañado: {e}"))?;
        for i in 0..zip.len() {
            let mut f = zip.by_index(i).map_err(|e| e.to_string())?;
            let inner = f.name().replace('\\', "/");
            let is_dir = f.is_dir();
            write(&inner, is_dir, &mut f)?;
        }
    } else {
        let reader: Box<dyn Read> = if lower.ends_with(".tar.xz") {
            let mut buf = Vec::new();
            lzma_rs::xz_decompress(&mut std::io::BufReader::new(file), &mut buf).map_err(|e| format!("Archivo dañado: {e}"))?;
            Box::new(std::io::Cursor::new(buf))
        } else {
            Box::new(flate2::read::GzDecoder::new(file))
        };
        let mut tar = tar::Archive::new(reader);
        for entry in tar.entries().map_err(|e| e.to_string())? {
            let mut e = entry.map_err(|e| e.to_string())?;
            let inner = e.path().map_err(|e| e.to_string())?.to_string_lossy().replace('\\', "/");
            let is_dir = e.header().entry_type().is_dir();
            write(&inner, is_dir, &mut e)?;
        }
    }
    Ok(bundles)
}

/// Copia (o mueve) una carpeta entera.
fn copy_dir(from: &Path, to: &Path) -> std::io::Result<()> {
    if from.is_file() {
        if let Some(p) = to.parent() {
            std::fs::create_dir_all(p)?;
        }
        std::fs::copy(from, to)?;
        return Ok(());
    }
    std::fs::create_dir_all(to)?;
    for e in std::fs::read_dir(from)? {
        let e = e?;
        copy_dir(&e.path(), &to.join(e.file_name()))?;
    }
    Ok(())
}

fn install(app: &AppHandle, data_dir: &Path, id: &str) -> Result<String, String> {
    let item = CATALOG.iter().find(|c| c.id == id).ok_or("Plugin desconocido")?;
    if item.repo.is_empty() {
        return Err("Este plugin se descarga a mano desde su página".into());
    }
    let mut p = Progress { id: id.into(), busy: true, phase: "comprobando".into(), ..Default::default() };
    emit(app, &p);
    let m = manifest()?;
    let entry = m.plugins.get(id).ok_or_else(|| format!("{} aún no está preparado; vuelve a intentarlo más tarde", item.name))?;
    let file = match os() {
        "windows" => entry.windows.as_ref(),
        "linux" => entry.linux.as_ref(),
        _ => None,
    }
    .ok_or_else(|| format!("{} aún no está disponible para este sistema", item.name))?;
    let version = entry.version.clone();
    let work = data_dir.join("vstpkg-tmp").join(id);
    let _ = std::fs::remove_dir_all(&work);
    std::fs::create_dir_all(&work).map_err(|e| e.to_string())?;
    // Descarga
    p.phase = "descargando".into();
    emit(app, &p);
    let resp = agent().get(&format!("{MIRROR}/{}", file.file)).call().map_err(|e| format!("No se pudo descargar: {e}"))?;
    let total = resp.header("Content-Length").and_then(|v| v.parse::<u64>().ok()).unwrap_or(0);
    let mut reader = resp.into_reader();
    let file_path = work.join(&file.file);
    let mut hasher = <sha2::Sha256 as sha2::Digest>::new();
    {
        let mut out = std::fs::File::create(&file_path).map_err(|e| e.to_string())?;
        let mut buf = vec![0u8; 256 * 1024];
        let mut got = 0u64;
        let mut last = std::time::Instant::now();
        loop {
            let n = reader.read(&mut buf).map_err(|e| format!("Se cortó la descarga: {e}"))?;
            if n == 0 {
                break;
            }
            std::io::Write::write_all(&mut out, &buf[..n]).map_err(|e| e.to_string())?;
            sha2::Digest::update(&mut hasher, &buf[..n]);
            got += n as u64;
            if total > 0 && last.elapsed() > Duration::from_millis(300) {
                last = std::time::Instant::now();
                p.fraction = got as f64 / total as f64;
                emit(app, &p);
            }
        }
    }
    if format!("{:x}", sha2::Digest::finalize(hasher)) != file.sha256 {
        let _ = std::fs::remove_dir_all(&work);
        return Err("La descarga no coincide con su firma SHA-256: se descarta".into());
    }
    // Extraccion a una carpeta de preparacion
    p.phase = "instalando".into();
    p.fraction = 1.0;
    emit(app, &p);
    let staged = work.join("vst3");
    let bundles = extract_vst3(&file_path, &file.file, &staged)?;
    let _ = std::fs::remove_file(&file_path);
    if bundles.is_empty() {
        return Err(format!("El paquete {} no trae plugins VST3", file.file));
    }
    let dest_root = user_vst3_dir().ok_or("No encuentro la carpeta VST3 del usuario")?;
    std::fs::create_dir_all(&dest_root).map_err(|e| e.to_string())?;
    let _g = STATE_LOCK.lock();
    let mut st = read_state(data_dir);
    let old = st.installed.get(id).cloned().unwrap_or_default();
    // Se quitan los bundles de la version anterior que ya no vienen.
    let mut placed_all = true;
    for b in &bundles {
        let dest = dest_root.join(b);
        if dest.exists() && std::fs::remove_dir_all(&dest).or_else(|_| std::fs::remove_file(&dest)).is_err() {
            placed_all = false;
            continue;
        }
        if copy_dir(&staged.join(b), &dest).is_err() {
            placed_all = false;
        }
    }
    let files: Vec<String> = bundles.iter().map(|b| dest_root.join(b).to_string_lossy().into_owned()).collect();
    for f in &old.files {
        if !files.contains(f) {
            let _ = std::fs::remove_dir_all(f).or_else(|_| std::fs::remove_file(f));
        }
    }
    let entry = st.installed.entry(id.to_string()).or_default();
    entry.files = files;
    st.latest.insert(id.to_string(), version.clone());
    if placed_all {
        entry.version = version.clone();
        entry.installed_at = now();
        entry.pending = None;
        write_state(data_dir, &st);
        let _ = std::fs::remove_dir_all(&work);
        Ok(format!("{} {} instalado", item.name, version))
    } else {
        // En uso: se coloca al reiniciar (queda en vstpkg-tmp/<id>/vst3).
        entry.pending = Some(version.clone());
        write_state(data_dir, &st);
        Ok(format!("{} {}: está en uso; se actualizará al reiniciar MiRadio", item.name, version))
    }
}

/// Al arrancar (antes de cargar la mesa): coloca las actualizaciones que
/// quedaron pendientes porque el plugin estaba en uso.
pub fn apply_pending(data_dir: &Path) {
    let _g = STATE_LOCK.lock();
    let mut st = read_state(data_dir);
    let Some(dest_root) = user_vst3_dir() else { return };
    let mut changed = false;
    for (id, inst) in st.installed.iter_mut() {
        let Some(ver) = inst.pending.clone() else { continue };
        let staged = data_dir.join("vstpkg-tmp").join(id).join("vst3");
        let Ok(list) = std::fs::read_dir(&staged) else {
            inst.pending = None;
            changed = true;
            continue;
        };
        let mut ok = true;
        for e in list.flatten() {
            let dest = dest_root.join(e.file_name());
            let _ = std::fs::remove_dir_all(&dest).or_else(|_| std::fs::remove_file(&dest));
            if copy_dir(&e.path(), &dest).is_err() {
                ok = false;
            }
        }
        if ok {
            inst.version = ver;
            inst.installed_at = now();
            inst.pending = None;
            let _ = std::fs::remove_dir_all(data_dir.join("vstpkg-tmp").join(id));
            changed = true;
        }
    }
    if changed {
        write_state(data_dir, &st);
    }
}

fn start(app: AppHandle, id: String) -> Result<(), String> {
    {
        let mut busy = BUSY.lock().unwrap_or_else(|e| e.into_inner());
        if busy.contains(&id) {
            return Err("Ya se está instalando".into());
        }
        busy.push(id.clone());
    }
    std::thread::spawn(move || {
        let data_dir = app.path().app_data_dir().unwrap_or_default();
        let res = install(&app, &data_dir, &id);
        BUSY.lock().unwrap_or_else(|e| e.into_inner()).retain(|x| x != &id);
        let p = match res {
            Ok(msg) => Progress { id: id.clone(), busy: false, done: Some(msg), fraction: 1.0, ..Default::default() },
            Err(e) => Progress { id: id.clone(), busy: false, error: Some(e), ..Default::default() },
        };
        emit(&app, &p);
    });
    Ok(())
}

/// Busca versiones nuevas de los instalados (y de todo el catalogo).
fn check(data_dir: &Path) {
    let Ok(m) = manifest() else { return };
    let latest: HashMap<String, String> = m.plugins.into_iter().map(|(k, v)| (k, v.version)).collect();
    let _g = STATE_LOCK.lock();
    let mut st = read_state(data_dir);
    st.latest.extend(latest);
    st.last_check = now();
    write_state(data_dir, &st);
}

/// Al arrancar: plugins que pide preinstalar el quiosco y, cada semana,
/// actualizacion de los instalados.
pub fn on_startup(app: AppHandle) {
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(8));
        let Ok(data_dir) = app.path().app_data_dir() else { return };
        // Preinstalacion (la deja el script del quiosco): un id por linea.
        let pre = data_dir.join("vst-preinstall");
        if let Ok(text) = std::fs::read_to_string(&pre) {
            let _ = std::fs::remove_file(&pre);
            for id in text.lines().map(str::trim).filter(|l| !l.is_empty()) {
                let _ = install(&app, &data_dir, id);
            }
        }
        let st = read_state(&data_dir);
        if st.installed.is_empty() || now().saturating_sub(st.last_check) < CHECK_EVERY.as_secs() {
            return;
        }
        check(&data_dir);
        let st = read_state(&data_dir);
        for (id, inst) in st.installed.iter() {
            if inst.pending.is_none() && st.latest.get(id).map(|v| v != &inst.version).unwrap_or(false) {
                let _ = install(&app, &data_dir, id);
            }
        }
    });
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PkgStatus {
    pub item: CatalogItem,
    pub available: bool,
    pub installed: Option<Installed>,
    pub latest: Option<String>,
    pub busy: bool,
}

#[tauri::command]
pub fn vstpkg_list(app: AppHandle) -> Vec<PkgStatus> {
    let data_dir = app.path().app_data_dir().unwrap_or_default();
    let st = read_state(&data_dir);
    let busy = BUSY.lock().map(|b| b.clone()).unwrap_or_default();
    CATALOG
        .iter()
        .map(|c| PkgStatus {
            item: c.clone(),
            available: c.platforms.contains(&os()),
            installed: st.installed.get(c.id).cloned(),
            latest: st.latest.get(c.id).cloned(),
            busy: busy.iter().any(|b| b == c.id),
        })
        .collect()
}

#[tauri::command]
pub fn vstpkg_install(app: AppHandle, id: String) -> Result<(), String> {
    start(app, id)
}

#[tauri::command]
pub async fn vstpkg_check(app: AppHandle) -> Result<(), String> {
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    tauri::async_runtime::spawn_blocking(move || check(&data_dir)).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub fn vstpkg_remove(app: AppHandle, id: String) -> Result<String, String> {
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let _g = STATE_LOCK.lock();
    let mut st = read_state(&data_dir);
    let Some(inst) = st.installed.remove(&id) else { return Err("No está instalado".into()) };
    let mut busy = Vec::new();
    for f in &inst.files {
        if std::fs::remove_dir_all(f).or_else(|_| std::fs::remove_file(f)).is_err() && Path::new(f).exists() {
            busy.push(f.clone());
        }
    }
    let _ = std::fs::remove_dir_all(data_dir.join("vstpkg-tmp").join(&id));
    write_state(&data_dir, &st);
    if busy.is_empty() {
        Ok("Plugin quitado".into())
    } else {
        Err("Está en uso: quítalo de la mesa y vuelve a intentarlo (o reinicia MiRadio)".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_bundles_from_zip_and_tar() {
        use std::io::Write;
        let dir = std::env::temp_dir().join(format!("miradio-vstpkg-{}", now()));
        std::fs::create_dir_all(&dir).unwrap();
        // zip
        let zp = dir.join("a.zip");
        {
            let f = std::fs::File::create(&zp).unwrap();
            let mut z = zip::ZipWriter::new(f);
            let o = zip::write::SimpleFileOptions::default();
            z.start_file("pkg/VST3/Comp.vst3/Contents/x86_64-win/Comp.vst3", o).unwrap();
            z.write_all(b"DLL").unwrap();
            z.start_file("pkg/README.txt", o).unwrap();
            z.write_all(b"hola").unwrap();
            z.finish().unwrap();
        }
        let out = dir.join("out");
        let b = extract_vst3(&zp, "a.zip", &out).unwrap();
        assert_eq!(b, vec!["Comp.vst3".to_string()]);
        assert_eq!(std::fs::read(out.join("Comp.vst3/Contents/x86_64-win/Comp.vst3")).unwrap(), b"DLL");
        // tar.gz
        let tp = dir.join("b.tar.gz");
        {
            let f = std::fs::File::create(&tp).unwrap();
            let gz = flate2::write::GzEncoder::new(f, flate2::Compression::fast());
            let mut t = tar::Builder::new(gz);
            let data = b"SO";
            let mut h = tar::Header::new_gnu();
            h.set_size(data.len() as u64);
            h.set_mode(0o644);
            h.set_cksum();
            t.append_data(&mut h, "x/Eq.vst3/Contents/x86_64-linux/Eq.so", &data[..]).unwrap();
            t.into_inner().unwrap().finish().unwrap();
        }
        let out2 = dir.join("out2");
        let b = extract_vst3(&tp, "b.tar.gz", &out2).unwrap();
        assert_eq!(b, vec!["Eq.vst3".to_string()]);
        assert!(out2.join("Eq.vst3/Contents/x86_64-linux/Eq.so").is_file());
        let _ = std::fs::remove_dir_all(dir);
    }
}
