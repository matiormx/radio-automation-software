//! Reconocimiento de voz local (whisper.cpp) para la IA de metadatos: cuando
//! una canción no tiene letra (ni en el archivo ni en LRCLIB), se escucha un
//! trozo cantado y se saca el idioma de la voz y un fragmento de lo que dice.
//!
//! - Todo ocurre en este equipo: el audio no sale de él.
//! - whisper.cpp va como programa aparte (si fallara, no tumba OmniCaster) y
//!   con prioridad mínima y pocos hilos, para no quitarle CPU al audio.
//! - En Windows se descargan solos el programa (whisper.cpp v1.8.2, firma
//!   SHA-256 comprobada) y el modelo «base» multilingüe (~142 MB) la primera
//!   vez que hacen falta. En Linux se usa `whisper-cli` si está instalado.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

const BIN_URL: &str = "https://github.com/ggml-org/whisper.cpp/releases/download/v1.8.2/whisper-bin-x64.zip";
const BIN_SHA256: &str = "b1514ebc099765e39fa37eb780b92a140a94c86bb0b3b3d98226b38825979732";
const BIN_DIR: &str = "bin-v1.8.2";
const MODEL_URL: &str = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin";
const MODEL_FILE: &str = "ggml-base.bin";
/// Segundos de audio que se escuchan en cada intento.
const CLIP_SECS: u32 = 30;
/// Un reconocimiento que se alarga más que esto se corta.
const RUN_LIMIT: Duration = Duration::from_secs(150);

/// Lo que se ha oído en la canción.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Voice {
    /// Código ISO 639-1 detectado ("es", "en"…)
    pub language: String,
    /// Seguridad de la detección, 0..1
    pub probability: f64,
    /// Fragmento reconocido (vacío = no se oye voz)
    pub text: String,
}

/// Un reconocimiento cada vez (también evita dos descargas a la vez).
static BUSY: Mutex<()> = Mutex::new(());
/// Tras un fallo de descarga no se reintenta en cada canción.
static LAST_FAIL: Mutex<Option<(Instant, String)>> = Mutex::new(None);

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
#[cfg(windows)]
const IDLE_PRIORITY_CLASS: u32 = 0x0000_0040;

fn root(data_dir: &Path) -> PathBuf {
    data_dir.join("whisper")
}

fn cli_name() -> &'static str {
    if cfg!(windows) {
        "whisper-cli.exe"
    } else {
        "whisper-cli"
    }
}

/// Programa whisper-cli: el descargado o, si no, uno del sistema.
fn find_cli(data_dir: &Path) -> Option<PathBuf> {
    let own = root(data_dir).join(BIN_DIR).join(cli_name());
    if own.is_file() {
        return Some(own);
    }
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path).map(|d| d.join(cli_name())).find(|p| p.is_file())
}

fn model_ok(p: &Path) -> bool {
    let Ok(meta) = std::fs::metadata(p) else { return false };
    if meta.len() < 100_000_000 {
        return false;
    }
    let mut magic = [0u8; 4];
    std::fs::File::open(p).and_then(|mut f| f.read_exact(&mut magic)).is_ok() && &magic == b"lmgg"
}

fn download_to(url: &str, dest: &Path, timeout: Duration) -> Result<(), String> {
    let resp = ureq::get(url)
        .timeout(timeout)
        .set("User-Agent", concat!("OmniCaster/", env!("CARGO_PKG_VERSION")))
        .call()
        .map_err(|e| format!("No se pudo descargar {url}: {e}"))?;
    let part = dest.with_extension("part");
    let mut file = std::fs::File::create(&part).map_err(|e| e.to_string())?;
    std::io::copy(&mut resp.into_reader(), &mut file).map_err(|e| {
        let _ = std::fs::remove_file(&part);
        format!("Se cortó la descarga: {e}")
    })?;
    drop(file);
    std::fs::rename(&part, dest).map_err(|e| e.to_string())
}

