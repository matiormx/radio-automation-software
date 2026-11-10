import { invoke } from "@tauri-apps/api/core";
import { openDialog } from "./api";

/** Unión a un maestro en la nube (omnicaster-cloud). */
export interface CloudJoin {
  api: string;
  station: { id: string; name: string };
  node: { id: string; name: string; role: string };
  token: string;
}

export type CloudState = "off" | "connecting" | "online" | "retrying";
export interface CloudStatus {
  state: CloudState;
  join: CloudJoin | null;
  error: string;
  /** Versión de datos del maestro (la última que nos ha dicho) */
  version: number;
  since: number;
}

export function cloudGet(): Promise<CloudJoin | null> {
  return invoke<CloudJoin | null>("cloud_get");
}
export async function cloudJoinPick(): Promise<CloudJoin | null> {
  const file = await openDialog({ title: "Archivo de alta del maestro", filters: [{ name: "Alta de OmniCaster", extensions: ["omnicaster", "json"] }] });
  if (!file) return null;
  return invoke<CloudJoin>("cloud_join", { file });
}
export function cloudLeave(): Promise<void> {
  return invoke("cloud_leave");
}

/** Subida de la música a la nube (en segundo plano). */
export interface MediaStatus {
  enabled: boolean;
  limitMbps: number;
  phase: "idle" | "hashing" | "checking" | "uploading" | "done" | "paused" | "error" | "nomaster";
  totalFiles: number;
  totalBytes: number;
  hashed: number;
  already: number;
  pendingFiles: number;
  pendingBytes: number;
  uploadedFiles: number;
  uploadedBytes: number;
  current: string;
  rateMbps: number;
  error: string;
  failed: number;
  finishedAt: number;
}
export function cloudMediaStatus(): Promise<MediaStatus> {
  return invoke<MediaStatus>("cloud_media_status");
}
export function cloudMediaSet(enabled: boolean, limitMbps: number): Promise<MediaStatus> {
  return invoke<MediaStatus>("cloud_media_set", { enabled, limitMbps });
}

/** Sincronización de los datos con el maestro. */
export interface SyncStatus {
  enabled: boolean;
  download: "needed" | "all" | "none";
  phase: "off" | "syncing" | "ok" | "error" | "nomaster";
  error: string;
  lastAt: number;
  version: number;
  items: number;
  sentTotal: number;
  receivedTotal: number;
  dlPending: number;
  dlDone: number;
  dlBytes: number;
  dlCurrent: string;
  dlError: string;
}
export function cloudSyncStatus(): Promise<SyncStatus> {
  return invoke<SyncStatus>("cloud_sync_status");
}
export function cloudSyncSet(enabled: boolean, download: SyncStatus["download"]): Promise<SyncStatus> {
  return invoke<SyncStatus>("cloud_sync_set", { enabled, download });
}

type Listener = (s: CloudStatus) => void;

/** El directo del equipo que emite, tal como lo ve un puesto de trabajo. */
export interface LiveState {
  node: string;
  /** Lista en antena y sus canciones (en orden, como se ven allí) */
  listId: string;
  listName: string;
  ids: string[];
  /** Fila que suena (-1 = nada) y la siguiente elegida a mano (-1 = la de después) */
  row: number;
  nextPick: number;
  paused: boolean;
  /** Posición (s) y cuándo se midió (ms): se puede extrapolar */
  pos: number;
  dur: number;
  at: number;
  autopilot: boolean;
  live: boolean;
  title: string;
  artist: string;
}

/**
 * Conexión de este equipo con el maestro: un WebSocket que se mantiene abierto
 * (y se reconecta solo). Por él van el latido cada 30 s con el estado de la
 * emisora y las órdenes del control remoto, que se ejecutan igual que las del
 * control desde el móvil.
 */
class CloudNode {
  private ws: WebSocket | null = null;
  private timer: number | null = null;
  private retry: number | null = null;
  private wait = 2000;
  private listeners = new Set<Listener>();
  status: CloudStatus = { state: "off", join: null, error: "", version: 0, since: 0 };
  getStatus: () => Record<string, unknown> = () => ({});
  onCommand: (cmd: Record<string, unknown>) => unknown = () => undefined;
  /** El directo del equipo que emite (si este equipo no es el que emite) */
  live: LiveState | null = null;
  private liveListeners = new Set<(l: LiveState | null) => void>();
  private pending = new Map<string, (r: { ok: boolean; error?: string }) => void>();

  subscribeLive(fn: (l: LiveState | null) => void): () => void {
    this.liveListeners.add(fn);
    fn(this.live);
    return () => this.liveListeners.delete(fn);
  }

  /** El equipo que emite cuenta cómo va el directo. */
  sendLive(live: Omit<LiveState, "node">) {
    this.send({ type: "event", kind: "live", live });
  }

