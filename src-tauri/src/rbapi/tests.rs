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
        Reply::Xml(s, b) | Reply::Text(s, b) => (s, b),
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
        cast_title: "Café del Mar - Tom".into(),
        volume: 0.8,
        list_name: "Mañana".into(),
        scheduler: true,
        encoders: vec![PubEncoder { name: "ngradio - mp3".into(), status: "active".into(), host: "h".into(), port: 8000, mount: "/live".into(), codec: "mp3".into(), bitrate_kbps: 128, sample_rate: 44100, channels: 2, enabled: true, ..Default::default() }],
    });
}


/// Nombres de los atributos de la primera etiqueta `<name …>`.
fn attr_names(x: &str, name: &str) -> Vec<String> {
    let start = x.find(&format!("<{name} ")).unwrap_or_else(|| panic!("falta <{name}> en {x}"));
    let body = &x[start..x[start..].find("/>").unwrap() + start];
    body.split('"').step_by(2).filter_map(|p| p.trim().strip_suffix('=').map(|k| k.split_whitespace().last().unwrap().to_string())).collect()
}

const INFO_ATTRS: &str = "ARTIST TITLE ALBUM YEAR GENRE COMMENT FILENAME DURATION PLAYCOUNT LASTPLAYED INTRO OUTRO LANGUAGE RATING BPM TAGS PUBLISHER ALBUMARTIST COMPOSER COPYRIGHT TRACKNUMBER F1 F2 F3 F4 F5";

#[test]
fn auth_required_and_both_methods_work() {
    let (core, _, _) = fixture("auth");
    assert_eq!(get(&core, "/?action=playbackinfo"), (401, "E001: Wrong password".to_string()));
    assert_eq!(get(&core, "/?action=playbackinfo&user=radio&pass=mal").0, 401);
    assert_eq!(get(&core, "/?action=playbackinfo&user=otro&pass=clave-secreta").0, 401);
    assert_eq!(get(&core, &format!("/?action=playbackinfo&{AUTH}")).0, 200);
    assert!(matches!(handle(&core, "GET", "/?action=playbackinfo", Some("tok123")), Reply::Xml(200, _)));
    assert!(matches!(handle(&core, "GET", "/?action=playbackinfo", Some("tok124")), Reply::Text(401, _)));
    let empty = Core::new(tmpdir("noauth"));
    assert_eq!(get(&empty, "/?action=playbackinfo&user=&pass=").0, 401);
}

