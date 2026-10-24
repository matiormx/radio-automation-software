import { invoke } from "@tauri-apps/api/core";
import type { SoundMixer } from "./mixer";

/**
 * Con el motor nativo, la preescucha y las llamadas siguen sonando en el
 * WebView: aqui se capturan y se mandan al motor (s16le estereo, ~21 ms por
 * bloque) para que pasen por la mesa nativa como cualquier otra fuente.
 */
export class NativeAppFeed {
  private nodes: AudioWorkletNode[] = [];
  private sink: GainNode | null = null;
  private stopped = false;
  private retTimer: number | null = null;
  private retNode: AudioWorkletNode | null = null;

  constructor(private readonly mixer: SoundMixer) {}

  async start(): Promise<void> {
    const ctx = this.mixer.ctx;
    await ctx.audioWorklet.addModule(new URL("/pcm-worklet.js", window.location.href).href).catch(() => undefined);
    if (this.stopped) return;
    const sink = ctx.createGain();
    sink.gain.value = 0;
    sink.connect(ctx.destination);
    this.sink = sink;
    const rate = Math.round(ctx.sampleRate);
    const sources: Array<["preview" | "call", AudioNode]> = [
      ["preview", this.mixer.previewInput],
      ["call", this.mixer.callInput],
    ];
    for (const [src, input] of sources) {
      const node = new AudioWorkletNode(ctx, "pcm-capture", {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [2],
        channelCount: 2,
        channelCountMode: "explicit",
        channelInterpretation: "speakers",
        processorOptions: { frames: 1024 },
      });
      let busy = 0;
      node.port.onmessage = (event: MessageEvent<Float32Array>) => {
        if (this.stopped || busy > 8) return;
        const f = event.data;
        let any = false;
        const bytes = new Uint8Array(f.length * 2);
        const view = new DataView(bytes.buffer);
        for (let i = 0; i < f.length; i += 1) {
          const v = Math.max(-1, Math.min(1, f[i]));
          if (v !== 0) any = true;
          view.setInt16(i * 2, v < 0 ? v * 0x8000 : v * 0x7fff, true);
        }
        // Silencio total: no se manda (el motor lo trata como silencio).
        if (!any) return;
        busy += 1;
        void invoke("engine_feed", { src, rate, data: Array.from(bytes) })
          .catch(() => undefined)
          .finally(() => {
            busy -= 1;
          });
      };
      input.connect(node);
      node.connect(sink);
      this.nodes.push(node);
    }
    await this.startReturn();
  }

  /** Lo que oyen los que llaman: el mix-minus del motor nativo (sin su voz). */
  private async startReturn(): Promise<void> {
    const ctx = this.mixer.ctx;
    await ctx.audioWorklet.addModule(new URL("/pcm-player.js", window.location.href).href).catch(() => undefined);
    if (this.stopped) return;
    const rate = ctx.sampleRate;
    const node = new AudioWorkletNode(ctx, "pcm-player", {
      numberOfInputs: 0,
      outputChannelCount: [2],
      processorOptions: { capacity: Math.round(rate * 2 * 2), prebuffer: Math.round(rate * 2 * 0.08) },
    });
    this.mixer.connectToReturn(node);
    this.retNode = node;
    const ratio = 48000 / rate;
    let busy = false;
    this.retTimer = window.setInterval(() => {
      if (busy || this.stopped) return;
      busy = true;
      void invoke<ArrayBuffer>("engine_return_pcm")
        .then((buf) => {
          if (this.stopped || !buf || buf.byteLength < 8) return;
          const src = new Float32Array(buf);
          let out = src;
          if (ratio !== 1) {
            // Remuestreo lineal 48 kHz -> frecuencia del WebView.
            const frames = Math.floor(src.length / 2 / ratio);
            out = new Float32Array(frames * 2);
            for (let i = 0; i < frames; i += 1) {
              const p = i * ratio;
              const k = Math.floor(p);
              const t = p - k;
              const k1 = Math.min(k + 1, src.length / 2 - 1);
              out[i * 2] = src[k * 2] * (1 - t) + src[k1 * 2] * t;
              out[i * 2 + 1] = src[k * 2 + 1] * (1 - t) + src[k1 * 2 + 1] * t;
            }
          }
          node.port.postMessage(out, [out.buffer]);
        })
        .catch(() => undefined)
        .finally(() => {
          busy = false;
        });
    }, 20);
  }

  dispose() {
    this.stopped = true;
    if (this.retTimer !== null) window.clearInterval(this.retTimer);
    this.retTimer = null;
    try {
      this.retNode?.disconnect();
    } catch {
      /* ya desconectado */
    }
    this.retNode = null;
    for (const n of this.nodes) {
      n.port.onmessage = null;
      try {
        n.disconnect();
      } catch {
        /* ya desconectado */
      }
      try {
        this.mixer.previewInput.disconnect(n);
        this.mixer.callInput.disconnect(n);
      } catch {
        /* ya desconectado */
      }
    }
    this.nodes = [];
    this.sink?.disconnect();
    this.sink = null;
  }
}
