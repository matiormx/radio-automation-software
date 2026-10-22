//! Respuestas con el formato exacto de RadioBOSS 7.x (capturado de una
//! instalacion real): declaracion XML, saltos CRLF, `<TAG a="x" />` con
//! espacio antes de `/>`, atributos en el mismo orden y los mismos formatos
//! de fecha, duracion e intro.

use std::collections::HashMap;
use std::path::Path;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::Engine;
use lofty::file::{AudioFile, TaggedFileExt};
use lofty::prelude::ItemKey;

use super::xml::{duration, norm};
use crate::library::Track;

pub const XML_HEAD: &str = "<?xml version=\"1.0\" encoding=\"utf-8\"?>\r\n";

/// Escapado de atributo como RadioBOSS: los saltos de linea van como
/// `&#13;&#10;` (la letra de una cancion conserva sus lineas).
pub fn esc(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 8);
    let mut prev_cr = false;
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\r' => out.push_str("&#13;"),
            '\n' => {
                if !prev_cr {
                    out.push_str("&#13;");
                }
                out.push_str("&#10;");
            }
            '\t' => out.push_str("&#9;"),
            c if (c as u32) < 0x20 => {}
            '\u{FFFE}' | '\u{FFFF}' => {}
            c => out.push(c),
        }
        prev_cr = c == '\r';
    }
    out
}

/// `<NAME a="x" b="y" />`
pub fn tag(name: &str, attrs: &[(&str, String)]) -> String {
    let mut s = String::with_capacity(16 + attrs.len() * 24);
    s.push('<');
    s.push_str(name);
    for (k, v) in attrs {
        s.push(' ');
        s.push_str(k);
        s.push_str("=\"");
        s.push_str(&esc(v));
        s.push('"');
    }
    s.push_str(" />");
    s
}

/// `<TRACK …/>` de ficha: RadioBOSS deja dos espacios tras DURATION.
pub fn track_tag(attrs: &[(&str, String)]) -> String {
    let s = tag("TRACK", attrs);
    match s.find("\" PLAYCOUNT=\"") {
        Some(i) if s[..i].ends_with(&format!("DURATION=\"{}", esc(&attrs.iter().find(|(k, _)| *k == "DURATION").map(|(_, v)| v.clone()).unwrap_or_default()))) => {
            format!("{}\"  PLAYCOUNT=\"{}", &s[..i], &s[i + 13..])
        }
        _ => s,
    }
}

/// Documento: cabecera, raiz y cada linea con CRLF.
pub fn doc(root_open: &str, root: &str, lines: &[String]) -> String {
    let mut out = String::with_capacity(64 + lines.iter().map(|l| l.len() + 2).sum::<usize>());
    out.push_str(XML_HEAD);
    out.push_str(root_open);
    out.push_str("\r\n");
    for l in lines {
        out.push_str(l);
        out.push_str("\r\n");
    }
    out.push_str("</");
    out.push_str(root);
    out.push_str(">\r\n");
    out
}

pub fn local(t: SystemTime) -> String {
    let dt: chrono::DateTime<chrono::Local> = t.into();
    dt.format("%Y-%m-%d %H:%M:%S").to_string()
}

pub fn local_epoch(secs: u64) -> String {
    local(UNIX_EPOCH + Duration::from_secs(secs))
}

pub fn clock(t: SystemTime) -> String {
    let dt: chrono::DateTime<chrono::Local> = t.into();
    dt.format("%H:%M:%S").to_string()
}

/// INTRO de las fichas: segundos con dos decimales ("2.66").
pub fn secs2(v: f64) -> String {
    format!("{:.2}", if v.is_finite() && v > 0.0 { v } else { 0.0 })
}

