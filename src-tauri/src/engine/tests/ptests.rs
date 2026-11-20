use crate::engine::pcm::Pcm;
use crate::engine::player::*;
use std::collections::HashMap;
use std::sync::Arc;

const RATE: u32 = 8000;

struct TL { pcms: HashMap<String, Arc<Pcm>>, delay: HashMap<String, u32>, fail: Vec<String> }
impl Loader for TL {
    fn get(&mut self, t: &TrackInfo) -> Load {
        if self.fail.contains(&t.id) { return Load::Failed("roto".into()); }
        if let Some(d) = self.delay.get_mut(&t.id) { if *d > 0 { *d -= 1; return Load::Pending; } }
        match self.pcms.get(&t.id) { Some(p) => Load::Ready(p.clone()), None => Load::Pending }
    }
    fn keep(&mut self, _ids: &[&str]) {}
}
fn tone(secs: f64, amp: f32) -> Arc<Pcm> {
    let n = (secs * RATE as f64) as usize;
    Arc::new(Pcm { rate: RATE, data: (0..n * 2).map(|i| if (i / 2) % 8 < 4 { amp } else { -amp }).collect() })
}
fn track(id: &str, dur: f64) -> TrackInfo { TrackInfo { id: id.into(), title: id.into(), duration_secs: dur, ..Default::default() } }

struct Sim { core: PlayCore, p: Player, ld: TL, ev: Vec<Event>, level: Vec<(f64, f32, usize)> }
impl Sim {
    fn new(tracks: Vec<(TrackInfo, Arc<Pcm>)>) -> Sim {
        let mut ld = TL { pcms: HashMap::new(), delay: HashMap::new(), fail: vec![] };
        let list: Vec<TrackInfo> = tracks.iter().map(|(t, _)| t.clone()).collect();
        for (t, p) in tracks { ld.pcms.insert(t.id.clone(), p); }
        let mut s = Sim { core: PlayCore::new(RATE), p: Player::default(), ld, ev: vec![], level: vec![] };
        s.p.set_playlist(list, &mut s.ld);
        s
    }
    fn run(&mut self, secs: f64) {
        let block = 80; // 10 ms
        let steps = (secs * 100.0) as usize;
        let mut buf = vec![0f32; block * 2];
        for k in 0..steps {
            buf.iter_mut().for_each(|x| *x = 0.0);
            self.core.voices.render(self.core.now, &mut buf);
            let ms = buf.iter().map(|x| x * x).sum::<f32>() / buf.len() as f32;
            self.core.sig_ms = ms;
            self.core.now += block as u64;
            self.core.voices.dead.clear();
            if k % 2 == 0 { self.p.tick(&mut self.core, &mut self.ld); }
            self.ev.extend(self.p.drain_events());
            let peak = buf.iter().fold(0f32, |a, &b| a.max(b.abs()));
            self.level.push((self.core.secs(self.core.now), peak, self.core.voices.list.len()));
        }
    }
    fn indexes(&self) -> Vec<i64> { let mut v = vec![]; for e in &self.ev { if let Event::Index(i) = e { if v.last() != Some(i) { v.push(*i) } } } v }
    fn at(&self, t: f64) -> (f32, usize) { let x = self.level.iter().find(|l| l.0 >= t).unwrap(); (x.1, x.2) }
    fn last_tick(&self) -> (f64, f64) { self.ev.iter().rev().find_map(|e| if let Event::Tick { pos, total } = e { Some((*pos, *total)) } else { None }).unwrap() }
}

#[test]
fn crossfade_at_end() {
    let mut s = Sim::new(vec![(track("a", 20.0), tone(20.0, 0.5)), (track("b", 20.0), tone(20.0, 0.25))]);
    s.p.fade_seconds = 4.0;
    s.p.play_at(0, &mut s.core, &mut s.ld);
    s.run(10.0);
    let (pos, total) = s.last_tick();
    assert!((pos - 9.9).abs() < 0.2 && (total - 20.0).abs() < 0.01, "{pos} {total}");
    s.run(7.0); // t=17: crossfade started at 16
    assert_eq!(s.indexes(), vec![-1, 0, 1]);
    let (_, voices) = s.at(17.0);
    assert_eq!(voices, 2, "overlap");
    s.run(5.0);
    let (peak, voices) = s.at(21.5);
    assert_eq!(voices, 1);
    assert!((peak - 0.25).abs() < 0.01, "only b at full {peak}");
    // no gap: level never 0 around crossfade
    assert!(s.level.iter().filter(|l| l.0 > 0.2 && l.0 < 22.0).all(|l| l.1 > 0.05));
}

