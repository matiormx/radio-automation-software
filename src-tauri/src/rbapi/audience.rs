//! Historial de oyentes: una muestra por minuto (el total de los montajes
//! propios) en `<datos>/oyentes.log`, para ver la audiencia por franjas.
//!
//! Formato del archivo: una línea por minuto, «segundos_unix oyentes». Se
//! guardan los últimos 400 días (~575 000 líneas, unos 8 MB).

use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use chrono::{Datelike, Local, TimeZone, Timelike};
use serde::Serialize;

const FILE: &str = "oyentes.log";
const KEEP_SECS: u64 = 400 * 24 * 3600;

struct Store {
    path: PathBuf,
    samples: Vec<(u64, u32)>,
    loaded: bool,
}

static STORE: Mutex<Option<Store>> = Mutex::new(None);

fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

fn load(path: &Path) -> Vec<(u64, u32)> {
    let cut = now().saturating_sub(KEEP_SECS);
    let text = std::fs::read_to_string(path).unwrap_or_default();
    let mut v: Vec<(u64, u32)> = text
        .lines()
        .filter_map(|l| {
            let mut it = l.split_whitespace();
            Some((it.next()?.parse().ok()?, it.next()?.parse().ok()?))
        })
        .filter(|(t, _)| *t >= cut)
        .collect();
    v.sort_by_key(|x| x.0);
    v.dedup_by_key(|x| x.0 / 60);
    v
}

/// Prepara el historial (se llama al arrancar el sondeo).
pub fn init(data_dir: &Path) {
    let mut g = STORE.lock().unwrap_or_else(|e| e.into_inner());
    if g.is_none() {
        *g = Some(Store { path: data_dir.join(FILE), samples: Vec::new(), loaded: false });
    }
}

fn with<R>(f: impl FnOnce(&mut Store) -> R) -> Option<R> {
    let mut g = STORE.lock().unwrap_or_else(|e| e.into_inner());
    let st = g.as_mut()?;
    if !st.loaded {
        st.samples = load(&st.path);
        st.loaded = true;
        // Se reescribe ya recortado (lo viejo fuera).
        let body: String = st.samples.iter().map(|(t, n)| format!("{t} {n}\n")).collect();
        let _ = std::fs::write(&st.path, body);
    }
    Some(f(st))
}

