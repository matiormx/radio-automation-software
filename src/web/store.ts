// Almacén de la gestión web: los datos de la emisora tal como los tiene el
// maestro (elementos sincronizados), y las órdenes de la interfaz de
// OmniCaster traducidas a cambios en el maestro.
//
// - Al entrar se traen todos los elementos (GET /v1/sync/items) y después,
//   por WebSocket, solo los cambios.
// - Cada cambio se manda al maestro (POST /v1/sync/items) y se aplica aquí al
//   momento; los equipos de la emisora lo reciben en segundos.
// - El audio se escucha directamente desde R2 (GET /v1/media/<sha256>).

import { DEFAULT_SETTINGS, type Playlist, type Settings, type Track, type TrackDetails, type Waveform } from "../types";

type Data = Record<string, unknown>;
type Kind = "track" | "block" | "playlist" | "program" | "event" | "campaign";
const KINDS: Kind[] = ["track", "block", "playlist", "program", "event", "campaign"];

export interface Me {
  station: { id: string; name: string };
  caller: { kind: "owner" | "helper" | "node"; name?: string };
}

const TOKEN_KEY = "oc.web.llave";
let token = "";
let me: Me | null = null;
let cursor = 0;
const items = new Map<Kind, Map<string, Data>>(KINDS.map((k) => [k, new Map()]));
const listeners = new Set<() => void>();
let ws: WebSocket | null = null;

// ------------------------------------------------------------------ llave

/** La llave llega en el enlace (#llave=…): se guarda y se quita de la barra. */
export function takeToken(): string {
  const m = location.hash.match(/llave=([^&]+)/);
  if (m) {
    token = decodeURIComponent(m[1]);
    try {
      localStorage.setItem(TOKEN_KEY, token);
    } catch {
      /* sin almacenamiento: vale para esta visita */
    }
    history.replaceState(null, "", location.pathname + location.search);
  } else {
    try {
      token = localStorage.getItem(TOKEN_KEY) ?? "";
    } catch {
      token = "";
    }
  }
  return token;
}

export function setToken(t: string) {
  token = t.trim();
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* nada */
  }
}

export async function logout() {
  setToken("");
  await fetch("/v1/auth/logout", { method: "POST", credentials: "same-origin" }).catch(() => undefined);
  try {
    ws?.close();
  } catch {
    /* nada */
  }
  location.reload();
}

export function whoAmI(): Me | null {
  return me;
}

// ------------------------------------------------------------------ entrar con el email

export async function authState(): Promise<{ setup: boolean; station: string | null }> {
  return api("/v1/auth/state");
}
export async function requestCode(email: string): Promise<void> {
  await api("/v1/auth/code", { method: "POST", body: JSON.stringify({ email }) });
}
export async function verifyCode(email: string, code: string): Promise<void> {
  await api("/v1/auth/verify", { method: "POST", body: JSON.stringify({ email, code }) });
}

// ------------------------------------------------------------------ red

export class Unauthorized extends Error {}

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const r = await fetch(path, {
    ...init,
    credentials: "same-origin",
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(init.body && typeof init.body === "string" ? { "Content-Type": "application/json" } : {}), ...(init.headers ?? {}) },
  });
  const text = await r.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  if (!r.ok) {
    const msg = (body as { error?: string } | null)?.error ?? `${r.status} ${r.statusText}`;
    if (r.status === 401) throw new Unauthorized(msg);
    throw new Error(msg);
  }
  return body as T;
}

/** Entra con la llave y trae todos los datos. */
export async function connect(): Promise<Me> {
  me = await api<Me>("/v1/me");
  if (me.caller.kind === "node") throw new Error("Esta llave es de un equipo, no de una persona");
  await pull();
  openSocket();
  return me;
}

async function pull() {
  let more = true;
  let changed = false;
  while (more) {
    const r = await api<{ items: { kind: Kind; id: string; version: number; deleted: boolean; data: Data | null }[]; next: number; more: boolean }>(
      `/v1/sync/items?since=${cursor}&limit=2000`,
    );
    for (const it of r.items) {
      const m = items.get(it.kind);
      if (!m) continue;
      if (it.deleted || !it.data) m.delete(it.id);
      else m.set(it.id, it.data);
      changed = true;
    }
    cursor = r.next;
    more = r.more;
  }
  if (changed) notify();
}

