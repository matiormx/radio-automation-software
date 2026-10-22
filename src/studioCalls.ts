import type { SoundMixer } from "./mixer";
import type { StudioCallsSettings } from "./types";

/**
 * Parte del estudio de las llamadas al aire de NGRADIO.
 *
 * MiRadio se conecta al worker de NGRADIO con el token de estudio. Cuando un
 * moderador pasa una llamada al aire, el worker mete a MiRadio en esa reunion
 * de RealtimeKit y manda su token. Aqui se entra en la reunion, la voz del
 * oyente se conecta a la mesa (canal "Llamadas de oyentes") y se le devuelve el
 * programa sin su propia voz. La llamada se abandona sola cuando el worker la
 * quita de la lista (pasa a privado o se cuelga).
 */

export type StudioStatus = "off" | "connecting" | "online" | "error";

export interface StudioSnapshot {
  status: StudioStatus;
  error: string;
  /** Llamadas del oyente que suenan ahora mismo en la mesa */
  calls: { id: number; name: string }[];
}

interface WireCall {
  id: number;
  name: string;
  token: string;
}

interface Joined {
  id: number;
  name: string;
  leave: () => Promise<void>;
}

const PROTOCOL = "studio.v1";
/** Solo la voz del oyente entra en el programa; la del moderador no. */
const CALLER_PREFIX = "caller-";

