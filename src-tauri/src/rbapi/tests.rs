use super::*;
use std::process::Command;

fn tmpdir(tag: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("miradio-rbapi-{tag}-{}", uuid::Uuid::new_v4().simple()));
    std::fs::create_dir_all(&d).unwrap();
    d
}

/// Biblioteca de prueba con un FLAC real (para readtag/writetag).
fn fixture(tag: &str) -> (Arc<Core>, PathBuf, String) {
    let dir = tmpdir(tag);
    let audio = dir.join("Café & Té.flac");
    let ok = Command::new("ffmpeg")
        .args(["-loglevel", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=2", "-metadata", "artist=Viejo", "-metadata", "title=Antes"])
        .arg(&audio)
        .status()
        .map(|s| s.success())
        .unwrap_or(false);
    assert!(ok, "hace falta ffmpeg para las pruebas");
    let file = audio.to_string_lossy().to_string();
    let lib = serde_json::json!([
        {"id":"t1","title":"Tom & \"Jerry\"","artist":"Café  del Mar","album":"Uno","durationSecs":200.0,"file":file,"blocks":[],"tags":[],"library":"a"},
        {"id":"t2","title":"Segunda","artist":"Otro","durationSecs":61.0,"file":"/no/existe.mp3","blocks":[],"tags":[],"library":"a"}
    ]);
    std::fs::write(dir.join("library.json"), serde_json::to_vec(&lib).unwrap()).unwrap();
    let hist = serde_json::json!([{"trackId":"t2","playedAt":1761150000u64},{"trackId":"t1","playedAt":1761153600u64}]);
    std::fs::write(dir.join("history.json"), serde_json::to_vec(&hist).unwrap()).unwrap();
    let core = Core::new(dir.clone());
    {
        let mut s = core.secrets.lock().unwrap();
        s.user = "radio".into();
        s.pass_salt = "sal".into();
        s.pass_hash = sha_hex(&[b"sal", b"clave-secreta"]);
        s.token_hash = sha_hex(&[b"tok123"]);
    }
    (core, dir, file)
}

fn get(core: &Core, url: &str) -> (u16, String) {
    match handle(core, "GET", url, None) {
        Reply::Xml(s, b) => (s, b),
        Reply::Bytes(b, _) => (200, format!("<{} bytes>", b.len())),
    }
}

const AUTH: &str = "user=radio&pass=clave-secreta";

fn playing(core: &Arc<Core>, file: &str) {
    core.publish(Published {
        state: "play".into(),
        pos_ms: 5000.0,
        len_ms: 200000.0,
        current: Some(PubTrack { id: "t1".into(), artist: "Café  del Mar".into(), title: "Tom & \"Jerry\"".into(), album: "Uno".into(), file: file.into(), duration_secs: 200.0, cover: String::new() }),
        next: Some(PubTrack { id: "t2".into(), artist: "Otro".into(), title: "Segunda".into(), file: "/no/existe.mp3".into(), ..Default::default() }),
        queue: vec![
            PubTrack { id: "t1".into(), artist: "Café del Mar".into(), title: "Tom".into(), file: file.into(), duration_secs: 200.0, ..Default::default() },
            PubTrack { id: "t2".into(), artist: "Otro".into(), title: "Segunda".into(), file: "/no/existe.mp3".into(), duration_secs: 61.0, ..Default::default() },
        ],
        current_index: 0,
    });
}

#[test]
fn auth_required_and_both_methods_work() {
    let (core, _, _) = fixture("auth");
    assert_eq!(get(&core, "/?action=playbackinfo").0, 401);
    assert_eq!(get(&core, "/?action=playbackinfo&user=radio&pass=mal").0, 401);
    assert_eq!(get(&core, "/?action=playbackinfo&user=otro&pass=clave-secreta").0, 401);
    assert_eq!(get(&core, &format!("/?action=playbackinfo&{AUTH}")).0, 200);
    match handle(&core, "GET", "/?action=playbackinfo", Some("tok123")) {
        Reply::Xml(s, _) => assert_eq!(s, 200),
        _ => panic!(),
    }
    match handle(&core, "GET", "/?action=playbackinfo", Some("tok124")) {
        Reply::Xml(s, _) => assert_eq!(s, 401),
        _ => panic!(),
    }
    // Sin credenciales configuradas, nadie entra.
    let empty = Core::new(tmpdir("noauth"));
    assert_eq!(get(&empty, "/?action=playbackinfo&user=&pass=").0, 401);
}

#[test]
fn playbackinfo_exact_format() {
    let (core, _, file) = fixture("pbi");
    let (_, idle) = get(&core, &format!("/?action=playbackinfo&{AUTH}"));
    assert_eq!(
        idle,
        "<Info>\n  <Playback state=\"stop\" pos=\"0\" len=\"0\"/>\n  <CurrentTrack></CurrentTrack>\n  <NextTrack></NextTrack>\n  <Listeners>0</Listeners>\n</Info>"
    );
    playing(&core, &file);
    std::thread::sleep(Duration::from_millis(120));
    let (s, x) = get(&core, &format!("/?action=playbackinfo&{AUTH}"));
    assert_eq!(s, 200);
    let fname = xml::esc(&filename_of(&file));
    let start = core.now.lock().unwrap().started.map(local_time).unwrap();
    // pos avanza con el tiempo (milisegundos) y no pasa de len.
    let pos: u64 = x.split("pos=\"").nth(1).unwrap().split('"').next().unwrap().parse().unwrap();
    assert!((5100..5500).contains(&pos), "pos {pos}");
    let expected = format!(
        "<Info>\n  <Playback state=\"play\" pos=\"{pos}\" len=\"200000\"/>\n  <CurrentTrack><TRACK ARTIST=\"Café del Mar\" TITLE=\"Tom &amp; &quot;Jerry&quot;\" FILENAME=\"{fname}\" ALBUM=\"Uno\" DURATION=\"03:20\" STARTTIME=\"{start}\"/></CurrentTrack>\n  <NextTrack><TRACK ARTIST=\"Otro\" TITLE=\"Segunda\" FILENAME=\"/no/existe.mp3\"/></NextTrack>\n  <Listeners>0</Listeners>\n</Info>"
    );
    assert_eq!(x, expected);
    assert!(start.len() == 19 && start.as_bytes()[4] == b'-' && start.as_bytes()[13] == b':');
    // pausa: la posicion se congela
    let mut p = core.now.lock().unwrap().p.clone();
    p.state = "pause".into();
    p.pos_ms = 7000.0;
    core.publish(p);
    std::thread::sleep(Duration::from_millis(60));
    let (_, x) = get(&core, &format!("/?action=playbackinfo&{AUTH}"));
    assert!(x.contains("<Playback state=\"pause\" pos=\"7000\" len=\"200000\"/>"), "{x}");
}

#[test]
fn identity_is_stable() {
    let a = PubTrack { file: "C:\\Música\\Cafe\u{0301}  1.flac".into(), ..Default::default() };
    let b = PubTrack { file: "C:\\Música\\Café 1.flac".into(), ..Default::default() };
    assert_eq!(identity(&a), identity(&b));
    let c = PubTrack { artist: " ÁBBA ".into(), title: "Dancing  Queen".into(), ..Default::default() };
    assert_eq!(identity(&c), "ÁBBA - Dancing Queen");
}

#[test]
fn lastplayed_library_playlist() {
    let (core, _, file) = fixture("lists");
    let (_, x) = get(&core, &format!("/?action=getlastplayed&{AUTH}"));
    let lines: Vec<&str> = x.lines().collect();
    assert_eq!(lines[0], "<LastPlayed>");
    assert!(lines[1].starts_with("  <Track ARTIST=\"Café del Mar\" TITLE=\"Tom &amp; &quot;Jerry&quot;\" FILENAME=\""), "{}", lines[1]);
    assert!(lines[1].contains(&format!("LASTPLAYED=\"{}\"/>", epoch_time(1761153600))), "más reciente primero");
    assert!(lines[2].contains("TITLE=\"Segunda\""));
    assert_eq!(*lines.last().unwrap(), "</LastPlayed>");
    let (_, x) = get(&core, &format!("/?action=getlastplayed&count=1&{AUTH}"));
    assert_eq!(x.lines().count(), 3);

    let (_, x) = get(&core, &format!("/?action=library&{AUTH}"));
    assert!(x.starts_with("<Library>\n  <Track ARTIST=\"Café del Mar\" TITLE=\"Tom &amp; &quot;Jerry&quot;\" FILENAME=\""));
    assert!(x.contains("ALBUM=\"Uno\" GENRE=\"\" YEAR=\"\" DURATION=\"03:20\"/>"));

    playing(&core, &file);
    let (_, x) = get(&core, &format!("/?action=getplaylist2&{AUTH}"));
    let rows: Vec<&str> = x.lines().filter(|l| l.contains("<TRACK")).collect();
    assert_eq!(rows.len(), 2);
    assert!(rows[0].contains("ITEMTYPE=\"song\" STARTTIME=\"20"), "{}", rows[0]);
    assert!(rows[1].contains("TITLE=\"Segunda\" FILENAME=\"/no/existe.mp3\" ITEMTYPE=\"song\" STARTTIME=\"20"));

    let (_, x) = get(&core, &format!("/?action=songrequestlist&{AUTH}"));
    assert_eq!(x, "<Requests>\n</Requests>");
    let (_, x) = get(&core, &format!("/?action=encoderstatus&{AUTH}"));
    assert_eq!(x, "<Encoders>\n</Encoders>");
}

#[test]
fn tags_only_inside_library_and_roundtrip() {
    let (core, _, file) = fixture("tags");
    let enc = |s: &str| form_urlencoded::byte_serialize(s.as_bytes()).collect::<String>();
    // Fuera de la biblioteca: rechazado, y el resto de acciones sigue igual.
    let (s, x) = get(&core, &format!("/?action=readtag&fn={}&{AUTH}", enc("/etc/passwd")));
    assert_eq!(s, 404, "{x}");
    let (s, _) = get(&core, &format!("/?action=playbackinfo&{AUTH}"));
    assert_eq!(s, 200);
    let (s, x) = get(&core, &format!("/?action=readtag&fn={}&{AUTH}", enc(&file)));
    assert_eq!(s, 200, "{x}");
    assert!(x.starts_with("<TagInfo>\n  <File FN=\""));
    assert!(x.contains("ARTIST=\"Viejo\" TITLE=\"Antes\""), "{x}");
    let data = r#"<TagInfo><File ARTIST="Nuevo &amp; Mejor" TITLE="Después" YEAR="2026"/></TagInfo>"#;
    let (s, x) = get(&core, &format!("/?action=writetag&fn={}&data={}&{AUTH}", enc(&file), enc(data)));
    assert_eq!((s, x.as_str()), (200, "<Result>OK</Result>"));
    let (_, x) = get(&core, &format!("/?action=readtag&fn={}&{AUTH}", enc(&file)));
    assert!(x.contains("ARTIST=\"Nuevo &amp; Mejor\" TITLE=\"Después\""), "{x}");
    let lib = crate::library::read_library_internal(&core.data_dir);
    assert_eq!(lib[0].artist, "Nuevo & Mejor", "la ficha de la biblioteca se actualiza");
    let (s, _) = get(&core, &format!("/?action=writetag&fn={}&data=basura&{AUTH}", enc(&file)));
    assert_eq!(s, 400);
}

#[test]
fn errors_are_isolated() {
    let (core, _, _) = fixture("iso");
    assert_eq!(get(&core, &format!("/?action=nada&{AUTH}")).0, 400);
    assert_eq!(get(&core, &format!("/?{AUTH}")).0, 400);
    assert_eq!(get(&core, &format!("/?action=trackartwork&{AUTH}")).0, 404);
    assert_eq!(get(&core, &format!("/otra?action=playbackinfo&{AUTH}")).0, 404);
    assert_eq!(get(&core, &format!("/?action=playbackinfo&{AUTH}")).0, 200);
}

#[test]
fn real_http_server_is_fast() {
    let (core, _, file) = fixture("http");
    playing(&core, &file);
    let port = 19000 + (std::process::id() % 1000) as u16;
    let cfg = ApiConfig { enabled: true, port, ..Default::default() };
    let srv = start_server(core.clone(), &cfg).expect("servidor");
    let base = format!("http://127.0.0.1:{port}/");
    let t0 = Instant::now();
    for _ in 0..20 {
        let r = ureq::get(&format!("{base}?action=playbackinfo&{AUTH}")).call().unwrap();
        assert_eq!(r.header("Content-Type"), Some("text/xml; charset=utf-8"));
        assert!(r.into_string().unwrap().starts_with("<Info>"));
    }
    assert!(t0.elapsed() < Duration::from_millis(1000), "20 peticiones en {:?}", t0.elapsed());
    let r = ureq::get(&format!("{base}?action=playbackinfo")).set("Authorization", "Bearer tok123").call().unwrap();
    assert_eq!(r.status(), 200);
    match ureq::get(&format!("{base}?action=playbackinfo")).call() {
        Err(ureq::Error::Status(401, r)) => assert_eq!(r.header("WWW-Authenticate"), Some("Bearer")),
        other => panic!("{:?}", other.map(|r| r.status())),
    }
    srv.shutdown();
}

#[test]
fn update_notified_once_per_change() {
    use std::io::{Read, Write};
    let (core, _, file) = fixture("upd");
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let hits = Arc::new(Mutex::new(Vec::<String>::new()));
    let h2 = hits.clone();
    std::thread::spawn(move || {
        for s in listener.incoming().flatten() {
            let mut s = s;
            let mut buf = [0u8; 2048];
            let n = s.read(&mut buf).unwrap_or(0);
            let line = String::from_utf8_lossy(&buf[..n]).lines().next().unwrap_or("").to_string();
            h2.lock().unwrap().push(line);
            let _ = s.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok");
        }
    });
    core.set_urls(&ApiConfig { update_url: format!("http://127.0.0.1:{port}/update"), ..Default::default() });
    core.secrets.lock().unwrap().update_token = "a b&c".into();
    for _ in 0..5 {
        playing(&core, &file); // misma cancion varias veces: un solo aviso
    }
    std::thread::sleep(Duration::from_millis(400));
    let mut p = core.now.lock().unwrap().p.clone();
    p.current = p.next.clone();
    core.publish(p.clone());
    core.publish(p);
    std::thread::sleep(Duration::from_millis(400));
    let got = hits.lock().unwrap().clone();
    assert_eq!(got.len(), 2, "{got:?}");
    assert!(got[0].starts_with("GET /update?token=a+b%26c "), "{}", got[0]);
    assert!(core.status_line().unwrap().contains("aviso enviado"));
}
