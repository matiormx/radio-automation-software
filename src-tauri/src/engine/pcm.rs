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
        let channels = spec.channels.count().max(1);
        let needed = decoded.capacity() as u64;
        if buf.as_ref().map(|b| b.capacity() < needed as usize).unwrap_or(true) {
            buf = Some(symphonia::core::audio::SampleBuffer::<f32>::new(needed, spec));
        }
        let sb = buf.as_mut().expect("buffer");
        sb.copy_interleaved_ref(decoded);
        let samples = sb.samples();
        if channels == 1 {
            for &s in samples {
                out.push(s);
                out.push(s);
            }
        } else {
            for ch in samples.chunks_exact(channels) {
                out.push(ch[0]);
                out.push(ch[1]);
            }
        }
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
