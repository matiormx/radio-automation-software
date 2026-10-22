use crate::engine::resamp::{Drift, Stretch};

fn src_gen(start: &mut usize, hz: f64, rate: f64) -> impl FnMut(&mut Vec<f32>, usize) + '_ {
    move |b: &mut Vec<f32>, n: usize| {
        for _ in 0..n { let v = (2.0 * std::f64::consts::PI * hz * *start as f64 / rate).sin() as f32 * 0.5; b.push(v); b.push(-v); *start += 1; }
    }
}

#[test]
fn identity_ratio() {
    let mut s = Stretch::new();
    let mut k = 0usize;
    let mut out = vec![];
    for _ in 0..10 { s.process(480, 1.0, src_gen(&mut k, 1000.0, 48000.0), |_, l, r| out.push((l, r))); }
    // output equals input
    for (i, (l, r)) in out.iter().enumerate().skip(2) {
        let v = (2.0 * std::f64::consts::PI * 1000.0 * (i as f64) / 48000.0).sin() as f32 * 0.5;
        assert!((l - v).abs() < 1e-5 && (r + v).abs() < 1e-5, "{i} {l} {v}");
    }
}

#[test]
fn converts_rate_keeps_pitch() {
    // engine 48k -> device 44.1k : ratio = 48000/44100
    let mut s = Stretch::new();
    let mut k = 0usize;
    let mut out = vec![];
    for _ in 0..100 { s.process(441, 48000.0 / 44100.0, src_gen(&mut k, 1000.0, 48000.0), |_, l, _| out.push(l)); }
    let n = out.len();
    let z = out[1000..n].windows(2).filter(|w| (w[0] < 0.0) != (w[1] < 0.0)).count();
    let hz = z as f64 / 2.0 / ((n - 1000) as f64 / 44100.0);
    assert!((hz - 1000.0).abs() < 1.5, "{hz}");
    let mx = out[1000..].iter().fold(0f32, |a, &b| a.max(b.abs()));
    assert!((mx - 0.5).abs() < 0.01, "{mx}");
    assert!(s.pending() < 10.0);
}

#[test]
fn drift_loop_holds_buffer() {
    // producer 48000 Hz, consumer card actually runs 0.3 % fast
    let mut ring: std::collections::VecDeque<f32> = Default::default();
    let mut s = Stretch::new();
    let mut d = Drift::default();
    let target = 2400.0;
    let (mut produced, mut consumed_time) = (0f64, 0f64);
    let mut fills = vec![];
    for step in 0..20000 {
        // 10 ms of producer
        produced += 480.0;
        while ring.len() / 2 < produced as usize - (produced as usize - ring.len() / 2) { break; }
        for _ in 0..480 { ring.push_back(0.1); ring.push_back(0.1); }
        // consumer callbacks: 480 * 1.003 frames per 10 ms
        consumed_time += 480.0 * 1.003;
        while consumed_time >= 480.0 {
            consumed_time -= 480.0;
            let fill = ring.len() as f64 / 2.0 + s.pending();
            let ratio = d.ratio(1.0, fill, target);
            s.process(480, ratio, |b, n| { for _ in 0..n { let l = ring.pop_front().unwrap_or(0.0); let r = ring.pop_front().unwrap_or(0.0); b.push(l); b.push(r); } }, |_, _, _| {});
        }
        if step > 15000 { fills.push(ring.len() as f64 / 2.0); }
    }
    let avg = fills.iter().sum::<f64>() / fills.len() as f64;
    let mn = fills.iter().cloned().fold(f64::MAX, f64::min);
    assert!(mn > 200.0, "underrun risk: min fill {mn}, avg {avg}");
    assert!(avg < 6000.0, "fill grows {avg}");
}
