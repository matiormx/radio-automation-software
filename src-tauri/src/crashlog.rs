//! Registro de cierres inesperados.
//!
//! La versión publicada aborta ante cualquier error interno (panic = abort),
//! así que sin esto un cierre no deja rastro. Aquí:
//! - Los errores internos se apuntan en `errores.log` (carpeta de datos).
//! - Antes de cada operación delicada con un plugin se deja una «miga»
//!   (qué plugin y qué se estaba haciendo). Si el programa muere dentro de
//!   la operación (un plugin que revienta no avisa), la miga sigue ahí al
//!   arrancar otra vez y se avisa de qué plugin fue.

use std::io::Write;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

static DIR: OnceLock<PathBuf> = OnceLock::new();
static LAST: Mutex<Option<String>> = Mutex::new(None);

const CRUMB: &str = "actividad-plugins.txt";
const PANIC_NOTE: &str = "ultimo-error.txt";
const LOG: &str = "errores.log";

fn now() -> String {
    let secs = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    // Fecha UTC sin dependencias extra
    let (d, s) = (secs / 86_400, secs % 86_400);
    let (mut y, mut days) = (1970i64, d as i64);
    loop {
        let len = if (y % 4 == 0 && y % 100 != 0) || y % 400 == 0 { 366 } else { 365 };
        if days < len {
            break;
        }
        days -= len;
        y += 1;
    }
    let leap = (y % 4 == 0 && y % 100 != 0) || y % 400 == 0;
    let months = [31, if leap { 29 } else { 28 }, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    let mut m = 0;
    while days >= months[m] {
        days -= months[m];
        m += 1;
    }
    format!("{y}-{:02}-{:02} {:02}:{:02}:{:02} UTC", m + 1, days + 1, s / 3600, s % 3600 / 60, s % 60)
}

fn append_log(dir: &std::path::Path, text: &str) {
    let path = dir.join(LOG);
    // Que no crezca sin fin
    if std::fs::metadata(&path).map(|m| m.len() > 512 * 1024).unwrap_or(false) {
        let _ = std::fs::rename(&path, dir.join("errores.old.log"));
    }
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(f, "[{}] {text}", now());
    }
}

/// Al arrancar: mira si la vez anterior terminó mal y prepara el registro.
pub fn init(data_dir: PathBuf) {
    let _ = std::fs::create_dir_all(&data_dir);
    let mut last = None;
    // Un error interno apuntado por el gancho de abajo
    if let Ok(t) = std::fs::read_to_string(data_dir.join(PANIC_NOTE)) {
        if !t.trim().is_empty() {
            last = Some(format!("OmniCaster se cerró la última vez por un error interno: {}", t.trim()));
        }
        let _ = std::fs::remove_file(data_dir.join(PANIC_NOTE));
    }
    // Una operación con un plugin que no llegó a terminar
    if let Ok(t) = std::fs::read_to_string(data_dir.join(CRUMB)) {
        let t = t.trim();
        if !t.is_empty() {
            append_log(&data_dir, &format!("Cierre inesperado mientras se estaba {t}"));
            if last.is_none() {
                last = Some(format!(
                    "OmniCaster se cerró la última vez mientras se estaba {t}. Si vuelve a pasar, ese plugin no es estable en este equipo: quítalo o cámbialo por otro."
                ));
            }
        }
        let _ = std::fs::remove_file(data_dir.join(CRUMB));
    }
    if let Ok(mut g) = LAST.lock() {
        *g = last;
    }
    let _ = DIR.set(data_dir.clone());

    let prev = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let thread = std::thread::current().name().unwrap_or("sin nombre").to_string();
        let msg = info
            .payload()
            .downcast_ref::<&str>()
            .map(|s| s.to_string())
            .or_else(|| info.payload().downcast_ref::<String>().cloned())
            .unwrap_or_else(|| "(sin mensaje)".into());
        let at = info.location().map(|l| format!("{}:{}", l.file(), l.line())).unwrap_or_default();
        let crumb = std::fs::read_to_string(data_dir.join(CRUMB)).unwrap_or_default();
        let text = format!(
            "hilo «{thread}»: {msg} ({at}){}",
            if crumb.trim().is_empty() { String::new() } else { format!(" — se estaba {}", crumb.trim()) }
        );
        append_log(&data_dir, &format!("ERROR {text}"));
        let _ = std::fs::write(data_dir.join(PANIC_NOTE), &text);
        prev(info);
    }));
}

/// Apunta qué se está haciendo («abriendo la ventana de «X»»…); None al terminar.
pub fn crumb(what: Option<&str>) {
    let Some(dir) = DIR.get() else { return };
    match what {
        Some(t) => {
            let _ = std::fs::write(dir.join(CRUMB), t);
        }
        None => {
            let _ = std::fs::remove_file(dir.join(CRUMB));
        }
    }
}

/// Aviso del cierre anterior (una sola vez).
#[tauri::command]
pub fn last_crash() -> Option<String> {
    LAST.lock().ok().and_then(|mut g| g.take())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn leftover_crumb_becomes_notice() {
        let dir = std::env::temp_dir().join(format!("oc-crash-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(CRUMB), "abriendo la ventana de el plugin «Compresor» (/x.vst3)").unwrap();
        init(dir.clone());
        let n = last_crash().unwrap();
        assert!(n.contains("Compresor"), "{n}");
        assert!(last_crash().is_none(), "solo una vez");
        assert!(!dir.join(CRUMB).exists());
        let log = std::fs::read_to_string(dir.join(LOG)).unwrap();
        assert!(log.contains("Cierre inesperado") && log.contains(" UTC]"), "{log}");
        crumb(Some("cargando algo"));
        assert!(dir.join(CRUMB).exists());
        crumb(None);
        assert!(!dir.join(CRUMB).exists());
        let _ = std::fs::remove_dir_all(dir);
    }
}
