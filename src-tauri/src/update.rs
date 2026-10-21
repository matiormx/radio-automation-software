use serde::Serialize;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInstall {
    /// Ruta del instalador descargado
    pub path: String,
    /// Si el instalador se ha puesto en marcha
    pub launched: bool,
    /// Tamano del archivo descargado, en bytes
    pub bytes: u64,
}

/// Version de la aplicacion (la de este binario).
#[tauri::command]
pub fn app_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

/// Descarga el instalador de una version nueva y lo ejecuta.
/// Solo se admiten enlaces https publicados en GitHub.
#[tauri::command]
pub fn install_update(url: String, version: String) -> Result<UpdateInstall, String> {
    let url = check_download_url(&url)?;
    let file_name = format!("MiRadio-{}-setup.exe", safe_version(&version));
    let path: PathBuf = std::env::temp_dir().join(file_name);

    let bytes = download_file(&url, &path)?;
    if bytes < 512_000 {
        let _ = std::fs::remove_file(&path);
        return Err("La descarga parece incompleta; no se instala nada".to_string());
    }

    let launch = format!("Start-Process -FilePath '{path}'", path = ps_quote(&path.to_string_lossy()));
    run_powershell(&launch)?;

    Ok(UpdateInstall {
        path: path.to_string_lossy().to_string(),
        launched: true,
        bytes,
    })
}

/// Descarga el archivo a la ruta que elija el usuario, sin ejecutarlo.
/// Aqui si se admiten cualquier enlaces https: descargar no es ejecutar.
#[tauri::command]
pub fn download_update(url: String, dest: String) -> Result<String, String> {
    let url = url.trim();
    if !url.starts_with("https://") {
        return Err("Solo se admiten enlaces https".to_string());
    }
    if url.chars().any(|c| c.is_control()) {
        return Err("El enlace no es válido".to_string());
    }
    let dest = dest.trim();
    if dest.is_empty() {
        return Err("No se ha elegido dónde guardar el archivo".to_string());
    }
    let target = PathBuf::from(dest);
    if target.is_dir() {
        return Err("Esa ruta es una carpeta, no un archivo".to_string());
    }
    if let Some(dir) = target.parent() {
        if !dir.as_os_str().is_empty() && !dir.is_dir() {
            return Err(format!("La carpeta no existe: {}", dir.display()));
        }
    }
    download_file(url, &target)?;
    Ok(target.display().to_string())
}

/// Descarga una url a una ruta concreta y devuelve el tamaño.
fn download_file(url: &str, target: &Path) -> Result<u64, String> {
    let script = format!(
        "$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; \
         Invoke-WebRequest -Uri '{url}' -OutFile '{dest}' -UseBasicParsing;",
        url = ps_quote(url),
        dest = ps_quote(&target.to_string_lossy()),
    );
    run_powershell(&script)?;
    let meta = std::fs::metadata(target).map_err(|e| format!("No se pudo leer la descarga: {e}"))?;
    if meta.len() < 1024 {
        let _ = std::fs::remove_file(target);
        return Err("La descarga está vacía o incompleta".to_string());
    }
    Ok(meta.len())
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

fn run_powershell(script: &str) -> Result<String, String> {
    if !cfg!(windows) {
        return Err("La instalación automática solo está disponible en Windows".to_string());
    }
    let mut command = Command::new("powershell");
    command.args([
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        script,
    ]);
    command.stdout(Stdio::piped()).stderr(Stdio::piped());
    configure_no_window(&mut command);
    let output = command
        .output()
        .map_err(|e| format!("No se pudo ejecutar PowerShell: {e}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let message = stderr
            .lines()
            .map(|line| line.trim())
            .find(|line| !line.is_empty())
            .unwrap_or("Falló la actualización")
            .to_string();
        return Err(message);
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

/// Solo se ejecutan instaladores descargados de los servidores de GitHub.
fn check_download_url(url: &str) -> Result<String, String> {
    let url = url.trim();
    if url.chars().any(|c| c.is_control()) {
        return Err("El enlace no es válido".to_string());
    }
    let Some(rest) = url.strip_prefix("https://") else {
        return Err("Por seguridad solo se instalan enlaces https".to_string());
    };
    let host = rest
        .split(['/', '?', '#'])
        .next()
        .unwrap_or("")
        .rsplit('@')
        .next()
        .unwrap_or("");
    let host = host.split(':').next().unwrap_or(host).to_ascii_lowercase();
    let allowed = host == "github.com"
        || host == "objects.githubusercontent.com"
        || host == "release-assets.githubusercontent.com"
        || host.ends_with(".githubusercontent.com");
    if !allowed {
        return Err(
            "Por seguridad solo se instalan actualizaciones publicadas en GitHub. \
             Puedes abrir la página de la descarga a mano."
                .to_string(),
        );
    }
    Ok(url.to_string())
}

/// Deja la version en un formato seguro para nombres de archivo.
fn safe_version(version: &str) -> String {
    let clean: String = version
        .trim()
        .trim_start_matches('v')
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '.' || *c == '-')
        .collect();
    let clean = clean.replace("..", ".");
    if clean.is_empty() {
        "nueva".to_string()
    } else {
        clean
    }
}

/// Escapa una cadena para meterla en comillas simples de PowerShell.
fn ps_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
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
    fn solo_se_aceptan_los_servidores_de_github() {
        assert!(check_download_url("https://github.com/matiormx/app/releases/download/v1/instalador.exe").is_ok());
        assert!(check_download_url("https://objects.githubusercontent.com/x").is_ok());
        assert!(check_download_url("https://release-assets.githubusercontent.com/x").is_ok());
        assert!(check_download_url("http://github.com/x").is_err());
        assert!(check_download_url("https://descargas.ejemplo.com/instalador.exe").is_err());
        assert!(check_download_url("https://github.com.evil.com/x").is_err());
    }

    #[test]
    fn la_version_limpia_sirve_para_el_nombre_del_archivo() {
        assert_eq!(safe_version("v0.5.1"), "0.5.1");
        assert_eq!(safe_version("0.5.1-beta"), "0.5.1-beta");
        assert_eq!(safe_version(""), "nueva");
        assert_eq!(safe_version("../raro"), ".raro");
        assert!(!safe_version("../../etc/passwd").contains('/'));
    }

    #[test]
    fn las_comillas_de_powershell_quedan_escapadas() {
        assert_eq!(ps_quote("C:\\Users\\a'b\\MiRadio.exe"), "'C:\\Users\\a''b\\MiRadio.exe'");
    }
}
