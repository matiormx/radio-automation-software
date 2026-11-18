//! Ventana principal maximizada: si Windows la lanza así (acceso directo en
//! «Ejecutar: Maximizada») o si se cerró maximizada, se abre maximizada.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU8, Ordering};

use tauri::{Manager, Runtime, WebviewWindow};

const FILE: &str = "ventana.json";
/// 0 = no se sabe, 1 = normal, 2 = maximizada (lo último guardado)
static LAST: AtomicU8 = AtomicU8::new(0);

fn path(dir: &Path) -> PathBuf {
    dir.join(FILE)
}

/// ¿El acceso directo pide abrirla maximizada?
#[cfg(windows)]
fn launched_maximized() -> bool {
    use windows_sys::Win32::System::Threading::{GetStartupInfoW, STARTF_USESHOWWINDOW, STARTUPINFOW};
    unsafe {
        let mut si: STARTUPINFOW = std::mem::zeroed();
        si.cb = std::mem::size_of::<STARTUPINFOW>() as u32;
        GetStartupInfoW(&mut si);
        // SW_SHOWMAXIMIZED = 3
        si.dwFlags & STARTF_USESHOWWINDOW != 0 && si.wShowWindow == 3
    }
}
#[cfg(not(windows))]
fn launched_maximized() -> bool {
    false
}

fn saved_maximized(dir: &Path) -> bool {
    std::fs::read_to_string(path(dir))
        .ok()
        .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok())
        .and_then(|v| v.get("maximized").and_then(|x| x.as_bool()))
        .unwrap_or(false)
}

/// Al arrancar: maximizar si toca.
pub fn on_startup<R: Runtime>(w: &WebviewWindow<R>, dir: &Path) {
    let saved = saved_maximized(dir);
    LAST.store(if saved { 2 } else { 1 }, Ordering::Relaxed);
    if launched_maximized() || saved {
        let _ = w.maximize();
    }
}

/// Al cambiar de tamaño: se recuerda si quedó maximizada (para la próxima vez).
pub fn on_resized<R: Runtime>(w: &tauri::Window<R>) {
    let Ok(max) = w.is_maximized() else { return };
    let now = if max { 2 } else { 1 };
    if LAST.swap(now, Ordering::Relaxed) == now {
        return;
    }
    // Minimizada no cuenta (en la barra de tareas): se queda lo anterior.
    if w.is_minimized().unwrap_or(false) {
        return;
    }
    if let Some(state) = w.app_handle().try_state::<crate::AppState>() {
        let _ = std::fs::write(path(&state.data_dir), format!("{{\"maximized\":{max}}}"));
    }
}
