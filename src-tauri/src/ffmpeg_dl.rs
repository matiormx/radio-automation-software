//! FFmpeg gestionado por OmniCaster: si no hay uno puesto a mano, se descarga
//! solo (compilaciones oficiales para Windows de BtbN/FFmpeg-Builds en
//! GitHub), se comprueba su SHA-256 y se mantiene al dia.
//!
//! Cada version va en su propia carpeta (`<datos>/ffmpeg/<nombre>/`), asi una
//! actualizacion nunca pisa el ffmpeg.exe que este usando una emision: la
//! nueva se usa en el siguiente arranque de FFmpeg y la vieja se borra luego.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager};

const BASE: &str = "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest";
/// Variante: Windows 64 bits, GPL (lleva x264 para RTMP), ejecutable unico.
const FLAVOR: &str = "win64-gpl";
const STATE_FILE: &str = "state.json";
/// Cada cuanto se mira si hay version nueva.
const CHECK_EVERY: Duration = Duration::from_secs(7 * 24 * 3600);
/// Una compilacion de la misma version se renueva como mucho una vez al mes.
const REFRESH_SAME: Duration = Duration::from_secs(30 * 24 * 3600);

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Installed {
    /// Carpeta (dentro de <datos>/ffmpeg) con ffmpeg.exe
    pub dir: String,
    /// Archivo descargado, p. ej. ffmpeg-n9.0-latest-win64-gpl-9.0.zip
    pub asset: String,
    pub sha256: String,
    /// Segundos desde 1970
    pub installed_at: u64,
    pub last_check: u64,
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub busy: bool,
    /// "comprobando", "descargando", "verificando", "instalando"
    pub phase: String,
    /// 0..1 (descarga)
    pub fraction: f64,
    pub error: Option<String>,
    /// Mensaje al terminar ("FFmpeg instalado", "Ya está al día"...)
    pub done: Option<String>,
}

static PROGRESS: Mutex<Option<Progress>> = Mutex::new(None);

fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

fn root(data_dir: &Path) -> PathBuf {
    data_dir.join("ffmpeg")
}

fn read_state(data_dir: &Path) -> Option<Installed> {
    let raw = std::fs::read(root(data_dir).join(STATE_FILE)).ok()?;
    serde_json::from_slice(&raw).ok()
}

fn write_state(data_dir: &Path, st: &Installed) {
    let _ = std::fs::create_dir_all(root(data_dir));
    if let Ok(json) = serde_json::to_vec_pretty(st) {
        let _ = std::fs::write(root(data_dir).join(STATE_FILE), json);
    }
}

fn exe_name() -> &'static str {
    if cfg!(windows) {
        "ffmpeg.exe"
    } else {
        "ffmpeg"
    }
}

/// ffmpeg.exe descargado por OmniCaster (si lo hay).
pub fn installed(data_dir: &Path) -> Option<PathBuf> {
    let st = read_state(data_dir)?;
    let p = root(data_dir).join(&st.dir).join(exe_name());
    p.is_file().then_some(p)
}

/// ¿Puede OmniCaster descargar FFmpeg en este sistema?
pub fn supported() -> bool {
    cfg!(windows)
}

/// Elige, de checksums.sha256, la ultima version estable para Windows:
/// `ffmpeg-nX.Y-latest-win64-gpl-X.Y.zip` con la X.Y mas alta. Si no hay
/// ninguna estable, la de desarrollo (master).
pub fn choose_asset(checksums: &str, flavor: &str) -> Option<(String, String)> {
    let mut best: Option<((u32, u32), String, String)> = None;
    let mut master: Option<(String, String)> = None;
    for line in checksums.lines() {
        let mut parts = line.split_whitespace();
        let (Some(sha), Some(name)) = (parts.next(), parts.next()) else { continue };
        let name = name.trim_start_matches('*');
        if sha.len() != 64 || !name.ends_with(".zip") || name.contains("-shared") {
            continue;
        }
        if name == format!("ffmpeg-master-latest-{flavor}.zip") {
            master = Some((name.to_string(), sha.to_lowercase()));
            continue;
        }
        // ffmpeg-n9.0-latest-win64-gpl-9.0.zip
        let Some(rest) = name.strip_prefix("ffmpeg-n") else { continue };
        let Some((ver, tail)) = rest.split_once("-latest-") else { continue };
        if !tail.starts_with(&format!("{flavor}-")) {
            continue;
        }
        let mut it = ver.split('.').map(|x| x.parse::<u32>().ok());
        let (Some(Some(major)), Some(Some(minor))) = (it.next(), it.next()) else { continue };
        if best.as_ref().map(|(v, _, _)| (major, minor) > *v).unwrap_or(true) {
            best = Some(((major, minor), name.to_string(), sha.to_lowercase()));
        }
    }
    best.map(|(_, n, s)| (n, s)).or(master)
}

