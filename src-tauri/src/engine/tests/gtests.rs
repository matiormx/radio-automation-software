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
fn no_channels_means_silence_and_no_hidden_route() {
    let mut c = core_with_music(0.5);
    let l = levels(&mut c, 1024);
    // Sin canal la musica no sale por ningun sitio (nada oculto).
    assert_eq!(l["default"], 0.0);
    assert_eq!(l["_program"], 0.0);
    assert!(!c.plan.has_music());
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
    assert!(l["_program"].abs() < 1e-3, "sin salida Streaming, el programa es la salida predeterminada (aqui vacia)");
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

#[test]
fn pan_solo_sends_and_meters() {
    let mut c = core_with_music(0.5);
    apply(&mut c, r#"{"mixerChannels":[
      {"id":"m","input":{"kind":"app","app":"music"},"output":{"kind":"device","id":"cardA"},"gainDb":0,"muted":false,"pan":1,
       "sends":[{"busId":"S","gainDb":-6.0206,"pre":false,"muted":false},{"busId":"P","gainDb":0,"pre":true,"muted":false}]},
      {"id":"x","input":{"kind":"app","app":"music"},"output":{"kind":"device","id":"cardB"},"gainDb":0,"muted":false}],
      "mixerBuses":[{"id":"S","outputDeviceId":"streaming","gainDb":0,"muted":false},{"id":"P","outputDeviceId":"cardP","gainDb":0,"muted":false}],"monitorBusId":""}"#);
    let mut lr = std::collections::HashMap::new();
    for _ in 0..2 {
        c.render(2048, |plan, _, n| { for o in &plan.outs { lr.insert(o.device.clone(), (o.buf[(n - 1) * 2], o.buf[(n - 1) * 2 + 1])); } });
    }
    assert_eq!(lr["cardA"], (0.0, 0.5), "pan right");
    let (sl, sr) = lr["streaming"];
    assert!(sl.abs() < 1e-4 && (sr - 0.25).abs() < 1e-3, "post send keeps pan, -6 dB: {:?}", lr["streaming"]);
    let (pl, pr) = lr["cardP"];
    assert!((pl - 0.5).abs() < 1e-3 && (pr - 0.5).abs() < 1e-3, "pre send ignores pan/fader {:?}", lr["cardP"]);
    assert!((lr["cardB"].0 - 0.5).abs() < 1e-3);
    let meters = c.plan.take_meters();
    let m = meters.iter().find(|m| m.0 == "ch:m").unwrap();
    assert!(m.1 < 1e-6 && (m.2 - 0.5).abs() < 1e-3, "{m:?}");
    let s = meters.iter().find(|m| m.0 == "bus:S").unwrap();
    assert!((s.2 - 0.25).abs() < 1e-3);
    // solo on x: m (and its pre send) go silent, x keeps playing
    apply(&mut c, r#"{"mixerChannels":[
      {"id":"m","input":{"kind":"app","app":"music"},"output":{"kind":"device","id":"cardA"},"gainDb":0,"muted":false,"pan":1,
       "sends":[{"busId":"P","gainDb":0,"pre":true,"muted":false}]},
      {"id":"x","input":{"kind":"app","app":"music"},"output":{"kind":"device","id":"cardB"},"gainDb":0,"muted":false,"solo":true}],
      "mixerBuses":[{"id":"P","outputDeviceId":"cardP","gainDb":0,"muted":false}],"monitorBusId":""}"#);
    for _ in 0..2 {
        c.render(2048, |plan, _, n| { for o in &plan.outs { lr.insert(o.device.clone(), (o.buf[(n - 1) * 2], o.buf[(n - 1) * 2 + 1])); } });
    }
    assert_eq!(lr["cardA"], (0.0, 0.0));
    assert_eq!(lr["cardP"], (0.0, 0.0));
    assert!((lr["cardB"].1 - 0.5).abs() < 1e-3);
}

