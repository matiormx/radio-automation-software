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

fn trace(app: &AppHandle, line: &str) {
    let _ = update_log(app.clone(), line.to_string());
}

/// Descarga, comprueba e instala la versión nueva.
///
/// En Windows no se usa la instalación del plugin: lanzaba el instalador y
/// luego cerraba OmniCaster con un cierre «normal», que espera a que los
/// plugins (WaveShell…) y las tarjetas suelten sus recursos. Mientras tanto
/// el instalador no podía cerrarlo («Failed to kill») o abría la versión
/// nueva y esta, al ver la vieja todavía viva, le cedía el paso y se cerraba:
/// al final no quedaba ninguna abierta. Aquí se lanza el instalador y el
/// proceso termina al instante.
#[tauri::command]
pub async fn update_install_now(app: AppHandle) -> Result<(), String> {
    use tauri::Emitter;
    use tauri_plugin_updater::UpdaterExt;
    let update = app
        .updater()
        .map_err(|e| e.to_string())?
        .check()
        .await
        .map_err(|e| format!("No se pudo buscar la actualización: {e}"))?
        .ok_or_else(|| "No hay ninguna versión nueva".to_string())?;
    let version = update.version.clone();
    trace(&app, &format!("intento: {} → {version}", env!("CARGO_PKG_VERSION")));
    let progress = app.clone();
    let mut done: u64 = 0;
    let bytes = update
        .download(
            move |chunk, total| {
                done += chunk as u64;
                let _ = progress.emit("update://progress", (done, total));
            },
            || {},
        )
        .await
        .map_err(|e| format!("No se pudo descargar la actualización: {e}"))?;
    // La firma ya se comprobó al descargar; por si acaso, otra vez.
    update.verify(&bytes).map_err(|e| format!("La firma de la actualización no es válida: {e}"))?;
    trace(&app, &format!("descarga completa y firma correcta ({version})"));

    #[cfg(windows)]
    {
        let path = std::env::temp_dir().join(format!("OmniCaster_{version}_x64-setup.exe"));
        std::fs::write(&path, &bytes).map_err(|e| format!("No se pudo guardar el instalador: {e}"))?;
        let app2 = app.clone();
        let _ = tauri::async_runtime::spawn_blocking(move || crate::prepare_shutdown(&app2)).await;
        // /P sin preguntas · /UPDATE actualización · /R abrir OmniCaster al terminar
        win::shell_execute(&path, "/P /UPDATE /R").map_err(|e| {
            trace(&app, &format!("instalacion fallida: {e}"));
            format!("No se pudo arrancar el instalador: {e}")
        })?;
        // «OK» al final: al arrancar, App.tsx avisa solo si falta
        trace(&app, &format!("instalador lanzado; OmniCaster se cierra ya OK {version}"));
        win::terminate_now();
    }
    #[cfg(not(windows))]
    {
        let app2 = app.clone();
        let _ = tauri::async_runtime::spawn_blocking(move || crate::prepare_shutdown(&app2)).await;
        update.install(bytes).map_err(|e| {
            trace(&app, &format!("instalacion fallida: {e}"));
            format!("La instalación falló: {e}")
        })?;
        trace(&app, &format!("instalada; reiniciando OK {version}"));
        app.restart()
    }
}

#[cfg(windows)]
mod win {
    use std::os::windows::ffi::OsStrExt;

    #[link(name = "shell32")]
    extern "system" {
        fn ShellExecuteW(hwnd: isize, op: *const u16, file: *const u16, params: *const u16, dir: *const u16, show: i32) -> isize;
    }
    #[link(name = "kernel32")]
    extern "system" {
        fn GetCurrentProcess() -> isize;
        fn TerminateProcess(process: isize, code: u32) -> i32;
    }

    fn wide(s: &std::ffi::OsStr) -> Vec<u16> {
        s.encode_wide().chain(std::iter::once(0)).collect()
    }

    /// Como hace el plugin: ShellExecute (si el instalador pide permisos de
    /// administrador, Windows los pregunta).
    pub fn shell_execute(file: &std::path::Path, params: &str) -> Result<(), String> {
        let op = wide(std::ffi::OsStr::new("open"));
        let f = wide(file.as_os_str());
        let p = wide(std::ffi::OsStr::new(params));
        let r = unsafe { ShellExecuteW(0, op.as_ptr(), f.as_ptr(), p.as_ptr(), std::ptr::null(), 1) };
        if r <= 32 {
            Err(format!("código {r}"))
        } else {
            Ok(())
        }
    }

    /// Termina OmniCaster ya, sin el cierre ordenado (que es lo que se colgaba).
    pub fn terminate_now() -> ! {
        unsafe {
            TerminateProcess(GetCurrentProcess(), 0);
        }
        std::process::exit(0)
    }
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