fn set_progress(app: &AppHandle, p: Progress) {
    *PROGRESS.lock().unwrap_or_else(|e| e.into_inner()) = Some(p.clone());
    let _ = app.emit("ffmpeg://progress", p);
}

fn agent() -> ureq::Agent {
    ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(20))
        .timeout_read(Duration::from_secs(60))
        .redirects(8)
        .user_agent("OmniCaster")
        .build()
}

/// Comprueba y, si hace falta, descarga e instala. `force`: aunque se haya
/// mirado hace poco. Devuelve el mensaje final.
fn run(app: &AppHandle, data_dir: &Path, force: bool) -> Result<String, String> {
    if !supported() {
        return Err("En este sistema usa el FFmpeg instalado (OmniCaster solo lo descarga en Windows)".into());
    }
    let mut progress = Progress { busy: true, phase: "comprobando".into(), ..Default::default() };
    set_progress(app, progress.clone());
    let agent = agent();
    let checksums = agent
        .get(&format!("{BASE}/checksums.sha256"))
        .call()
        .map_err(|e| format!("No se pudo consultar la última versión de FFmpeg: {e}"))?
        .into_string()
        .map_err(|e| e.to_string())?;
    let (asset, sha) = choose_asset(&checksums, FLAVOR).ok_or("No se encontró FFmpeg para Windows en la publicación")?;
    let mut state = read_state(data_dir);
    let have = installed(data_dir).is_some();
    if let (true, Some(st)) = (have, state.as_mut()) {
        st.last_check = now();
        let same_build = st.sha256 == sha;
        let same_version = st.asset == asset;
        let old = now().saturating_sub(st.installed_at) > REFRESH_SAME.as_secs();
        if same_build || (same_version && !old && !force) {
            write_state(data_dir, st);
            return Ok("FFmpeg ya está al día".into());
        }
    }
    // Descarga a memoria contando el progreso.
    progress.phase = "descargando".into();
    set_progress(app, progress.clone());
    let resp = agent
        .get(&format!("{BASE}/{asset}"))
        .call()
        .map_err(|e| format!("No se pudo descargar FFmpeg: {e}"))?;
    let total: u64 = resp.header("Content-Length").and_then(|v| v.parse().ok()).unwrap_or(0);
    let mut reader = resp.into_reader();
    // A disco mientras se descarga (son ~200 MB), calculando la firma a la vez.
    std::fs::create_dir_all(root(data_dir)).map_err(|e| e.to_string())?;
    let part = root(data_dir).join("download.part");
    let mut file = std::fs::File::create(&part).map_err(|e| format!("No se pudo guardar la descarga: {e}"))?;
    let mut hasher = Sha256::new();
    let mut got_bytes: u64 = 0;
    let mut buf = vec![0u8; 256 * 1024];
    let mut last = std::time::Instant::now();
    loop {
        let n = reader.read(&mut buf).map_err(|e| format!("Se cortó la descarga de FFmpeg: {e}"))?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
        std::io::Write::write_all(&mut file, &buf[..n]).map_err(|e| format!("No se pudo guardar la descarga: {e}"))?;
        got_bytes += n as u64;
        if total > 0 && last.elapsed() > Duration::from_millis(300) {
            last = std::time::Instant::now();
            progress.fraction = got_bytes as f64 / total as f64;
            set_progress(app, progress.clone());
        }
    }
    drop(file);
    progress.phase = "verificando".into();
    progress.fraction = 1.0;
    set_progress(app, progress.clone());
    if format!("{:x}", hasher.finalize()) != sha {
        let _ = std::fs::remove_file(&part);
        return Err("La descarga de FFmpeg no coincide con su firma SHA-256: se descarta".into());
    }
    progress.phase = "instalando".into();
    set_progress(app, progress.clone());
    let dir_name = format!("{}-{}", asset.trim_end_matches(".zip"), &sha[..8]);
    let dir = root(data_dir).join(&dir_name);
    let res = std::fs::File::open(&part).map_err(|e| e.to_string()).and_then(|f| extract_exe(f, &dir));
    let _ = std::fs::remove_file(&part);
    res?;
    let st = Installed { dir: dir_name, asset: asset.clone(), sha256: sha, installed_at: now(), last_check: now() };
    write_state(data_dir, &st);
    cleanup(data_dir);
    let ver = asset.trim_start_matches("ffmpeg-").split("-latest").next().unwrap_or("").to_string();
    Ok(if have { format!("FFmpeg actualizado ({ver})") } else { format!("FFmpeg instalado ({ver})") })
}

