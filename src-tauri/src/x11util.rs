//! Ayudas de X11 (Linux): buscar una ventana por su titulo (para capturarla
//! con x11grab) y mantener el raton dentro de un rectangulo (pared).
//! La libreria de X se carga al vuelo: sin servidor X simplemente no hace nada.

use std::ffi::{CStr, CString};
use std::sync::OnceLock;

use x11_dl::xlib;

fn lib() -> Option<&'static xlib::Xlib> {
    static LIB: OnceLock<Option<xlib::Xlib>> = OnceLock::new();
    LIB.get_or_init(|| xlib::Xlib::open().ok()).as_ref()
}

struct Display {
    x: &'static xlib::Xlib,
    d: *mut xlib::Display,
}

impl Display {
    fn open() -> Option<Display> {
        let x = lib()?;
        let name = std::env::var("DISPLAY").ok().and_then(|v| CString::new(v).ok());
        let d = unsafe { (x.XOpenDisplay)(name.as_ref().map(|c| c.as_ptr()).unwrap_or(std::ptr::null())) };
        (!d.is_null()).then_some(Display { x, d })
    }
}

impl Drop for Display {
    fn drop(&mut self) {
        unsafe { (self.x.XCloseDisplay)(self.d) };
    }
}

fn name_of(dp: &Display, w: xlib::Window) -> Option<String> {
    let mut raw: *mut std::os::raw::c_char = std::ptr::null_mut();
    unsafe {
        if (dp.x.XFetchName)(dp.d, w, &mut raw) != 0 && !raw.is_null() {
            let s = CStr::from_ptr(raw).to_string_lossy().into_owned();
            (dp.x.XFree)(raw as *mut _);
            return Some(s);
        }
    }
    None
}

fn search(dp: &Display, w: xlib::Window, title: &str, depth: u32) -> Option<xlib::Window> {
    if name_of(dp, w).as_deref() == Some(title) {
        return Some(w);
    }
    if depth > 6 {
        return None;
    }
    let (mut root, mut parent) = (0, 0);
    let mut children: *mut xlib::Window = std::ptr::null_mut();
    let mut n = 0u32;
    unsafe {
        if (dp.x.XQueryTree)(dp.d, w, &mut root, &mut parent, &mut children, &mut n) == 0 {
            return None;
        }
    }
    let list: Vec<xlib::Window> = if children.is_null() { Vec::new() } else { unsafe { std::slice::from_raw_parts(children, n as usize).to_vec() } };
    if !children.is_null() {
        unsafe { (dp.x.XFree)(children as *mut _) };
    }
    list.into_iter().rev().find_map(|c| search(dp, c, title, depth + 1))
}

/// Id de la ventana con ese titulo exacto (la mas alta si hay varias).
pub fn find_window(title: &str) -> Option<u64> {
    let dp = Display::open()?;
    let root = unsafe { (dp.x.XDefaultRootWindow)(dp.d) };
    search(&dp, root, title, 0).map(|w| w as u64)
}

/// Pared del raton: si sale de `rect` (izq, arriba, der, abajo) se le
/// devuelve al borde. Ctrl+Mayus la abren. Se llama a menudo desde un hilo.
pub struct Wall {
    dp: Display,
}

impl Wall {
    pub fn new() -> Option<Wall> {
        Display::open().map(|dp| Wall { dp })
    }

    pub fn keep_inside(&self, r: [i32; 4]) {
        let x = self.dp.x;
        let d = self.dp.d;
        unsafe {
            let root = (x.XDefaultRootWindow)(d);
            let (mut rr, mut child) = (0, 0);
            let (mut px, mut py, mut wx, mut wy) = (0, 0, 0, 0);
            let mut mask = 0u32;
            if (x.XQueryPointer)(d, root, &mut rr, &mut child, &mut px, &mut py, &mut wx, &mut wy, &mut mask) == 0 {
                return;
            }
            // Ctrl + Mayus pulsadas: se puede cruzar.
            if mask & xlib::ControlMask != 0 && mask & xlib::ShiftMask != 0 {
                return;
            }
            let nx = px.clamp(r[0], r[2] - 1);
            let ny = py.clamp(r[1], r[3] - 1);
            if nx != px || ny != py {
                (x.XWarpPointer)(d, 0, root, 0, 0, 0, 0, nx, ny);
                (x.XFlush)(d);
            }
        }
    }
}

// El Display solo lo usa el hilo de la pared.
unsafe impl Send for Wall {}

#[cfg(test)]
mod tests {
    /// Con la app abierta en un X (DISPLAY): cargo test -- --ignored finds_window
    #[test]
    #[ignore]
    fn finds_window() {
        let id = super::find_window("OmniCaster Lo que suena");
        eprintln!("ventana: {id:?}");
        assert!(id.is_some());
    }

    /// Con un X (DISPLAY): cargo test -- --ignored wall_pulls_back
    #[test]
    #[ignore]
    fn wall_pulls_back() {
        let w = super::Wall::new().unwrap();
        let x = &w.dp;
        unsafe {
            let root = (x.x.XDefaultRootWindow)(x.d);
            (x.x.XWarpPointer)(x.d, 0, root, 0, 0, 0, 0, 1200, 500);
            (x.x.XFlush)(x.d);
        }
        w.keep_inside([0, 0, 800, 1000]);
        let out = std::process::Command::new("xdotool").arg("getmouselocation").output().unwrap();
        let s = String::from_utf8_lossy(&out.stdout).to_string();
        eprintln!("{s}");
        assert!(s.starts_with("x:799 "), "{s}");
    }
}
