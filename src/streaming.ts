import { pushStreamPcm } from "./api";
import type { SoundMixer } from "./mixer";

const CHANNELS = 2;
const MAX_QUEUE = 32;

const workletModules = new WeakMap<BaseAudioContext, Promise<void>>();

function loadPcmWorklet(ctx: AudioContext): Promise<void> {
  let pending = workletModules.get(ctx);
  if (!pending) {
    const url = new URL("/pcm-worklet.js", window.location.href).href;
    pending = ctx.audioWorklet.addModule(url);
    workletModules.set(ctx, pending);
  }
  return pending;
}

function floatToPcm16(samples: Float32Array): Uint8Array {
  const bytes = new Uint8Array(samples.length * 2);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < samples.length; i += 1) {
    const sample = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(i * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
  }
  return bytes;
}

/**
 * Captura PCM de la señal del programa (mismo bus que el VU) y la envia a
 * FFmpeg en fragmentos s16le de 48 kHz estereo. El backend reparte cada
 * fragmento a las salidas Icecast y RTMP activas.
 */
export class StreamEncoder {
  private node: AudioWorkletNode | null = null;
  private sink: GainNode | null = null;
  private queue: Promise<void> = Promise.resolve();
  private pending = 0;
  private stopped = false;

  constructor(
    private readonly mixer: SoundMixer,
    private readonly onError: (message: string) => void,
  ) {}

  get active(): boolean {
    return this.node !== null && !this.stopped;
  }

  async start(): Promise<void> {
    await this.mixer.resume();
    const ctx = this.mixer.ctx;
    await loadPcmWorklet(ctx);
    const node = new AudioWorkletNode(ctx, "pcm-capture", {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [CHANNELS],
      channelCount: CHANNELS,
      channelCountMode: "explicit",
      channelInterpretation: "speakers",
    });
    const sink = ctx.createGain();
    sink.gain.value = 0;
    this.mixer.getProgramNode().connect(node);
    node.connect(sink);
    sink.connect(ctx.destination);
    this.node = node;
    this.sink = sink;
    this.stopped = false;

    node.port.onmessage = (event: MessageEvent<Float32Array>) => {
      if (this.stopped || this.pending >= MAX_QUEUE) return;
      const bytes = floatToPcm16(event.data);
      if (bytes.length === 0) return;
      this.pending += 1;
      this.queue = this.queue
        .then(async () => {
          if (this.stopped) return;
          await pushStreamPcm(Array.from(bytes));
        })
        .catch((error: unknown) => {
          this.onError(error instanceof Error ? error.message : String(error));
        })
        .finally(() => {
          this.pending = Math.max(0, this.pending - 1);
        });
    };
    node.onprocessorerror = () => {
      this.onError("La captura PCM de la emisión falló.");
    };
  }

  async stop(): Promise<void> {
    this.stopped = true;
    const node = this.node;
    const sink = this.sink;
    this.node = null;
    this.sink = null;
    if (node) {
      node.port.onmessage = null;
      try {
        this.mixer.getProgramNode().disconnect(node);
      } catch {
        /* ya estaba desconectado */
      }
      try {
        node.disconnect();
      } catch {
        /* ya estaba desconectado */
      }
      node.port.close();
    }
    if (sink) {
      try {
        sink.disconnect();
      } catch {
        /* ya estaba desconectado */
      }
    }
    await this.queue.catch(() => undefined);
  }
}
