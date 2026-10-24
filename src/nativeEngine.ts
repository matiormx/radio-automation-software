import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { Settings, Track } from "./types";

/**
 * Puente con el motor de audio nativo (Rust). Ofrece la misma interfaz que
 * RadioPlayer para que la app no note la diferencia, mas el nivel del VU.
 */

type OutEvent =
  | { type: "tick"; pos: number; total: number }
  | { type: "index"; index: number }
  | { type: "ended" }
  | { type: "diag"; message: string };

interface StatePayload {
  events: OutEvent[];
  index: number;
  playing: boolean;
  paused: boolean;
  level: number;
  db: number;
  streamLevel?: number;
  streamDb?: number;
}

type MixerSlice = Pick<Settings, "mixerChannels" | "mixerBuses" | "monitorBusId">;

/**
 * Arranque y parada del motor en orden estricto: al cambiar de motor (o al
 * remontar el componente) la parada del anterior no debe pisar el arranque.
 */
let lifecycle: Promise<unknown> = Promise.resolve();
function inOrder<T>(fn: () => Promise<T>): Promise<T> {
  const run = lifecycle.then(fn, fn);
  lifecycle = run.catch(() => undefined);
  return run;
}

export function nativeDevices(): Promise<string[]> {
  return invoke<string[]>("engine_devices");
}

export class NativePlayer {
  onTick: ((current: number, total: number) => void) | null = null;
  onIndexChange: ((index: number) => void) | null = null;
  onEnded: (() => void) | null = null;
  onDiag: ((message: string) => void) | null = null;

  private state: StatePayload = { events: [], index: -1, playing: false, paused: false, level: 0, db: -60 };
  private waiters: Array<(s: StatePayload) => boolean> = [];
  private unlisten: UnlistenFn | null = null;
  private ready: Promise<void>;
  private disposed = false;
  private opts = { fadeSeconds: 6, loopPlaylist: false, silenceSkip: false, silenceThresholdDb: -55 };
  private optsQueued = false;
  private playlist: Track[] = [];

  constructor(private readonly onError: (message: string) => void) {
    this.ready = (async () => {
      this.unlisten = await listen<StatePayload>("engine://state", (e) => this.receive(e.payload));
      this.unlistenLive = await listen<{ state: string; message: string }>("engine://live", (e) => {
        if (e.payload.state === "error") this.liveOn = false;
        this.onLive?.(e.payload.state, e.payload.message);
      });
      await inOrder(() => invoke("engine_start"));
    })().catch((error) => {
      this.onError(`No se pudo arrancar el motor nativo: ${String(error)}`);
    });
  }

  // ------------------------------------------------------------ RadioPlayer

  get isPlaying(): boolean {
    return this.state.playing;
  }

  get isPaused(): boolean {
    return this.state.paused;
  }

  get currentIndex(): number {
    return this.state.index;
  }

  get current(): Track | undefined {
    return this.playlist[this.state.index];
  }

  set fadeSeconds(v: number) {
    this.setOpt({ fadeSeconds: v });
  }

  set loop(v: boolean) {
    this.setOpt({ loopPlaylist: v });
  }

  set silenceSkip(v: boolean) {
    this.setOpt({ silenceSkip: v });
  }

  set silenceThresholdDb(v: number) {
    this.setOpt({ silenceThresholdDb: v });
  }

  setPlaylist(tracks: Track[]) {
    this.playlist = tracks;
    void this.cmd({ op: "setPlaylist", tracks });
  }

  async playAt(index: number): Promise<void> {
    await this.cmd({ op: "playAt", index });
    await this.until((s) => s.playing && s.index === index, 4000);
  }

  async prepare(index: number, positionSecs: number): Promise<void> {
    await this.cmd({ op: "prepare", index, pos: positionSecs });
    await this.until((s) => s.paused && s.index === index, 4000);
  }

  async restoreAt(index: number, positionSecs: number, autoplay: boolean): Promise<void> {
    await this.cmd({ op: "restoreAt", index, pos: positionSecs, autoplay });
    await this.until((s) => s.index === index && (autoplay ? s.playing : s.paused), 4000);
  }

  async toggle(): Promise<void> {
    const was = this.state.playing;
    await this.cmd({ op: "toggle" });
    await this.until((s) => s.playing !== was, 4000);
  }

  pause(): void {
    void this.cmd({ op: "pause" });
  }

