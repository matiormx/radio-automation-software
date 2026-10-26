//! Decodificacion de pistas a PCM estereo f32 a la frecuencia del motor.

use std::fs;
use std::path::Path;
use std::sync::Arc;

use rubato::{FftFixedIn, Resampler};
use symphonia::core::codecs::{DecoderOptions, CODEC_TYPE_NULL};
use symphonia::core::errors::Error as SymphoniaError;
use symphonia::core::formats::FormatOptions;
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;

/// Audio ya decodificado: estereo entrelazado (L R L R ...).
#[derive(Debug)]
pub struct Pcm {
    pub rate: u32,
    pub data: Vec<f32>,
}

impl Pcm {
    pub fn frames(&self) -> usize {
        self.data.len() / 2
    }

    pub fn duration(&self) -> f64 {
        self.frames() as f64 / self.rate.max(1) as f64
    }

    /// Muestra (L, R) del frame indicado; silencio fuera de rango.
    #[inline]
    pub fn frame(&self, i: usize) -> (f32, f32) {
        let j = i * 2;
        if j + 1 < self.data.len() {
            (self.data[j], self.data[j + 1])
        } else {
            (0.0, 0.0)
        }
    }
}

/// Pesos (izquierda, derecha) de cada canal para mezclar a estereo.
/// Antes se tomaban solo los dos primeros canales: en un archivo 5.1 se
/// perdia el central, que es donde va la voz («voz apagada»).
pub fn downmix_weights(channels: symphonia::core::audio::Channels) -> Vec<(f32, f32)> {
    use symphonia::core::audio::Channels as C;
    const H: f32 = std::f32::consts::FRAC_1_SQRT_2; // -3 dB
    let n = channels.count();
    if n <= 1 {
        return vec![(1.0, 1.0); n.max(1)];
    }
    if n == 2 {
        return vec![(1.0, 0.0), (0.0, 1.0)];
    }
    let mut w: Vec<(f32, f32)> = channels
        .iter()
        .map(|c| {
            if c == C::FRONT_LEFT || c == C::FRONT_LEFT_WIDE || c == C::FRONT_LEFT_HIGH {
                (1.0, 0.0)
            } else if c == C::FRONT_RIGHT || c == C::FRONT_RIGHT_WIDE || c == C::FRONT_RIGHT_HIGH {
                (0.0, 1.0)
            } else if c == C::FRONT_CENTRE || c == C::FRONT_CENTRE_HIGH {
                (H, H)
            } else if c == C::LFE1 || c == C::LFE2 {
                (0.0, 0.0)
            } else if c == C::REAR_LEFT || c == C::SIDE_LEFT || c == C::FRONT_LEFT_CENTRE || c == C::REAR_LEFT_CENTRE || c == C::TOP_FRONT_LEFT || c == C::TOP_REAR_LEFT {
                (H, 0.0)
            } else if c == C::REAR_RIGHT || c == C::SIDE_RIGHT || c == C::FRONT_RIGHT_CENTRE || c == C::REAR_RIGHT_CENTRE || c == C::TOP_FRONT_RIGHT || c == C::TOP_REAR_RIGHT {
                (0.0, H)
            } else {
                (0.5, 0.5)
            }
        })
        .collect();
    if w.len() != n {
        // Sin posiciones conocidas: 1º izq, 2º der, el resto a los dos lados.
        w = (0..n).map(|i| match i { 0 => (1.0, 0.0), 1 => (0.0, 1.0), _ => (0.5, 0.5) }).collect();
    }
    // Que no sature: cada lado suma como mucho 1 (el volumen lo iguala luego
    // la normalizacion de sonoridad, medida con esta misma mezcla).
    let sl: f32 = w.iter().map(|x| x.0).sum();
    let sr: f32 = w.iter().map(|x| x.1).sum();
    let k = 1.0 / sl.max(sr).max(1.0);
    w.iter().map(|&(l, r)| (l * k, r * k)).collect()
}

/// Muestras entrelazadas de `n` canales -> estereo entrelazado.
pub fn downmix_into(samples: &[f32], weights: &[(f32, f32)], out: &mut Vec<f32>) {
    let n = weights.len().max(1);
    if n == 1 {
        for &s in samples {
            out.push(s);
            out.push(s);
        }
        return;
    }
    if n == 2 {
        out.extend_from_slice(samples);
        return;
    }
    for f in samples.chunks_exact(n) {
        let (mut l, mut r) = (0.0f32, 0.0f32);
        for (s, w) in f.iter().zip(weights) {
            l += s * w.0;
            r += s * w.1;
        }
        out.push(l);
        out.push(r);
    }
}

/// Decodifica un archivo completo y lo lleva a `rate` Hz.
pub fn decode_file(path: &Path, rate: u32) -> Result<Arc<Pcm>, String> {
    let (src_rate, data) = decode_native(path)?;
    let data = if src_rate == rate || data.is_empty() {
        data
    } else {
        resample(&data, src_rate, rate)?
    };
    Ok(Arc::new(Pcm { rate, data }))
}

