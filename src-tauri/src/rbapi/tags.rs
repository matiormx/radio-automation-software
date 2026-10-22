//! `readtag` / `writetag`: etiquetas del archivo (ID3, Vorbis, MP4…) con lofty.

use std::path::Path;

use base64::Engine;
use lofty::config::WriteOptions;
use lofty::file::{AudioFile, TaggedFileExt};
use lofty::picture::MimeType;
use lofty::prelude::ItemKey;
use lofty::tag::Tag;

use super::xml::{duration, empty_tag, norm};

/// Campos que se leen y escriben (nombre del atributo, clave de lofty).
const FIELDS: [(&str, ItemKey); 6] = [
    ("ARTIST", ItemKey::TrackArtist),
    ("TITLE", ItemKey::TrackTitle),
    ("ALBUM", ItemKey::AlbumTitle),
    ("YEAR", ItemKey::Year),
    ("GENRE", ItemKey::Genre),
    ("COMMENT", ItemKey::Comment),
];

fn mime_of(m: Option<&MimeType>) -> &'static str {
    match m {
        Some(MimeType::Png) => "image/png",
        Some(MimeType::Gif) => "image/gif",
        Some(MimeType::Bmp) => "image/bmp",
        Some(MimeType::Tiff) => "image/tiff",
        _ => "image/jpeg",
    }
}

fn get(tag: Option<&Tag>, key: &ItemKey) -> String {
    let Some(t) = tag else { return String::new() };
    let v = t.get_string(key.clone()).map(|s| s.to_string());
    let v = match (v, key) {
        (None, ItemKey::Year) => t.get_string(ItemKey::RecordingDate).map(|d| d.chars().take(4).collect()),
        (v, _) => v,
    };
    norm(&v.unwrap_or_default())
}

/// `<TagInfo><File FN="…" ARTIST="…" …/></TagInfo>`; con `artwork` añade
/// `<Artwork MIME="…">base64</Artwork>`.
pub fn read(path: &Path, artwork: bool) -> Result<String, String> {
    let tagged = lofty::read_from_path(path).map_err(|e| format!("No se pudieron leer las etiquetas: {e}"))?;
    let tag = tagged.primary_tag().or_else(|| tagged.first_tag());
    let fn_attr = path.to_string_lossy().to_string();
    let mut values: Vec<(&str, String)> = vec![("FN", fn_attr)];
    for (name, key) in FIELDS.iter() {
        values.push((name, get(tag, key)));
    }
    values.push(("DURATION", duration(tagged.properties().duration().as_secs_f64())));
    let attrs: Vec<(&str, &str)> = values.iter().map(|(k, v)| (*k, v.as_str())).collect();
    let mut out = String::from("<TagInfo>\n  ");
    out.push_str(&empty_tag("File", &attrs));
    if artwork {
        if let Some(p) = tag.and_then(|t| t.pictures().first()) {
            out.push_str("\n  <Artwork MIME=\"");
            out.push_str(mime_of(p.mime_type()));
            out.push_str("\">");
            out.push_str(&base64::engine::general_purpose::STANDARD.encode(p.data()));
            out.push_str("</Artwork>");
        }
    }
    out.push_str("\n</TagInfo>");
    Ok(out)
}

/// Primera imagen embebida del archivo (para la caratula si no hay portada).
pub fn embedded_picture(path: &Path) -> Option<(Vec<u8>, &'static str)> {
    let tagged = lofty::read_from_path(path).ok()?;
    for tag in tagged.tags() {
        if let Some(p) = tag.pictures().first() {
            return Some((p.data().to_vec(), mime_of(p.mime_type())));
        }
    }
    None
}

/// Escribe en el archivo los campos presentes en `attrs` (ARTIST, TITLE…).
/// Devuelve los valores escritos, normalizados.
pub fn write(path: &Path, attrs: &[(String, String)]) -> Result<Vec<(String, String)>, String> {
    let mut tagged = lofty::read_from_path(path).map_err(|e| format!("No se pudo abrir el archivo: {e}"))?;
    if tagged.primary_tag_mut().is_none() {
        let tt = tagged.primary_tag_type();
        tagged.insert_tag(Tag::new(tt));
    }
    let tag = tagged.primary_tag_mut().ok_or("El formato no admite etiquetas")?;
    let mut written = Vec::new();
    for (name, value) in attrs {
        let upper = name.to_ascii_uppercase();
        let Some((_, key)) = FIELDS.iter().find(|(n, _)| *n == upper) else { continue };
        let v = norm(value);
        if v.is_empty() {
            tag.remove_key(key.clone());
        } else {
            tag.insert_text(key.clone(), v.clone());
        }
        written.push((upper, v));
    }
    tagged
        .save_to_path(path, WriteOptions::default())
        .map_err(|e| format!("No se pudieron guardar las etiquetas: {e}"))?;
    Ok(written)
}
