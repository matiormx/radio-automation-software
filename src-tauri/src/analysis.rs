use ebur128_stream::{Analyzer, AnalyzerBuilder, Channel, Mode};
use serde::Serialize;
use std::fs;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};
use symphonia::core::codecs::{DecoderOptions, CODEC_TYPE_NULL};
use symphonia::core::errors::Error as SymphoniaError;
use symphonia::core::formats::FormatOptions;
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;
use tauri::State;

use crate::library::{read_library_internal, write_library};
use crate::AppState;

/// Tramo de analisis para detectar silencios y dibujar la onda.
const FRAME_SECS: f64 = 0.05;
/// Por debajo de este nivel se considera silencio (-50 dBFS).
const SILENCE_DB: f64 = -50.0;
/// Silencio minimo para recortar; los huecos cortos se dejan.
const MIN_SILENCE_SECS: f64 = 0.35;
/// Margen que se conserva a cada lado para no cortar respiraciones.
const TRIM_PAD_SECS: f64 = 0.10;

struct Scan {
    peaks: Vec<f32>,
    duration: f64,
    sample_rate: u32,
    lufs: Option<f64>,
    true_peak_db: Option<f64>,
}

fn round2(v: f64) -> f64 {
    (v * 100.0).round() / 100.0
}

fn round3(v: f64) -> f64 {
    (v * 1000.0).round() / 1000.0
}

fn now_epoch() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn file_signature(path: &Path) -> String {
    match fs::metadata(path) {
        Ok(m) => {
            let modified = m
                .modified()
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_secs())
                .unwrap_or(0);
            format!("{}-{}", m.len(), modified)
        }
        Err(_) => String::new(),
    }
}

/// Decodifica el archivo en streaming y mide sonoridad, pico real,
/// duracion y la envolvente cada 50 ms. No guarda el PCM completo.
fn scan_file(path: &Path) -> Result<Scan, String> {
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
            &FormatOptions {
                enable_gapless: true,
                ..Default::default()
            },
            &MetadataOptions::default(),
        )
        .map_err(|e| format!("Formato no soportado para analisis: {e}"))?;
    let mut format = probed.format;

    let track = format
        .tracks()
        .iter()
        .find(|t| t.codec_params.codec != CODEC_TYPE_NULL)
        .ok_or_else(|| "El archivo no tiene pistas de audio decodificables".to_string())?;
    let track_id = track.id;
    let mut decoder = symphonia::default::get_codecs()
        .make(&track.codec_params, &DecoderOptions::default())
        .map_err(|e| format!("Codec no soportado: {e}"))?;

    let mut analyzer: Option<Analyzer> = None;
    let mut sample_rate = 0u32;
    let mut frame_len = 0usize;
    let mut frame_peak = 0f32;
    let mut frame_count = 0usize;
    let mut frames_total: u64 = 0;
    let mut peaks: Vec<f32> = Vec::new();
    let mut stereo: Vec<f32> = Vec::new();

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
        if analyzer.is_none() {
            sample_rate = spec.rate;
            frame_len = ((sample_rate as f64 * FRAME_SECS).round() as usize).max(1);
            analyzer = Some(
                AnalyzerBuilder::new()
                    .sample_rate(sample_rate)
                    .channels(&[Channel::Left, Channel::Right])
                    .modes(Mode::Integrated | Mode::TruePeak)
                    .build()
                    .map_err(|e| format!("No se pudo iniciar el medidor: {e}"))?,
            );
        }

        let channels = spec.channels.count().max(1);
        let mut sample_buf =
            symphonia::core::audio::SampleBuffer::<f32>::new(decoded.capacity() as u64, spec);
        sample_buf.copy_interleaved_ref(decoded);
        let samples = sample_buf.samples();

        stereo.clear();
        if channels == 1 {
            for &s in samples {
                stereo.push(s);
                stereo.push(s);
            }
        } else {
            for ch in samples.chunks_exact(channels) {
                stereo.push(ch[0]);
                stereo.push(ch[1]);
            }
        }
        let frames = (stereo.len() / 2) as u64;
        frames_total += frames;

        if let Some(a) = analyzer.as_mut() {
            a.push_interleaved(&stereo)
                .map_err(|e| format!("Error midiendo sonoridad: {e}"))?;
        }

        for pair in stereo.chunks_exact(2) {
            let p = pair[0].abs().max(pair[1].abs());
            if p > frame_peak {
                frame_peak = p;
            }
            frame_count += 1;
            if frame_count >= frame_len {
                peaks.push(frame_peak);
                frame_peak = 0.0;
                frame_count = 0;
            }
        }
    }

    if sample_rate == 0 || frames_total == 0 {
        return Err("No se pudo decodificar audio del archivo".to_string());
    }
    if frame_count > 0 {
        peaks.push(frame_peak);
    }

    let analyzer = analyzer.ok_or_else(|| "No se pudo analizar el archivo".to_string())?;
    let report = analyzer.finalize();
    let lufs = report.integrated_lufs().filter(|v| v.is_finite());
    let true_peak_db = report.true_peak_dbtp().filter(|v| v.is_finite());

    Ok(Scan {
        peaks,
        duration: frames_total as f64 / sample_rate as f64,
        sample_rate,
        lufs,
        true_peak_db,
    })
}