/// Duracion del audio de un archivo (sin decodificarlo) si el contenedor la indica.
pub fn probe_duration(path: &Path) -> Option<f64> {
    let src = fs::File::open(path).ok()?;
    let mss = MediaSourceStream::new(Box::new(src), Default::default());
    let mut hint = Hint::new();
    if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
        hint.with_extension(ext);
    }
    let probed = symphonia::default::get_probe().format(&hint, mss, &FormatOptions::default(), &MetadataOptions::default()).ok()?;
    let track = probed.format.tracks().iter().find(|t| t.codec_params.codec != CODEC_TYPE_NULL)?;
    let p = &track.codec_params;
    match (p.n_frames, p.time_base, p.sample_rate) {
        (Some(n), Some(tb), _) => {
            let t = tb.calc_time(n);
            Some(t.seconds as f64 + t.frac)
        }
        (Some(n), None, Some(sr)) if sr > 0 => Some(n as f64 / sr as f64),
        _ => None,
    }
}

/// Decodifica a estereo entrelazado en la frecuencia original del archivo.
fn decode_native(path: &Path) -> Result<(u32, Vec<f32>), String> {
    let src = fs::File::open(path).map_err(|e| format!("No se pudo abrir el archivo: {e}"))?;
    let mss = MediaSourceStream::new(Box::new(src), Default::default());
    let mut hint = Hint::new();
    if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
        hint.with_extension(ext);
    }
    let probed = symphonia::default::get_probe()
        .format(
            &hint,
            mss,
            &FormatOptions { enable_gapless: true, ..Default::default() },
            &MetadataOptions::default(),
        )
        .map_err(|e| format!("Formato no soportado: {e}"))?;
    let mut format = probed.format;
    let track = format
        .tracks()
        .iter()
        .find(|t| t.codec_params.codec != CODEC_TYPE_NULL)
        .ok_or_else(|| "El archivo no tiene audio".to_string())?;
    let track_id = track.id;
    let mut rate = track.codec_params.sample_rate.unwrap_or(0);
    let mut decoder = symphonia::default::get_codecs()
        .make(&track.codec_params, &DecoderOptions::default())
        .map_err(|e| format!("Codec no soportado: {e}"))?;

    let mut out: Vec<f32> = Vec::new();
    if let Some(n) = track.codec_params.n_frames {
        out.reserve((n as usize).saturating_mul(2));
    }
    let mut buf: Option<symphonia::core::audio::SampleBuffer<f32>> = None;
    loop {
        let packet = match format.next_packet() {
            Ok(p) => p,
            Err(SymphoniaError::IoError(_)) | Err(SymphoniaError::ResetRequired) => break,
            Err(e) => return Err(format!("Error leyendo el archivo: {e}")),
        };
        if packet.track_id() != track_id {
            continue;
        }
        let decoded = match decoder.decode(&packet) {
            Ok(d) => d,
            Err(SymphoniaError::DecodeError(_)) | Err(SymphoniaError::IoError(_)) => continue,
            Err(e) => return Err(format!("Error decodificando audio: {e}")),
        };
        let spec = *decoded.spec();
        if rate == 0 {
            rate = spec.rate;
        }
        let needed = decoded.capacity() as u64;
        if buf.as_ref().map(|b| b.capacity() < needed as usize).unwrap_or(true) {
            buf = Some(symphonia::core::audio::SampleBuffer::<f32>::new(needed, spec));
        }
        let sb = buf.as_mut().expect("buffer");
        sb.copy_interleaved_ref(decoded);
        downmix_into(sb.samples(), &downmix_weights(spec.channels), &mut out);
    }
    if rate == 0 {
        return Err("No se pudo leer la frecuencia del audio".into());
    }
    Ok((rate, out))
}

/// Remuestreo de alta calidad (FFT) de estereo entrelazado.
fn resample(data: &[f32], from: u32, to: u32) -> Result<Vec<f32>, String> {
    const CHUNK: usize = 4096;
    let frames = data.len() / 2;
    let mut rs = FftFixedIn::<f32>::new(from as usize, to as usize, CHUNK, 2, 2)
        .map_err(|e| format!("No se pudo preparar el remuestreo: {e}"))?;
    let delay = rs.output_delay();
    let expected = ((frames as u64 * to as u64) / from as u64) as usize;
    let mut out: Vec<f32> = Vec::with_capacity((expected + delay + CHUNK) * 2);
    let mut left = vec![0f32; CHUNK];
    let mut right = vec![0f32; CHUNK];
    let mut outbuf = rs.output_buffer_allocate(true);
    let mut pos = 0usize;
    let push = |out: &mut Vec<f32>, ob: &[Vec<f32>], n: usize| {
        for i in 0..n {
            out.push(ob[0][i]);
            out.push(ob[1][i]);
        }
    };
    while pos < frames {
        let n = (frames - pos).min(CHUNK);
        for i in 0..n {
            left[i] = data[(pos + i) * 2];
            right[i] = data[(pos + i) * 2 + 1];
        }
        let produced = if n == CHUNK {
            let (_, p) = rs
                .process_into_buffer(&[&left[..], &right[..]], &mut outbuf, None)
                .map_err(|e| format!("Error de remuestreo: {e}"))?;
            p
        } else {
            let (_, p) = rs
                .process_partial_into_buffer(Some(&[&left[..n], &right[..n]]), &mut outbuf, None)
                .map_err(|e| format!("Error de remuestreo: {e}"))?;
            p
        };
        push(&mut out, &outbuf, produced);
        pos += n;
    }
    // Vacia lo que queda en el remuestreador hasta cubrir el retardo.
    while out.len() / 2 < expected + delay {
        let (_, p) = rs
            .process_partial_into_buffer(None::<&[&[f32]]>, &mut outbuf, None)
            .map_err(|e| format!("Error de remuestreo: {e}"))?;
        if p == 0 {
            break;
        }
        push(&mut out, &outbuf, p);
    }
    let start = delay.min(out.len() / 2) * 2;
    let end = ((delay + expected) * 2).min(out.len());
    Ok(out[start..end].to_vec())
}

