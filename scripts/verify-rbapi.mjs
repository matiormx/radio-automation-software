#!/usr/bin/env node
// Verifica la API compatible con RadioBOSS de MiRadio.
//
// Uso:
//   node scripts/verify-rbapi.mjs --base https://api.ngradio.es --user radio --pass 'clave'
//   node scripts/verify-rbapi.mjs --base http://127.0.0.1:9000 --token <token>
//   ... --compare https://rb-direct.ngradio.es --compare-user U --compare-pass P
//
// Llama a cada accion, comprueba el formato (elementos, atributos y su orden,
// escapado), que responda en menos de 1 s, aguanta 20 playbackinfo seguidas y,
// con --compare, compara la estructura con la respuesta real de RadioBOSS.
// Sin dependencias: Node 18 o superior.

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => {
    if (a.startsWith("--")) acc.push([a.slice(2), all[i + 1] && !all[i + 1].startsWith("--") ? all[i + 1] : "1"]);
    return acc;
  }, []),
);
const BASE = (args.base || process.env.RBAPI_BASE || "http://127.0.0.1:9000").replace(/\/+$/, "");
const AUTH = { user: args.user || process.env.RBAPI_USER, pass: args.pass || process.env.RBAPI_PASS, token: args.token || process.env.RBAPI_TOKEN };
const CMP = args.compare ? { base: args.compare.replace(/\/+$/, ""), user: args["compare-user"], pass: args["compare-pass"], token: args["compare-token"] } : null;

let failures = 0;
const ok = (m) => console.log(`  \u2714 ${m}`);
const bad = (m) => {
  failures += 1;
  console.log(`  \u2718 ${m}`);
};
const check = (cond, m) => (cond ? ok(m) : bad(m));

function url(base, auth, params) {
  const q = new URLSearchParams(params);
  if (!auth.token) {
    q.set("user", auth.user ?? "");
    q.set("pass", auth.pass ?? "");
  }
  return `${base}/?${q}`;
}

async function call(base, auth, params, { raw = false, noAuth = false } = {}) {
  const headers = auth.token && !noAuth ? { Authorization: `Bearer ${auth.token}` } : {};
  const target = noAuth ? `${base}/?${new URLSearchParams(params)}` : url(base, auth, params);
  const t0 = performance.now();
  const res = await fetch(target, { headers });
  const body = raw ? Buffer.from(await res.arrayBuffer()) : await res.text();
  return { status: res.status, type: res.headers.get("content-type") || "", body, ms: performance.now() - t0 };
}

// ---------- mini analizador XML (suficiente para estas respuestas) ----------

