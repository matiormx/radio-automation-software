//! `readtag` / `writetag`: etiquetas del archivo (ID3, Vorbis, MP4…) con lofty.

use std::path::Path;

use lofty::config::WriteOptions;
use lofty::file::{AudioFile, TaggedFileExt};
use lofty::picture::MimeType;
use lofty::prelude::ItemKey;
use lofty::tag::Tag;

use super::xml::norm;

/// Campos que se leen y escriben (nombre del atributo, clave de lofty).
const FIELDS: [(&str, ItemKey); 14] = [
    ("ARTIST", ItemKey::TrackArtist),
    ("TITLE", ItemKey::TrackTitle),
    ("ALBUM", ItemKey::AlbumTitle),
    ("YEAR", ItemKey::Year),
    ("GENRE", ItemKey::Genre),
    ("COMMENT", ItemKey::Comment),
    ("BPM", ItemKey::IntegerBpm),
    ("ALBUMARTIST", ItemKey::AlbumArtist),
    ("COMPOSER", ItemKey::Composer),
    ("PUBLISHER", ItemKey::Publisher),
    ("COPYRIGHT", ItemKey::CopyrightMessage),
    ("TRACKNUMBER", ItemKey::TrackNumber),
    ("LYRICS", ItemKey::Lyrics),
    ("LANGUAGE", ItemKey::Language),
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
        let v = if upper == "LYRICS" { value.trim().to_string() } else { norm(value) };
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
