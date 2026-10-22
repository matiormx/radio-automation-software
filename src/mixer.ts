import { convertFileSrc } from "@tauri-apps/api/core";
import type { Settings } from "./types";

/**
 * Mesa de mezclas de la aplicacion.
 *
 * Canales -> buses o tarjeta de salida. Los buses suman canales y salen por
 * una tarjeta. Las fuentes de aplicacion (musica y preescucha) entran por
 * sendos nodos; las entradas fisicas se capturan con getUserMedia.
 *
 * La salida a varias tarjetas se hace con un MediaStreamAudioDestinationNode
 * por dispositivo y un elemento <audio> oculto con setSinkId. Si WebView2 no
 * soporta setSinkId, se usa la salida predeterminada del sistema.
 */

const DEFAULT_DEVICE = "default";
export const MIN_GAIN_DB = -60;
export const MAX_GAIN_DB = 12;

export function dbToGain(db: number): number {
  if (!Number.isFinite(db) || db <= MIN_GAIN_DB) return 0;
  if (db >= MAX_GAIN_DB) return 10 ** (MAX_GAIN_DB / 20);
  return 10 ** (db / 20);
}

function normDevice(id: string): string {
  const s = (id || "").trim();
  return s === "" ? DEFAULT_DEVICE : s;
}

interface Sink {
  dest: MediaStreamAudioDestinationNode;
  el: HTMLAudioElement;
  /** setSinkId ya confirmo la tarjeta; hasta entonces no se reproduce */
  ready: boolean;
  failed: boolean;
}

interface DeviceMix {
  gain: GainNode;
}

interface InputSource {
  stream: MediaStream;
  node: MediaStreamAudioSourceNode;
}

type Config = Pick<Settings, "mixerChannels" | "mixerBuses" | "monitorBusId">;

export class SoundMixer {
  readonly ctx: AudioContext;
  /** Entrada de la reproduccion musical (los decks conectan aqui) */
  readonly musicInput: GainNode;
  /** Entrada de la preescucha del normalizador */
  readonly previewInput: GainNode;
  /** Entrada de la voz de los oyentes que llaman al aire */
  readonly callInput: GainNode;

  onError: ((message: string) => void) | null = null;

  private config: Config = { mixerChannels: [], mixerBuses: [], monitorBusId: "" };
  private volume = 1;
  private channelGains = new Map<string, GainNode>();
  private busGains = new Map<string, GainNode>();
  private deviceMixes = new Map<string, DeviceMix>();
  private sinks = new Map<string, Sink>();
  private inputSources = new Map<string, InputSource>();
  private inputPending = new Set<string>();
  private inputFailed = new Set<string>();
  private previewSource: AudioBufferSourceNode | null = null;
  private previewRaf = 0;
  /** Cancela decodificaciones de preescucha que ya no interesan */
  private previewJob = 0;
  private disposed = false;
  private monitorAnalyser: AnalyserNode;
  private monitorData: Float32Array<ArrayBuffer>;
  private monitorTap: AudioNode | null = null;
  private readonly programTap: GainNode;
  /**
   * Retorno para el oyente que llama (mix-minus): el programa sin su propia voz.
   * Suma la musica y los canales que no son de llamada, ya con su fader.
   */
  private readonly returnMix: GainNode;
  private readonly returnDest: MediaStreamAudioDestinationNode;
  private callSources = new Map<string, { node: MediaStreamAudioSourceNode; el: HTMLAudioElement }>();

  private readonly canSink =
    typeof HTMLMediaElement !== "undefined" && "setSinkId" in HTMLMediaElement.prototype;