function parseXml(text) {
  const root = { name: "#doc", attrs: [], children: [], text: "" };
  const stack = [root];
  const re = /<\?[^>]*\?>|<(\/?)([A-Za-z_][\w.-]*)((?:\s+[^\s=\/>]+\s*=\s*"[^"]*")*)\s*(\/?)>|([^<]+)/g;
  let m;
  let pos = 0;
  while ((m = re.exec(text))) {
    if (m.index !== pos) throw new Error(`XML mal formado cerca de: ${text.slice(pos, pos + 40)}`);
    pos = re.lastIndex;
    if (m[0].startsWith("<?")) continue;
    if (m[5] !== undefined) {
      if (/&(?!amp;|lt;|gt;|quot;|apos;|#\d+;|#x[0-9a-f]+;)/i.test(m[5])) throw new Error("& sin escapar en texto");
      stack[stack.length - 1].text += m[5];
      continue;
    }
    const [, close, name, attrText, selfClose] = m;
    if (close) {
      const top = stack.pop();
      if (!top || top.name !== name) throw new Error(`Cierre </${name}> inesperado`);
      continue;
    }
    const attrs = [...attrText.matchAll(/([^\s=\/>]+)\s*=\s*"([^"]*)"/g)].map(([, k, v]) => {
      if (/[<]/.test(v) || /&(?!amp;|lt;|gt;|quot;|apos;|#\d+;|#x[0-9a-f]+;)/i.test(v))
        throw new Error(`Atributo ${k} sin escapar: ${v.slice(0, 40)}`);
      return [k, v];
    });
    const node = { name, attrs, children: [], text: "" };
    stack[stack.length - 1].children.push(node);
    if (!selfClose) stack.push(node);
  }
  if (pos !== text.length) throw new Error("XML mal formado al final");
  if (stack.length !== 1) throw new Error(`Falta cerrar <${stack[stack.length - 1].name}>`);
  return root;
}

const names = (n) => n.attrs.map(([k]) => k).join(" ");
const attr = (n, k) => n.attrs.find(([a]) => a === k)?.[1];
const DATE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

/** Estructura comparable: nombres de elementos y atributos (en orden), sin valores. */
function shape(node) {
  const kids = [];
  const seen = new Set();
  for (const c of node.children) {
    const key = c.name;
    if (seen.has(key)) continue; // las listas se comparan por su primer elemento
    seen.add(key);
    kids.push(shape(c));
  }
  return { name: node.name, attrs: names(node), kids };
}

function diffShape(a, b, path = "") {
  const out = [];
  const here = `${path}/${a.name}`;
  if (a.name !== b.name) return [`${path}: <${a.name}> frente a <${b.name}>`];
  if (a.attrs !== b.attrs) out.push(`${here}: atributos "${a.attrs}" frente a "${b.attrs}"`);
  const n = Math.max(a.kids.length, b.kids.length);
  for (let i = 0; i < n; i += 1) {
    if (!a.kids[i]) out.push(`${here}: falta <${b.kids[i].name}> en MiRadio`);
    else if (!b.kids[i]) out.push(`${here}: <${a.kids[i].name}> no está en RadioBOSS`);
    else out.push(...diffShape(a.kids[i], b.kids[i], here));
  }
  return out;
}

// ---------- comprobaciones por accion ----------
// Formatos capturados de RadioBOSS 7.2 (docs/radioboss-referencia.md).

const INFO = "ARTIST TITLE ALBUM YEAR GENRE COMMENT FILENAME DURATION PLAYCOUNT LASTPLAYED INTRO OUTRO LANGUAGE RATING BPM TAGS PUBLISHER ALBUMARTIST COMPOSER COPYRIGHT TRACKNUMBER F1 F2 F3 F4 F5";
const PL2 = "STARTTIME CASTTITLE DURATION FILENAME TRACKFILENAME RATING PLAYCOUNT INTRO OUTRO BPM PLAYLISTINDEX INDEX FT_IDX ITEMTYPE PQUEUE ARTIST TITLE ALBUM YEAR GENRE COMMENT LASTPLAYED LANGUAGE F1 F2 F3 F4 F5";
const FILE = "FN Duration Artist Title Album Year Genre Comment BPM Rating Playcount LastPlayed Added UserField1 UserField2 UserField3 UserField4 UserField5 TypeIdentifier TagsList Intro Outro FadeIn FadeOut Mix Level Start End PlayedHistory Artwork_Base64 HookIn HookOut";
const DUR = /^\d+:\d{2}(:\d{2})?$/;
const kid = (n, name) => n?.children.find((c) => c.name === name);

const VALIDATE = {
  playbackinfo(doc) {
    const info = doc.children[0];
    check(info?.name === "Info", "raíz <Info>");
    const order = info.children.map((c) => c.name).filter((n) => n !== "Overlay").join(",");
    check(order === "CurrentTrack,Playback,Options,Features,Streaming,Relay,PrevTrack,NextTrack", `orden de elementos (${order})`);
    const pb = kid(info, "Playback");
    check(names(pb) === "pos len state playlistpos streams netstream playingtimeleft timestamp volume", `Playback: ${names(pb)}`);
    check(/^(play|pause|stop)$/.test(attr(pb, "state")), `state = ${attr(pb, "state")}`);
    check(DATE.test(attr(pb, "timestamp")), `timestamp ${attr(pb, "timestamp")}`);
    const cur = kid(info, "CurrentTrack").children[0];
    if (cur) {
      check(names(cur) === `${INFO} CASTTITLE LISTENERS LYRICS ITEMTITLE FT_IDX`, "CurrentTrack/TRACK con todos los atributos en orden");
      check(DUR.test(attr(cur, "DURATION")), `DURATION ${attr(cur, "DURATION")}`);
    } else ok("sin pista activa: CurrentTrack vacío");
    for (const n of ["PrevTrack", "NextTrack"]) {
      const t = kid(info, n).children[0];
      if (t) check(names(t) === `${INFO} LYRICS CASTTITLE ITEMTITLE FT_IDX`, `${n}/TRACK con todos los atributos en orden`);
    }
  },
  status(doc) {
    const p = doc.children[0]?.children[0];
    check(doc.children[0]?.name === "Status" && names(p) === "version uptime", "Status/Player version uptime");
  },
  encoderstatus(doc) {
    const root = doc.children[0];
    check(root?.name === "Encoders", "raíz <Encoders>");
    for (const e of root.children) check(names(e) === "index status error name listeners", `Encoder ${attr(e, "name")}`);
  },
  getlastplayed(doc) {
    const items = doc.children[0]?.children ?? [];
    check(items.length > 0, `${items.length} pistas`);
    check(items.every((t) => names(t) === `${INFO} LYRICS STARTTIME CASTTITLE TRACKTITLE ARTWORKID TITLESENT FT_IDX`), "TRACK con todos los atributos en orden");
    let prev = "9999";
    let sorted = true;
    for (const t of items) {
      if (attr(t, "STARTTIME") > prev) sorted = false;
      prev = attr(t, "STARTTIME");
    }
    check(sorted, "más recientes primero");
  },
  library(doc) {
    const items = doc.children[0]?.children ?? [];
    check(items.length > 0, `${items.length} canciones`);
    return attr(items[0] ?? { attrs: [] }, "FILENAME");
  },
  getplaylist2(doc) {
    const root = doc.children[0];
    check(names(root) === "COUNT TS FILE", `Playlist ${names(root)}`);
    const items = root?.children ?? [];
    check(items.every((t) => names(t) === PL2), `${items.length} TRACK con todos los atributos en orden`);
    check(items.every((t) => /^\d{2}:\d{2}:\d{2}$/.test(attr(t, "STARTTIME"))), "STARTTIME hh:mm:ss");
  },
  trackinfo(doc) {
    const t = doc.children[0]?.children[0]?.children[0];
    if (t) check(names(t) === `${INFO} LYRICS FT_IDX`, "Info/Track/TRACK en orden");
    else ok("posición vacía: <Info></Info>");
  },
  songrequestlist(doc) {
    check(doc.children[0]?.name === "SongRequest", `raíz <${doc.children[0]?.name}>`);
  },
};

async function action(name, params = {}) {
  console.log(`\n${name}`);
  try {
    const r = await call(BASE, AUTH, { action: name, ...params });
    check(r.status === 200, `HTTP ${r.status}`);
    check(r.ms < 1000, `${r.ms.toFixed(0)} ms`);
    check(/text\/xml/.test(r.type) && /utf-8/i.test(r.type), `Content-Type ${r.type}`);
    const doc = parseXml(r.body);
    ok("XML bien formado y escapado");
    const extra = VALIDATE[name]?.(doc);
    if (CMP) await compare(name, params, doc);
    return extra;
  } catch (e) {
    bad(String(e.message || e));
  }
}

async function compare(name, params, mine) {
  try {
    const theirs = await call(CMP.base, CMP, { action: name, ...params });
    if (theirs.status !== 200) return bad(`RadioBOSS respondió ${theirs.status}`);
    const strip = (n) => ({ ...n, children: n.children.filter((c) => c.name !== "Overlay").map(strip) });
    const diffs = diffShape(shape(strip(mine)), shape(strip(parseXml(theirs.body))));
    if (diffs.length === 0) ok("misma estructura que RadioBOSS");
    else for (const d of diffs) bad(`distinto de RadioBOSS: ${d}`);
  } catch (e) {
    bad(`comparación: ${e.message || e}`);
  }
}

async function main() {
  console.log(`API: ${BASE}${CMP ? `  ·  comparando con ${CMP.base}` : ""}`);

  console.log("\nautenticación");
  const anon = await call(BASE, AUTH, { action: "playbackinfo" }, { noAuth: true });
  check(anon.status === 401 && anon.body === "E001: Wrong password", `sin credenciales → ${anon.status} ${anon.body}`);
  const wrong = await call(BASE, { user: AUTH.user || "x", pass: "incorrecta-123" }, { action: "playbackinfo" });
  check(wrong.status === 401, `clave incorrecta → ${wrong.status}`);

  await action("playbackinfo");
  await action("status");
  await action("encoderstatus");
  await action("getlastplayed");
  const firstFile = await action("library");
  await action("getplaylist2");
  await action("getplaylist2", { cnt: "3" });
  await action("trackinfo", { pos: "1" });
  await action("songrequestlist");

  console.log("\nreadtag");
  if (firstFile || args.fn) {
    for (const art of ["0", "1"]) {
      const r = await call(BASE, AUTH, { action: "readtag", fn: args.fn || firstFile, artwork: art });
      check(r.status === 200, `artwork=${art}: HTTP ${r.status} (${r.ms.toFixed(0)} ms)`);
      const f = parseXml(r.body).children[0]?.children[0];
      check(f?.name === "File" && names(f) === FILE, `File con todos los atributos en orden`);
      if (art === "1") ok(`Artwork_Base64: ${(attr(f, "Artwork_Base64") || "").length} caracteres`);
    }
  } else bad("no hay canciones para probar readtag");
  const outside = await call(BASE, AUTH, { action: "readtag", fn: "C:\\Windows\\win.ini" });
  check(outside.status === 200 && /Duration="0" Artist=""/.test(outside.body), "archivo fuera de la biblioteca: ficha vacía, sin leerlo");

  for (const a of ["trackartwork", "nexttrackartwork", "prevtrackartwork"]) {
    console.log(`\n${a}`);
    const r = await call(BASE, AUTH, { action: a }, { raw: true });
    check(r.status === 200, `HTTP ${r.status}, ${r.type}, ${r.body.length} bytes`);
  }

  for (const [a, extra] of [["mic", {}], ["streamarchivestatus", {}]]) {
    const r = await call(BASE, AUTH, { action: a, ...extra });
    check(r.status === 200 && /^[01]$/.test(r.body), `${a} → ${r.body}`);
  }

  console.log("\nun fallo no tira el resto");
  const err = await call(BASE, AUTH, { action: "no-existe" });
  check(err.status === 400 && err.body === "E005: Unknown action", `acción desconocida → ${err.status} ${err.body}`);
  const after = await call(BASE, AUTH, { action: "playbackinfo" });
  check(after.status === 200, "playbackinfo sigue respondiendo");

  console.log("\ncarga: 20 playbackinfo seguidas");
  const t0 = performance.now();
  const times = [];
  for (let i = 0; i < 20; i += 1) times.push((await call(BASE, AUTH, { action: "playbackinfo" })).ms);
  const max = Math.max(...times);
  check(max < 1000, `máx ${max.toFixed(0)} ms, total ${(performance.now() - t0).toFixed(0)} ms`);

  console.log(failures ? `\n${failures} comprobaciones fallidas` : "\nTodo correcto");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