function openSocket() {
  const url = `${location.origin.replace(/^http/, "ws")}/v1/ws${token ? `?token=${encodeURIComponent(token)}` : ""}`;
  ws = new WebSocket(url);
  ws.onmessage = (ev) => {
    try {
      const m = JSON.parse(String(ev.data));
      if (m.type === "changed" && typeof m.version === "number" && m.version > cursor) void pull().catch(() => undefined);
    } catch {
      /* nada */
    }
  };
  ws.onclose = (ev) => {
    ws = null;
    if (ev.code === 4001) return; // dado de baja
    window.setTimeout(() => {
      if (me) {
        void pull().catch(() => undefined);
        openSocket();
      }
    }, 5000);
  };
}

/** La interfaz se vuelve a pintar cuando cambia algo (de aquí o de fuera). */
export function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
function notify() {
  for (const fn of listeners) fn();
}

async function write(list: { kind: Kind; id: string; data?: Data; deleted?: boolean }[]) {
  if (list.length === 0) return;
  // Aquí al momento; si el maestro lo rechaza, se vuelve a traer lo suyo.
  for (const it of list) {
    const m = items.get(it.kind)!;
    if (it.deleted) m.delete(it.id);
    else m.set(it.id, it.data!);
  }
  notify();
  try {
    for (let i = 0; i < list.length; i += 500) {
      await api("/v1/sync/items", { method: "POST", body: JSON.stringify({ items: list.slice(i, i + 500) }) });
    }
  } catch (e) {
    void pull().catch(() => undefined);
    throw e;
  }
}

// ------------------------------------------------------------------ audio

/** Archivo de una canción en la web: «cloud:<sha256>.<ext>». */
export function mediaUrl(path: string): string {
  // Canciones («cloud:») e imágenes de programas y eventos («media:»)
  const m = path.match(/^(?:cloud|media):([a-f0-9]{64})/);
  if (!m) return "";
  // Con sesión (cookie) no hace falta nada más; con llave, va en la dirección.
  return `/v1/media/${m[1]}${token ? `?token=${encodeURIComponent(token)}` : ""}`;
}

// ------------------------------------------------------------------ canciones

function toTrack(id: string, d: Data): Track {
  const media = String(d.media ?? "");
  const ext = String(d.ext ?? "");
  return {
    album: "",
    genre: "",
    year: "",
    originalName: "",
    blocks: [],
    tags: [],
    library: "a",
    lufs: null,
    gainDb: null,
    truePeakDb: null,
    limited: false,
    trimStart: 0,
    trimEnd: null,
    autoTrimStart: 0,
    autoTrimEnd: null,
    trimManual: false,
    introPoint: 0,
    mixPoint: 0,
    fadeOutStart: 0,
    analyzedAt: 0,
    ...(d as unknown as Partial<Track>),
    title: String(d.title ?? ""),
    artist: String(d.artist ?? ""),
    durationSecs: Number(d.durationSecs ?? 0),
    id,
    file: media.length === 64 ? `cloud:${media}${ext ? `.${ext}` : ""}` : "",
    missing: media.length !== 64,
    cover: "",
    format: ext || undefined,
  } as Track;
}

function track(id: string): Data {
  const d = items.get("track")!.get(id);
  if (!d) throw new Error("La canción ya no existe en la biblioteca");
  return d;
}

async function patchTracks(ids: string[], f: (d: Data) => Data | null) {
  const out: { kind: Kind; id: string; data: Data }[] = [];
  for (const id of ids) {
    const d = items.get("track")!.get(id);
    if (!d) continue;
    const n = f({ ...d });
    if (n) out.push({ kind: "track", id, data: n });
  }
  await write(out);
  return out.length;
}

export function tracksNow(): Track[] {
  return [...items.get("track")!.entries()].map(([id, d]) => toTrack(id, d));
}

// ------------------------------------------------------------------ ajustes

const SETTINGS_KIND: Record<"programs" | "events" | "campaigns", Kind> = { programs: "program", events: "event", campaigns: "campaign" };

function settingsNow(): Settings {
  const s: Settings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
  for (const [field, kind] of Object.entries(SETTINGS_KIND)) {
    (s as unknown as Record<string, unknown>)[field] = [...items.get(kind)!.values()];
  }
  return s;
}

async function saveSettings(next: Settings) {
  const out: { kind: Kind; id: string; data?: Data; deleted?: boolean }[] = [];
  for (const [field, kind] of Object.entries(SETTINGS_KIND)) {
    const list = ((next as unknown as Record<string, unknown>)[field] as Data[]) ?? [];
    const cur = items.get(kind)!;
    const seen = new Set<string>();
    for (const it of list) {
      const id = String(it.id ?? "");
      if (!id) continue;
      seen.add(id);
      if (JSON.stringify(cur.get(id)) !== JSON.stringify(it)) out.push({ kind, id, data: it });
    }
    for (const id of cur.keys()) if (!seen.has(id)) out.push({ kind, id, deleted: true });
  }
  await write(out);
}

