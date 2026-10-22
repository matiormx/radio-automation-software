//! XML al estilo de RadioBOSS: atributos entre comillas dobles, escapados y
//! en el orden exacto en que se piden.

use unicode_normalization::UnicodeNormalization;

/// Escapa un valor de atributo o texto y quita caracteres que XML 1.0 no admite.
pub fn esc(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 8);
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&apos;"),
            '\t' | '\n' | '\r' => out.push(' '),
            c if (c as u32) < 0x20 => {}
            '\u{FFFE}' | '\u{FFFF}' => {}
            c => out.push(c),
        }
    }
    out
}

/// Texto estable: misma entrada, misma salida. Forma Unicode NFC (una "á"
/// siempre igual), espacios unificados y recortados. Nunca cambia mayusculas
/// ni quita tildes.
pub fn norm(s: &str) -> String {
    let nfc: String = s.nfc().collect();
    let mut out = String::with_capacity(nfc.len());
    let mut space = false;
    for c in nfc.chars() {
        if c.is_whitespace() || c == '\u{00A0}' {
            space = true;
            continue;
        }
        if space && !out.is_empty() {
            out.push(' ');
        }
        space = false;
        out.push(c);
    }
    out
}

/// `<NAME A="x" B="y"/>` con los atributos en el orden dado.
pub fn empty_tag(name: &str, attrs: &[(&str, &str)]) -> String {
    let mut s = String::with_capacity(32 + attrs.len() * 24);
    s.push('<');
    s.push_str(name);
    for (k, v) in attrs {
        s.push(' ');
        s.push_str(k);
        s.push_str("=\"");
        s.push_str(&esc(v));
        s.push('"');
    }
    s.push_str("/>");
    s
}

/// Lee los atributos de la primera etiqueta `<name …>` de un XML sencillo
/// (lo que manda `writetag`). Devuelve pares (clave, valor) ya desescapados.
pub fn parse_attrs(xml: &str, name: &str) -> Option<Vec<(String, String)>> {
    let open = format!("<{name}");
    let start = xml.find(&open)? + open.len();
    let rest = &xml[start..];
    let end = rest.find('>')?;
    let body = rest[..end].trim_end_matches('/');
    let mut out = Vec::new();
    let mut chars = body.char_indices().peekable();
    loop {
        // saltar espacios
        while let Some((_, c)) = chars.peek() {
            if c.is_whitespace() {
                chars.next();
            } else {
                break;
            }
        }
        let Some(&(ks, _)) = chars.peek() else { break };
        let mut ke = ks;
        while let Some(&(i, c)) = chars.peek() {
            if c == '=' || c.is_whitespace() {
                break;
            }
            ke = i + c.len_utf8();
            chars.next();
        }
        let key = body[ks..ke].to_string();
        while let Some(&(_, c)) = chars.peek() {
            if c == '=' || c.is_whitespace() {
                chars.next();
            } else {
                break;
            }
        }
        let Some((_, q)) = chars.next() else { break };
        if q != '"' && q != '\'' {
            return None;
        }
        let mut val = String::new();
        let mut closed = false;
        for (_, c) in chars.by_ref() {
            if c == q {
                closed = true;
                break;
            }
            val.push(c);
        }
        if !closed || key.is_empty() {
            return None;
        }
        out.push((key, unesc(&val)));
    }
    Some(out)
}

fn unesc(s: &str) -> String {
    s.replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&amp;", "&")
}

/// mm:ss (o h:mm:ss si pasa de una hora), como DURATION de RadioBOSS.
pub fn duration(secs: f64) -> String {
    let t = if secs.is_finite() && secs > 0.0 { secs.round() as u64 } else { 0 };
    let (h, m, s) = (t / 3600, (t % 3600) / 60, t % 60);
    if h > 0 {
        format!("{h}:{m:02}:{s:02}")
    } else {
        format!("{m:02}:{s:02}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn escapes_everything() {
        assert_eq!(esc(r#"Tom & "Jerry" <b> l'été"#), "Tom &amp; &quot;Jerry&quot; &lt;b&gt; l&apos;été");
        assert_eq!(esc("a\u{0001}b\nc"), "ab c");
    }

    #[test]
    fn norm_is_stable() {
        // "é" compuesta y descompuesta dan lo mismo; espacios unificados.
        let a = norm("  Café   del\u{00A0}Mar ");
        let b = norm("Cafe\u{0301} del Mar");
        assert_eq!(a, "Café del Mar");
        assert_eq!(a, b);
        assert_eq!(norm(&a), a, "idempotente");
        assert_eq!(norm("ÁRBOL árbol"), "ÁRBOL árbol", "no toca mayúsculas ni tildes");
    }

    #[test]
    fn tags_keep_order() {
        assert_eq!(
            empty_tag("TRACK", &[("ARTIST", "A&B"), ("TITLE", "x"), ("FILENAME", "C:\\m\\a.flac")]),
            r#"<TRACK ARTIST="A&amp;B" TITLE="x" FILENAME="C:\m\a.flac"/>"#
        );
    }

    #[test]
    fn parses_writetag_data() {
        let a = parse_attrs(r#"<TagInfo><File ARTIST="AC&amp;DC" TITLE='T "x"' YEAR="1980"/></TagInfo>"#, "File").unwrap();
        assert_eq!(a[0], ("ARTIST".into(), "AC&DC".into()));
        assert_eq!(a[1], ("TITLE".into(), "T \"x\"".into()));
        assert_eq!(a[2], ("YEAR".into(), "1980".into()));
        assert!(parse_attrs("<File ARTIST=\"x></File>", "File").is_none());
    }

    #[test]
    fn durations() {
        assert_eq!(duration(200.0), "03:20");
        assert_eq!(duration(3725.0), "1:02:05");
        assert_eq!(duration(f64::NAN), "00:00");
    }
}
