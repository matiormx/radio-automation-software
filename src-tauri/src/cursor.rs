//! «Pared» del ratón: lo mantiene dentro de un monitor (el de MiRadio) para
//! no perderlo en la pantalla de emisión. Windows: ClipCursor; Linux (X11):
//! se vigila el puntero y se devuelve al monitor.
//!
//! Mientras se mantienen pulsadas Ctrl y Mayús la pared se abre, para poder
//! pasar al otro monitor cuando haga falta. Se suelta al desactivarla y al
//! cerrar la aplicación.

use std::sync::Mutex;

static WALL: Mutex<Option<[i32; 4]>> = Mutex::new(None);

#[cfg(windows)]
mod sys {
    #[repr(C)]
    pub struct Rect {
        pub left: i32,
        pub top: i32,
        pub right: i32,
        pub bottom: i32,
    }
    #[link(name = "user32")]
    extern "system" {
        pub fn ClipCursor(rect: *const Rect) -> i32;
        pub fn GetAsyncKeyState(vkey: i32) -> i16;
    }
}

#[cfg(windows)]
fn apply(rect: Option<[i32; 4]>) {
    let open = unsafe { sys::GetAsyncKeyState(0x11) < 0 && sys::GetAsyncKeyState(0x10) < 0 };
    match rect {
        Some(r) if !open => {
            let rc = sys::Rect { left: r[0], top: r[1], right: r[2], bottom: r[3] };
            unsafe { sys::ClipCursor(&rc) };
        }
        _ => unsafe {
            sys::ClipCursor(std::ptr::null());
        },
    }
}

#[cfg(not(windows))]
fn apply(_rect: Option<[i32; 4]>) {}

/// Linux (X11): no hay ClipCursor; se vigila el raton y se le devuelve al
/// monitor si sale (cada 8 ms, imperceptible).
#[cfg(target_os = "linux")]
fn ensure_thread() {
    use std::sync::Once;
    static ONCE: Once = Once::new();
    ONCE.call_once(|| {
        let _ = std::thread::Builder::new().name("miradio-cursor-wall".into()).spawn(|| {
            let mut wall: Option<crate::x11util::Wall> = None;
            loop {
                let rect = *WALL.lock().unwrap_or_else(|e| e.into_inner());
                match rect {
                    Some(r) => {
                        if wall.is_none() {
                            wall = crate::x11util::Wall::new();
                        }
                        if let Some(w) = &wall {
                            w.keep_inside(r);
                        }
                        std::thread::sleep(std::time::Duration::from_millis(8));
                    }
                    None => {
                        wall = None;
                        std::thread::sleep(std::time::Duration::from_millis(200));
                    }
                }
            }
        });
    });
}

#[cfg(not(target_os = "linux"))]
fn ensure_thread() {
    use std::sync::Once;
    static ONCE: Once = Once::new();
    ONCE.call_once(|| {
        let _ = std::thread::Builder::new().name("miradio-cursor-wall".into()).spawn(|| loop {
            let rect = *WALL.lock().unwrap_or_else(|e| e.into_inner());
            if rect.is_some() {
                // Windows suelta la pared al cambiar de aplicacion o bloquear: se renueva.
                apply(rect);
            }
            std::thread::sleep(std::time::Duration::from_millis(150));
        });
    });
}

/// Rectangulo en pixeles fisicos de pantalla (izq, arriba, der, abajo); `None` la quita.
#[tauri::command]
pub fn cursor_wall(rect: Option<[i32; 4]>) {
    ensure_thread();
    *WALL.lock().unwrap_or_else(|e| e.into_inner()) = rect;
    apply(None);
    if rect.is_some() {
        apply(rect);
    }
}

/// Al cerrar la aplicacion el raton queda libre.
pub fn release() {
    *WALL.lock().unwrap_or_else(|e| e.into_inner()) = None;
    apply(None);
}