  constructor() {
    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) throw new Error("Este equipo no tiene Web Audio");
    this.ctx = new Ctor();
    this.musicInput = this.ctx.createGain();
    this.previewInput = this.ctx.createGain();
    this.callInput = this.ctx.createGain();
    this.returnMix = this.ctx.createGain();
    this.returnDest = this.ctx.createMediaStreamDestination();
    this.programTap = this.ctx.createGain();
    this.monitorAnalyser = this.ctx.createAnalyser();
    this.monitorAnalyser.fftSize = 1024;
    this.monitorAnalyser.smoothingTimeConstant = 0.7;
    this.monitorData = new Float32Array(new ArrayBuffer(this.monitorAnalyser.fftSize * 4));
    const silent = this.ctx.createGain();
    silent.gain.value = 0;
    this.monitorAnalyser.connect(silent);
    silent.connect(this.ctx.destination);
    this.apply(this.config);
  }

  apply(config: Config) {
    if (this.disposed) return;
    const cfg: Config = {
      mixerChannels: config.mixerChannels ?? [],
      mixerBuses: config.mixerBuses ?? [],
      monitorBusId: config.monitorBusId ?? "",
    };
    this.config = cfg;

    if (this.monitorTap) {
      try {
        this.monitorTap.disconnect(this.monitorAnalyser);
      } catch {
        /* ya estaba desconectado */
      }
      try {
        this.monitorTap.disconnect(this.programTap);
      } catch {
        /* ya estaba desconectado */
      }
      this.monitorTap = null;
    }
    this.musicInput.disconnect();
    this.previewInput.disconnect();
    this.callInput.disconnect();
    this.returnMix.disconnect();
    this.returnMix.connect(this.returnDest);
    for (const src of this.inputSources.values()) src.node.disconnect();
    for (const gain of this.channelGains.values()) gain.disconnect();
    for (const gain of this.busGains.values()) gain.disconnect();
    for (const mix of this.deviceMixes.values()) mix.gain.disconnect();
    this.channelGains.clear();
    this.busGains.clear();
    this.deviceMixes.clear();

    const busById = new Map(cfg.mixerBuses.map((b) => [b.id, b]));
    const usedDevices = new Set<string>([DEFAULT_DEVICE]);
    for (const bus of cfg.mixerBuses) usedDevices.add(normDevice(bus.outputDeviceId));
    for (const ch of cfg.mixerChannels) {
      if (ch.output.kind === "device") usedDevices.add(normDevice(ch.output.id));
      if (ch.output.kind === "bus" && busById.has(ch.output.id)) {
        const bus = busById.get(ch.output.id);
        if (bus) usedDevices.add(normDevice(bus.outputDeviceId));
      }
    }

    // Los buses se crean antes que los canales para poder enrutar hacia ellos.
    for (const bus of cfg.mixerBuses) {
      const gain = this.ctx.createGain();
      gain.gain.value = bus.muted ? 0 : dbToGain(bus.gainDb);
      gain.connect(this.deviceMix(normDevice(bus.outputDeviceId)));
      this.busGains.set(bus.id, gain);
    }

    const monitorSource = cfg.monitorBusId ? this.busGains.get(cfg.monitorBusId) : null;
    const monitorTap = monitorSource ?? this.deviceMix(DEFAULT_DEVICE);
    monitorTap.connect(this.monitorAnalyser);
    monitorTap.connect(this.programTap);
    this.monitorTap = monitorTap;

    let musicUsed = false;
    let previewUsed = false;
    let callUsed = false;
    const inputDevices = new Set<string>();

    for (const ch of cfg.mixerChannels) {
      const gain = this.ctx.createGain();
      gain.gain.value = ch.muted ? 0 : dbToGain(ch.gainDb);
      this.channelGains.set(ch.id, gain);

      if (ch.input.kind === "app") {
        if (ch.input.app === "preview") {
          this.previewInput.connect(gain);
          previewUsed = true;
        } else if (ch.input.app === "call") {
          this.callInput.connect(gain);
          callUsed = true;
        } else {
          this.musicInput.connect(gain);
          musicUsed = true;
        }
      } else {
        const id = normDevice(ch.input.deviceId);
        inputDevices.add(id);
        this.connectInput(id, gain);
      }

      // Todo lo que no es la voz del que llama alimenta su retorno.
      if (!(ch.input.kind === "app" && ch.input.app === "call")) gain.connect(this.returnMix);

      if (ch.output.kind === "bus") {
        const busGain = this.busGains.get(ch.output.id);
        if (busGain) gain.connect(busGain);
        else gain.connect(this.deviceMix(DEFAULT_DEVICE));
      } else {
        gain.connect(this.deviceMix(normDevice(ch.output.id)));
      }
    }

    // Sin canal para una fuente de la app, esta sigue saliendo por la salida
    // del sistema para no dejar la radio muda por una configuracion a medias.
    if (!musicUsed) {
      this.musicInput.connect(this.deviceMix(DEFAULT_DEVICE));
      this.musicInput.connect(this.returnMix);
    }
    if (!callUsed) this.callInput.connect(this.deviceMix(DEFAULT_DEVICE));
    if (!previewUsed) this.previewInput.connect(this.deviceMix(DEFAULT_DEVICE));

    // Liberar entradas fisicas que ya no usa ningun canal.
    for (const [id, src] of this.inputSources) {
      if (inputDevices.has(id)) continue;
      src.node.disconnect();
      for (const track of src.stream.getTracks()) track.stop();
      this.inputSources.delete(id);
    }
    for (const id of this.inputFailed) {
      if (!inputDevices.has(id)) this.inputFailed.delete(id);
    }

    // Liberar salidas que ya no se usan.
    for (const [id, sink] of this.sinks) {
      if (usedDevices.has(id)) continue;
      sink.el.pause();
      sink.el.srcObject = null;
      sink.el.remove();
      this.sinks.delete(id);
    }
  }

  /**
   * Conecta la voz de un oyente (audio remoto de la llamada) a la mesa.
   * El <audio> mudo mantiene vivo el flujo: sin el, Chromium no entrega audio remoto a Web Audio.
   */
  attachCallSource(id: string, stream: MediaStream) {
    if (this.disposed) return;
    this.detachCallSource(id);
    const el = document.createElement("audio");
    el.muted = true;
    el.srcObject = stream;
    el.style.display = "none";
    document.body.appendChild(el);
    void el.play().catch(() => undefined);
    const node = this.ctx.createMediaStreamSource(stream);
    node.connect(this.callInput);
    this.callSources.set(id, { node, el });
    void this.resume();
  }

  detachCallSource(id: string) {
    const src = this.callSources.get(id);
    if (!src) return;
    try {
      src.node.disconnect();
    } catch {
      /* ya desconectado */
    }
    src.el.pause();
    src.el.srcObject = null;
    src.el.remove();
    this.callSources.delete(id);
  }

  /** Silencia o devuelve la voz de los oyentes sin tocar los faders de la mesa. */
  setCallMuted(muted: boolean) {
    this.callInput.gain.setTargetAtTime(muted ? 0 : 1, this.ctx.currentTime, 0.015);
  }

  /** Pista con el retorno (programa menos la voz del que llama), una copia por llamada. */
  getCallReturnTrack(): MediaStreamTrack | null {
    const track = this.returnDest.stream.getAudioTracks()[0];
    return track ? track.clone() : null;
  }

  /** Señal del programa (mismo bus que el VU) para el motor de emisión. */
  getProgramNode(): AudioNode {
    return this.programTap;
  }

  getMonitorLevel(): { level: number; db: number } {
    if (this.disposed) return { level: 0, db: -60 };
    this.monitorAnalyser.getFloatTimeDomainData(this.monitorData);
    let sum = 0;
    for (const sample of this.monitorData) sum += sample * sample;
    const rms = Math.sqrt(sum / this.monitorData.length);
    const db = 20 * Math.log10(Math.max(rms, 0.000001));
    return {
      level: Math.max(0, Math.min(1, (db + 48) / 48)),
      db: Math.max(-60, db),
    };
  }

  setMasterVolume(v: number) {
    const next = Math.max(0, Math.min(1, Number.isFinite(v) ? v : 1));
    this.volume = next;
    const now = this.ctx.currentTime;
    for (const mix of this.deviceMixes.values()) {
      mix.gain.gain.cancelScheduledValues(now);
      mix.gain.gain.setTargetAtTime(next, now, 0.012);
    }
  }

  async resume(): Promise<void> {
    if (this.disposed) return;
    if (this.ctx.state === "suspended") {
      // Si el navegador bloquea el arranque automatico, la promesa se queda
      // colgada: no esperamos mas de un momento y seguimos.
      await Promise.race([
        this.ctx.resume().catch(() => undefined),
        new Promise((resolve) => window.setTimeout(resolve, 1200)),
      ]);
    }
    for (const sink of this.sinks.values()) this.playSink(sink);
  }

  /** Reintenta entradas que fallaron (por ejemplo tras conceder permiso). */
  retryInputs() {
    this.inputFailed.clear();
    this.apply(this.config);
  }

  /** Reintenta tarjetas de salida que no estaban disponibles. */
  retryOutputs() {
    for (const [id, sink] of this.sinks) {
      if (!sink.failed) continue;
      sink.el.pause();
      sink.el.srcObject = null;
      sink.el.remove();
      this.sinks.delete(id);
    }
    this.apply(this.config);
  }

  async playPreview(
    file: string,
    start: number,
    end: number,
    onTick: (position: number) => void,
    onEnded: () => void,
  ): Promise<void> {
    this.stopPreview();
    const job = this.previewJob;
    await this.resume();
    if (job !== this.previewJob) return;
    const res = await fetch(convertFileSrc(file));
    if (!res.ok) throw new Error(`No se pudo leer el audio (${res.status})`);
    const bytes = await res.arrayBuffer();
    if (job !== this.previewJob) return;
    const buffer = await this.ctx.decodeAudioData(bytes);
    if (job !== this.previewJob) return;
    const from = Math.max(0, Math.min(buffer.duration - 0.05, start));
    const duration = Math.max(0.05, Math.min(buffer.duration - from, end - start));
    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(this.previewInput);
    const startAt = this.ctx.currentTime + 0.03;
    source.start(startAt, from, duration);
    this.previewSource = source;

    const tick = () => {
      if (this.previewSource !== source) return;
      const pos = from + Math.max(0, this.ctx.currentTime - startAt);
      onTick(Math.min(from + duration, pos));
      if (pos < from + duration) this.previewRaf = requestAnimationFrame(tick);
    };
    this.previewRaf = requestAnimationFrame(tick);

    source.onended = () => {
      if (this.previewSource !== source) return;
      this.previewSource = null;
      cancelAnimationFrame(this.previewRaf);
      this.previewRaf = 0;
      onEnded();
    };
  }

  stopPreview() {
    this.previewJob += 1;
    cancelAnimationFrame(this.previewRaf);
    this.previewRaf = 0;
    const source = this.previewSource;
    this.previewSource = null;
    if (!source) return;
    source.onended = null;
    try {
      source.stop();
    } catch {
      /* ya estaba parada */
    }
    source.disconnect();
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.stopPreview();
    if (this.monitorTap) {
      try {
        this.monitorTap.disconnect(this.monitorAnalyser);
      } catch {
        /* ya estaba desconectado */
      }
      try {
        this.monitorTap.disconnect(this.programTap);
      } catch {
        /* ya estaba desconectado */
      }
      this.monitorTap = null;
    }
    for (const id of Array.from(this.callSources.keys())) this.detachCallSource(id);
    for (const src of this.inputSources.values()) {
      src.node.disconnect();
      for (const track of src.stream.getTracks()) track.stop();
    }
    this.inputSources.clear();
    for (const sink of this.sinks.values()) {
      sink.el.pause();
      sink.el.srcObject = null;
      sink.el.remove();
    }
    this.sinks.clear();
    this.deviceMixes.clear();
    this.programTap.disconnect();
    void this.ctx.close().catch(() => undefined);
  }

  // ---------------------------------------------------------------- internals

  private deviceMix(deviceId: string): GainNode {
    const id = normDevice(deviceId);
    const existing = this.deviceMixes.get(id);
    if (existing) return existing.gain;

    const gain = this.ctx.createGain();
    gain.gain.value = this.volume;
    if (id === DEFAULT_DEVICE || !this.canSink) {
      gain.connect(this.ctx.destination);
    } else {
      const sink = this.ensureSink(id);
      if (sink && !sink.failed) gain.connect(sink.dest);
      else gain.connect(this.ctx.destination);
    }
    this.deviceMixes.set(id, { gain });
    return gain;
  }

  private ensureSink(deviceId: string): Sink | null {
    const existing = this.sinks.get(deviceId);
    if (existing) return existing;
    if (!this.canSink) return null;

    const dest = this.ctx.createMediaStreamDestination();
    const el = document.createElement("audio");
    el.autoplay = false;
    el.srcObject = dest.stream;
    el.style.display = "none";
    el.setAttribute("aria-hidden", "true");
    document.body.appendChild(el);
    const sink: Sink = { dest, el, ready: false, failed: false };
    this.sinks.set(deviceId, sink);

    const withSink = el as HTMLAudioElement & {
      setSinkId?: (id: string) => Promise<void>;
    };
    if (typeof withSink.setSinkId !== "function") {
      this.failSink(sink);
      return sink;
    }
    void withSink
      .setSinkId(deviceId)
      .then(() => {
        if (this.disposed) return;
        sink.ready = true;
        this.playSink(sink);
      })
      .catch(() => {
        if (this.disposed) return;
        this.failSink(sink);
        this.onError?.(
          "No se pudo abrir una tarjeta de salida; ese bus usara la salida predeterminada.",
        );
        this.apply(this.config);
      });
    return sink;
  }

  /**
   * Un sink que no se pudo abrir no debe quedarse reproduciendo en la salida
   * predeterminada: el mismo audio saldria dos veces.
   */
  private failSink(sink: Sink) {
    sink.failed = true;
    sink.ready = false;
    sink.el.pause();
    sink.el.srcObject = null;
    sink.el.remove();
  }

  private playSink(sink: Sink) {
    if (sink.failed || !sink.ready || this.disposed) return;
    if (!sink.el.paused) return;
    void sink.el.play().catch(() => undefined);
  }

  private connectInput(deviceId: string, channelGain: GainNode) {
    const id = normDevice(deviceId);
    const existing = this.inputSources.get(id);
    if (existing) {
      existing.node.connect(channelGain);
      return;
    }
    this.requestInput(id);
  }

  private requestInput(deviceId: string) {
    if (this.disposed || this.inputPending.has(deviceId) || this.inputFailed.has(deviceId)) return;
    const media = navigator.mediaDevices;
    if (!media?.getUserMedia) {
      this.inputFailed.add(deviceId);
      this.onError?.("Este equipo no permite capturar entradas de audio.");
      return;
    }
    this.inputPending.add(deviceId);
    const constraints: MediaStreamConstraints = {
      audio:
        deviceId === DEFAULT_DEVICE
          ? { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
          : {
              deviceId: { exact: deviceId },
              echoCancellation: false,
              noiseSuppression: false,
              autoGainControl: false,
            },
    };
    void media
      .getUserMedia(constraints)
      .then((stream) => {
        this.inputPending.delete(deviceId);
        if (this.disposed || !this.usesInput(deviceId)) {
          for (const track of stream.getTracks()) track.stop();
          return;
        }
        if (this.inputSources.has(deviceId)) {
          for (const track of stream.getTracks()) track.stop();
          return;
        }
        const node = this.ctx.createMediaStreamSource(stream);
        this.inputSources.set(deviceId, { stream, node });
        for (const ch of this.config.mixerChannels) {
          if (ch.input.kind !== "device") continue;
          if (normDevice(ch.input.deviceId) !== deviceId) continue;
          const gain = this.channelGains.get(ch.id);
          if (gain) node.connect(gain);
        }
      })
      .catch(() => {
        this.inputPending.delete(deviceId);
        if (this.disposed) return;
        this.inputFailed.add(deviceId);
        this.onError?.("No se pudo abrir una entrada de audio. Revisa los permisos.");
      });
  }

  private usesInput(deviceId: string): boolean {
    return this.config.mixerChannels.some(
      (ch) => ch.input.kind === "device" && normDevice(ch.input.deviceId) === deviceId,
    );
  }
}
