//! Red del equipo (quiosco Linux): IP automática o fija, puerta de enlace,
//! DNS, Wi-Fi y nombre del equipo. Lo hace el ayudante
//! /usr/local/bin/omnicaster-net (lo instala el instalador del quiosco), que
//! pide la contraseña de un administrador y deshace el cambio solo si no se
//! confirma a tiempo.

const HELPER: &str = "/usr/local/bin/omnicaster-net";

fn helper(args: &[&str], input: Option<&str>) -> Result<String, String> {
    use std::io::Write;
    use std::process::{Command, Stdio};
    if !std::path::Path::new(HELPER).exists() {
        return Err("Falta el ayudante de red. Vuelve a ejecutar el instalador del quiosco (wget -O q matiormx.github.io/q && sudo bash q).".into());
    }
    let mut child = Command::new("sudo")
        .arg("-n")
        .arg(HELPER)
        .args(args)
        .stdin(if input.is_some() { Stdio::piped() } else { Stdio::null() })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("no se pudo ejecutar el ayudante de red: {e}"))?;
    if let (Some(text), Some(mut stdin)) = (input, child.stdin.take()) {
        let _ = stdin.write_all(text.as_bytes());
    }
    let out = child.wait_with_output().map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    } else {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        Err(if err.is_empty() { "el ayudante de red ha fallado".into() } else { err })
    }
}

#[tauri::command]
pub async fn net_status() -> Result<serde_json::Value, String> {
    if !cfg!(target_os = "linux") {
        return Ok(serde_json::json!({ "supported": false }));
    }
    tauri::async_runtime::spawn_blocking(|| {
        let out = helper(&["status"], None)?;
        serde_json::from_str(&out).map_err(|e| format!("respuesta no válida del ayudante de red: {e}"))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Aplica la configuración; devuelve los segundos que hay para confirmarla.
#[tauri::command]
pub async fn net_apply(config: serde_json::Value, password: String) -> Result<u32, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let req = serde_json::json!({ "password": password, "config": config }).to_string();
        let out = helper(&["apply"], Some(&req))?;
        let v: serde_json::Value = serde_json::from_str(&out).unwrap_or_default();
        Ok(v["revertSecs"].as_u64().unwrap_or(120) as u32)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn net_confirm() -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(|| helper(&["confirm"], None).map(|_| ())).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn net_revert() -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(|| helper(&["revert"], None).map(|_| ())).await.map_err(|e| e.to_string())?
}

/// Conecta una carpeta compartida de otro ordenador (\\\\servidor\\carpeta) en
/// /mnt/red/<nombre>; queda puesta en cada arranque.
#[tauri::command]
pub async fn net_share_add(share: serde_json::Value, password: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let req = serde_json::json!({ "password": password, "share": share }).to_string();
        let out = helper(&["share-add"], Some(&req))?;
        let v: serde_json::Value = serde_json::from_str(&out).unwrap_or_default();
        Ok(v["path"].as_str().unwrap_or_default().to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn net_share_remove(name: String, password: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let req = serde_json::json!({ "password": password, "name": name }).to_string();
        helper(&["share-remove"], Some(&req)).map(|_| ())
    })
    .await
    .map_err(|e| e.to_string())?
}
