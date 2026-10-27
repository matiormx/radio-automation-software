//! Acceso remoto en Linux (equipo de quiosco): VNC para manejar OmniCaster
//! desde otro ordenador y WireGuard para llegar al equipo de forma segura.
//!
//! - VNC: x11vnc sobre la propia pantalla (lo arranca OmniCaster, como el
//!   usuario del quiosco; no hace falta ser root). La contraseña va en
//!   ~/.vnc/passwd.
//! - WireGuard: lo maneja el sistema (wg-quick@wg0). El instalador del
//!   quiosco deja un ayudante, /usr/local/bin/omnicaster-remote, que el
//!   usuario puede ejecutar con sudo sin contraseña solo para eso.

use serde::Serialize;

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct RemoteStatus {
    /// false fuera de Linux
    pub supported: bool,
    pub vnc_installed: bool,
    pub vnc_running: bool,
    pub vnc_password_set: bool,
    pub vnc_port: u16,
    /// Direcciones del equipo (LAN y WireGuard)
    pub addresses: Vec<String>,
    /// El ayudante de WireGuard está instalado (lo pone el instalador del quiosco)
    pub wg_helper: bool,
    pub wg_configured: bool,
    pub wg_up: bool,
    pub wg_address: String,
    pub wg_endpoint: String,
    /// Segundos desde el último contacto con el otro extremo (-1 = nunca)
    pub wg_handshake_secs: i64,
    /// Carpeta de música compartida por Samba (red de Windows)
    pub smb_installed: bool,
    pub smb_enabled: bool,
    pub smb_path: String,
    /// Nombre del recurso: \\IP\Musica
    pub smb_share: String,
    pub error: String,
}

#[cfg(target_os = "linux")]
mod imp {
    use super::RemoteStatus;
    use std::path::PathBuf;
    use std::process::{Child, Command, Stdio};
    use std::sync::{Mutex, OnceLock};

    pub const VNC_PORT: u16 = 5900;
    const HELPER: &str = "/usr/local/bin/omnicaster-remote";