// ------------------------------------------------------------------ forma de onda

const waveCache = new Map<string, Promise<Waveform>>();

async function waveform(id: string, buckets: number): Promise<Waveform> {
  const t = toTrack(id, track(id));
  const url = mediaUrl(t.file);
  if (!url) throw new Error("Esta canción aún no tiene su archivo en la nube");
  const key = `${t.file}|${buckets}`;
  let p = waveCache.get(key);
  if (!p) {
    p = (async () => {
      const r = await fetch(url);
      if (!r.ok) throw new Error("No se pudo traer el audio de la nube");
      const buf = await r.arrayBuffer();
      const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      const ctx = new Ctx();
      try {
        const audio = await ctx.decodeAudioData(buf);
        const n = Math.max(80, Math.min(4000, buckets));
        const peaks = new Array<number>(n).fill(0);
        const chans = [...Array(audio.numberOfChannels).keys()].map((c) => audio.getChannelData(c));
        const len = audio.length;
        for (let i = 0; i < n; i++) {
          const a = Math.floor((i * len) / n);
          const b = Math.max(a + 1, Math.floor(((i + 1) * len) / n));
          let mx = 0;
          // Con paso: sobra precisión y va mucho más rápido.
          const step = Math.max(1, Math.floor((b - a) / 2000));
          for (const ch of chans) for (let j = a; j < b; j += step) mx = Math.max(mx, Math.abs(ch[j]));
          peaks[i] = mx;
        }
        return { durationSecs: audio.duration, sampleRate: audio.sampleRate, peaks };
      } finally {
        void ctx.close();
      }
    })();
    p.catch(() => waveCache.delete(key));
    waveCache.set(key, p);
  }
  return p;
}

// ------------------------------------------------------------------ subir

export interface UploadProgress {
  name: string;
  index: number;
  total: number;
  /** 0..1 del archivo actual */
  fraction: number;
  phase: "hash" | "upload" | "done";
}

async function sha256(file: File): Promise<string> {
  const buf = await file.arrayBuffer();
  const h = await crypto.subtle.digest("SHA-256", buf);
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function durationOf(file: File): Promise<number> {
  return new Promise((resolve) => {
    const a = document.createElement("audio");
    const url = URL.createObjectURL(file);
    const done = (v: number) => {
      URL.revokeObjectURL(url);
      resolve(Number.isFinite(v) ? v : 0);
    };
    a.preload = "metadata";
    a.onloadedmetadata = () => done(a.duration);
    a.onerror = () => done(0);
    a.src = url;
  });
}

function putWithProgress(url: string, body: Blob, headers: Record<string, string>, onProgress: (f: number) => void): Promise<string> {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open("PUT", url);
    if (token) x.setRequestHeader("Authorization", `Bearer ${token}`);
    for (const [k, v] of Object.entries(headers)) x.setRequestHeader(k, v);
    x.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    x.onload = () => (x.status >= 200 && x.status < 300 ? resolve(x.responseText) : reject(new Error(`Error al subir (${x.status})`)));
    x.onerror = () => reject(new Error("Se cortó la conexión al subir"));
    x.send(body);
  });
}

const SINGLE_MAX = 90 * 1024 * 1024;
const PART = 50 * 1024 * 1024;

async function uploadMedia(file: File, hash: string, onProgress: (f: number) => void) {
  const type = file.type || "application/octet-stream";
  if (file.size <= SINGLE_MAX) {
    await putWithProgress(`/v1/media/${hash}`, file, { "Content-Type": type }, onProgress);
    return;
  }
  const { uploadId } = await api<{ uploadId: string }>(`/v1/media/${hash}/multipart`, { method: "POST", headers: { "x-content-type": type } });
  const parts: { n: number; etag: string }[] = [];
  let n = 1;
  for (let off = 0; off < file.size; off += PART, n++) {
    const chunk = file.slice(off, Math.min(file.size, off + PART));
    const text = await putWithProgress(`/v1/media/${hash}/multipart/${n}?uploadId=${encodeURIComponent(uploadId)}`, chunk, {}, (f) =>
      onProgress((off + f * chunk.size) / file.size),
    );
    parts.push({ n, etag: JSON.parse(text).etag });
  }
  await api(`/v1/media/${hash}/multipart/complete?uploadId=${encodeURIComponent(uploadId)}`, {
    method: "POST",
    body: JSON.stringify({ parts, contentType: type }),
  });
}

