use std::path::PathBuf;

/// Tamano maximo del texto que se escribe en el archivo.
const MAX_LEN: usize = 8192;
/// Tamano maximo de la imagen (base64) que se escribe.
const MAX_IMAGE_LEN: usize = 8 * 1024 * 1024;

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

/// Escribe la portada de la cancion en un archivo .jpg. Los bytes llegan en
/// base64 desde la interfaz, que ya ha convertido la imagen a JPEG.
#[tauri::command]
pub fn write_now_playing_image(path: String, data: String) -> Result<String, String> {
    let path = path.trim();
    if path.is_empty() {
        return Err("No hay ningun archivo de portada configurado".to_string());
    }
    if path.chars().any(|c| c.is_control()) {
        return Err("La ruta del archivo no es valida".to_string());
    }
    let lower = path.to_ascii_lowercase();
    if !lower.ends_with(".jpg") && !lower.ends_with(".jpeg") {
        return Err("La portada debe guardarse en un archivo .jpg".to_string());
    }
    if data.len() > MAX_IMAGE_LEN {
        return Err("La imagen es demasiado grande".to_string());
    }

    let bytes = decode_base64(data.trim())?;
    if bytes.len() < 4 || bytes[0] != 0xFF || bytes[1] != 0xD8 || bytes[2] != 0xFF {
        return Err("La imagen no es un JPEG valido".to_string());
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

    let temp = target.with_extension("jpg.tmp");
    std::fs::write(&temp, &bytes).map_err(|e| format!("No se pudo preparar la imagen: {e}"))?;
    if std::fs::rename(&temp, &target).is_err() {
        let _ = std::fs::remove_file(&temp);
        std::fs::write(&target, &bytes)
            .map_err(|e| format!("No se pudo escribir {}: {e}", target.display()))?;
    }
    Ok(target.display().to_string())
}

/// Decodifica base64 estandar sin dependencias externas.
fn decode_base64(input: &str) -> Result<Vec<u8>, String> {
    let mut out = Vec::with_capacity(input.len() / 4 * 3);
    let mut buffer: u32 = 0;
    let mut bits = 0;
    for ch in input.chars() {
        if ch == '=' {
            break;
        }
        if ch.is_whitespace() {
            continue;
        }
        let value = match ch {
            'A'..='Z' => ch as u32 - 'A' as u32,
            'a'..='z' => ch as u32 - 'a' as u32 + 26,
            '0'..='9' => ch as u32 - '0' as u32 + 52,
            '+' => 62,
            '/' => 63,
            _ => return Err("La imagen no tiene un formato valido".to_string()),
        };
        buffer = (buffer << 6) | value;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push(((buffer >> bits) & 0xFF) as u8);
        }
    }
    if out.is_empty() {
        return Err("La imagen esta vacia".to_string());
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodifica_base64() {
        assert_eq!(decode_base64("aGVsbG8=").unwrap(), b"hello");
        assert_eq!(decode_base64("T0U=").unwrap(), b"ME");
        assert!(decode_base64("!!").is_err());
        assert!(decode_base64("").is_err());
    }
}