/// Apunta el total de oyentes (como mucho una muestra por minuto).
pub fn record(total: u64) {
    let t = now();
    let n = total.min(u32::MAX as u64) as u32;
    with(|st| {
        if st.samples.last().map(|(lt, _)| lt / 60 == t / 60).unwrap_or(false) {
            // Mismo minuto: se queda el mayor.
            if let Some(last) = st.samples.last_mut() {
                last.1 = last.1.max(n);
            }
            return;
        }
        st.samples.push((t, n));
        if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&st.path) {
            let _ = writeln!(f, "{t} {n}");
        }
    });
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Point {
    /// Segundos unix del inicio del tramo
    pub t: u64,
    pub avg: f64,
    pub max: u32,
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Stats {
    /// Días que abarca el resumen
    pub days: u32,
    /// Muestras (minutos) con datos en el periodo
    pub samples: usize,
    /// Primera muestra guardada (para saber desde cuándo hay datos)
    pub since: u64,
    /// Últimas 24 horas en tramos de 10 minutos
    pub last24h: Vec<Point>,
    /// Media y máximo por hora del día (0..23), en el periodo
    pub by_hour: Vec<Point>,
    /// Media por día de la semana (lunes = 0) y hora: 7 × 24
    pub heat: Vec<Vec<f64>>,
    /// Máximo del periodo y cuándo
    pub peak: u32,
    pub peak_at: u64,
    /// Media de todo el periodo
    pub avg: f64,
    /// Las tres franjas horarias con más audiencia media («20-21»…)
    pub best_hours: Vec<u32>,
}

/// Resumen de los últimos `days` días, en la hora local del equipo.
pub fn stats(days: u32) -> Stats {
    let days = days.clamp(1, 400);
    with(|st| compute(&st.samples, now(), days)).unwrap_or_default()
}

pub fn compute(samples: &[(u64, u32)], now: u64, days: u32) -> Stats {
    let from = now.saturating_sub(days as u64 * 86_400);
    let in_range: Vec<&(u64, u32)> = samples.iter().filter(|(t, _)| *t >= from && *t <= now).collect();
    let mut out = Stats { days, samples: in_range.len(), since: samples.first().map(|x| x.0).unwrap_or(0), ..Default::default() };

    // Últimas 24 h, tramos de 10 minutos.
    let start = (now.saturating_sub(86_400) / 600) * 600;
    let mut buckets: Vec<(u64, f64, u32)> = (0..=144).map(|i| (start + i * 600, 0.0, 0)).collect();
    for (t, n) in samples.iter().filter(|(t, _)| *t >= start) {
        let i = ((t - start) / 600) as usize;
        if let Some(b) = buckets.get_mut(i) {
            b.1 += *n as f64;
            b.2 += 1;
            // el máximo va aparte en la conversión
        }
    }
    let mut maxes = vec![0u32; buckets.len()];
    for (t, n) in samples.iter().filter(|(t, _)| *t >= start) {
        let i = ((t - start) / 600) as usize;
        if let Some(m) = maxes.get_mut(i) {
            *m = (*m).max(*n);
        }
    }
    out.last24h = buckets
        .iter()
        .zip(maxes.iter())
        .filter(|((t, _, _), _)| *t <= now)
        .map(|((t, sum, c), m)| Point { t: *t, avg: if *c > 0 { sum / *c as f64 } else { -1.0 }, max: *m })
        .collect();

    // Por hora del día y por día de la semana × hora.
    let mut hour_sum = [0f64; 24];
    let mut hour_cnt = [0u32; 24];
    let mut hour_max = [0u32; 24];
    let mut heat_sum = vec![vec![0f64; 24]; 7];
    let mut heat_cnt = vec![vec![0u32; 24]; 7];
    let mut total = 0f64;
    for (t, n) in &in_range {
        let Some(dt) = Local.timestamp_opt(*t as i64, 0).single() else { continue };
        let h = dt.hour() as usize;
        let wd = dt.weekday().num_days_from_monday() as usize;
        hour_sum[h] += *n as f64;
        hour_cnt[h] += 1;
        hour_max[h] = hour_max[h].max(*n);
        heat_sum[wd][h] += *n as f64;
        heat_cnt[wd][h] += 1;
        total += *n as f64;
        if *n > out.peak {
            out.peak = *n;
            out.peak_at = *t;
        }
    }
    out.avg = if in_range.is_empty() { 0.0 } else { total / in_range.len() as f64 };
    out.by_hour = (0..24)
        .map(|h| Point { t: h as u64, avg: if hour_cnt[h] > 0 { hour_sum[h] / hour_cnt[h] as f64 } else { -1.0 }, max: hour_max[h] })
        .collect();
    out.heat = (0..7)
        .map(|d| (0..24).map(|h| if heat_cnt[d][h] > 0 { heat_sum[d][h] / heat_cnt[d][h] as f64 } else { -1.0 }).collect())
        .collect();
    let mut ranked: Vec<(usize, f64)> = out.by_hour.iter().enumerate().filter(|(_, p)| p.avg > 0.0).map(|(h, p)| (h, p.avg)).collect();
    ranked.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    out.best_hours = ranked.into_iter().take(3).map(|(h, _)| h as u32).collect();
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hours_and_peak() {
        let base = Local.with_ymd_and_hms(2026, 10, 26, 0, 0, 0).single().unwrap().timestamp() as u64; // lunes
        let mut s = Vec::new();
        for m in 0..(24 * 60) {
            let h = m / 60;
            let n = if h == 20 { 50 } else if h == 8 { 30 } else { 5 };
            s.push((base + m * 60, n));
        }
        let st = compute(&s, base + 86_399, 7);
        assert_eq!(st.peak, 50);
        assert_eq!(st.best_hours[0], 20);
        assert_eq!(st.best_hours[1], 8);
        assert!((st.by_hour[20].avg - 50.0).abs() < 1e-9);
        assert!((st.heat[0][8] - 30.0).abs() < 1e-9);
        assert!(st.heat[1][8] < 0.0, "sin datos el martes");
        assert_eq!(st.last24h.len(), 145);
    }
}