#[cfg(test)]
mod downmix_tests {
    use super::*;
    use symphonia::core::audio::Channels as C;

    #[test]
    fn surround_keeps_centre() {
        let ch = C::FRONT_LEFT | C::FRONT_RIGHT | C::FRONT_CENTRE | C::LFE1 | C::REAR_LEFT | C::REAR_RIGHT;
        let w = downmix_weights(ch);
        let mut out = Vec::new();
        // Solo suena el central (orden: FL FR FC LFE RL RR)
        downmix_into(&[0.0, 0.0, 1.0, 0.0, 0.0, 0.0], &w, &mut out);
        assert!(out[0] > 0.2 && (out[0] - out[1]).abs() < 1e-6, "{out:?}");
        // El LFE no entra
        out.clear();
        downmix_into(&[0.0, 0.0, 0.0, 1.0, 0.0, 0.0], &w, &mut out);
        assert_eq!(out, vec![0.0, 0.0]);
    }

    #[test]
    fn stereo_untouched() {
        let w = downmix_weights(C::FRONT_LEFT | C::FRONT_RIGHT);
        let mut out = Vec::new();
        downmix_into(&[0.25, -0.5], &w, &mut out);
        assert_eq!(out, vec![0.25, -0.5]);
    }
}

#[cfg(test)]
mod centre_tests {
    /// Voz centrada (L = R): tras decodificar y remuestrear, L y R deben ser
    /// identicos. Archivos en MIRADIO_CENTRE_DIR (c.flac, c.mp3, c.m4a).
    #[test]
    fn centred_stays_centred() {
        let Ok(dir) = std::env::var("MIRADIO_CENTRE_DIR") else { return };
        for f in ["c.flac", "c.mp3", "c.m4a"] {
            let p = std::path::Path::new(&dir).join(f);
            let pcm = super::decode_file(&p, 48_000).unwrap();
            let mut diff = 0.0f32;
            let mut peak = 0.0f32;
            for fr in pcm.data.chunks_exact(2) {
                diff = diff.max((fr[0] - fr[1]).abs());
                peak = peak.max(fr[0].abs());
            }
            eprintln!("{f}: pico {peak:.3}, diferencia L-R {diff:.6}");
            assert!(diff < 1e-3, "{f}: L y R no coinciden ({diff})");
        }
    }
}

#[cfg(test)]
mod flac_compare_tests {
    /// Compara lo que decodifica OmniCaster con lo que decodifica FFmpeg (f32,
    /// misma frecuencia) para cada archivo de MIRADIO_FLAC_DIR.
    #[test]
    fn matches_ffmpeg() {
        let Ok(dir) = std::env::var("MIRADIO_FLAC_DIR") else { return };
        let mut bad = Vec::new();
        let mut files: Vec<_> = std::fs::read_dir(&dir).unwrap().flatten().map(|e| e.path()).filter(|p| p.extension().map(|e| e == "flac").unwrap_or(false)).collect();
        files.sort();
        for p in files {
            let (rate, ours) = super::decode_native(&p).unwrap();
            let out = std::process::Command::new("ffmpeg")
                .args(["-loglevel", "error", "-i"])
                .arg(&p)
                .args(["-f", "f32le", "-ac", "2", "-ar"])
                .arg(rate.to_string())
                .arg("-")
                .output()
                .unwrap();
            let refs: Vec<f32> = out.stdout.chunks_exact(4).map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]])).collect();
            let n = ours.len().min(refs.len());
            let mut maxd = 0.0f32;
            for i in 0..n {
                maxd = maxd.max((ours[i] - refs[i]).abs());
            }
            let name = p.file_name().unwrap().to_string_lossy().to_string();
            eprintln!("{name}: {rate} Hz, nuestras {} / ffmpeg {} muestras, diferencia max {maxd:.6}", ours.len(), refs.len());
            if maxd > 1e-3 || (ours.len() as i64 - refs.len() as i64).abs() > 4096 {
                bad.push(name);
            }
        }
        assert!(bad.is_empty(), "difieren: {bad:?}");
    }
}