/// Instala whisper-cli (Windows) y el modelo si faltan. Devuelve (programa, modelo).
fn ensure(data_dir: &Path) -> Result<(PathBuf, PathBuf), String> {
    if let Some((at, err)) = LAST_FAIL.lock().ok().and_then(|g| g.clone()) {
        if at.elapsed() < Duration::from_secs(600) {
            return Err(err);
        }
    }
    let res = (|| {
        let dir = root(data_dir);
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let cli = match find_cli(data_dir) {
            Some(p) => p,
            None if cfg!(windows) => {
                let zip_path = dir.join("whisper-bin.zip");
                download_to(BIN_URL, &zip_path, Duration::from_secs(120))?;
                let bytes = std::fs::read(&zip_path).map_err(|e| e.to_string())?;
                let _ = std::fs::remove_file(&zip_path);
                use sha2::{Digest, Sha256};
                if format!("{:x}", Sha256::digest(&bytes)) != BIN_SHA256 {
                    return Err("La descarga de whisper.cpp no coincide con su firma: se descarta".to_string());
                }
                extract(&bytes, &dir.join(BIN_DIR))?;
                find_cli(data_dir).ok_or("El paquete de whisper.cpp no trae whisper-cli")?
            }
            None => return Err("No está instalado whisper-cli (whisper.cpp)".to_string()),
        };
        let model = dir.join(MODEL_FILE);
        if !model_ok(&model) {
            crate::crashlog::note("IA: descargando el modelo de voz de Whisper (~142 MB)");
            download_to(MODEL_URL, &model, Duration::from_secs(900))?;
            if !model_ok(&model) {
                let _ = std::fs::remove_file(&model);
                return Err("El modelo de Whisper descargado no es válido".to_string());
            }
        }
        Ok((cli, model))
    })();
    if let Err(e) = &res {
        if let Ok(mut g) = LAST_FAIL.lock() {
            *g = Some((Instant::now(), e.clone()));
        }
    }
    res
}

/// Saca whisper-cli.exe y sus DLL del zip (vienen en Release/).
fn extract(bytes: &[u8], dir: &Path) -> Result<(), String> {
    let mut zip = zip::ZipArchive::new(std::io::Cursor::new(bytes)).map_err(|e| format!("Zip de whisper.cpp dañado: {e}"))?;
    let tmp = dir.with_extension("tmp");
    let _ = std::fs::remove_dir_all(&tmp);
    std::fs::create_dir_all(&tmp).map_err(|e| e.to_string())?;
    for i in 0..zip.len() {
        let mut f = zip.by_index(i).map_err(|e| e.to_string())?;
        let name = f.name().replace('\\', "/");
        let base = name.rsplit('/').next().unwrap_or("").to_string();
        let lower = base.to_ascii_lowercase();
        if !(lower.ends_with(".dll") || lower == "whisper-cli.exe") {
            continue;
        }
        let mut out = std::fs::File::create(tmp.join(&base)).map_err(|e| e.to_string())?;
        std::io::copy(&mut f, &mut out).map_err(|e| e.to_string())?;
    }
    let _ = std::fs::remove_dir_all(dir);
    std::fs::rename(&tmp, dir).map_err(|e| e.to_string())
}

/// Ejecuta un programa a baja prioridad, sin ventana y con tiempo máximo.
fn run_quiet(mut cmd: Command, limit: Duration) -> Result<(String, String), String> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW | IDLE_PRIORITY_CLASS);
    }
    let mut child = cmd
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| e.to_string())?;
    // Las salidas se leen en hilos para que el programa nunca se quede
    // esperando con el búfer lleno.
    let mut so = child.stdout.take();
    let mut se = child.stderr.take();
    let t_out = std::thread::spawn(move || {
        let mut s = String::new();
        if let Some(o) = so.as_mut() {
            let _ = o.read_to_string(&mut s);
        }
        s
    });
    let t_err = std::thread::spawn(move || {
        let mut s = String::new();
        if let Some(e) = se.as_mut() {
            let _ = e.read_to_string(&mut s);
        }
        s
    });
    let start = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if start.elapsed() > limit => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("El reconocimiento de voz tardó demasiado".to_string());
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(100)),
            Err(e) => return Err(e.to_string()),
        }
    }
    Ok((t_out.join().unwrap_or_default(), t_err.join().unwrap_or_default()))
}

fn low_priority(program: &Path) -> Command {
    // En Linux, con `nice` (prioridad mínima); en Windows se pone al lanzar.
    if cfg!(unix) && Path::new("/usr/bin/nice").is_file() {
        let mut c = Command::new("/usr/bin/nice");
        c.arg("-n").arg("19").arg(program);
        c
    } else {
        Command::new(program)
    }
}