    fn vnc_child() -> &'static Mutex<Option<Child>> {
        static C: OnceLock<Mutex<Option<Child>>> = OnceLock::new();
        C.get_or_init(|| Mutex::new(None))
    }

    fn which(bin: &str) -> bool {
        std::env::var_os("PATH")
            .map(|p| std::env::split_paths(&p).any(|d| d.join(bin).is_file()))
            .unwrap_or(false)
    }

    fn passwd_file() -> Option<PathBuf> {
        std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".vnc").join("passwd"))
    }

    fn helper(args: &[&str]) -> Result<String, String> {
        helper_input(args, None)
    }

    /// Igual, pasando un secreto por la entrada (no se ve en la lista de procesos).
    fn helper_input(args: &[&str], input: Option<&str>) -> Result<String, String> {
        use std::io::Write;
        let mut child = Command::new("sudo")
            .arg("-n")
            .arg(HELPER)
            .args(args)
            .stdin(if input.is_some() { Stdio::piped() } else { Stdio::null() })
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("no se pudo ejecutar el ayudante: {e}"))?;
        if let (Some(text), Some(mut stdin)) = (input, child.stdin.take()) {
            let _ = writeln!(stdin, "{text}");
        }
        let out = child.wait_with_output().map_err(|e| e.to_string())?;
        if out.status.success() {
            Ok(String::from_utf8_lossy(&out.stdout).into_owned())
        } else {
            let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
            Err(if err.is_empty() { "el ayudante de WireGuard ha fallado".into() } else { err })
        }
    }

    fn addresses() -> Vec<String> {
        Command::new("hostname")
            .arg("-I")
            .output()
            .map(|o| String::from_utf8_lossy(&o.stdout).split_whitespace().filter(|a| !a.contains(':')).map(String::from).collect())
            .unwrap_or_default()
    }

    /// IP del equipo en la red de WireGuard (sin la máscara).
    fn wg_ip() -> Option<String> {
        let out = Command::new("ip").args(["-4", "-o", "addr", "show", "dev", "wg0"]).output().ok()?;
        let text = String::from_utf8_lossy(&out.stdout);
        let cidr = text.split_whitespace().skip_while(|w| *w != "inet").nth(1)?;
        Some(cidr.split('/').next()?.to_string())
    }

    pub fn status() -> RemoteStatus {
        let mut s = RemoteStatus { supported: true, vnc_port: VNC_PORT, ..Default::default() };
        s.vnc_installed = which("x11vnc");
        s.vnc_password_set = passwd_file().map(|p| p.is_file()).unwrap_or(false);
        {
            let mut c = vnc_child().lock().unwrap_or_else(|e| e.into_inner());
            if let Some(ch) = c.as_mut() {
                if matches!(ch.try_wait(), Ok(Some(_))) {
                    *c = None;
                }
            }
            s.vnc_running = c.is_some();
        }
        s.addresses = addresses();
        s.wg_helper = std::path::Path::new(HELPER).is_file();
        s.smb_share = "Musica".into();
        if s.wg_helper {
            match helper(&["wg-status"]) {
                Ok(text) => {
                    for line in text.lines() {
                        let mut kv = line.splitn(2, '=');
                        let (k, v) = (kv.next().unwrap_or(""), kv.next().unwrap_or("").trim());
                        match k {
                            "configured" => s.wg_configured = v == "1",
                            "up" => s.wg_up = v == "1",
                            "endpoint" => s.wg_endpoint = v.to_string(),
                            "smb_installed" => s.smb_installed = v == "1",
                            "smb_enabled" => s.smb_enabled = v == "1",
                            "smb_path" => s.smb_path = v.to_string(),
                            "handshake" => {
                                let t: i64 = v.parse().unwrap_or(0);
                                let now = std::time::SystemTime::now()
                                    .duration_since(std::time::UNIX_EPOCH)
                                    .map(|d| d.as_secs() as i64)
                                    .unwrap_or(0);
                                s.wg_handshake_secs = if t > 0 { (now - t).max(0) } else { -1 };
                            }
                            _ => {}
                        }
                    }
                }
                Err(e) => s.error = e,
            }
            if s.wg_up {
                s.wg_address = wg_ip().unwrap_or_default();
            }
        }
        s
    }

    pub fn set_password(password: &str) -> Result<(), String> {
        if password.len() < 6 {
            return Err("La contraseña debe tener al menos 6 caracteres".into());
        }
        let file = passwd_file().ok_or("no se encuentra la carpeta del usuario")?;
        if let Some(dir) = file.parent() {
            std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        // VNC solo usa los 8 primeros caracteres.
        let st = Command::new("x11vnc")
            .args(["-storepasswd", password])
            .arg(&file)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map_err(|e| format!("x11vnc no está instalado: {e}"))?;
        if !st.success() {
            return Err("no se pudo guardar la contraseña".into());
        }
        Ok(())
    }

    pub fn stop_vnc() {
        let mut c = vnc_child().lock().unwrap_or_else(|e| e.into_inner());
        if let Some(mut ch) = c.take() {
            let _ = ch.kill();
            let _ = ch.wait();
        }
    }

    pub fn start_vnc(only_wg: bool) -> Result<(), String> {
        stop_vnc();
        let file = passwd_file().ok_or("no se encuentra la carpeta del usuario")?;
        if !file.is_file() {
            return Err("Pon primero una contraseña para VNC".into());
        }
        let display = std::env::var("DISPLAY").unwrap_or_else(|_| ":0".into());
        let mut cmd = Command::new("x11vnc");
        cmd.args(["-display", &display, "-rfbauth"])
            .arg(&file)
            .args(["-rfbport", &VNC_PORT.to_string(), "-forever", "-shared", "-noxdamage", "-quiet"]);
        if only_wg {
            let ip = wg_ip().ok_or("WireGuard no está conectado: no se puede limitar VNC a esa red")?;
            cmd.args(["-listen", &ip]);
        }
        let child = cmd
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| format!("no se pudo arrancar x11vnc: {e}"))?;
        *vnc_child().lock().unwrap_or_else(|e| e.into_inner()) = Some(child);
        Ok(())
    }

    pub fn smb(enabled: bool, path: &str, password: Option<&str>) -> Result<(), String> {
        if !enabled {
            return helper(&["smb-disable"]).map(|_| ());
        }
        if let Some(p) = password.filter(|p| !p.is_empty()) {
            if p.len() < 6 {
                return Err("La contraseña debe tener al menos 6 caracteres".into());
            }
            helper_input(&["smb-password"], Some(p))?;
        }
        std::fs::create_dir_all(path).map_err(|e| format!("{path}: {e}"))?;
        helper(&["smb-enable", path]).map(|_| ())
    }

    pub fn wg(action: &str, path: Option<&str>) -> Result<(), String> {
        match action {
            "import" => {
                let p = path.ok_or("falta el archivo")?;
                helper(&["wg-import", p]).map(|_| ())
            }
            "up" => helper(&["wg-up"]).map(|_| ()),
            "down" => helper(&["wg-down"]).map(|_| ()),
            "remove" => helper(&["wg-remove"]).map(|_| ()),
            _ => Err("acción desconocida".into()),
        }
    }
}