#[test]
fn ends_after_last() {
    let mut s = Sim::new(vec![(track("a", 3.0), tone(3.0, 0.5))]);
    s.p.play_at(0, &mut s.core, &mut s.ld);
    s.run(5.0);
    assert!(s.ev.contains(&Event::Ended));
    assert_eq!(s.at(4.0).1, 0);
}

#[test]
fn mix_point_keeps_current() {
    let mut t = track("a", 20.0); t.mix_point = 15.0;
    let mut s = Sim::new(vec![(t, tone(20.0, 0.5)), (track("b", 20.0), tone(20.0, 0.25))]);
    s.p.fade_seconds = 2.0;
    s.p.play_at(0, &mut s.core, &mut s.ld);
    s.run(16.0);
    assert_eq!(s.indexes(), vec![-1, 0, 1]);
    s.run(6.0);
    let (peak, voices) = s.at(18.0);
    assert_eq!(voices, 2);
    assert!(peak > 0.7, "a full + b {peak}");
    assert_eq!(s.at(21.0).1, 1);
}

#[test]
fn early_mix_point_ignored() {
    let mut t = track("a", 20.0); t.mix_point = 3.0;
    let mut s = Sim::new(vec![(t, tone(20.0, 0.5)), (track("b", 20.0), tone(20.0, 0.25))]);
    s.p.fade_seconds = 2.0;
    s.p.play_at(0, &mut s.core, &mut s.ld);
    s.run(10.0);
    assert_eq!(s.indexes(), vec![-1, 0]);
}

#[test]
fn pause_resume_keeps_position() {
    let mut s = Sim::new(vec![(track("a", 20.0), tone(20.0, 0.5))]);
    s.p.play_at(0, &mut s.core, &mut s.ld);
    s.run(5.0);
    s.p.toggle(&mut s.core, &mut s.ld);
    assert!(s.p.is_paused());
    let (pos, _) = s.last_tick();
    s.run(3.0);
    assert_eq!(s.at(7.0).1, 0);
    s.p.toggle(&mut s.core, &mut s.ld);
    s.run(1.0);
    let (pos2, _) = s.last_tick();
    assert!((pos2 - pos - 1.0).abs() < 0.15, "{pos} {pos2}");
}

#[test]
fn seek_moves() {
    let mut s = Sim::new(vec![(track("a", 60.0), tone(60.0, 0.5))]);
    s.p.play_at(0, &mut s.core, &mut s.ld);
    s.run(1.0);
    s.p.seek(30.0, &mut s.core, &mut s.ld);
    s.run(1.0);
    let (pos, _) = s.last_tick();
    assert!((pos - 31.0).abs() < 0.15, "{pos}");
    assert_eq!(s.core.voices.list.len(), 1);
}

#[test]
fn silence_skips() {
    let mut pcm = (*tone(30.0, 0.5)).data.clone();
    for x in pcm[(5 * RATE as usize) * 2..].iter_mut() { *x = 0.0; }
    let a = Arc::new(Pcm { rate: RATE, data: pcm });
    let mut s = Sim::new(vec![(track("a", 30.0), a), (track("b", 30.0), tone(30.0, 0.25))]);
    s.p.silence_skip = true;
    s.p.play_at(0, &mut s.core, &mut s.ld);
    s.run(9.0);
    assert_eq!(s.indexes(), vec![-1, 0, 1]);
    assert!(s.ev.iter().any(|e| matches!(e, Event::Diag(m) if m.contains("Silencio"))));
}

#[test]
fn silence_threshold_respected() {
    let mut s = Sim::new(vec![(track("a", 30.0), tone(30.0, 0.0005)), (track("b", 30.0), tone(30.0, 0.25))]);
    s.p.silence_skip = true;
    s.p.silence_threshold_db = -80.0; // 0.0005 = -66 dB: not silence
    s.p.play_at(0, &mut s.core, &mut s.ld);
    s.run(8.0);
    assert_eq!(s.indexes(), vec![-1, 0]);
}