  async next(): Promise<void> {
    const from = this.state.index;
    await this.cmd({ op: "next" });
    await this.until((s) => s.index !== from && s.playing, 4000);
  }

  async prev(): Promise<void> {
    const from = this.state.index;
    await this.cmd({ op: "prev" });
    await this.until((s) => s.index !== from && s.playing, 4000);
  }

  async seek(seconds: number): Promise<void> {
    await this.cmd({ op: "seek", secs: seconds });
  }

  setVolume(v: number) {
    void this.cmd({ op: "volume", value: v });
  }

  // ------------------------------------------------------------ directo (eventos)

  private unlistenLive: (() => void) | null = null;
  private liveOn = false;
  onLive: ((state: string, message: string) => void) | null = null;

  fadePause(secs: number) {
    void this.cmd({ op: "fadePause", secs });
  }

  async startLive(source: string, fadeIn: number): Promise<void> {
    this.liveOn = true;
    await this.cmd({ op: "liveStart", url: source, fadeIn });
  }

  stopLive(fadeOut: number) {
    this.liveOn = false;
    void this.cmd({ op: "liveStop", fadeOut });
  }

  get liveActive(): boolean {
    return this.liveOn;
  }

  dispose() {
    this.disposed = true;
    this.onTick = null;
    this.onIndexChange = null;
    this.onEnded = null;
    this.onDiag = null;
    this.unlisten?.();
    this.unlisten = null;
    this.unlistenLive?.();
    this.unlistenLive = null;
    for (const w of this.waiters.splice(0)) w(this.state);
    void inOrder(() => invoke("engine_stop")).catch(() => undefined);
  }

  // ------------------------------------------------------------ mesa y VU

  /** Envia la configuracion de la mesa (canales, buses y VU). */
  applyMixer(cfg: MixerSlice) {
    void this.cmd({
      op: "mixer",
      config: {
        mixerChannels: cfg.mixerChannels ?? [],
        mixerBuses: cfg.mixerBuses ?? [],
        monitorBusId: cfg.monitorBusId ?? "",
      },
    });
  }

  /** Fader en vivo mientras se arrastra (sin rehacer la mesa). */
  liveGain(key: string, db: number) {
    void this.cmd({ op: "liveGain", key, db });
  }

  /** Envio de medidores por tira (ventana Mixer abierta). */
  setMeters(on: boolean) {
    void this.cmd({ op: "meters", on });
  }

  getMonitorLevel(): { level: number; db: number } {
    return { level: this.state.level, db: this.state.db };
  }

  /** Nivel de lo que va a los encoders de streaming. */
  getStreamLevel(): { level: number; db: number } {
    return { level: this.state.streamLevel ?? 0, db: this.state.streamDb ?? -60 };
  }

  // ------------------------------------------------------------ internals

  private setOpt(patch: Partial<NativePlayer["opts"]>) {
    this.opts = { ...this.opts, ...patch };
    if (this.optsQueued) return;
    this.optsQueued = true;
    queueMicrotask(() => {
      this.optsQueued = false;
      void this.cmd({ op: "options", ...this.opts });
    });
  }

  private async cmd(op: Record<string, unknown>): Promise<void> {
    await this.ready;
    if (this.disposed) return;
    try {
      await invoke("engine_cmd", { op });
    } catch (error) {
      this.onError(String(error));
    }
  }

  /** Espera a que el estado cumpla `ok` (o se agote el tiempo). */
  private until(ok: (s: StatePayload) => boolean, timeoutMs: number): Promise<void> {
    if (this.disposed) return Promise.resolve();
    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        resolve();
      };
      const timer = window.setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== check);
        finish();
      }, timeoutMs);
      const check = (s: StatePayload) => {
        if (!ok(s)) return false;
        window.clearTimeout(timer);
        finish();
        return true;
      };
      this.waiters.push(check);
    });
  }

  private receive(s: StatePayload) {
    if (this.disposed) return;
    const prevIndex = this.state.index;
    this.state = s;
    let indexReported = false;
    for (const e of s.events) {
      switch (e.type) {
        case "tick":
          this.onTick?.(e.pos, e.total);
          break;
        case "index":
          indexReported = true;
          this.onIndexChange?.(e.index);
          break;
        case "ended":
          this.onEnded?.();
          break;
        case "diag":
          this.onDiag?.(e.message);
          break;
      }
    }
    if (!indexReported && s.index !== prevIndex) this.onIndexChange?.(s.index);
    this.waiters = this.waiters.filter((w) => !w(s));
  }
}