/// Idioma detectado en la salida de whisper-cli:
/// «auto-detected language: es (p = 0.973453)».
pub fn parse_language(stderr: &str) -> Option<(String, f64)> {
    let line = stderr.lines().find(|l| l.contains("auto-detected language:"))?;
    let rest = line.split("auto-detected language:").nth(1)?.trim();
    let lang = rest.split_whitespace().next()?.trim().to_ascii_lowercase();
    let p = rest
        .split("p =")
        .nth(1)
        .and_then(|x| x.trim().trim_end_matches(')').trim().parse::<f64>().ok())
        .unwrap_or(0.0);
    (!lang.is_empty()).then_some((lang, p))
}

/// Quita lo que no es letra: [Música], (aplausos), ♪… y deja un fragmento.
pub fn clean_text(stdout: &str) -> String {
    let mut out = String::new();
    let mut depth = 0i32;
    for ch in stdout.chars() {
        match ch {
            '[' | '(' | '{' => depth += 1,
            ']' | ')' | '}' => depth = (depth - 1).max(0),
            '♪' | '♫' | '♬' | '*' => {}
            _ if depth == 0 => out.push(if ch == '\n' || ch == '\r' { ' ' } else { ch }),
            _ => {}
        }
    }
    let joined = out.split_whitespace().collect::<Vec<_>>().join(" ");
    joined.chars().take(700).collect()
}

/// Escucha la canción y dice qué idioma se canta. `Ok(None)` = no se oye voz
/// (probablemente instrumental).
pub fn listen(data_dir: &Path, ffmpeg: &Path, file: &str, duration: f64) -> Result<Option<Voice>, String> {
    let _guard = BUSY.lock().unwrap_or_else(|e| e.into_inner());
    let (cli, model) = ensure(data_dir)?;
    let tmp = std::env::temp_dir().join(format!("omnicaster-voz-{}.wav", std::process::id()));
    let threads = std::thread::available_parallelism().map(|n| (n.get() / 3).clamp(1, 3)).unwrap_or(2);
    let mut best: Option<Voice> = None;
    // Primero hacia el centro (suele haber voz); si no se oye nada, más adelante.
    let starts: Vec<f64> = if duration > 75.0 {
        vec![duration * 0.35, duration * 0.62]
    } else {
        vec![(duration * 0.15).max(0.0)]
    };
    for start in starts {
        let mut ff = low_priority(ffmpeg);
        ff.args(["-nostdin", "-v", "error", "-y", "-ss"])
            .arg(format!("{start:.1}"))
            .args(["-t", &CLIP_SECS.to_string(), "-i"])
            .arg(file)
            .args(["-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le"])
            .arg(&tmp);
        run_quiet(ff, Duration::from_secs(60)).map_err(|e| format!("FFmpeg no pudo leer el audio: {e}"))?;
        if !tmp.is_file() {
            return Err("FFmpeg no pudo leer el audio".to_string());
        }
        let mut wc = low_priority(&cli);
        wc.arg("-m")
            .arg(&model)
            .arg("-f")
            .arg(&tmp)
            .args(["-l", "auto", "-nt", "-nf", "-bs", "1", "-bo", "1", "-t", &threads.to_string()]);
        let res = run_quiet(wc, RUN_LIMIT);
        let _ = std::fs::remove_file(&tmp);
        let (stdout, stderr) = res?;
        let Some((language, probability)) = parse_language(&stderr) else {
            let last = stderr.lines().rev().find(|l| !l.trim().is_empty()).unwrap_or("sin detalle");
            return Err(format!("whisper-cli no devolvió el idioma ({last})"));
        };
        let text = clean_text(&stdout);
        let voice = Voice { language, probability, text };
        if voice.text.chars().filter(|c| c.is_alphabetic()).count() >= 15 {
            return Ok(Some(voice));
        }
        best.get_or_insert(voice);
    }
    // No se oyó letra en ningún trozo: el idioma detectado sería un invento.
    let _ = best;
    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_language_and_text() {
        let err = "whisper_init_from_file\nwhisper_full_with_state: auto-detected language: es (p = 0.973453)\n";
        assert_eq!(parse_language(err), Some(("es".to_string(), 0.973453)));
        assert_eq!(parse_language("nada"), None);
        let out = " [Música]\n Te quiero ver ♪ bailar (aplausos)\n otra vez\n";
        assert_eq!(clean_text(out), "Te quiero ver bailar otra vez");
        assert_eq!(clean_text(" [Music]\n ♪ ♪\n"), "");
    }
}
