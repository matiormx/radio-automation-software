use crate::engine::core::Core;
use crate::engine::graph::*;
use crate::engine::pcm::Pcm;
use crate::engine::voices::{Env, Voice};
use std::sync::Arc;

fn cfg(j: &str) -> MixConfig { serde_json::from_str(j).unwrap() }
fn core_with_music(amp: f32) -> Core {
    let mut c = Core::new(48000);
    let pcm = Arc::new(Pcm { rate: 48000, data: vec![amp; 48000 * 20] });
    c.play.voices.add(Voice { id: 0, pcm, start_at: 0, from: 0, end: 48000 * 10, stop_at: None, gain: Env::constant(1.0), norm: 1.0 });
    c
}
fn levels(c: &mut Core, frames: usize) -> std::collections::HashMap<String, f32> {
    let mut m = std::collections::HashMap::new();
    c.render(frames, |plan, _, n| {
        for o in &plan.outs { m.insert(o.device.clone(), o.buf[(n - 1) * 2]); }
        m.insert("_program".into(), plan.program[(n - 1) * 2]);
        m.insert("_monitor".into(), plan.monitor[(n - 1) * 2]);
    });
    m
}
fn apply(c: &mut Core, j: &str) { let p = Plan::build(&cfg(j), c.volume(), Some(&c.plan)); c.swap_plan(p); }

#[test]
fn no_channels_music_to_default() {
    let mut c = core_with_music(0.5);
    let l = levels(&mut c, 1024);
    assert_eq!(l["default"], 0.5);
    assert_eq!(l["_program"], 0.5);
}

#[test]
fn routing_bus_stream_and_volume() {
    let mut c = core_with_music(0.5);
    apply(&mut c, r#"{"mixerChannels":[{"id":"m","input":{"kind":"app","app":"music"},"output":{"kind":"bus","id":"B"},"gainDb":-6.0206,"muted":false}],
      "mixerBuses":[{"id":"B","outputDeviceId":"streaming","gainDb":0,"muted":false}],"monitorBusId":""}"#);
    let l = levels(&mut c, 4096); // ramp settles within a block
    let l = if (l["streaming"] - 0.25).abs() > 1e-3 { levels(&mut c, 1024) } else { l };
    assert!((l["streaming"] - 0.25).abs() < 1e-3, "{:?}", l);
    assert_eq!(l["default"], 0.0);
    assert!((l["_program"] - 0.25).abs() < 1e-3);
    c.set_volume(0.1);
    let l = levels(&mut c, 2048);
    assert!((l["streaming"] - 0.25).abs() < 1e-3, "stream ignores master volume");
}

#[test]
fn master_volume_and_monitor_bus() {
    let mut c = core_with_music(0.5);
    apply(&mut c, r#"{"mixerChannels":[{"id":"m","input":{"kind":"app","app":"music"},"output":{"kind":"bus","id":"B"},"gainDb":0,"muted":false}],
      "mixerBuses":[{"id":"B","outputDeviceId":"cardX","gainDb":0,"muted":false}],"monitorBusId":"B"}"#);
    c.set_volume(0.5);
    let l = levels(&mut c, 2048);
    assert!((l["cardX"] - 0.25).abs() < 1e-3, "{:?}", l);
    assert!((l["_monitor"] - 0.5).abs() < 1e-3, "monitor bus is pre master volume");
    assert!((l["_program"] - 0.5).abs() < 1e-3);
}

#[test]
fn fader_ramps_without_jump() {
    let mut c = core_with_music(0.5);
    let base = r#"{"mixerChannels":[{"id":"m","input":{"kind":"app","app":"music"},"output":{"kind":"device","id":"default"},"gainDb":GAIN,"muted":false}],"mixerBuses":[],"monitorBusId":""}"#;
    apply(&mut c, &base.replace("GAIN", "0"));
    levels(&mut c, 1024);
    apply(&mut c, &base.replace("GAIN", "-60"));
    let mut maxstep = 0f32; let mut prev = 0.5f32;
    c.render(512, |plan, _, n| { for i in 0..n { let v = plan.outs[0].buf[i * 2]; maxstep = maxstep.max((v - prev).abs()); prev = v; } });
    assert!(maxstep < 0.01, "step {maxstep}");
    assert!(prev.abs() < 1e-6);
}

#[test]
fn muted_and_unknown_bus() {
    let mut c = core_with_music(0.5);
    apply(&mut c, r#"{"mixerChannels":[{"id":"m","input":{"kind":"app","app":"music"},"output":{"kind":"bus","id":"nope"},"gainDb":0,"muted":false},
      {"id":"x","input":{"kind":"app","app":"music"},"output":{"kind":"device","id":"cardY"},"gainDb":0,"muted":true}],"mixerBuses":[],"monitorBusId":""}"#);
    let l = levels(&mut c, 4096);
    assert!((l["default"] - 0.5).abs() < 1e-3);
    assert_eq!(l["cardY"], 0.0);
}

#[test]
fn silence_level_tracked() {
    let mut c = core_with_music(0.5);
    c.render(48000, |_, _, _| {});
    assert!((c.play.music_ms - 0.25).abs() < 0.01);
    c.render(48000 * 10, |_, _, _| {});
    assert!(c.play.music_ms < 1e-6);
    let (lvl, db) = c.monitor_level();
    assert!(lvl == 0.0 && db == -60.0);
}
