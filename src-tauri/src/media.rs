//! Protocolo `media://` para los archivos que el protocolo de recursos de
//! Tauri sirve con un tipo que el WebView no reproduce: los .m4v se detectan
//! como `video/x-m4v` y Chromium/WebView2 los rechaza. Aqui se sirven como
//! `video/mp4` (son MP4), con peticiones por rangos para poder buscar.

use std::io::{Read, Seek, SeekFrom};

use tauri::http::{header, Request, Response, StatusCode};

/// Extensiones que pasan por aqui. Ademas de .m4v, los videos y las
/// portadas que dibuja la ventana «Lo que suena» en un lienzo: este protocolo
/// manda Access-Control-Allow-Origin y el lienzo no queda «contaminado» (si
/// no, no se podria sacar la imagen como JPEG).
pub const EXTENSIONS: [&str; 13] =
    ["m4v", "mp4", "mov", "webm", "mkv", "ogv", "jpg", "jpeg", "png", "webp", "gif", "bmp", "avif"];

const CHUNK: u64 = 4 * 1024 * 1024;

fn mime(ext: &str) -> &'static str {
    match ext {
        "m4v" | "mp4" | "mov" => "video/mp4",
        "webm" => "video/webm",
        "mkv" => "video/x-matroska",
        "ogv" => "video/ogg",
        "jpg" | "jpeg" => "image/jpeg",
        "png" => "image/png",
        "webp" => "image/webp",
        "gif" => "image/gif",
        "bmp" => "image/bmp",
        "avif" => "image/avif",
        _ => "application/octet-stream",
    }
}

fn error(status: StatusCode) -> Response<Vec<u8>> {
    Response::builder().status(status).body(Vec::new()).unwrap_or_default()
}

/// Ruta del archivo a partir de la URL (media://localhost/<ruta codificada>
/// o http://media.localhost/<ruta codificada> en Windows).
fn path_of(req: &Request<Vec<u8>>) -> String {
    let raw = req.uri().path().trim_start_matches('/');
    let bytes: Vec<u8> = percent_encoding::percent_decode(raw.as_bytes()).collect();
    String::from_utf8_lossy(&bytes).into_owned()
}

/// "bytes=inicio-fin" (fin opcional).
fn parse_range(v: &str, len: u64) -> Option<(u64, u64)> {
    let v = v.trim().strip_prefix("bytes=")?;
    let (a, b) = v.split_once('-')?;
    let (start, end) = if a.is_empty() {
        // Ultimos N bytes
        let n: u64 = b.parse().ok()?;
        (len.saturating_sub(n), len.saturating_sub(1))
    } else {
        let s: u64 = a.parse().ok()?;
        let e = if b.is_empty() { len.saturating_sub(1) } else { b.parse::<u64>().ok()?.min(len.saturating_sub(1)) };
        (s, e)
    };
    (start <= end && start < len).then_some((start, end))
}

pub fn handle(req: &Request<Vec<u8>>) -> Response<Vec<u8>> {
    let path = path_of(req);
    let ext = std::path::Path::new(&path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    // Solo archivos multimedia: este protocolo no sirve cualquier archivo.
    if !EXTENSIONS.contains(&ext.as_str()) {
        return error(StatusCode::FORBIDDEN);
    }
    let Ok(mut file) = std::fs::File::open(&path) else { return error(StatusCode::NOT_FOUND) };
    let len = file.metadata().map(|m| m.len()).unwrap_or(0);
    let range = req.headers().get(header::RANGE).and_then(|v| v.to_str().ok()).map(|v| parse_range(v, len));
    let (start, end, partial) = match range {
        Some(None) => {
            return Response::builder()
                .status(StatusCode::RANGE_NOT_SATISFIABLE)
                .header(header::CONTENT_RANGE, format!("bytes */{len}"))
                .body(Vec::new())
                .unwrap_or_default();
        }
        Some(Some((s, e))) => (s, e.min(s + CHUNK - 1), true),
        // Una imagen va entera (no se pide por trozos).
        None if mime(&ext).starts_with("image/") => (0, len.saturating_sub(1), false),
        None => (0, len.saturating_sub(1).min(CHUNK - 1), len > CHUNK),
    };
    let mut buf = vec![0u8; if len == 0 { 0 } else { (end - start + 1) as usize }];
    if file.seek(SeekFrom::Start(start)).is_err() || file.read_exact(&mut buf).is_err() {
        return error(StatusCode::INTERNAL_SERVER_ERROR);
    }
    let mut b = Response::builder()
        .header(header::CONTENT_TYPE, mime(&ext))
        .header(header::ACCEPT_RANGES, "bytes")
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .header(header::CONTENT_LENGTH, buf.len().to_string());
    if partial {
        b = b.status(StatusCode::PARTIAL_CONTENT).header(header::CONTENT_RANGE, format!("bytes {start}-{end}/{len}"));
    } else {
        b = b.status(StatusCode::OK);
    }
    b.body(buf).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ranges() {
        assert_eq!(parse_range("bytes=0-", 100), Some((0, 99)));
        assert_eq!(parse_range("bytes=10-19", 100), Some((10, 19)));
        assert_eq!(parse_range("bytes=-10", 100), Some((90, 99)));
        assert_eq!(parse_range("bytes=200-", 100), None);
    }

    #[test]
    fn serves_m4v_as_mp4_with_ranges() {
        let dir = std::env::temp_dir().join("miradio-media-test");
        let _ = std::fs::create_dir_all(&dir);
        let f = dir.join("prueba vídeo.m4v");
        std::fs::write(&f, (0..=255u8).collect::<Vec<u8>>()).unwrap();
        let enc = percent_encoding::utf8_percent_encode(&f.to_string_lossy(), percent_encoding::NON_ALPHANUMERIC).to_string();
        let req = Request::builder().uri(format!("media://localhost/{enc}")).header("Range", "bytes=10-19").body(Vec::new()).unwrap();
        let r = handle(&req);
        assert_eq!(r.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(r.headers()[header::CONTENT_TYPE], "video/mp4");
        assert_eq!(r.body(), &(10..=19u8).collect::<Vec<u8>>());
        // Otro tipo de archivo: prohibido
        let req = Request::builder().uri("media://localhost/%2Fetc%2Fpasswd").body(Vec::new()).unwrap();
        assert_eq!(handle(&req).status(), StatusCode::FORBIDDEN);
    }
}