#[test]
fn channel_insert_bypass_then_return_replaces_dry() {
    let mut c = core_with_music(0.5);
    apply(&mut c, r#"{"mixerChannels":[
      {"id":"m","input":{"kind":"app","app":"music"},"output":{"kind":"device","id":"cardA"},"gainDb":0,"muted":false,
       "insert":{"enabled":true,"sendDeviceId":"procIn","returnDeviceId":"procOut"}}],
      "mixerBuses":[],"monitorBusId":""}"#);
    let mut sent = Vec::new();
    c.render(1024, |plan, _, n| {
        assert_eq!(plan.inserts.len(), 1);
        assert_eq!(plan.inserts[0].send_device, "procIn");
        assert_eq!(plan.inserts[0].return_device, "procOut");
        sent = plan.insert_sends[0].buf[..n * 2].to_vec();
        assert!((plan.outs[plan.out_index("cardA").unwrap()].buf[(n - 1) * 2] - 0.5).abs() < 1e-3);
    });
    assert!(sent.iter().all(|v| (*v - 0.5).abs() < 1e-3), "el envio lleva el seco");

    // Retorno activo: sale el retorno, no el seco, y el envio sigue seco.
    let ret = vec![0.25f32; 1024 * 2];
    c.render_inserts(1024, &[InsertFeed { data: &ret[..], active: true }], |plan, _, n| {
        let out = plan.out_index("cardA").unwrap();
        assert!((plan.outs[out].buf[(n - 1) * 2] - 0.25).abs() < 1e-3);
        assert!((plan.insert_sends[0].buf[(n - 1) * 2] - 0.5).abs() < 1e-3);
    });
}

#[test]
fn bus_insert_is_sent_before_fader_and_return_replaces_sum() {
    let mut c = core_with_music(0.5);
    apply(&mut c, r#"{"mixerChannels":[
      {"id":"m","input":{"kind":"app","app":"music"},"output":{"kind":"bus","id":"B"},"gainDb":0,"muted":false}],
      "mixerBuses":[{"id":"B","outputDeviceId":"cardA","gainDb":-6.0206,"muted":false,
       "insert":{"enabled":true,"sendDeviceId":"busIn","returnDeviceId":"busOut"}}],"monitorBusId":""}"#);
    c.render(1024, |plan, _, n| {
        assert!((plan.insert_sends[0].buf[(n - 1) * 2] - 0.5).abs() < 1e-3, "envio pre-fader");
        let out = plan.out_index("cardA").unwrap();
        assert!((plan.outs[out].buf[(n - 1) * 2] - 0.25).abs() < 1e-3);
    });
    let ret = vec![0.2f32; 1024 * 2];
    c.render_inserts(1024, &[InsertFeed { data: &ret[..], active: true }], |plan, _, n| {
        let out = plan.out_index("cardA").unwrap();
        assert!((plan.outs[out].buf[(n - 1) * 2] - 0.1).abs() < 1e-3, "retorno pasa por el fader del bus");
    });
}

#[test]
fn insert_without_send_or_return_is_ignored_and_devices_deduplicated() {
    let p = Plan::build(&cfg(r#"{"mixerChannels":[
      {"id":"a","input":{"kind":"app","app":"music"},"output":{"kind":"device","id":"default"},"gainDb":0,"muted":false,
       "insert":{"enabled":true,"sendDeviceId":"S","returnDeviceId":"R"}},
      {"id":"b","input":{"kind":"app","app":"preview"},"output":{"kind":"device","id":"default"},"gainDb":0,"muted":false,
       "insert":{"enabled":true,"sendDeviceId":"S","returnDeviceId":"R2"}},
      {"id":"c","input":{"kind":"app","app":"call"},"output":{"kind":"device","id":"default"},"gainDb":0,"muted":false,
       "insert":{"enabled":true,"sendDeviceId":"S","returnDeviceId":""}}],
      "mixerBuses":[],"monitorBusId":""}"#), 1.0, None);
    let (sends, returns) = p.insert_devices();
    assert_eq!(sends, vec!["S".to_string()]);
    assert_eq!(returns, vec!["R".to_string(), "R2".to_string()]);
}

#[test]
fn mono_channel_mixes_sides() {
    let mut c = core_with_music(0.5);
    apply(&mut c, r#"{"mixerChannels":[{"id":"m","input":{"kind":"app","app":"music"},"output":{"kind":"device","id":"default"},"gainDb":0,"muted":false,"mono":true}],"mixerBuses":[],"monitorBusId":""}"#);
    let l = levels(&mut c, 2048);
    assert!(l["default"] > 0.0, "{:?}", l);
}