#[test]
fn slow_load_waits_and_failed_is_skipped() {
    let mut s = Sim::new(vec![(track("a", 10.0), tone(10.0, 0.5)), (track("b", 10.0), tone(10.0, 0.25)), (track("c", 10.0), tone(10.0, 0.3))]);
    s.ld.delay.insert("a".into(), 5);
    s.ld.fail.push("b".into());
    s.p.fade_seconds = 2.0;
    s.p.play_at(0, &mut s.core, &mut s.ld);
    s.run(0.05);
    assert!(s.core.voices.list.is_empty());
    s.run(0.3);
    assert_eq!(s.core.voices.list.len(), 1);
    s.run(10.0);
    assert_eq!(s.indexes(), vec![-1, 0, 2]);
    assert!(s.ev.iter().any(|e| matches!(e, Event::Diag(m) if m.contains("No se pudo leer"))));
}

#[test]
fn fade_out_point() {
    let mut t = track("a", 20.0); t.fade_out_start = 10.0;
    let mut s = Sim::new(vec![(t, tone(20.0, 0.5))]);
    s.p.fade_seconds = 0.0;
    s.p.play_at(0, &mut s.core, &mut s.ld);
    s.run(19.5);
    let (p15, _) = s.at(15.0);
    assert!(p15 < 0.3 && p15 > 0.2, "{p15}");
}

#[test]
fn trims_and_gain() {
    let mut t = track("a", 20.0); t.trim_start = 2.0; t.trim_end = Some(12.0); t.trim_manual = true; t.gain_db = Some(-6.0206);
    let mut s = Sim::new(vec![(t, tone(20.0, 0.5))]);
    s.p.play_at(0, &mut s.core, &mut s.ld);
    s.run(1.0);
    let (pos, total) = s.last_tick();
    assert!((total - 10.0).abs() < 0.01 && pos < 1.1, "{pos} {total}");
    assert!((s.at(0.5).0 - 0.25).abs() < 0.01);
    s.run(10.5);
    assert!(s.ev.contains(&Event::Ended));
}

#[test]
fn intro_overlay_sounds_over_the_intro_gap() {
    let mut a = track("a", 20.0);
    a.intro_overlay = Some(Overlay { file: "x.wav".into(), at: 4.0, gain_db: 0.0, key: String::new() });
    let mut s = Sim::new(vec![(a, tone(20.0, 0.2))]);
    s.ld.pcms.insert("ovl:x.wav".into(), tone(2.0, 0.4));
    s.p.play_at(0, &mut s.core, &mut s.ld);
    s.run(8.0);
    let (p1, v1) = s.at(2.0);
    assert!((p1 - 0.2).abs() < 0.01 && v1 == 2, "solo la cancion {p1} {v1}");
    let (p2, v2) = s.at(5.0);
    assert!((p2 - 0.6).abs() < 0.01 && v2 == 2, "cancion + intro {p2} {v2}");
    let (p3, v3) = s.at(7.0);
    assert!((p3 - 0.2).abs() < 0.01 && v3 == 1, "el intro termino {p3} {v3}");
}

#[test]
fn jingle_plays_whole_without_fades() {
    // Jingle de 5 s con un fade out automático: suena entero a volumen
    // completo y la siguiente entra a su final, sin cruce de 2 s.
    let mut j = track("j", 5.0);
    j.media_type = "jingle".into();
    j.fade_out_start = 3.0;
    j.markers_auto = true;
    let mut s = Sim::new(vec![(j, tone(5.0, 0.5)), (track("b", 20.0), tone(20.0, 0.25))]);
    s.p.fade_seconds = 2.0;
    s.p.whole_xfade = Some(0.0); // empalme seco
    s.p.play_at(0, &mut s.core, &mut s.ld);
    s.run(4.8);
    assert_eq!(s.indexes(), vec![-1, 0], "aún en el jingle");
    let (peak, voices) = s.at(4.5);
    assert_eq!(voices, 1);
    assert!((peak - 0.5).abs() < 0.02, "jingle sin bajar {peak}");
    s.run(1.0);
    assert_eq!(s.indexes(), vec![-1, 0, 1]);
    // La siguiente entra a volumen completo
    let (peak, _) = s.at(5.5);
    assert!((peak - 0.25).abs() < 0.02, "b entera {peak}");
}