/** Sube una imagen (portada) y devuelve su referencia «media:<sha256>.<ext>». */
export async function uploadImage(file: File): Promise<string> {
  const hash = await sha256(file);
  const ext = (file.name.match(/\.([a-z0-9]+)$/i)?.[1] ?? "jpg").toLowerCase();
  const { missing } = await api<{ missing: string[] }>("/v1/media/missing", { method: "POST", body: JSON.stringify({ hashes: [hash] }) });
  if (missing.includes(hash)) await putWithProgress(`/v1/media/${hash}`, file, { "Content-Type": file.type || "image/jpeg" }, () => undefined);
  return `media:${hash}.${ext}`;
}

/** «Artista - Título.flac» -> título y artista */
function guessFromName(name: string): { title: string; artist: string } {
  const base = name.replace(/\.[^.]+$/, "").replace(/_/g, " ").trim();
  const m = base.match(/^(.+?)\s+[-–]\s+(.+)$/);
  return m ? { artist: m[1].trim(), title: m[2].trim() } : { artist: "", title: base };
}

/** Sube archivos y crea sus fichas. Si el archivo ya estaba en la nube, solo la ficha. */
export async function uploadFiles(files: File[], opts: { blockId?: string } = {}, onProgress?: (p: UploadProgress) => void): Promise<Track[]> {
  const made: Track[] = [];
  const existing = new Map<string, string>();
  for (const [id, d] of items.get("track")!) if (typeof d.media === "string") existing.set(d.media, id);
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    const report = (phase: UploadProgress["phase"], fraction: number) => onProgress?.({ name: f.name, index: i, total: files.length, fraction, phase });
    report("hash", 0);
    const hash = await sha256(f);
    const dupe = existing.get(hash);
    if (dupe) {
      made.push(toTrack(dupe, track(dupe)));
      continue;
    }
    const { missing } = await api<{ missing: string[] }>("/v1/media/missing", { method: "POST", body: JSON.stringify({ hashes: [hash] }) });
    if (missing.includes(hash)) await uploadMedia(f, hash, (x) => report("upload", x));
    const ext = (f.name.match(/\.([a-z0-9]+)$/i)?.[1] ?? "").toLowerCase();
    const id = crypto.randomUUID();
    const { title, artist } = guessFromName(f.name);
    const data: Data = {
      id,
      title,
      artist,
      durationSecs: await durationOf(f),
      originalName: f.name,
      blocks: opts.blockId ? [opts.blockId] : [],
      tags: [],
      library: "a",
      addedAt: Math.floor(Date.now() / 1000),
      media: hash,
      ext,
    };
    await write([{ kind: "track", id, data }]);
    existing.set(hash, id);
    made.push(toTrack(id, data));
    report("done", 1);
  }
  return made;
}

// ------------------------------------------------------------------ órdenes

type Args = Record<string, unknown>;
const str = (v: unknown) => String(v ?? "");

