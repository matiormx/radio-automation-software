//! Lector HLS propio para las fuentes de internet.
//!
//! FFmpeg, leyendo HLS en directo, a veces repite o se salta trozos: al
//! recargar la lista tarde, al reconectar un trozo a medias o cuando el
//! servidor mueve la ventana (emisiones en diferido). Aquí se descarga cada
//! trozo UNA vez, en orden, siguiendo su número de secuencia, y se le pasa a
//! FFmpeg por la entrada estándar como si fuera un único archivo continuo.
//!
//! - Lista maestra: se elige la variante de más calidad.
//! - fMP4: el trozo de inicio (EXT-X-MAP) se manda una vez.
//! - Listas cifradas (EXT-X-KEY): se dejan a FFmpeg (este lector no descifra).

use std::io::Write;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

#[derive(Debug, Default, Clone, PartialEq)]
pub struct Playlist {
    pub target: f64,
    pub seq: u64,
    pub segments: Vec<(String, f64)>,
    pub ended: bool,
    pub map: Option<String>,
    pub encrypted: bool,
    /// Lista maestra: (ancho de banda, url de la variante)
    pub variants: Vec<(u64, String)>,
}

fn join(base: &str, rel: &str) -> String {
    if rel.starts_with("http://") || rel.starts_with("https://") {
        return rel.to_string();
    }
    tauri::Url::parse(base).and_then(|b| b.join(rel)).map(|u| u.to_string()).unwrap_or_else(|_| rel.to_string())
}

fn attr(line: &str, key: &str) -> Option<String> {
    let i = line.find(&format!("{key}="))? + key.len() + 1;
    let rest = &line[i..];
    if let Some(r) = rest.strip_prefix('"') {
        r.split('"').next().map(str::to_string)
    } else {
        rest.split(',').next().map(|s| s.trim().to_string())
    }
}

pub fn parse(text: &str, base: &str) -> Playlist {
    let mut p = Playlist { target: 6.0, ..Default::default() };
    let mut dur = 0.0;
    let mut bw: Option<u64> = None;
    for raw in text.lines() {
        let l = raw.trim();
        if l.is_empty() {
            continue;
        }
        if let Some(v) = l.strip_prefix("#EXT-X-TARGETDURATION:") {
            p.target = v.trim().parse().unwrap_or(6.0);
        } else if let Some(v) = l.strip_prefix("#EXT-X-MEDIA-SEQUENCE:") {
            p.seq = v.trim().parse().unwrap_or(0);
        } else if let Some(v) = l.strip_prefix("#EXTINF:") {
            dur = v.split(',').next().and_then(|d| d.trim().parse().ok()).unwrap_or(0.0);
        } else if l.starts_with("#EXT-X-ENDLIST") {
            p.ended = true;
        } else if l.starts_with("#EXT-X-MAP:") {
            p.map = attr(l, "URI").map(|u| join(base, &u));
        } else if l.starts_with("#EXT-X-KEY:") {
            if attr(l, "METHOD").map(|m| m != "NONE").unwrap_or(false) {
                p.encrypted = true;
            }
        } else if l.starts_with("#EXT-X-STREAM-INF:") {
            bw = attr(l, "BANDWIDTH").and_then(|b| b.parse().ok()).or(Some(0));
        } else if !l.starts_with('#') {
            let url = join(base, l);
            if let Some(b) = bw.take() {
                p.variants.push((b, url));
            } else {
                p.segments.push((url, dur));
                dur = 0.0;
            }
        }
    }
    p
}

fn agent() -> ureq::Agent {
    ureq::AgentBuilder::new().timeout_connect(Duration::from_secs(8)).timeout_read(Duration::from_secs(20)).user_agent("OmniCaster").build()
}

fn get_text(a: &ureq::Agent, url: &str) -> Result<(String, String), String> {
    let r = a.get(url).call().map_err(|e| e.to_string())?;
    let final_url = r.get_url().to_string();
    let t = r.into_string().map_err(|e| e.to_string())?;
    Ok((t, final_url))
}

fn get_bytes(a: &ureq::Agent, url: &str) -> Result<Vec<u8>, String> {
    let r = a.get(url).call().map_err(|e| e.to_string())?;
    let mut v = Vec::new();
    std::io::Read::read_to_end(&mut r.into_reader().take(64 * 1024 * 1024), &mut v).map_err(|e| e.to_string())?;
    Ok(v)
}

use std::io::Read as _;

/// Lista de reproducción de medios (resolviendo la maestra si hace falta).
pub fn open(url: &str) -> Result<(Playlist, String), String> {
    let a = agent();
    let (text, base) = get_text(&a, url)?;
    if !text.trim_start().starts_with("#EXTM3U") {
        return Err("No es una lista HLS".into());
    }
    let p = parse(&text, &base);
    if let Some((_, v)) = p.variants.iter().max_by_key(|(b, _)| *b) {
        let (t2, b2) = get_text(&a, v)?;
        return Ok((parse(&t2, &b2), v.clone()));
    }
    Ok((p, url.to_string()))
}

