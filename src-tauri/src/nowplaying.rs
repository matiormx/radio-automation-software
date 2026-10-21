use std::path::PathBuf;

/// Tamano maximo del texto que se escribe en el archivo.
const MAX_LEN: usize = 8192;

/// Escribe el archivo "now playing" con los datos de la cancion actual.
/// Solo se admiten archivos .txt y la escritura es atomica (archivo
/// temporal y renombrado) para que quien lo lea nunca vea medias lineas.
#[tauri::command]
pub fn write_now_playing(path: String, contents: String) -> Result<String, String> {
    let path = path.trim();
    if path.is_empty() {
        return Err("No hay ningun archivo nowplaying configurado".to_string());
    }
    if path.chars().any(|c| c.is_control()) {
        return Err("La ruta del archivo no es valida".to_string());
    }
    if !path.to_ascii_lowercase().ends_with(".txt") {
        return Err("El archivo nowplaying debe terminar en .txt".to_string());
    }
    if contents.len() > MAX_LEN {
        return Err("El texto del nowplaying es demasiado largo".to_string());
    }

    let target = PathBuf::from(path);
    if target.is_dir() {
        return Err("Esa ruta es una carpeta, no un archivo".to_string());
    }
    if let Some(dir) = target.parent() {
        if !dir.as_os_str().is_empty() && !dir.is_dir() {
            return Err(format!("La carpeta no existe: {}", dir.display()));
        }
    }

    let temp = target.with_extension("txt.tmp");
    std::fs::write(&temp, contents.as_bytes())
        .map_err(|e| format!("No se pudo preparar el archivo: {e}"))?;
    if let Err(error) = std::fs::rename(&temp, &target) {
        let _ = std::fs::remove_file(&temp);
        std::fs::write(&target, contents.as_bytes())
            .map_err(|e| format!("No se pudo escribir {}: {e}", target.display()))?;
        let _ = error;
    }
    Ok(target.display().to_string())
}