  /** Orden al equipo que emite (como el control del móvil). */
  remote(cmd: Record<string, unknown>): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.ws?.readyState !== WebSocket.OPEN) {
        reject(new Error("Sin conexión con el maestro"));
        return;
      }
      const id = Math.random().toString(36).slice(2);
      const t = window.setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("El estudio no ha respondido"));
      }, 8000);
      this.pending.set(id, (r) => {
        window.clearTimeout(t);
        if (r.ok) resolve();
        else reject(new Error(r.error || "El estudio no pudo hacerlo"));
      });
      this.send({ type: "cmd", id, cmd });
    });
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    fn(this.status);
    return () => this.listeners.delete(fn);
  }
  private set(patch: Partial<CloudStatus>) {
    this.status = { ...this.status, ...patch };
    for (const l of this.listeners) l(this.status);
  }

  start(join: CloudJoin | null) {
    this.stop();
    this.set({ join, state: join ? "connecting" : "off", error: "" });
    if (join) this.connect();
  }

  stop() {
    if (this.timer !== null) window.clearInterval(this.timer);
    if (this.retry !== null) window.clearTimeout(this.retry);
    this.timer = this.retry = null;
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onclose = null;
      try {
        ws.close();
      } catch {
        /* ya cerrado */
      }
    }
    this.set({ state: "off" });
  }

  private connect() {
    const join = this.status.join;
    if (!join) return;
    const url = `${join.api.replace(/^http/, "ws")}/v1/ws?token=${encodeURIComponent(join.token)}`;
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch (e) {
      this.later(String(e));
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      this.wait = 2000;
      this.set({ state: "online", error: "", since: Date.now() });
      this.beat();
      this.timer = window.setInterval(() => this.beat(), 30_000);
    };
    ws.onmessage = (ev) => {
      let msg: { type?: string; [k: string]: unknown };
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if ((msg.type === "hello" || msg.type === "changed") && typeof msg.version === "number") {
        this.set({ version: msg.version });
        // Hay cambios en el maestro: que la sincronización pase ya.
        void invoke("cloud_sync_now").catch(() => undefined);
      } else if (msg.type === "reply" && typeof msg.id === "string" && this.pending.has(msg.id)) {
        const f = this.pending.get(msg.id)!;
        this.pending.delete(msg.id);
        f({ ok: !!msg.ok, error: typeof msg.error === "string" ? msg.error : "" });
      } else if (msg.type === "event" && msg.kind === "live" && msg.live && typeof msg.live === "object") {
        this.live = { ...(msg.live as Omit<LiveState, "node">), node: String(msg.node ?? "") };
        for (const l of this.liveListeners) l(this.live);
      } else if (msg.type === "cmd" && msg.cmd && typeof msg.cmd === "object") {
        let ok = true;
        let error = "";
        try {
          this.onCommand(msg.cmd as Record<string, unknown>);
        } catch (e) {
          ok = false;
          error = String(e);
        }
        this.send({ type: "reply", id: msg.id, ok, error, from: msg.from });
        // Tras una orden, el panel ve el resultado enseguida.
        window.setTimeout(() => this.beat(), 600);
      }
    };
    ws.onclose = (ev) => {
      if (this.timer !== null) window.clearInterval(this.timer);
      this.timer = null;
      this.ws = null;
      // 4001: el maestro dio de baja este equipo.
      if (ev.code === 4001) {
        this.set({ state: "off", error: "El maestro ha dado de baja este equipo" });
        return;
      }
      this.later(ev.code === 1006 ? "Sin conexión con el maestro" : `Conexión cerrada (${ev.code})`);
    };
  }

  private later(error: string) {
    this.set({ state: "retrying", error });
    this.retry = window.setTimeout(() => {
      this.retry = null;
      this.connect();
    }, this.wait);
    this.wait = Math.min(this.wait * 2, 60_000);
  }

  private send(msg: unknown) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  /** Latido: lo que se ve del equipo en el panel del maestro. */
  beat() {
    let status: Record<string, unknown> = {};
    try {
      status = this.getStatus();
    } catch {
      /* que no falte el latido por un dato */
    }
    this.send({ type: "hb", status });
  }
}

export const cloudNode = new CloudNode();

/** Música bajada de la nube en este equipo. */
export function cloudLocalUsage(): Promise<{ files: number; bytes: number }> {
  return invoke("cloud_local_usage");
}
export function cloudFreeSpace(): Promise<{ files: number; bytes: number }> {
  return invoke("cloud_free_space");
}
/** Cambia la carpeta (lo ya bajado se mueve en segundo plano). Devuelve la carpeta. */
export function cloudSetMediaDir(path: string): Promise<string> {
  return invoke("cloud_set_media_dir", { path });
}
export function cloudMediaDir(): Promise<string> {
  return invoke("cloud_media_dir");
}