/// Saca bin/ffmpeg.exe del zip a `dir` (primero a un temporal y luego se renombra).
pub fn extract_exe<R: Read + std::io::Seek>(src: R, dir: &Path) -> Result<(), String> {
    let mut zip = zip::ZipArchive::new(src).map_err(|e| format!("Zip de FFmpeg dañado: {e}"))?;
    // Las compilaciones son de Windows: dentro siempre es bin/ffmpeg.exe.
    let want = "ffmpeg.exe";
    let index = (0..zip.len())
        .find(|&i| {
            zip.by_index(i)
                .map(|f| {
                    let n = f.name().replace('\\', "/");
                    n.ends_with(&format!("/bin/{want}")) || n == format!("bin/{want}")
                })
                .unwrap_or(false)
        })
        .ok_or("El zip no trae ffmpeg.exe")?;
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let tmp = dir.join("ffmpeg.part");
    {
        let mut f = zip.by_index(index).map_err(|e| e.to_string())?;
        let mut out = std::fs::File::create(&tmp).map_err(|e| e.to_string())?;
        std::io::copy(&mut f, &mut out).map_err(|e| format!("No se pudo escribir ffmpeg.exe: {e}"))?;
    }
    std::fs::rename(&tmp, dir.join(exe_name())).map_err(|e| e.to_string())?;
    Ok(())
}

/// Borra las versiones viejas (si alguna esta en uso, ya se borrara otro dia).
fn cleanup(data_dir: &Path) {
    let Some(st) = read_state(data_dir) else { return };
    let Ok(list) = std::fs::read_dir(root(data_dir)) else { return };
    for e in list.flatten() {
        let p = e.path();
        if p.is_dir() && e.file_name().to_string_lossy() != st.dir {
            let _ = std::fs::remove_dir_all(&p);
        }
    }
}

fn start(app: AppHandle, force: bool) -> bool {
    {
        let mut g = PROGRESS.lock().unwrap_or_else(|e| e.into_inner());
        if g.as_ref().map(|p| p.busy).unwrap_or(false) {
            return false;
        }
        *g = Some(Progress { busy: true, phase: "comprobando".into(), ..Default::default() });
    }
    std::thread::Builder::new()
        .name("miradio-ffmpeg-update".into())
        .spawn(move || {
            let Ok(data_dir) = app.path().app_data_dir() else { return };
            let res = run(&app, &data_dir, force);
            let p = match res {
                Ok(msg) => Progress { busy: false, phase: String::new(), fraction: 1.0, error: None, done: Some(msg) },
                Err(e) => Progress { busy: false, phase: String::new(), fraction: 0.0, error: Some(e), done: None },
            };
            set_progress(&app, p);
        })
        .is_ok()
}

/// Al arrancar: si no hay FFmpeg, se descarga; si es el de OmniCaster y hace una
/// semana que no se mira, se busca version nueva.
pub fn on_startup(app: AppHandle) {
    if !supported() {
        return;
    }
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(4));
        let Ok(data_dir) = app.path().app_data_dir() else { return };
        cleanup(&data_dir);
        if crate::streaming::find_ffmpeg(&app).is_none() {
            start(app, false);
            return;
        }
        if let (Some(_), Some(st)) = (installed(&data_dir), read_state(&data_dir)) {
            if now().saturating_sub(st.last_check) > CHECK_EVERY.as_secs() {
                start(app, false);
            }
        }
    });
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FfmpegInfo {
    /// Ruta del FFmpeg que se usa (vacio = ninguno)
    pub path: String,
    /// "manual" (puesto a mano), "auto" (de OmniCaster), "system" (PATH) o "none"
    pub source: String,
    /// Primera linea de `ffmpeg -version`
    pub version: String,
    pub managed: Option<Installed>,
    pub can_download: bool,
    pub progress: Option<Progress>,
}

#[tauri::command]
pub async fn ffmpeg_info(app: AppHandle) -> FfmpegInfo {
    tauri::async_runtime::spawn_blocking(move || {
        let data_dir = app.path().app_data_dir().unwrap_or_default();
        let found = crate::streaming::find_ffmpeg(&app);
        let managed_path = installed(&data_dir);
        let (path, source) = match &found {
            None => (String::new(), "none"),
            Some(p) if Some(p) == managed_path.as_ref() => (p.display().to_string(), "auto"),
            Some(p) if p.components().count() > 1 => (p.display().to_string(), "manual"),
            Some(p) => (p.display().to_string(), "system"),
        };
        let version = found.as_ref().and_then(|p| crate::streaming::ffmpeg_version(p).ok())
            .map(|v| v.split(" Copyright").next().unwrap_or("").trim().trim_start_matches("ffmpeg version ").to_string())
            .unwrap_or_default();
        FfmpegInfo {
            path,
            source: source.into(),
            version,
            managed: read_state(&data_dir).filter(|_| managed_path.is_some()),
            can_download: supported(),
            progress: PROGRESS.lock().ok().and_then(|g| g.clone()),
        }
    })
    .await
    .unwrap_or(FfmpegInfo { path: String::new(), source: "none".into(), version: String::new(), managed: None, can_download: supported(), progress: None })
}