#[test]
fn playbackinfo_like_radioboss() {
    let (core, _, file) = fixture("pbi");
    let (_, idle) = get(&core, &format!("/?action=playbackinfo&{AUTH}"));
    assert!(idle.starts_with("<?xml version=\"1.0\" encoding=\"utf-8\"?>\r\n<Info>\r\n<CurrentTrack>\r\n</CurrentTrack>\r\n<Playback pos=\"0\" len=\"0\" state=\"stop\" playlistpos=\"0\""), "{idle}");
    playing(&core, &file);
    std::thread::sleep(Duration::from_millis(120));
    let (s, x) = get(&core, &format!("/?action=playbackinfo&{AUTH}"));
    assert_eq!(s, 200);
    assert!(x.ends_with("</Info>\r\n"));
    let order: Vec<&str> = x.lines().filter_map(|l| l.trim().strip_prefix('<')).map(|l| l.split([' ', '>', '/']).next().unwrap()).filter(|n| !n.is_empty() && *n != "?xml" && *n != "TRACK").collect();
    assert_eq!(order, ["Info", "CurrentTrack", "", "Playback", "Options", "Features", "Streaming", "Relay", "PrevTrack", "", "NextTrack", "", ""].iter().copied().filter(|n| !n.is_empty()).collect::<Vec<_>>(), "{x}");
    let cur = attr_names(&x, "TRACK").join(" ");
    assert_eq!(cur, format!("{INFO_ATTRS} CASTTITLE LISTENERS LYRICS ITEMTITLE FT_IDX"));
    assert!(x.contains("ARTIST=\"Café del Mar\" TITLE=\"Tom &amp; &quot;Jerry&quot;\" ALBUM=\"Uno\""), "{x}");
    assert!(x.contains("DURATION=\"03:20\"  PLAYCOUNT=\"2\""), "dos espacios y cuenta la actual: {x}");
    assert!(x.contains("CASTTITLE=\"Café del Mar - Tom\" LISTENERS=\"0\""));
    assert!(x.contains("ITEMTITLE=\"Café del Mar - Tom &amp; &quot;Jerry&quot; ()\" FT_IDX=\"1\" />"));
    let pos: u64 = x.split("pos=\"").nth(1).unwrap().split('"').next().unwrap().parse().unwrap();
    assert!((5100..5500).contains(&pos), "pos {pos}");
    assert!(x.contains("len=\"200000\" state=\"play\" playlistpos=\"1\" streams=\"1\" netstream=\"n/a\" playingtimeleft=\""));
    assert!(x.contains("volume=\"80\" />\r\n<Options repeat_list=\"0\" shuffle=\"0\" queuemode=\"0\" />\r\n<Features scheduler=\"1\" />"));
    // Siguiente: ficha con LYRICS CASTTITLE ITEMTITLE FT_IDX
    let next = &x[x.find("<NextTrack>").unwrap()..];
    assert_eq!(attr_names(next, "TRACK").join(" "), format!("{INFO_ATTRS} LYRICS CASTTITLE ITEMTITLE FT_IDX"));
    // Anterior: la ultima del historial antes de que empezara la actual
    // (en la prueba, la propia Tom sono por ultima vez hace un año).
    let prev = &x[x.find("<PrevTrack>").unwrap()..x.find("</PrevTrack>").unwrap()];
    assert!(prev.contains("TITLE=\"Tom &amp;") && prev.contains("PLAYCOUNT=\"0\""), "{prev}");
    // pausa: la posicion se congela
    let mut p = core.now.lock().unwrap().p.clone();
    p.state = "pause".into();
    p.pos_ms = 7000.0;
    core.publish(p);
    std::thread::sleep(Duration::from_millis(60));
    let (_, x) = get(&core, &format!("/?action=playbackinfo&{AUTH}"));
    assert!(x.contains("<Playback pos=\"7000\" len=\"200000\" state=\"pause\""), "{x}");
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
fn lists_like_radioboss() {
    let (core, _, file) = fixture("lists");
    let (_, x) = get(&core, &format!("/?action=getlastplayed&{AUTH}"));
    assert!(x.starts_with("<?xml version=\"1.0\" encoding=\"utf-8\"?>\r\n<LastPlayed>\r\n<TRACK ARTIST=\"Café del Mar\""), "más reciente primero: {x}");
    assert_eq!(attr_names(&x, "TRACK").join(" "), format!("{INFO_ATTRS} LYRICS STARTTIME CASTTITLE TRACKTITLE ARTWORKID TITLESENT FT_IDX"));
    assert!(x.contains(&format!("STARTTIME=\"{}\"", rb::local_epoch(1761153600))));
    assert!(x.contains("PLAYCOUNT=\"0\" LASTPLAYED=\"\""), "la cuenta es la de antes de esa vez");
    assert_eq!(x.matches("<TRACK ").count(), 2);
    let (_, x) = get(&core, &format!("/?action=getlastplayed&count=1&{AUTH}"));
    assert_eq!(x.matches("<TRACK ").count(), 1);

    playing(&core, &file);
    let (_, x) = get(&core, &format!("/?action=getplaylist2&{AUTH}"));
    assert!(x.contains("<Playlist COUNT=\"2\" TS=\""), "{x}");
    assert!(x.contains("FILE=\"MiRadio\\Mañana\">\r\n"));
    assert_eq!(
        attr_names(&x, "TRACK").join(" "),
        "STARTTIME CASTTITLE DURATION FILENAME TRACKFILENAME RATING PLAYCOUNT INTRO OUTRO BPM PLAYLISTINDEX INDEX FT_IDX ITEMTYPE PQUEUE ARTIST TITLE ALBUM YEAR GENRE COMMENT LASTPLAYED LANGUAGE F1 F2 F3 F4 F5"
    );
    assert!(x.contains("PLAYLISTINDEX=\"0\" INDEX=\"1\" FT_IDX=\"-1\" ITEMTYPE=\"TRACK_PLAYED\""));
    assert!(x.contains("PLAYLISTINDEX=\"1\" INDEX=\"2\" FT_IDX=\"-1\" ITEMTYPE=\"TRACK\""));
    let st = x.split("STARTTIME=\"").nth(1).unwrap().split('"').next().unwrap();
    assert!(st.len() == 8 && st.as_bytes()[2] == b':', "hora sola: {st}");
    let (_, x) = get(&core, &format!("/?action=getplaylist2&cnt=1&{AUTH}"));
    assert_eq!(x.matches("<TRACK ").count(), 1);
    assert!(x.contains("INDEX=\"1\""));

    let (_, x) = get(&core, &format!("/?action=trackinfo&pos=2&{AUTH}"));
    assert!(x.contains("<Info>\r\n<Track>\r\n<TRACK ARTIST=\"Otro\" TITLE=\"Segunda\""), "{x}");
    assert_eq!(attr_names(&x, "TRACK").join(" "), format!("{INFO_ATTRS} LYRICS FT_IDX"));
    let (_, x) = get(&core, &format!("/?action=trackinfo&pos=9&{AUTH}"));
    assert_eq!(x, "<?xml version=\"1.0\" encoding=\"utf-8\"?>\r\n<Info>\r\n</Info>\r\n");
    let (_, x) = get(&core, &format!("/?action=getplaylist&from=2&to=2&{AUTH}"));
    assert_eq!(x.matches("<TRACK ").count(), 1);
    assert!(x.contains("TITLE=\"Segunda\""));

    let (_, x) = get(&core, &format!("/?action=status&{AUTH}"));
    assert!(x.contains("<Status>\r\n<Player version=\""), "{x}");
    let (_, x) = get(&core, &format!("/?action=songrequestlist&{AUTH}"));
    assert_eq!(x, "<?xml version=\"1.0\" encoding=\"utf-8\"?>\r\n<SongRequest>\r\n</SongRequest>\r\n");
    let (_, x) = get(&core, &format!("/?action=encoderstatus&{AUTH}"));
    assert!(x.contains("<Encoder index=\"0\" status=\"active\" error=\"\" name=\"ngradio - mp3\" listeners=\"0\" />"), "{x}");
    let (_, x) = get(&core, &format!("/?action=getencoder&id=0&{AUTH}"));
    assert!(x.contains("Server=\"h:8000/live\" Password=\"\""), "nunca la clave: {x}");
    assert_eq!(get(&core, &format!("/?action=mic&{AUTH}")), (200, "0".to_string()));
    assert_eq!(get(&core, &format!("/?action=streamarchivestatus&{AUTH}")), (200, "0".to_string()));
    assert_eq!(get(&core, &format!("/?action=schedulecontrol&type=state&{AUTH}")), (200, "on".to_string()));
    let (_, x) = get(&core, &format!("/?action=library&{AUTH}"));
    assert!(x.contains("<Library>\r\n<TRACK ARTIST=\"Café del Mar\""));
}

#[test]
fn tags_only_inside_library_and_roundtrip() {
    let (core, _, file) = fixture("tags");
    let enc = |s: &str| form_urlencoded::byte_serialize(s.as_bytes()).collect::<String>();
    // Fuera de la biblioteca: ficha vacia, sin leer el archivo.
    let (s, x) = get(&core, &format!("/?action=readtag&fn={}&{AUTH}", enc("/etc/passwd")));
    assert_eq!(s, 200);
    assert!(x.contains("<File FN=\"/etc/passwd\" Duration=\"0\" Artist=\"\""), "{x}");
    let (s, x) = get(&core, &format!("/?action=readtag&fn={}&{AUTH}", enc(&file)));
    assert_eq!(s, 200, "{x}");
    assert_eq!(
        attr_names(&x, "File").join(" "),
        "FN Duration Artist Title Album Year Genre Comment BPM Rating Playcount LastPlayed Added UserField1 UserField2 UserField3 UserField4 UserField5 TypeIdentifier TagsList Intro Outro FadeIn FadeOut Mix Level Start End PlayedHistory Artwork_Base64 HookIn HookOut"
    );
    assert!(x.contains("Duration=\"2000\" Artist=\"Café del Mar\""), "{x}");
    assert!(x.contains(&format!("PlayedHistory=\"{}&#13;&#10;\"", rb::local_epoch(1761153600))));
    let data = r#"<TagInfo><File Artist="Nuevo &amp; Mejor" Title="Después" Year="2026"/></TagInfo>"#;
    let (s, x) = get(&core, &format!("/?action=writetag&fn={}&data={}&{AUTH}", enc(&file), enc(data)));
    assert_eq!((s, x.as_str()), (200, "OK"));
    let lib = crate::library::read_library_internal(&core.data_dir);
    assert_eq!(lib[0].artist, "Nuevo & Mejor", "la ficha de la biblioteca se actualiza");
    let (_, x) = get(&core, &format!("/?action=readtag&fn={}&{AUTH}", enc(&file)));
    assert!(x.contains("Artist=\"Nuevo &amp; Mejor\" Title=\"Después\""), "{x}");
    let (s, _) = get(&core, &format!("/?action=writetag&fn={}&data=basura&{AUTH}", enc(&file)));
    assert_eq!(s, 400);
    let (s, _) = get(&core, &format!("/?action=writetag&fn={}&data={}&{AUTH}", enc("/etc/passwd"), enc(data)));
    assert_eq!(s, 400, "nunca fuera de la biblioteca");
}

#[test]
fn errors_are_isolated() {
    let (core, _, _) = fixture("iso");
    assert_eq!(get(&core, &format!("/?action=nada&{AUTH}")), (400, "E005: Unknown action".to_string()));
    assert_eq!(get(&core, &format!("/?{AUTH}")), (400, "E003: Nothing to do".to_string()));
    assert_eq!(get(&core, &format!("/?action=trackartwork&{AUTH}")), (200, String::new()), "sin caratula: vacio");
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
        assert_eq!(r.header("Content-Type"), Some("text/xml; charset=UTF-8"));
        assert!(r.into_string().unwrap().starts_with("<?xml"));
    }
    assert!(t0.elapsed() < Duration::from_millis(1000), "20 peticiones en {:?}", t0.elapsed());
    let r = ureq::get(&format!("{base}?action=playbackinfo")).set("Authorization", "Bearer tok123").call().unwrap();
    assert_eq!(r.status(), 200);
    match ureq::get(&format!("{base}?action=playbackinfo")).call() {
        Err(ureq::Error::Status(401, r)) => {
            assert_eq!(r.header("Content-Type"), Some("text/html; charset=UTF-8"));
            assert_eq!(r.into_string().unwrap(), "E001: Wrong password");
        }
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

/// Servidor de prueba para scripts/verify-rbapi.mjs (cargo test serve_for_script -- --ignored).
#[test]
#[ignore]
fn serve_for_script() {
    let (core, _, file) = fixture("script");
    playing(&core, &file);
    let cfg = ApiConfig { enabled: true, port: 19555, ..Default::default() };
    let srv = start_server(core.clone(), &cfg).expect("servidor");
    std::thread::sleep(Duration::from_secs(40));
    srv.shutdown();
}