/// Nombre del idioma como lo guarda RadioBOSS ("Español", "English"…).
pub fn language_name(code: &str) -> String {
    let n = match code {
        "es" => "Español",
        "en" => "English",
        "pt" => "Português",
        "de" => "Deutsch",
        "fr" => "Français",
        "it" => "Italiano",
        "ca" => "Català",
        "gl" => "Galego",
        "eu" => "Euskara",
        "nl" => "Nederlands",
        "sv" => "Svenska",
        "no" => "Norsk",
        "da" => "Dansk",
        "fi" => "Suomi",
        "pl" => "Polski",
        "ru" => "Русский",
        "uk" => "Українська",
        "el" => "Ελληνικά",
        "tr" => "Türkçe",
        "ro" => "Română",
        "ja" => "日本語",
        "ko" => "한국어",
        "zh" => "中文",
        "ar" => "العربية",
        "he" => "עברית",
        "hi" => "हिन्दी",
        "la" => "Latina",
        other => return other.to_string(),
    };
    n.to_string()
}

// ------------------------------------------------------------ etiquetas extra

/// Campos que MiRadio no guarda en la ficha y salen de las etiquetas del archivo.
#[derive(Clone, Debug, Default)]
pub struct Extra {
    pub comment: String,
    pub bpm: String,
    pub publisher: String,
    pub album_artist: String,
    pub composer: String,
    pub copyright: String,
    pub track_number: String,
    pub lyrics: String,
    pub language: String,
    pub duration_ms: u64,
}

pub fn read_extra(path: &Path) -> Extra {
    let Ok(tagged) = lofty::read_from_path(path) else { return Extra::default() };
    let mut e = Extra { duration_ms: tagged.properties().duration().as_millis() as u64, ..Default::default() };
    let Some(tag) = tagged.primary_tag().or_else(|| tagged.first_tag()) else { return e };
    let get = |k: ItemKey| tag.get_string(k).map(|s| s.trim().to_string()).unwrap_or_default();
    e.comment = norm(&get(ItemKey::Comment));
    e.bpm = {
        let b = get(ItemKey::IntegerBpm);
        let b = if b.is_empty() { get(ItemKey::Bpm) } else { b };
        b.split('.').next().unwrap_or("").to_string()
    };
    e.publisher = {
        let p = get(ItemKey::Publisher);
        norm(&if p.is_empty() { get(ItemKey::Label) } else { p })
    };
    e.album_artist = norm(&get(ItemKey::AlbumArtist));
    e.composer = norm(&get(ItemKey::Composer));
    e.copyright = norm(&get(ItemKey::CopyrightMessage));
    e.track_number = get(ItemKey::TrackNumber).split('/').next().unwrap_or("").trim().to_string();
    e.lyrics = get(ItemKey::Lyrics).replace("\r\n", "\n").replace('\r', "\n").replace('\n', "\r\n");
    e.language = norm(&get(ItemKey::Language));
    e
}

/// Primera imagen embebida (bytes, MIME).
pub fn embedded_art(path: &Path) -> Option<(Vec<u8>, &'static str)> {
    super::tags::embedded_picture(path)
}