/// Busca version nueva ahora (y la instala si la hay, o si no hay ninguna).
#[tauri::command]
pub fn ffmpeg_update(app: AppHandle) -> Result<(), String> {
    if !supported() {
        return Err("OmniCaster solo descarga FFmpeg en Windows; aquí usa el del sistema".into());
    }
    if start(app, true) {
        Ok(())
    } else {
        Err("Ya se está descargando FFmpeg".into())
    }
}

/// ¿Se esta descargando ahora? (para los mensajes de error de quien lo necesita)
pub fn downloading() -> bool {
    PROGRESS.lock().ok().and_then(|g| g.as_ref().map(|p| p.busy)).unwrap_or(false)
}

/// Mensaje para cuando falta FFmpeg.
pub fn missing_message() -> String {
    if downloading() {
        "FFmpeg se está descargando; en un momento estará listo (Ajustes > Copia y actualizaciones)".into()
    } else if supported() {
        "Falta FFmpeg: descárgalo en Ajustes > Copia y actualizaciones (o pon ffmpeg.exe junto a OmniCaster.exe)".into()
    } else {
        "No se encontró FFmpeg: instálalo en el sistema".into()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SUMS: &str = "\
1111111111111111111111111111111111111111111111111111111111111111  ffmpeg-master-latest-win64-gpl.zip
2222222222222222222222222222222222222222222222222222222222222222  ffmpeg-n9.0-latest-win64-gpl-9.0.zip
3333333333333333333333333333333333333333333333333333333333333333  ffmpeg-n9.0-latest-win64-gpl-shared-9.0.zip
4444444444444444444444444444444444444444444444444444444444444444  ffmpeg-n8.1-latest-win64-gpl-8.1.zip
5555555555555555555555555555555555555555555555555555555555555555  ffmpeg-n9.0-latest-win64-lgpl-9.0.zip
6666666666666666666666666666666666666666666666666666666666666666  ffmpeg-n10.1-latest-linux64-gpl-10.1.tar.xz
";

    #[test]
    fn picks_highest_stable_windows_gpl() {
        let (name, sha) = choose_asset(SUMS, "win64-gpl").unwrap();
        assert_eq!(name, "ffmpeg-n9.0-latest-win64-gpl-9.0.zip");
        assert!(sha.starts_with("2222"));
    }

    #[test]
    fn falls_back_to_master() {
        let only = SUMS.lines().next().unwrap();
        assert_eq!(choose_asset(only, "win64-gpl").unwrap().0, "ffmpeg-master-latest-win64-gpl.zip");
    }

    #[test]
    fn extracts_exe_from_zip() {
        use std::io::Write;
        let mut cur = std::io::Cursor::new(Vec::new());
        {
            let mut z = zip::ZipWriter::new(&mut cur);
            let opt = zip::write::SimpleFileOptions::default();
            z.start_file("ffmpeg-n9.0-win64-gpl-9.0/LICENSE.txt", opt).unwrap();
            z.write_all(b"GPL").unwrap();
            z.start_file("ffmpeg-n9.0-win64-gpl-9.0/bin/ffmpeg.exe", opt).unwrap();
            z.write_all(b"EXE").unwrap();
            z.finish().unwrap();
        }
        let dir = std::env::temp_dir().join(format!("miradio-ff-{}", now()));
        extract_exe(std::io::Cursor::new(cur.into_inner()), &dir).unwrap();
        assert_eq!(std::fs::read(dir.join(exe_name())).unwrap(), b"EXE");
        let _ = std::fs::remove_dir_all(dir);
    }

    /// Con el zip real (solo a mano): MIRADIO_FF_ZIP=ruta cargo test -- --ignored real_zip
    #[test]
    #[ignore]
    fn real_zip() {
        let path = std::env::var("MIRADIO_FF_ZIP").unwrap();
        let dir = std::env::temp_dir().join("miradio-ff-real");
        let _ = std::fs::remove_dir_all(&dir);
        extract_exe(std::fs::File::open(path).unwrap(), &dir).unwrap();
        let len = std::fs::metadata(dir.join(exe_name())).unwrap().len();
        assert!(len > 50_000_000, "{len}");
        let _ = std::fs::remove_dir_all(dir);
    }
}