#[test]
fn jingle_enters_full_even_with_fade_in() {
    let mut j = track("j", 10.0);
    j.media_type = "jingle".into();
    let mut s = Sim::new(vec![(track("a", 10.0), tone(10.0, 0.5)), (j, tone(10.0, 0.25))]);
    s.p.fade_seconds = 4.0;
    s.p.fade_in = true;
    s.p.play_at(0, &mut s.core, &mut s.ld);
    s.run(7.0); // cruce a los 6 s
    assert_eq!(s.indexes(), vec![-1, 0, 1]);
    // A los 6,5 s el jingle ya suena entero (no subiendo durante 4 s)
    let x = s.level.iter().find(|l| l.0 >= 6.5).unwrap();
    assert!(x.1 >= 0.25, "jingle a volumen completo {}", x.1);
}

#[test]
fn commercial_keeps_manual_fade_out() {
    // Un fade out puesto a mano en un comercial sí se respeta
    let mut c = track("c", 10.0);
    c.media_type = "commercial".into();
    c.fade_out_start = 6.0;
    let mut s = Sim::new(vec![(c, tone(10.0, 0.5)), (track("b", 20.0), tone(20.0, 0.25))]);
    s.p.fade_seconds = 2.0;
    s.p.play_at(0, &mut s.core, &mut s.ld);
    s.run(9.0);
    assert_eq!(s.indexes(), vec![-1, 0], "sin cruce anticipado");
    let x = s.level.iter().find(|l| l.0 >= 8.5).unwrap();
    assert!(x.1 < 0.3, "bajando por su fade out {}", x.1);
}

#[test]
fn whole_tracks_cross_with_constant_power() {
    // Dos jingles seguidos: cruce de 1 s de potencia constante (sin bajón).
    let mut a = track("a", 6.0);
    a.media_type = "jingle".into();
    let mut b = track("b", 6.0);
    b.media_type = "jingle".into();
    let mut s = Sim::new(vec![(a, tone(6.0, 0.5)), (b, tone(6.0, 0.5))]);
    s.p.fade_seconds = 4.0;
    s.p.whole_xfade = Some(1.0);
    s.p.play_at(0, &mut s.core, &mut s.ld);
    s.run(4.8);
    assert_eq!(s.indexes(), vec![-1, 0], "no cruza 4 s antes");
    s.run(2.0);
    assert_eq!(s.indexes(), vec![-1, 0, 1]);
    // En mitad del cruce las dos suenan a ~0,707 (seno/coseno)
    let (_, voices) = s.at(5.5);
    assert_eq!(voices, 2, "las dos a la vez en el cruce");
}

#[test]
fn equal_power_envelope() {
    use crate::engine::voices::Env;
    let mut up = Env::constant(0.0);
    up.schedule_eq(0, 0.0, 100, 1.0);
    let mut down = Env::constant(1.0);
    down.schedule_eq(0, 1.0, 100, 0.0);
    for t in [0u64, 25, 50, 75, 100] {
        let (u, d) = (up.value_at(t), down.value_at(t));
        assert!((u * u + d * d - 1.0).abs() < 0.01, "potencia constante en {t}: {u} {d}");
    }
}

#[test]
fn repeated_spot_keeps_its_own_position() {
    // La cuña «c» está dos veces: suena la segunda y la lista cambia
    // (el AutoDJ añade al final). No debe saltar a la primera «c» y repetir «x».
    let mut s = Sim::new(vec![
        (track("c", 30.0), tone(30.0, 0.5)),
        (track("x", 30.0), tone(30.0, 0.5)),
        (track("y", 30.0), tone(30.0, 0.5)),
    ]);
    let list = |ids: &[&str]| ids.iter().map(|id| track(id, 30.0)).collect::<Vec<_>>();
    s.p.set_playlist(list(&["c", "x", "y", "c"]), &mut s.ld);
    s.p.play_at(3, &mut s.core, &mut s.ld);
    s.run(1.0);
    s.p.set_playlist(list(&["c", "x", "y", "c", "z"]), &mut s.ld);
    s.run(0.5);
    assert_eq!(s.indexes().last(), Some(&3), "{:?}", s.indexes());
}