/// Descarga los trozos en orden y los escribe en `out` hasta `stop`, fin de
/// la lista o que `out` se cierre (FFmpeg terminado).
pub fn feed(media_url: String, first: Playlist, mut out: impl Write, stop: Arc<AtomicBool>) {
    let a = agent();
    let mut pl = first;
    let mut next: u64 = if pl.ended {
        pl.seq
    } else {
        // En directo se empieza 3 trozos antes del final (como FFmpeg).
        pl.seq + pl.segments.len().saturating_sub(3) as u64
    };
    let mut map_sent: Option<String> = None;
    let mut fails = 0u32;
    while !stop.load(Ordering::SeqCst) {
        let t0 = Instant::now();
        let mut wrote = false;
        if let Some(m) = pl.map.clone() {
            if map_sent.as_deref() != Some(m.as_str()) {
                match get_bytes(&a, &m) {
                    Ok(b) => {
                        if out.write_all(&b).is_err() {
                            return;
                        }
                        map_sent = Some(m);
                    }
                    Err(e) => crate::perflog::note(&format!("HLS: no se pudo bajar el inicio: {e}")),
                }
            }
        }
        // Si el servidor ya ha borrado los trozos que tocaban, se sigue por
        // el primero que haya (hueco inevitable, pero sin repetir).
        if next < pl.seq {
            crate::perflog::note(&format!("HLS: {} trozos ya no estaban en el servidor", pl.seq - next));
            next = pl.seq;
        }
        for (i, (url, _)) in pl.segments.iter().enumerate() {
            let n = pl.seq + i as u64;
            if n < next {
                continue;
            }
            if stop.load(Ordering::SeqCst) {
                return;
            }
            let mut got = None;
            for attempt in 0..4 {
                match get_bytes(&a, url) {
                    Ok(b) => {
                        got = Some(b);
                        break;
                    }
                    Err(e) => {
                        if attempt == 3 {
                            crate::perflog::note(&format!("HLS: trozo {n} perdido: {e}"));
                        }
                        std::thread::sleep(Duration::from_millis(400 * (attempt + 1) as u64));
                    }
                }
            }
            if let Some(b) = got {
                if out.write_all(&b).is_err() {
                    return; // FFmpeg se ha cerrado
                }
                let _ = out.flush();
                wrote = true;
            }
            next = n + 1;
        }
        if pl.ended && next >= pl.seq + pl.segments.len() as u64 {
            return; // lista terminada (bajo demanda): fin
        }
        // Recarga: a la duración de un trozo; la mitad si no había nada nuevo.
        let wait = Duration::from_secs_f64(if wrote { pl.target } else { (pl.target / 2.0).max(1.0) });
        let elapsed = t0.elapsed();
        if wait > elapsed {
            let until = Instant::now() + (wait - elapsed);
            while Instant::now() < until {
                if stop.load(Ordering::SeqCst) {
                    return;
                }
                std::thread::sleep(Duration::from_millis(200));
            }
        }
        match get_text(&a, &media_url) {
            Ok((t, base)) => {
                let p = parse(&t, &base);
                // Si el servidor reinicia la numeración (o cambia de emisión),
                // se vuelve a empezar cerca del final.
                if p.seq + p.segments.len() as u64 + 5 < next {
                    next = p.seq + p.segments.len().saturating_sub(3) as u64;
                }
                pl = p;
                fails = 0;
            }
            Err(e) => {
                fails += 1;
                if fails == 1 || fails % 10 == 0 {
                    crate::perflog::note(&format!("HLS: no se pudo recargar la lista ({fails}): {e}"));
                }
                std::thread::sleep(Duration::from_secs(fails.min(5) as u64));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_media_and_master() {
        let m = "#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXT-X-MEDIA-SEQUENCE:120\n#EXT-X-MAP:URI=\"init.mp4\"\n#EXTINF:6.0,\nseg120.ts\n#EXTINF:6.0,\nhttps://cdn.x/seg121.ts\n";
        let p = parse(m, "https://radio.x/live/stream.m3u8?delay=10");
        assert_eq!(p.seq, 120);
        assert_eq!(p.segments.len(), 2);
        assert_eq!(p.segments[0].0, "https://radio.x/live/seg120.ts");
        assert_eq!(p.segments[1].0, "https://cdn.x/seg121.ts");
        assert_eq!(p.map.as_deref(), Some("https://radio.x/live/init.mp4"));
        assert!(!p.ended && !p.encrypted);
        let master = "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=64000,CODECS=\"mp4a.40.2\"\nlow/index.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=192000\nhigh/index.m3u8\n";
        let q = parse(master, "https://radio.x/master.m3u8");
        assert_eq!(q.variants.len(), 2);
        assert_eq!(q.variants.iter().max_by_key(|v| v.0).unwrap().1, "https://radio.x/high/index.m3u8");
        let enc = parse("#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI=\"k\"\n#EXTINF:6,\na.ts\n", "https://r.x/a.m3u8");
        assert!(enc.encrypted);
    }
}

#[cfg(test)]
mod live_test {
    /// Prueba manual: HLS_TEST_URL=http://… HLS_TEST_OUT=/ruta.pcm cargo test hls_live -- --ignored
    #[test]
    #[ignore]
    fn hls_live() {
        use std::process::{Command, Stdio};
        let url = std::env::var("HLS_TEST_URL").unwrap();
        let outp = std::env::var("HLS_TEST_OUT").unwrap();
        let secs: u64 = std::env::var("HLS_TEST_SECS").ok().and_then(|s| s.parse().ok()).unwrap_or(30);
        let (child, mut out) = crate::netstream::spawn(std::path::Path::new("ffmpeg"), &url, 48000).unwrap();
        let mut child = child;
        let t = std::thread::spawn(move || {
            let mut v = Vec::new();
            let _ = std::io::Read::read_to_end(&mut out, &mut v);
            v
        });
        std::thread::sleep(std::time::Duration::from_secs(secs));
        let _ = child.kill();
        let v = t.join().unwrap();
        std::fs::write(outp, v).unwrap();
        let _ = Stdio::null();
        let _ = Command::new("true");
    }
}