export function studioSocketUrl(serverUrl: string): string | null {
  const raw = serverUrl.trim();
  if (!raw) return null;
  try {
    const url = new URL(/^[a-z]+:\/\//i.test(raw) ? raw : `https://${raw}`);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.pathname = "/api/studio/calls";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

export class StudioCalls {
  onChange: ((snapshot: StudioSnapshot) => void) | null = null;

  private ws: WebSocket | null = null;
  private timer: number | null = null;
  private retry = 0;
  private running = false;
  private cfg: StudioCallsSettings = { enabled: false, serverUrl: "", token: "" };
  private status: StudioStatus = "off";
  private error = "";
  private joined = new Map<number, Joined>();
  private joining = new Set<number>();
  private muted = false;

  constructor(private mixer: SoundMixer) {}

  /** Aplica la configuracion: conecta, reconecta si cambia o desconecta. */
  configure(cfg: StudioCallsSettings) {
    const same =
      cfg.enabled === this.cfg.enabled &&
      cfg.serverUrl === this.cfg.serverUrl &&
      cfg.token === this.cfg.token;
    this.cfg = { ...cfg };
    if (same) return;
    this.stop();
    if (cfg.enabled) this.start();
  }

  setCallMuted(muted: boolean) {
    this.muted = muted;
    this.mixer.setCallMuted(muted);
  }

  get callMuted(): boolean {
    return this.muted;
  }

  dispose() {
    this.stop();
    this.onChange = null;
  }

  // -------------------------------------------------------------- conexion

  private start() {
    const url = studioSocketUrl(this.cfg.serverUrl);
    if (!url || this.cfg.token.trim().length < 24) {
      this.setStatus("error", "Falta la dirección de NGRADIO o el token es demasiado corto.");
      return;
    }
    this.running = true;
    this.retry = 0;
    this.connect(url);
  }

  private stop() {
    this.running = false;
    if (this.timer !== null) {
      window.clearTimeout(this.timer);
      this.timer = null;
    }
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onclose = null;
      ws.onmessage = null;
      ws.onerror = null;
      try {
        ws.close(1000);
      } catch {
        /* ya cerrado */
      }
    }
    void this.leaveAll();
    this.setStatus("off", "");
  }

  private connect(url: string) {
    if (!this.running) return;
    this.setStatus("connecting", "");
    let ws: WebSocket;
    try {
      ws = new WebSocket(url, [PROTOCOL, `token.${this.cfg.token.trim()}`]);
    } catch (e) {
      this.setStatus("error", `No se pudo abrir la conexión: ${String(e)}`);
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      this.setStatus("online", "");
    };
    ws.onmessage = (ev) => {
      let data: { t?: string; studio?: boolean; calls?: WireCall[] };
      try {
        data = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (data.t === "state" && data.studio) void this.reconcile(data.calls ?? []);
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      // Sin conexion con el worker no se sabe que llamadas siguen al aire: se sueltan.
      void this.leaveAll();
      if (!this.running) return;
      this.setStatus("connecting", "");
      const wait = Math.min(15000, 1000 * 2 ** this.retry++);
      this.timer = window.setTimeout(() => {
        this.timer = null;
        const next = studioSocketUrl(this.cfg.serverUrl);
        if (next) this.connect(next);
      }, wait);
    };
  }

  // -------------------------------------------------------------- llamadas

  private async reconcile(calls: WireCall[]) {
    const wanted = new Set(calls.map((c) => c.id));
    for (const [id, j] of Array.from(this.joined)) {
      if (!wanted.has(id)) {
        this.joined.delete(id);
        void j.leave();
      }
    }
    this.emit();
    for (const call of calls) {
      if (this.joined.has(call.id) || this.joining.has(call.id)) continue;
      this.joining.add(call.id);
      try {
        const j = await this.join(call);
        // Si mientras entraba el worker la quito de la lista, se sale ya
        if (this.running && this.ws) this.joined.set(call.id, j);
        else await j.leave();
      } catch (e) {
        this.error = `No se pudo entrar en la llamada: ${String(e)}`;
      } finally {
        this.joining.delete(call.id);
      }
      this.emit();
    }
  }

  private async join(call: WireCall): Promise<Joined> {
    const { default: RealtimeKitClient } = (await import("@cloudflare/realtimekit")) as any;
    const meeting = await RealtimeKitClient.init({
      authToken: call.token,
      defaults: { audio: false, video: false },
    });
    const key = String(call.id);
    const mixer = this.mixer;
    let closed = false;

    // La voz del oyente (y solo la suya) entra en la mesa.
    const apply = () => {
      if (closed) return;
      const tracks: MediaStreamTrack[] = [];
      for (const p of meeting.participants.joined.toArray?.() ?? []) {
        const custom = String(p.customParticipantId ?? "");
        if (custom.startsWith(CALLER_PREFIX) && p.audioEnabled && p.audioTrack) {
          tracks.push(p.audioTrack);
        }
      }
      if (tracks.length) mixer.attachCallSource(key, new MediaStream(tracks));
      else mixer.detachCallSource(key);
    };
    const joinedList = meeting.participants.joined;
    joinedList.on("participantJoined", (p: any) => {
      p.on("audioUpdate", apply);
      apply();
    });
    joinedList.on("participantLeft", apply);
    joinedList.on("participantsUpdate", apply);

    let returnTrack: MediaStreamTrack | null = mixer.getCallReturnTrack();
    const cleanup = () => {
      if (closed) return;
      closed = true;
      mixer.detachCallSource(key);
      try {
        returnTrack?.stop();
      } catch {
        /* ya parada */
      }
      returnTrack = null;
      if (this.joined.get(call.id)?.leave === leave) this.joined.delete(call.id);
      this.emit();
    };
    meeting.self.on("roomLeft", cleanup);

    const leave = async () => {
      try {
        await meeting.leave();
      } catch {
        /* ya fuera */
      }
      cleanup();
    };

    // El retorno es una pista de Web Audio: el SDK la publica como si fuera el micro.
    if (returnTrack) {
      try {
        await meeting.self.enableAudio(returnTrack);
      } catch (e) {
        console.warn("enableAudio antes de entrar falló; se reintenta al entrar", e);
      }
    }
    await meeting.join();
    if (returnTrack && !meeting.self.audioEnabled) {
      await meeting.self.enableAudio(returnTrack).catch((e: unknown) => {
        this.error = `La llamada no recibe el retorno del programa: ${String(e)}`;
      });
    }
    apply();
    return { id: call.id, name: call.name, leave };
  }

  private async leaveAll() {
    const all = Array.from(this.joined.values());
    this.joined.clear();
    this.joining.clear();
    await Promise.all(all.map((j) => j.leave().catch(() => undefined)));
    this.emit();
  }

  // -------------------------------------------------------------- estado

  private setStatus(status: StudioStatus, error: string) {
    this.status = status;
    this.error = error;
    this.emit();
  }

  private emit() {
    this.onChange?.({
      status: this.status,
      error: this.error,
      calls: Array.from(this.joined.values()).map((j) => ({ id: j.id, name: j.name })),
    });
  }
}
