use std::process::Command;

use tauri::{AppHandle, Manager};

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Version de la aplicacion (la de este binario).
///
/// La busqueda e instalacion de actualizaciones las hace el plugin oficial
/// (`tauri-plugin-updater`), que descarga el paquete, comprueba su firma con
/// la clave publica de `tauri.conf.json` y lanza el instalador.
#[tauri::command]
pub fn app_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

/// Rastro de las actualizaciones (data/update-trace.log, max 40 lineas): si el
/// instalador muere a medias, al reabrir se sabe donde quedo.
fn trace_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    Ok(dir.join("update-trace.log"))
}

#[tauri::command]
pub fn update_log(app: AppHandle, line: String) -> Result<(), String> {
    use std::io::Write;
    let path = trace_path(&app)?;
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let mut lines: Vec<String> = std::fs::read_to_string(&path)
        .unwrap_or_default()
        .lines()
        .map(str::to_string)
        .collect();
    lines.push(format!("[{secs}] {}", line.chars().take(300).collect::<String>()));
    while lines.len() > 40 {
        lines.remove(0);
    }
    let mut f = std::fs::File::create(&path).map_err(|e| e.to_string())?;
    f.write_all(lines.join("\n").as_bytes()).map_err(|e| e.to_string())?;
    Ok(())
}

/// Ultima linea del rastro (null si no hay).
#[tauri::command]
pub fn update_trace_last(app: AppHandle) -> Result<Option<String>, String> {
    let path = trace_path(&app)?;
    Ok(std::fs::read_to_string(&path)
        .ok()
        .and_then(|c| c.lines().last().map(|l| l.to_string()))
        .filter(|l| !l.is_empty()))
}

/// Abre un enlace en el navegador (pagina de la release, avisos, etc).
#[tauri::command]
pub fn open_url(url: String) -> Result<(), String> {
    let url = url.trim().to_string();
    if !url.starts_with("https://") {
        return Err("Solo se admiten enlaces https".to_string());
    }
    if url.chars().any(|c| c.is_control()) {
        return Err("El enlace no es válido".to_string());
    }
    let mut command = if cfg!(windows) {
        let mut c = Command::new("rundll32");
        c.arg("url.dll,FileProtocolHandler");
        c.arg(&url);
        c
    } else if cfg!(target_os = "macos") {
        let mut c = Command::new("open");
        c.arg(&url);
        c
    } else {
        let mut c = Command::new("xdg-open");
        c.arg(&url);
        c
    };
    configure_no_window(&mut command);
    command
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("No se pudo abrir el enlace: {e}"))
}

#[cfg(windows)]
fn configure_no_window(command: &mut Command) {
    use std::os::windows::process::CommandExt;
    command.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(windows))]
fn configure_no_window(_command: &mut Command) {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn la_version_coincide_con_el_paquete() {
        assert_eq!(app_version(), env!("CARGO_PKG_VERSION"));
    }

    #[test]
    fn open_url_rechaza_enlaces_que_no_son_https() {
        assert!(open_url("http://github.com/x".to_string()).is_err());
        assert!(open_url("file:///C:/Windows/System32/calc.exe".to_string()).is_err());
        assert!(open_url("https://github.com/x\ny".to_string()).is_err());
    }
}
