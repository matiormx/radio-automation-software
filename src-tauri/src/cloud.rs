//! Unión a un maestro en la nube (omnicaster-cloud).
//!
//! El archivo de alta (.omnicaster) que da el panel del maestro se guarda en
//! `<datos>/maestro.json`. Su token es la llave de este equipo: no va en los
//! ajustes (que se exportan en las copias de seguridad), va aparte.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::AppState;

const FILE: &str = "maestro.json";

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Named {
    pub id: String,
    pub name: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub role: String,
}

/// Archivo de alta tal como lo da el maestro.
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct JoinFile {
    pub omnicaster: String,
    pub v: u32,
    pub api: String,
    pub station: Named,
    pub node: Named,
    pub token: String,
}

fn path(data_dir: &Path) -> PathBuf {
    data_dir.join(FILE)
}

fn read(data_dir: &Path) -> Option<JoinFile> {
    let text = std::fs::read_to_string(path(data_dir)).ok()?;
    serde_json::from_str(&text).ok()
}

/// Comprueba que es un archivo de alta válido.
pub fn parse_join(text: &str) -> Result<JoinFile, String> {
    let j: JoinFile = serde_json::from_str(text.trim_start_matches('\u{feff}'))
        .map_err(|_| "No es un archivo de alta de OmniCaster (.omnicaster)".to_string())?;
    if j.omnicaster != "join" || j.v != 1 {
        return Err("Este archivo no es de alta o es de una versión que esta OmniCaster no entiende".into());
    }
    let api = j.api.trim().trim_end_matches('/');
    if !(api.starts_with("https://") || api.starts_with("http://localhost") || api.starts_with("http://127.")) {
        return Err("La dirección del maestro no es segura (tiene que ser https)".into());
    }
    if !j.token.starts_with("ocn_") || j.node.id.is_empty() || j.station.id.is_empty() {
        return Err("El archivo de alta está incompleto".into());
    }
    Ok(JoinFile { api: api.to_string(), ..j })
}

/// Datos de la unión (con el token: la interfaz lo usa para conectarse).
#[tauri::command]
pub fn cloud_get(state: State<'_, AppState>) -> Option<JoinFile> {
    read(&state.data_dir)
}

/// Une este equipo al maestro con su archivo de alta.
#[tauri::command]
pub fn cloud_join(state: State<'_, AppState>, file: String) -> Result<JoinFile, String> {
    let meta = std::fs::metadata(&file).map_err(|e| format!("No se pudo abrir el archivo: {e}"))?;
    if meta.len() > 64 * 1024 {
        return Err("No es un archivo de alta de OmniCaster (.omnicaster)".into());
    }
    let text = std::fs::read_to_string(&file).map_err(|e| format!("No se pudo leer el archivo: {e}"))?;
    let j = parse_join(&text)?;
    let body = serde_json::to_string_pretty(&j).map_err(|e| e.to_string())?;
    std::fs::write(path(&state.data_dir), body).map_err(|e| format!("No se pudo guardar: {e}"))?;
    crate::crashlog::note(&format!("Unido al maestro {} como «{}»", j.api, j.node.name));
    Ok(j)
}

/// Deja el maestro (borra la llave de este equipo).
#[tauri::command]
pub fn cloud_leave(state: State<'_, AppState>) -> Result<(), String> {
    match std::fs::remove_file(path(&state.data_dir)) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn valid_join_file() {
        let t = r#"{"omnicaster":"join","v":1,"api":"https://cloud.ngradio.es/","station":{"id":"s1","name":"NGRADIO"},"node":{"id":"n1","name":"Estudio","role":"main"},"token":"ocn_x"}"#;
        let j = parse_join(t).unwrap();
        assert_eq!(j.api, "https://cloud.ngradio.es");
        assert_eq!(j.node.role, "main");
        assert!(parse_join(&t.replace("https://", "http://")).is_err());
        assert!(parse_join("hola").is_err());
    }
}
