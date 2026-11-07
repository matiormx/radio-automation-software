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
      } else if (msg.type === "cmd" && msg.cmd && typeof msg.cmd === "object") {
        let ok = true;
        let error = "";
        try {
          this.onCommand(msg.cmd as Record<string, unknown>);
        } catch (e) {
          ok = false;
          error = String(e);
        }
        this.send({ type: "reply", id: msg.id, ok, error });
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