pub fn b64(bytes: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

// ------------------------------------------------------------ ficha resuelta

/// Todo lo que RadioBOSS cuenta de una pista, ya resuelto.
#[derive(Clone, Debug, Default)]
pub struct Info {
    pub artist: String,
    pub title: String,
    pub album: String,
    pub year: String,
    pub genre: String,
    pub filename: String,
    /// Duracion del archivo (s)
    pub dur: f64,
    /// Duracion efectiva con recortes (s)
    pub eff: f64,
    pub playcount: usize,
    pub lastplayed: String,
    pub intro: f64,
    pub language: String,
    pub rating: String,
    pub tags: String,
    pub extra: Extra,
}

impl Info {
    pub fn item_title(&self) -> String {
        format!("{} - {} ({})", self.artist, self.title, self.year)
    }

    pub fn cast_title(&self) -> String {
        if self.album.is_empty() {
            format!("{} - {}", self.artist, self.title)
        } else {
            format!("{} - {} - {}", self.artist, self.title, self.album)
        }
    }

    /// Atributos comunes de una ficha de pista, hasta F5.
    pub fn base_attrs(&self) -> Vec<(&'static str, String)> {
        vec![
            ("ARTIST", self.artist.clone()),
            ("TITLE", self.title.clone()),
            ("ALBUM", self.album.clone()),
            ("YEAR", self.year.clone()),
            ("GENRE", self.genre.clone()),
            ("COMMENT", self.extra.comment.clone()),
            ("FILENAME", self.filename.clone()),
            ("DURATION", duration(self.dur)),
            ("PLAYCOUNT", self.playcount.to_string()),
            ("LASTPLAYED", self.lastplayed.clone()),
            ("INTRO", secs2(self.intro)),
            ("OUTRO", secs2(0.0)),
            ("LANGUAGE", self.language.clone()),
            ("RATING", self.rating.clone()),
            ("BPM", self.extra.bpm.clone()),
            ("TAGS", self.tags.clone()),
            ("PUBLISHER", self.extra.publisher.clone()),
            ("ALBUMARTIST", self.extra.album_artist.clone()),
            ("COMPOSER", self.extra.composer.clone()),
            ("COPYRIGHT", self.extra.copyright.clone()),
            ("TRACKNUMBER", self.extra.track_number.clone()),
            ("F1", String::new()),
            ("F2", String::new()),
            ("F3", String::new()),
            ("F4", String::new()),
            ("F5", String::new()),
        ]
    }

    /// Ficha de `getplaylist2`.
    #[allow(clippy::too_many_arguments)]
    pub fn playlist2_attrs(&self, start: &str, index0: usize, played: bool) -> Vec<(&'static str, String)> {
        vec![
            ("STARTTIME", start.to_string()),
            ("CASTTITLE", self.item_title()),
            ("DURATION", duration(self.eff)),
            ("FILENAME", self.filename.clone()),
            ("TRACKFILENAME", self.filename.clone()),
            ("RATING", self.rating.clone()),
            ("PLAYCOUNT", self.playcount.to_string()),
            ("INTRO", duration(self.intro.round())),
            ("OUTRO", "00:00".to_string()),
            ("BPM", self.extra.bpm.clone()),
            ("PLAYLISTINDEX", index0.to_string()),
            ("INDEX", (index0 + 1).to_string()),
            ("FT_IDX", "-1".to_string()),
            ("ITEMTYPE", if played { "TRACK_PLAYED" } else { "TRACK" }.to_string()),
            ("PQUEUE", "0".to_string()),
            ("ARTIST", self.artist.clone()),
            ("TITLE", self.title.clone()),
            ("ALBUM", self.album.clone()),
            ("YEAR", self.year.clone()),
            ("GENRE", self.genre.clone()),
            ("COMMENT", self.extra.comment.clone()),
            ("LASTPLAYED", self.lastplayed.clone()),
            ("LANGUAGE", self.language.clone()),
            ("F1", String::new()),
            ("F2", String::new()),
            ("F3", String::new()),
            ("F4", String::new()),
            ("F5", String::new()),
        ]
    }
}

/// Ficha minima a partir de la biblioteca (sin etiquetas del archivo).
pub fn info_from_track(t: &Track, plays: &[u64]) -> Info {
    let eff = {
        let start = t.trim_start.max(0.0);
        let end = t.trim_end.unwrap_or(t.duration_secs).min(t.duration_secs.max(0.0));
        (end - start).max(0.0)
    };
    Info {
        artist: norm(&t.artist),
        title: norm(&t.title),
        album: norm(&t.album),
        year: norm(&t.year),
        genre: norm(&t.genre),
        filename: super::filename_of(&t.file),
        dur: t.duration_secs,
        eff: if eff > 0.0 { eff } else { t.duration_secs },
        playcount: plays.len(),
        lastplayed: plays.last().map(|s| local_epoch(*s)).unwrap_or_default(),
        intro: (t.intro_point - t.trim_start.max(0.0)).max(0.0) * (t.intro_point > 0.0) as u8 as f64,
        language: if t.language.is_empty() { String::new() } else { language_name(&t.language) },
        rating: "0".to_string(),
        tags: t.tags.join(", "),
        extra: Extra::default(),
    }
}

/// `readtag`: atributos de `<File …/>` (mismo orden que RadioBOSS).
pub fn readtag_attrs(fname: &str, t: Option<&Track>, info: Option<&Info>, plays: &[u64], artwork: String) -> Vec<(&'static str, String)> {
    let ms = |s: f64| if s > 0.0 { ((s * 1000.0).round() as i64).to_string() } else { "-1".to_string() };
    let (dur_ms, artist, title, album, year, genre, comment, bpm) = match info {
        Some(i) => (
            if i.extra.duration_ms > 0 { i.extra.duration_ms } else { (i.dur * 1000.0).round() as u64 },
            i.artist.clone(),
            i.title.clone(),
            i.album.clone(),
            i.year.clone(),
            i.genre.clone(),
            i.extra.comment.clone(),
            i.extra.bpm.clone(),
        ),
        None => (0, String::new(), String::new(), String::new(), String::new(), String::new(), String::new(), String::new()),
    };
    let level = t
        .and_then(|t| t.gain_db)
        .filter(|g| g.is_finite())
        .map(|g| format!("{g:.1}").replace('.', ","))
        .unwrap_or_else(|| "0,0".to_string());
    let history: String = plays.iter().rev().map(|p| format!("{}\r\n", local_epoch(*p))).collect();
    vec![
        ("FN", fname.to_string()),
        ("Duration", dur_ms.to_string()),
        ("Artist", artist),
        ("Title", title),
        ("Album", album),
        ("Year", year),
        ("Genre", genre),
        ("Comment", comment),
        ("BPM", bpm),
        ("Rating", "0".to_string()),
        ("Playcount", plays.len().to_string()),
        ("LastPlayed", plays.last().map(|p| local_epoch(*p)).unwrap_or_default()),
        ("Added", String::new()),
        ("UserField1", String::new()),
        ("UserField2", String::new()),
        ("UserField3", String::new()),
        ("UserField4", String::new()),
        ("UserField5", String::new()),
        ("TypeIdentifier", String::new()),
        ("TagsList", t.map(|t| t.tags.join(", ")).unwrap_or_default()),
        ("Intro", t.map(|t| ms(t.intro_point)).unwrap_or_else(|| "-1".into())),
        ("Outro", "-1".to_string()),
        ("FadeIn", "-1".to_string()),
        ("FadeOut", t.map(|t| ms(t.fade_out_start)).unwrap_or_else(|| "-1".into())),
        ("Mix", t.map(|t| ms(t.mix_point)).unwrap_or_else(|| "-1".into())),
        ("Level", level),
        ("Start", t.map(|t| ms(t.trim_start)).unwrap_or_else(|| "-1".into())),
        ("End", t.and_then(|t| t.trim_end).map(ms).unwrap_or_else(|| "-1".into())),
        ("PlayedHistory", history),
        ("Artwork_Base64", artwork),
        ("HookIn", "-1".to_string()),
        ("HookOut", "-1".to_string()),
    ]
}

/// Mapa pista → horas en que sono (epoch, ascendente).
pub fn plays_by_track(hist: &[crate::settings::HistoryEntry]) -> HashMap<&str, Vec<u64>> {
    let mut m: HashMap<&str, Vec<u64>> = HashMap::new();
    for h in hist {
        m.entry(h.track_id.as_str()).or_default().push(h.played_at);
    }
    for v in m.values_mut() {
        v.sort_unstable();
    }
    m
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn escapes_like_radioboss() {
        assert_eq!(esc("a\r\nb\nc"), "a&#13;&#10;b&#13;&#10;c");
        assert_eq!(esc("Alex & \"R\" <x>"), "Alex &amp; &quot;R&quot; &lt;x&gt;");
        assert_eq!(esc("it's"), "it's");
    }

    #[test]
    fn tags_and_docs() {
        let t = tag("Player", &[("version", "1".into()), ("uptime", "5".into())]);
        assert_eq!(t, "<Player version=\"1\" uptime=\"5\" />");
        assert_eq!(doc("<Status>", "Status", &[t]), "<?xml version=\"1.0\" encoding=\"utf-8\"?>\r\n<Status>\r\n<Player version=\"1\" uptime=\"5\" />\r\n</Status>\r\n");
        let i = Info { artist: "A".into(), dur: 196.0, ..Default::default() };
        let mut a = i.base_attrs();
        a.push(("LYRICS", String::new()));
        let s = track_tag(&a);
        assert!(s.contains("DURATION=\"03:16\"  PLAYCOUNT=\"0\""), "{s}");
        assert_eq!(secs2(2.656), "2.66");
        assert_eq!(language_name("es"), "Español");
        assert_eq!(language_name("en"), "English");
    }
}