fn auto_trim(peaks: &[f32], duration: f64) -> (f64, Option<f64>) {
    let threshold = 10f32.powf(SILENCE_DB as f32 / 20.0);
    let first = peaks.iter().position(|p| *p > threshold);
    let last = peaks.iter().rposition(|p| *p > threshold);
    let (Some(first), Some(last)) = (first, last) else {
        return (0.0, None);
    };

    let start_raw = first as f64 * FRAME_SECS - TRIM_PAD_SECS;
    let end_raw = (last as f64 + 1.0) * FRAME_SECS + TRIM_PAD_SECS;
    let start = if start_raw >= MIN_SILENCE_SECS {
        start_raw.max(0.0)
    } else {
        0.0
    };
    let end = if duration - end_raw >= MIN_SILENCE_SECS {
        end_raw.min(duration)
    } else {
        duration
    };

    if end - start < 0.5 {
        return (0.0, None);
    }
    let start = round3(start);
    let end = round3(end);
    let trim_end = if end >= duration - 0.02 { None } else { Some(end) };
    (start, trim_end)
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AnalysisOut {
    pub id: String,
    pub duration_secs: f64,
    pub lufs: Option<f64>,
    pub gain_db: Option<f64>,
    pub true_peak_db: Option<f64>,
    pub limited: bool,
    pub trim_start: f64,
    pub trim_end: Option<f64>,
    pub auto_trim_start: f64,
    pub auto_trim_end: Option<f64>,
    pub trim_manual: bool,
    pub analyzed_at: u64,
}

#[tauri::command]
pub async fn analyze_track(
    state: State<'_, AppState>,
    id: String,
    target_lufs: f64,
    true_peak_db: f64,
) -> Result<AnalysisOut, String> {
    if !target_lufs.is_finite() || !(-40.0..=-5.0).contains(&target_lufs) {
        return Err("El objetivo debe estar entre -40 y -5 LUFS".to_string());
    }
    if !true_peak_db.is_finite() || !(-6.0..=0.0).contains(&true_peak_db) {
        return Err("El techo de pico debe estar entre -6 y 0 dBTP".to_string());
    }

    let file = {
        let tracks = read_library_internal(&state.data_dir);
        let t = tracks
            .iter()
            .find(|t| t.id == id)
            .ok_or_else(|| "La cancion ya no existe en la biblioteca".to_string())?;
        t.file.trim().to_string()
    };
    let path = Path::new(&file);
    if file.is_empty() || !path.is_file() {
        return Err("El archivo de la cancion no esta disponible".to_string());
    }

    let scan = scan_file(path)?;

    let _guard = crate::library::lock_library();
    let mut tracks = read_library_internal(&state.data_dir);
    let Some(t) = tracks.iter_mut().find(|t| t.id == id) else {
        return Err("La cancion ya no existe en la biblioteca".to_string());
    };
    let lufs = scan
        .lufs
        .ok_or_else(|| "No se pudo medir la sonoridad (pista silenciosa o demasiado corta)".to_string())?;
    let mut gain = target_lufs - lufs;
    let mut limited = false;
    if let Some(tp) = scan.true_peak_db {
        if tp + gain > true_peak_db {
            gain = true_peak_db - tp;
            limited = true;
        }
    }
    gain = gain.clamp(-40.0, 24.0);

    let (auto_start, auto_end) = auto_trim(&scan.peaks, scan.duration);

    t.duration_secs = round2(scan.duration);
    t.lufs = Some(round2(lufs));
    t.gain_db = Some(round2(gain));
    t.true_peak_db = scan.true_peak_db.map(round2);
    t.limited = limited;
    t.auto_trim_start = auto_start;
    t.auto_trim_end = auto_end;
    if !t.trim_manual {
        t.trim_start = auto_start;
        t.trim_end = auto_end;
    }
    t.analysis_sig = file_signature(path);
    t.analyzed_at = now_epoch();

    let out = AnalysisOut {
        id: t.id.clone(),
        duration_secs: t.duration_secs,
        lufs: t.lufs,
        gain_db: t.gain_db,
        true_peak_db: t.true_peak_db,
        limited: t.limited,
        trim_start: t.trim_start,
        trim_end: t.trim_end,
        auto_trim_start: t.auto_trim_start,
        auto_trim_end: t.auto_trim_end,
        trim_manual: t.trim_manual,
        analyzed_at: t.analyzed_at,
    };
    write_library(&state.data_dir, &tracks)?;
    Ok(out)
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Waveform {
    pub duration_secs: f64,
    pub sample_rate: u32,
    pub peaks: Vec<f32>,
}

/// Envolvente para el editor manual de recorte. Se calcula al abrir
/// la pista, no se guarda en la biblioteca.
#[tauri::command]
pub async fn track_waveform(
    state: State<'_, AppState>,
    id: String,
    buckets: Option<usize>,
) -> Result<Waveform, String> {
    let tracks = read_library_internal(&state.data_dir);
    let t = tracks
        .iter()
        .find(|t| t.id == id)
        .ok_or_else(|| "La cancion ya no existe en la biblioteca".to_string())?;
    let path = Path::new(t.file.trim());
    if t.file.trim().is_empty() || !path.is_file() {
        return Err("El archivo de la cancion no esta disponible".to_string());
    }
    let scan = scan_file(path)?;
    let wanted = buckets.unwrap_or(900).clamp(80, 4000);
    let peaks = downsample(&scan.peaks, wanted);
    Ok(Waveform {
        duration_secs: scan.duration,
        sample_rate: scan.sample_rate,
        peaks,
    })
}

fn downsample(peaks: &[f32], buckets: usize) -> Vec<f32> {
    if peaks.is_empty() {
        return Vec::new();
    }
    let mut out = Vec::with_capacity(buckets);
    for i in 0..buckets {
        let start = i * peaks.len() / buckets;
        let end = ((i + 1) * peaks.len() / buckets).max(start + 1).min(peaks.len());
        let peak = peaks[start..end].iter().copied().fold(0f32, f32::max);
        out.push(peak);
    }
    out
}