#[cfg(not(target_os = "linux"))]
const ONLY_LINUX: &str = "El acceso remoto se configura aquí solo en Linux (equipo de quiosco)";

#[tauri::command]
pub async fn remote_status() -> RemoteStatus {
    #[cfg(target_os = "linux")]
    {
        tauri::async_runtime::spawn_blocking(imp::status).await.unwrap_or_default()
    }
    #[cfg(not(target_os = "linux"))]
    {
        RemoteStatus::default()
    }
}

/// Activa o desactiva VNC (y, si llega, cambia la contraseña antes).
#[tauri::command]
pub async fn remote_vnc(enabled: bool, only_wg: bool, password: Option<String>) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        tauri::async_runtime::spawn_blocking(move || {
            if let Some(p) = password.as_deref().filter(|p| !p.is_empty()) {
                imp::set_password(p)?;
            }
            if enabled {
                imp::start_vnc(only_wg)
            } else {
                imp::stop_vnc();
                Ok(())
            }
        })
        .await
        .map_err(|e| e.to_string())?
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (enabled, only_wg, password);
        Err(ONLY_LINUX.into())
    }
}

/// Samba: comparte la carpeta de música en la red (\\IP\Musica). La
/// contraseña es la del usuario de Samba (solo hace falta la primera vez).
#[tauri::command]
pub async fn remote_smb(state: tauri::State<'_, crate::AppState>, enabled: bool, password: Option<String>) -> Result<(), String> {
    let music = crate::library::music_dir_of(&state.data_dir);
    #[cfg(target_os = "linux")]
    {
        let path = music.to_string_lossy().into_owned();
        tauri::async_runtime::spawn_blocking(move || imp::smb(enabled, &path, password.as_deref()))
            .await
            .map_err(|e| e.to_string())?
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (music, enabled, password);
        Err(ONLY_LINUX.into())
    }
}

/// WireGuard: "import" (con `path` a un .conf), "up", "down" o "remove".
#[tauri::command]
pub async fn remote_wg(action: String, path: Option<String>) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        tauri::async_runtime::spawn_blocking(move || imp::wg(&action, path.as_deref())).await.map_err(|e| e.to_string())?
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (action, path);
        Err(ONLY_LINUX.into())
    }
}

/// Al arrancar: si VNC estaba activado, se vuelve a encender.
pub fn on_startup(settings: &crate::settings::Settings) {
    #[cfg(target_os = "linux")]
    if settings.remote.vnc {
        let only_wg = settings.remote.vnc_only_wg;
        std::thread::spawn(move || {
            // Con «solo WireGuard», se espera a que el túnel tenga IP.
            for _ in 0..30 {
                if imp::start_vnc(only_wg).is_ok() {
                    return;
                }
                std::thread::sleep(std::time::Duration::from_secs(5));
            }
        });
    }
    #[cfg(not(target_os = "linux"))]
    let _ = settings;
}

/// Al cerrar: VNC se apaga con OmniCaster.
pub fn shutdown() {
    #[cfg(target_os = "linux")]
    imp::stop_vnc();
}