const commands: Record<string, (a: Args) => unknown | Promise<unknown>> = {
  app_version: () => "web",
  list_tracks: () => tracksNow(),
  list_history: () => [],
  update_track: (a) =>
    patchTracks([str(a.id)], (d) => {
      const p = (a.patch ?? {}) as Data;
      for (const [k, v] of Object.entries(p)) if (v !== undefined && v !== null) d[k] = v;
      return d;
    }).then(() => null),
  set_track_blocks: (a) => patchTracks([str(a.id)], (d) => ({ ...d, blocks: (a.blockIds as string[]) ?? [] })).then(() => undefined),
  move_tracks_block: (a) =>
    patchTracks((a.ids as string[]) ?? [], (d) => {
      const add = str(a.addBlock);
      const rm = a.removeBlock ? str(a.removeBlock) : "";
      let b = ((d.blocks as string[]) ?? []).filter((x) => x !== rm);
      if (add && !b.includes(add)) b = [...b, add];
      return { ...d, blocks: b };
    }),
  set_tracks_language: (a) => patchTracks((a.ids as string[]) ?? [], (d) => ({ ...d, language: str(a.language) })),
  set_track_library: (a) => patchTracks((a.ids as string[]) ?? [], (d) => ({ ...d, library: a.library === "b" ? "b" : "a" })),
  delete_track: async (a) => {
    const id = str(a.id);
    // Fuera también de las listas.
    const pls: { kind: Kind; id: string; data: Data }[] = [];
    for (const [pid, p] of items.get("playlist")!) {
      const ids = (p.trackIds as string[]) ?? [];
      if (ids.includes(id)) pls.push({ kind: "playlist", id: pid, data: { ...p, trackIds: ids.filter((x) => x !== id), meta: [] } });
    }
    await write([{ kind: "track", id, deleted: true }, ...pls]);
  },
  save_track_trim: (a) =>
    patchTracks([str(a.id)], (d) => {
      const dur = Number(d.durationSecs) > 0 ? Number(d.durationSecs) : Number(a.end);
      const start = Math.max(0, Math.min(Number(a.start), Math.max(0, dur - 0.3)));
      const end = Math.min(Number(a.end), dur);
      if (!(end - start >= 0.3)) throw new Error("El recorte deja menos de 0,3 s de música");
      return { ...d, trimStart: Math.round(start * 1000) / 1000, trimEnd: end >= dur - 0.02 ? null : Math.round(end * 1000) / 1000, trimManual: true };
    }).then(() => undefined),
  save_track_markers: (a) =>
    patchTracks([str(a.id)], (d) => {
      const dur = Number(d.durationSecs) || 0;
      const pt = (v: unknown) => (Number(v) > 0 ? Math.round(Math.min(Number(v), dur) * 1000) / 1000 : 0);
      return { ...d, introPoint: pt(a.introPoint), mixPoint: pt(a.mixPoint), fadeOutStart: pt(a.fadeOutStart) };
    }).then(() => undefined),
  auto_track_trim: (a) =>
    patchTracks([str(a.id)], (d) => ({ ...d, trimStart: d.autoTrimStart ?? 0, trimEnd: d.autoTrimEnd ?? null, trimManual: false })).then(() => undefined),
  track_waveform: (a) => waveform(str(a.id), Number(a.buckets) || 900),
  track_details: (a): TrackDetails => {
    const t = toTrack(str(a.id), track(str(a.id)));
    const names = new Map([...items.get("block")!.entries()].map(([id, b]) => [id, str(b.name)]));
    return {
      ...t,
      blockNames: t.blocks.map((b) => names.get(b) ?? b),
      fileSize: 0,
      format: t.format ?? "",
      bitrateKbps: t.audioKbps || null,
      sampleRate: t.audioRate || null,
      channels: null,
      bitDepth: t.audioBits || null,
    } as unknown as TrackDetails;
  },
  clear_track_cover: () => undefined,
  // Bloques (las «listas» de la biblioteca)
  list_blocks: () => {
    const count = new Map<string, number>();
    for (const d of items.get("track")!.values()) for (const b of (d.blocks as string[]) ?? []) count.set(b, (count.get(b) ?? 0) + 1);
    return [...items.get("block")!.entries()]
      .map(([id, b]) => ({ id, name: str(b.name), trackCount: count.get(id) ?? 0 }))
      .sort((x, y) => x.name.localeCompare(y.name, "es"));
  },
  create_block: async (a) => {
    const name = str(a.name).trim();
    if (!name) throw new Error("Falta el nombre");
    const id = crypto.randomUUID();
    await write([{ kind: "block", id, data: { id, name } }]);
    return { id, name, trackCount: 0 };
  },
  rename_block: (a) => write([{ kind: "block", id: str(a.id), data: { id: str(a.id), name: str(a.name).trim() } }]),
  delete_block: async (a) => {
    const id = str(a.id);
    const out: { kind: Kind; id: string; data?: Data; deleted?: boolean }[] = [{ kind: "block", id, deleted: true }];
    for (const [tid, d] of items.get("track")!) {
      const b = (d.blocks as string[]) ?? [];
      if (b.includes(id)) out.push({ kind: "track", id: tid, data: { ...d, blocks: b.filter((x) => x !== id) } });
    }
    await write(out);
  },
  // Playlists
  list_playlists: () => [...items.get("playlist")!.values()] as unknown as Playlist[],
  save_playlist: (a) => {
    const p = a.playlist as Playlist;
    return write([{ kind: "playlist", id: p.id, data: { meta: [], ...(p as unknown as Data) } }]);
  },
  delete_playlist: (a) => write([{ kind: "playlist", id: str(a.id), deleted: true }]),
  // Programas, eventos y campañas (el resto de ajustes es de cada equipo)
  get_settings: () => settingsNow(),
  // La portada ya está en la nube: se usa tal cual (no hay carpeta que copiar).
  import_program_cover: (a) => str(a.path),
  delete_program_cover: () => undefined,
  save_settings: (a) => saveSettings(a.settings as Settings),
};

export async function webInvoke(cmd: string, args: Args): Promise<unknown> {
  const f = commands[cmd];
  if (!f) throw new Error("Esto solo se puede hacer desde OmniCaster, en el estudio");
  return f(args);
}
