import { Channel, invoke } from "@tauri-apps/api/core";

/**
 * Con el motor nativo, la mesa entera vive en Rust. El WebView solo produce
 * dos fuentes que no puede generar el motor (la voz de la llamada, que llega
 * por WebRTC, y la preescucha) y se las manda en trozos de ~20 ms. A cambio
 * recibe el retorno del que llama (el programa sin su propia voz).
 */

const FRAMES = 1024;

const modules = new WeakMap<BaseAudioContext, Promise<void>>();

function loadModules(ctx: AudioContext): Promise<void> {
  let p = modules.get(ctx);
  if (!p) {
    const base = window.location.href;
    p = Promise.all([
      ctx.audioWorklet.addModule(new URL("/pcm-worklet.js", base).href),
      ctx.audioWorklet.addModule(new URL("/pcm-player.js", base).href),
    ]).then(() => undefined);
    modules.set(ctx, p);
  }
  return p;
}

function silent(buf: Float32Array): boolean {
  for (let i = 0; i < buf.length; i += 1) if (Math.abs(buf[i]) > 1e-5) return false;
  return true;
}

export class NativeBridge {
  private nodes: AudioNode[] = [];
  private captures: { call?: AudioWorkletNode; preview?: AudioWorkletNode } = {};
  private stopped = false;
  private inFlight = { call: 0, preview: 0 };

  constructor(
    private readonly ctx: AudioContext,
    private readonly sources: { call: AudioNode; preview: AudioNode },
    private readonly returnDest: AudioNode,
  ) {}

  private returnStarted = false;
  private ready: Promise<void> = Promise.resolve();

  start(): Promise<void> {
    this.ready = this.startCapture();
    return this.ready;
  }

  private async startCapture(): Promise<void> {
    await loadModules(this.ctx);
    if (this.stopped) return;
    const mute = this.ctx.createGain();
    mute.gain.value = 0;
    mute.connect(this.ctx.destination);
    this.nodes.push(mute);
    const rate = String(Math.round(this.ctx.sampleRate));

    for (const src of ["call", "preview"] as const) {
      const node = new AudioWorkletNode(this.ctx, "pcm-capture", {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [2],
        channelCount: 2,
        channelCountMode: "explicit",
        channelInterpretation: "speakers",
        processorOptions: { frames: FRAMES },
      });
      this.sources[src].connect(node);
      node.connect(mute);
      this.nodes.push(node);
      this.captures[src] = node;
      let wasSilent = true;
      node.port.onmessage = (e: MessageEvent<Float32Array>) => {
        if (this.stopped) return;
        const data = e.data;
        // El silencio no se manda (el motor lo da por callado).
        const quiet = silent(data);
        if (quiet && wasSilent) return;
        wasSilent = quiet;
        if (this.inFlight[src] > 8) return; // IPC atascado: mejor perder un trozo
        this.inFlight[src] += 1;
        void invoke("engine_feed", new Uint8Array(data.buffer, data.byteOffset, data.byteLength), {
          headers: { "x-src": src, "x-rate": rate },
        })
          .catch(() => undefined)
          .finally(() => {
            this.inFlight[src] -= 1;
          });
      };
    }
  }

  /**
   * Retorno del que llama: se abre con la primera llamada (mientras no hay
   * llamadas no se manda nada por el IPC).
   */
  ensureReturn(): void {
    if (this.stopped || this.returnStarted) return;
    this.returnStarted = true;
    void this.ready.then(() => this.openReturn());
  }

  private async openReturn(): Promise<void> {
    if (this.stopped) return;
    const sr = this.ctx.sampleRate;
    const player = new AudioWorkletNode(this.ctx, "pcm-player", {
      numberOfInputs: 0,
      outputChannelCount: [2],
      processorOptions: {
        capacity: Math.round(sr * 2 * 2),
        prebuffer: Math.round(sr * 2 * 0.08),
        maxFill: Math.round(sr * 2 * 0.3),
      },
    });
    player.connect(this.returnDest);
    this.nodes.push(player);
    const channel = new Channel<ArrayBuffer | number[]>();
    channel.onmessage = (msg) => {
      if (this.stopped) return;
      const buf = msg instanceof ArrayBuffer ? msg : new Uint8Array(msg).buffer;
      if (buf.byteLength < 8) return;
      player.port.postMessage(new Float32Array(buf, 0, Math.floor(buf.byteLength / 4)));
    };
    await invoke("engine_call_return", { rate: Math.round(sr), channel }).catch(() => undefined);
  }

  /** La mesa desconecta sus entradas al reconfigurarse: se vuelven a enganchar. */
  reconnect() {
    if (this.stopped) return;
    for (const src of ["call", "preview"] as const) {
      const node = this.captures[src];
      if (node) this.sources[src].connect(node);
    }
  }

  stop() {
    this.stopped = true;
    for (const n of this.nodes) {
      try {
        n.disconnect();
      } catch {
        /* ya desconectado */
      }
      if (n instanceof AudioWorkletNode) {
        n.port.onmessage = null;
        n.port.close();
      }
    }
    for (const src of Object.values(this.sources)) {
      for (const n of this.nodes) {
        try {
          src.disconnect(n);
        } catch {
          /* no estaba conectado */
        }
      }
    }
    this.nodes = [];
    this.captures = {};
  }
}
