import { convertFileSrc } from "@tauri-apps/api/core";
import type { InsertSettings, Settings } from "./types";
import { Leveler, levelerOf } from "./leveler";

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
/** Salida virtual: lo que entra a los encoders de streaming */
export const STREAM_DEVICE = "streaming";
/** Salida «Ninguna»: no va a ninguna tarjeta */
export const NONE_DEVICE = "none";
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

/** Insert util: activado y con ambas tarjetas elegidas. */
export function insertOf(
  x: { insert?: Partial<InsertSettings> } | undefined,
): InsertSettings | null {
  const i = x?.insert;
  if (!i?.enabled) return null;
  const sendDeviceId = (i.sendDeviceId || "").trim();
  const returnDeviceId = (i.returnDeviceId || "").trim();
  if (!sendDeviceId || !returnDeviceId) return null;
  return { enabled: true, sendDeviceId, returnDeviceId };
}

interface InsertReturn {
  deviceId: string;
  /** Donde vuelve la senal procesada (nivelador o fader) */
  target: AudioNode;
  /** Camino directo: suena hasta que el retorno esta vivo, para no dejar el canal mudo */
  bypass: GainNode;
}

type Config = Pick<Settings, "mixerChannels" | "mixerBuses" | "monitorBusId">;

export class SoundMixer {
  readonly ctx: AudioContext;
  /** Entrada de la reproduccion musical (los decks conectan aqui) */
  readonly musicInput: GainNode;
  /** Entrada de la preescucha del normalizador */
  readonly previewInput: GainNode;
  /**
   * Medidor de la musica (deteccion de silencio). Vive aqui porque apply()
   * desconecta musicInput al reconfigurar la mesa y lo reconecta.
   */
  readonly musicAnalyser: AnalyserNode;
  /** Entrada de la voz de los oyentes que llaman al aire */
  readonly callInput: GainNode;

  onError: ((message: string) => void) | null = null;

  private config: Config = {
    mixerChannels: [],
    mixerBuses: [],
    monitorBusId: "",
  };
  private volume = 1;
  private channelGains = new Map<string, GainNode>();
  private busGains = new Map<string, GainNode>();
  /** Faders reales (ya con ganancia) de la ultima configuracion; busGains/channelGains guardan donde entra la senal */
  private busFaders = new Map<string, AudioNode>();
  /** Medidores por tira (izquierda y derecha) para la ventana Mixer */
  private stripMeters = new Map<string, { l: AnalyserNode; r: AnalyserNode }>();
  private meterData = new Float32Array(new ArrayBuffer(256 * 4));
  /** Faders por tira para moverlos en vivo sin rehacer la mesa */
  private liveFaders = new Map<string, { gain: GainNode; open: boolean }>();
  private readonly meterSink: GainNode;
  private faders: GainNode[] = [];
  private levelers = new Map<string, Leveler>();
  /** Salidas de envio de los inserts (sin volumen maestro: van a un procesador) */
  private insertSinks = new Map<string, { deviceId: string; sink: Sink }>();
  private insertReturns = new Map<string, InsertReturn>();
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
  private streamAnalyser: AnalyserNode;
  /** Algun canal lleva la musica de la app (si no, el detector de silencio no vale) */
  musicRouted = true;
  private streamData: Float32Array<ArrayBuffer>;
  private monitorData: Float32Array<ArrayBuffer>;
  private monitorTap: AudioNode | null = null;
  private readonly programTap: GainNode;
  /** Suma de lo enrutado a la salida Streaming (sin volumen maestro) */
  private readonly streamMix: GainNode;
  /**
   * Retorno para el oyente que llama (mix-minus): el programa sin su propia voz.
   * Suma la musica y los canales que no son de llamada, ya con su fader.
   */
  private readonly returnMix: GainNode;
  private readonly returnDest: MediaStreamAudioDestinationNode;
  private callSources = new Map<
    string,
    { node: MediaStreamAudioSourceNode; el: HTMLAudioElement }
  >();

  private readonly canSink =
    typeof HTMLMediaElement !== "undefined" &&
    "setSinkId" in HTMLMediaElement.prototype;

  constructor() {
    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext;
    if (!Ctor) throw new Error("Este equipo no tiene Web Audio");
    this.ctx = new Ctor();
    this.musicInput = this.ctx.createGain();
    this.previewInput = this.ctx.createGain();
    this.callInput = this.ctx.createGain();
    this.musicAnalyser = this.ctx.createAnalyser();
    this.musicAnalyser.fftSize = 512;
    const musicSilent = this.ctx.createGain();
    musicSilent.gain.value = 0;
    this.musicAnalyser.connect(musicSilent);
    musicSilent.connect(this.ctx.destination);
    this.returnMix = this.ctx.createGain();
    this.returnDest = this.ctx.createMediaStreamDestination();
    this.programTap = this.ctx.createGain();
    this.meterSink = this.ctx.createGain();
    this.meterSink.gain.value = 0;
    this.meterSink.connect(this.ctx.destination);
    this.streamMix = this.ctx.createGain();
    this.monitorAnalyser = this.ctx.createAnalyser();
    this.monitorAnalyser.fftSize = 1024;
    this.monitorAnalyser.smoothingTimeConstant = 0.7;
    this.monitorData = new Float32Array(
      new ArrayBuffer(this.monitorAnalyser.fftSize * 4),
    );
    const silent = this.ctx.createGain();
    silent.gain.value = 0;
    this.monitorAnalyser.connect(silent);
    silent.connect(this.ctx.destination);
    // VU de la salida de streaming: lo que reciben los encoders.
    this.streamAnalyser = this.ctx.createAnalyser();
    this.streamAnalyser.fftSize = 1024;
    this.streamAnalyser.smoothingTimeConstant = 0.7;
    this.streamData = new Float32Array(new ArrayBuffer(this.streamAnalyser.fftSize * 4));
    this.programTap.connect(this.streamAnalyser);
    this.streamAnalyser.connect(silent);
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
    this.streamMix.disconnect();
    this.musicInput.disconnect();
    this.musicInput.connect(this.musicAnalyser);
    this.previewInput.disconnect();
    this.callInput.disconnect();
    this.returnMix.disconnect();
    this.returnMix.connect(this.returnDest);
    for (const src of this.inputSources.values()) src.node.disconnect();
    for (const gain of this.faders) gain.disconnect();
    this.faders = [];
    this.busFaders.clear();
    const wantedLevelers = new Set<string>();
    // Nivelador de un canal o bus: se reutiliza entre reconfiguraciones para no
    // perder lo que ya ha medido (cambiar un fader no debe reiniciarlo).
    const levelerFor = (
      key: string,
      owner: Parameters<typeof levelerOf>[0],
    ): Leveler | null => {
      const cfg = levelerOf(owner);
      if (!cfg.enabled) return null;
      wantedLevelers.add(key);
      let lv = this.levelers.get(key);
      if (lv) lv.update(cfg);
      else {
        lv = new Leveler(this.ctx, cfg);
        this.levelers.set(key, lv);
      }
      lv.output.disconnect();
      return lv;
    };
    let musicUsed = false;
    let previewUsed = false;
    let callUsed = false;
    const inputDevices = new Set<string>();
    const wantedInserts = new Set<string>();
    this.insertReturns.clear();
    // Insert: entrada -> envio (tarjeta) ... procesador externo ... retorno -> next.
    // Mientras el retorno no llega, la senal pasa directa para no enmudecer.
    const insertFor = (
      key: string,
      owner: { insert?: Partial<InsertSettings> },
      next: GainNode,
    ): GainNode => {
      const ins = insertOf(owner);
      if (!ins) return next;
      wantedInserts.add(key);
      const send = this.ctx.createGain();
      const bypass = this.ctx.createGain();
      this.faders.push(send, bypass);
      send.connect(bypass);
      bypass.connect(next);
      const sink = this.insertSink(key, ins.sendDeviceId);
      if (!sink || sink.failed || !sink.ready) return send;
      send.connect(sink.dest);
      const returnId = normDevice(ins.returnDeviceId);
      inputDevices.add(returnId);
      this.insertReturns.set(key, { deviceId: returnId, target: next, bypass });
      const src = this.inputSources.get(returnId);
      if (src) {
        src.node.connect(next);
        bypass.gain.value = 0;
      } else {
        this.requestInput(returnId);
      }
      return send;
    };
    for (const mix of this.deviceMixes.values()) mix.gain.disconnect();
    // Las conexiones de las entradas se rehacen enteras en cada aplicacion.
    for (const src of this.inputSources.values()) src.node.disconnect();
    this.channelGains.clear();
    this.busGains.clear();
    this.deviceMixes.clear();

    const busById = new Map(cfg.mixerBuses.map((b) => [b.id, b]));
    const usedDevices = new Set<string>([DEFAULT_DEVICE]);
    for (const bus of cfg.mixerBuses)
      usedDevices.add(normDevice(bus.outputDeviceId));
    usedDevices.delete(NONE_DEVICE);
    for (const ch of cfg.mixerChannels) {
      if (ch.output.kind === "device")
        usedDevices.add(normDevice(ch.output.id));
      if (ch.output.kind === "bus" && busById.has(ch.output.id)) {
        const bus = busById.get(ch.output.id);
        if (bus) usedDevices.add(normDevice(bus.outputDeviceId));
      }
    }

    for (const m of this.stripMeters.values()) {
      m.l.disconnect();
      m.r.disconnect();
    }
    this.stripMeters.clear();
    this.liveFaders.clear();
    const meterFor = (key: string, node: AudioNode) => {
      const split = this.ctx.createChannelSplitter(2);
      const l = this.ctx.createAnalyser();
      const r = this.ctx.createAnalyser();
      l.fftSize = 256;
      r.fftSize = 256;
      node.connect(split);
      split.connect(l, 0);
      split.connect(r, 1);
      // Conectados a un sumidero mudo para que el navegador los procese.
      l.connect(this.meterSink);
      r.connect(this.meterSink);
      this.stripMeters.set(key, { l, r });
    };
    // Balance como el motor nativo: baja el lado contrario, no mezcla L en R.
    // La entrada fuerza estereo (una entrada mono sale por los dos lados).
    const panner = (pan: number | undefined) => {
      const p = Number.isFinite(pan) ? Math.max(-1, Math.min(1, pan as number)) : 0;
      const input = this.ctx.createGain();
      input.channelCount = 2;
      input.channelCountMode = "explicit";
      input.channelInterpretation = "speakers";
      const split = this.ctx.createChannelSplitter(2);
      const gl = this.ctx.createGain();
      const gr = this.ctx.createGain();
      const merge = this.ctx.createChannelMerger(2);
      gl.gain.value = p > 0 ? 1 - p : 1;
      gr.gain.value = p < 0 ? 1 + p : 1;
      input.connect(split);
      split.connect(gl, 0);
      split.connect(gr, 1);
      gl.connect(merge, 0, 0);
      gr.connect(merge, 0, 1);
      for (const n of [input, split, gl, gr, merge]) this.faders.push(n as unknown as GainNode);
      return { input, output: merge };
    };

    // Los buses se crean antes que los canales para poder enrutar hacia ellos.
    for (const bus of cfg.mixerBuses) {
      const gain = this.ctx.createGain();
      gain.gain.value = bus.muted ? 0 : dbToGain(bus.gainDb);
      const pan = panner(bus.pan);
      gain.connect(pan.input);
      if (normDevice(bus.outputDeviceId) !== NONE_DEVICE)
        pan.output.connect(this.deviceMix(normDevice(bus.outputDeviceId)));
      this.faders.push(gain);
      this.busFaders.set(bus.id, pan.output);
      this.liveFaders.set(`bus:${bus.id}`, { gain, open: !bus.muted });
      meterFor(`bus:${bus.id}`, pan.output);
      const lv = levelerFor(`bus:${bus.id}`, bus);
      if (lv) lv.output.connect(gain);
      this.busGains.set(
        bus.id,
        insertFor(`bus:${bus.id}`, bus, lv ? lv.input : gain),
      );
    }

    const monitorSource = cfg.monitorBusId
      ? this.busFaders.get(cfg.monitorBusId)
      : null;
    const monitorTap = monitorSource ?? this.deviceMix(DEFAULT_DEVICE);
    monitorTap.connect(this.monitorAnalyser);
    // Los encoders toman la salida Streaming si algo va a ella; si no, la
    // salida predeterminada (se avisa en la mesa; no depende del VU).
    const streamUsed =
      cfg.mixerBuses.some(
        (b) => normDevice(b.outputDeviceId) === STREAM_DEVICE,
      ) ||
      cfg.mixerChannels.some(
        (ch) =>
          ch.output.kind === "device" &&
          normDevice(ch.output.id) === STREAM_DEVICE,
      );
    if (streamUsed) this.streamMix.connect(this.programTap);
    else this.deviceMix(DEFAULT_DEVICE).connect(this.programTap);
    this.monitorTap = monitorTap;

    const anySolo = cfg.mixerChannels.some((c) => c.solo);
    for (const ch of cfg.mixerChannels) {
      // Con algun canal en solo, los demas se callan (solo en el sitio).
      const open = !ch.muted && (!anySolo || !!ch.solo);
      const gain = this.ctx.createGain();
      gain.gain.value = open ? dbToGain(ch.gainDb) : 0;
      this.faders.push(gain);
      // Punto antes del fader: de aqui salen los envios "pre".
      this.liveFaders.set(`ch:${ch.id}`, { gain, open });
      const pre = this.ctx.createGain();
      this.faders.push(pre);
      pre.connect(gain);
      // Mono: L+R se mezclan (downmix a 1 canal) y vuelven a salir por los dos lados.
      let head: GainNode = pre;
      const mm = ch.monoMode ?? "off";
      if (mm !== "off") {
        pre.channelCount = 2;
        pre.channelCountMode = "explicit";
        pre.channelInterpretation = "speakers";
        const input = this.ctx.createGain();
        input.channelCount = 2;
        input.channelCountMode = "explicit";
        input.channelInterpretation = "speakers";
        const split = this.ctx.createChannelSplitter(2);
        const merge = this.ctx.createChannelMerger(2);
        input.connect(split);
        // suma: (L+R)/2; izquierda o derecha: ese lado a los dos
        const gain = mm === "sum" ? 0.5 : 1;
        const sides = mm === "sum" ? [0, 1] : [mm === "left" ? 0 : 1];
        for (const side of sides) {
          const g = this.ctx.createGain();
          g.gain.value = gain;
          split.connect(g, side);
          g.connect(merge, 0, 0);
          g.connect(merge, 0, 1);
          this.faders.push(g);
        }
        merge.connect(pre);
        this.faders.push(input, merge as unknown as GainNode);
        head = input;
      }
      const panNode = panner(ch.pan);
      gain.connect(panNode.input);
      const pan = panNode.output;
      meterFor(`ch:${ch.id}`, pan);
      const lv = levelerFor(`ch:${ch.id}`, ch);
      if (lv) lv.output.connect(head);
      // La senal entra por el insert y el nivelador (si los hay) y luego pasa por el fader.
      const insertEntry = insertFor(`ch:${ch.id}`, ch, lv ? lv.input : head);
      // Ganancia de entrada, antes de inserts y fader (el AGC solo existe en el motor nativo).
      const entry = this.ctx.createGain();
      entry.gain.value = dbToGain(ch.inputGainDb ?? 0);
      entry.connect(insertEntry);
      this.faders.push(entry);
      for (const send of ch.sends ?? []) {
        const busEntry = this.busGains.get(send.busId);
        if (!busEntry) continue;
        if (ch.output.kind === "bus" && ch.output.id === send.busId) continue;
        const sg = this.ctx.createGain();
        const base = send.muted ? 0 : dbToGain(send.gainDb);
        sg.gain.value = send.pre && !open ? 0 : base;
        this.faders.push(sg);
        (send.pre ? pre : pan).connect(sg);
        sg.connect(busEntry);
      }
      this.channelGains.set(ch.id, entry);

      if (ch.input.kind === "app") {
        if (ch.input.app === "preview") {
          this.previewInput.connect(entry);
          previewUsed = true;
        } else if (ch.input.app === "call") {
          this.callInput.connect(entry);
          callUsed = true;
        } else {
          this.musicInput.connect(entry);
          musicUsed = true;
        }
      } else {
        const id = normDevice(ch.input.deviceId);
        // Entrada «Ninguna»: el canal no recibe nada.
        if (id !== NONE_DEVICE) {
          inputDevices.add(id);
          this.connectInput(id, entry, ch.input.channel ?? 0, (ch.monoMode ?? "off") !== "off");
        }
      }

      // Todo lo que no es la voz del que llama alimenta su retorno.
      if (!(ch.input.kind === "app" && ch.input.app === "call"))
        pan.connect(this.returnMix);

      if (ch.output.kind === "bus") {
        const busGain = this.busGains.get(ch.output.id);
        if (busGain) pan.connect(busGain);
        else pan.connect(this.deviceMix(DEFAULT_DEVICE));
      } else {
        if (normDevice(ch.output.id) !== NONE_DEVICE) pan.connect(this.deviceMix(normDevice(ch.output.id)));
      }
    }

    // Niveladores de canales o buses que ya no existen o se han apagado.
    for (const [key, lv] of Array.from(this.levelers)) {
      if (wantedLevelers.has(key)) continue;
      lv.dispose();
      this.levelers.delete(key);
    }

    // Una fuente de la app sin canal no sale por ningun sitio (nada oculto):
    // la mesa muestra el aviso y permite crear el canal.
    this.musicRouted = musicUsed;
    void callUsed;
    void previewUsed;

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

    for (const [key, entry] of Array.from(this.insertSinks)) {
      if (wantedInserts.has(key)) continue;
      this.closeSink(entry.sink);
      this.insertSinks.delete(key);
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

  /** Suma un nodo al retorno de los oyentes (motor nativo: su mix-minus). */
  connectToReturn(node: AudioNode) {
    node.connect(this.returnMix);
  }

  /** Silencia o devuelve la voz de los oyentes sin tocar los faders de la mesa. */
  setCallMuted(muted: boolean) {
    this.callInput.gain.setTargetAtTime(
      muted ? 0 : 1,
      this.ctx.currentTime,
      0.015,
    );
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

  /** Mueve un fader en vivo (mientras se arrastra), sin rehacer la mesa. */
  setLiveGain(key: string, db: number) {
    const f = this.liveFaders.get(key);
    if (!f) return;
    f.gain.gain.setTargetAtTime(f.open ? dbToGain(db) : 0, this.ctx.currentTime, 0.01);
  }

  /** Picos actuales de cada canal y bus (lineales, 0..1+). */
  getStripMeters(): { key: string; l: number; r: number }[] {
    const out: { key: string; l: number; r: number }[] = [];
    const data = this.meterData;
    const peak = (a: AnalyserNode) => {
      a.getFloatTimeDomainData(data);
      let m = 0;
      for (let i = 0; i < data.length; i += 1) m = Math.max(m, Math.abs(data[i]));
      return m;
    };
    for (const [key, m] of this.stripMeters) out.push({ key, l: peak(m.l), r: peak(m.r) });
    return out;
  }

  getMonitorLevel(): { level: number; db: number } {
    if (this.disposed) return { level: 0, db: -60 };
    return levelOf(this.monitorAnalyser, this.monitorData);
  }

  /** Analizador de lo que va a los encoders de streaming (detector de silencio). */
  getStreamAnalyser(): AnalyserNode {
    return this.streamAnalyser;
  }

  /** Nivel de lo que va a los encoders de streaming. */
  getStreamLevel(): { level: number; db: number } {
    if (this.disposed) return { level: 0, db: -60 };
    return levelOf(this.streamAnalyser, this.streamData);
  }

  setMasterVolume(v: number) {
    const next = Math.max(0, Math.min(1, Number.isFinite(v) ? v : 1));
    this.volume = next;
    const now = this.ctx.currentTime;
    for (const [id, mix] of this.deviceMixes) {
      if (id === STREAM_DEVICE) continue;
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
    for (const { sink } of this.insertSinks.values()) this.playSink(sink);
  }

  /** Reintenta entradas que fallaron (por ejemplo tras conceder permiso). */
  retryInputs() {
    this.inputFailed.clear();
    this.apply(this.config);
  }

  /** Reintenta tarjetas de salida que no estaban disponibles. */
  retryOutputs() {
    for (const [key, entry] of Array.from(this.insertSinks)) {
      if (!entry.sink.failed) continue;
      this.closeSink(entry.sink);
      this.insertSinks.delete(key);
    }
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
    const duration = Math.max(
      0.05,
      Math.min(buffer.duration - from, end - start),
    );
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
    for (const lv of this.levelers.values()) lv.dispose();
    this.levelers.clear();
    for (const id of Array.from(this.callSources.keys()))
      this.detachCallSource(id);
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
    for (const { sink } of this.insertSinks.values()) this.closeSink(sink);
    this.insertSinks.clear();
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
    if (id === STREAM_DEVICE) {
      // El volumen maestro es la escucha local: no debe cambiar la emision.
      gain.gain.value = 1;
      gain.connect(this.streamMix);
      this.deviceMixes.set(id, { gain });
      return gain;
    }
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
   * Salida de envio de un insert. Al confirmarse la tarjeta (o fallar) se
   * reconfigura la mesa para conectar el retorno o dejar el canal en directo.
   */
  private insertSink(key: string, deviceId: string): Sink | null {
    if (!this.canSink) return null;
    const existing = this.insertSinks.get(key);
    if (existing && existing.deviceId === deviceId) return existing.sink;
    if (existing) this.closeSink(existing.sink);
    const dest = this.ctx.createMediaStreamDestination();
    const el = document.createElement("audio");
    el.autoplay = false;
    el.srcObject = dest.stream;
    el.style.display = "none";
    el.setAttribute("aria-hidden", "true");
    document.body.appendChild(el);
    const sink: Sink = { dest, el, ready: false, failed: false };
    this.insertSinks.set(key, { deviceId, sink });
    const withSink = el as HTMLAudioElement & {
      setSinkId?: (id: string) => Promise<void>;
    };
    if (typeof withSink.setSinkId !== "function") {
      this.failSink(sink);
      return sink;
    }
    const target = deviceId === DEFAULT_DEVICE ? "" : deviceId;
    void withSink
      .setSinkId(target)
      .then(() => {
        if (this.disposed || this.insertSinks.get(key)?.sink !== sink) return;
        sink.ready = true;
        this.playSink(sink);
        this.apply(this.config);
      })
      .catch(() => {
        if (this.disposed || this.insertSinks.get(key)?.sink !== sink) return;
        this.failSink(sink);
        this.onError?.(
          "No se pudo abrir la tarjeta de envío del insert; el canal suena directo.",
        );
        this.apply(this.config);
      });
    return sink;
  }

  private closeSink(sink: Sink) {
    sink.el.pause();
    sink.el.srcObject = null;
    sink.el.remove();
    try {
      sink.dest.disconnect();
    } catch {
      /* ya desconectado */
    }
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

  /** Canales que necesita cada tarjeta de entrada segun los canales de la mesa. */
  private wantedChannels(deviceId: string): number {
    let n = 2;
    for (const ch of this.config.mixerChannels) {
      if (ch.input.kind !== "device" || normDevice(ch.input.deviceId) !== deviceId) continue;
      const c = ch.input.channel ?? 0;
      n = Math.max(n, (ch.monoMode ?? "off") !== "off" ? c : c * 2);
    }
    return n;
  }

  /**
   * Conecta la entrada al canal eligiendo sus canales: estereo = un par de la
   * tarjeta (1-2, 3-4...), mono = un solo canal que sale igual por los dos lados.
   */
  private attachInput(node: MediaStreamAudioSourceNode, target: GainNode, channel: number, mono: boolean) {
    const have = node.channelCount;
    const first = mono ? channel - 1 : Math.max(0, channel - 1) * 2;
    if (!mono && first === 0) {
      node.connect(target);
      return;
    }
    if (mono && channel === 0) {
      node.connect(target); // mezcla L+R (el boton Mono del canal hace el downmix)
      return;
    }
    if (first >= have) return; // la tarjeta no llega a ese canal: silencio
    const split = this.ctx.createChannelSplitter(Math.max(have, 2));
    const merge = this.ctx.createChannelMerger(2);
    node.connect(split);
    split.connect(merge, first, 0);
    split.connect(merge, mono ? first : Math.min(first + 1, have - 1), 1);
    merge.connect(target);
  }

  private connectInput(deviceId: string, channelGain: GainNode, channel = 0, mono = false) {
    const id = normDevice(deviceId);
    const existing = this.inputSources.get(id);
    if (existing) {
      if (this.wantedChannels(id) > existing.node.channelCount && existing.node.channelCount >= 2 && !this.inputPending.has(id)) {
        // Hace falta una tarjeta con mas canales abiertos: se reabre.
        existing.node.disconnect();
        for (const track of existing.stream.getTracks()) track.stop();
        this.inputSources.delete(id);
        this.requestInput(id);
        return;
      }
      this.attachInput(existing.node, channelGain, channel, mono);
      return;
    }
    this.requestInput(id);
  }

  private requestInput(deviceId: string) {
    if (
      this.disposed ||
      this.inputPending.has(deviceId) ||
      this.inputFailed.has(deviceId)
    )
      return;
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
          ? {
              echoCancellation: false,
              noiseSuppression: false,
              autoGainControl: false,
            }
          : {
              deviceId: { exact: deviceId },
              channelCount: { ideal: this.wantedChannels(deviceId) },
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
          if (gain) this.attachInput(node, gain, ch.input.channel ?? 0, (ch.monoMode ?? "off") !== "off");
        }
        for (const ret of this.insertReturns.values()) {
          if (ret.deviceId !== deviceId) continue;
          node.connect(ret.target);
          ret.bypass.gain.setTargetAtTime(0, this.ctx.currentTime, 0.01);
        }
      })
      .catch(() => {
        this.inputPending.delete(deviceId);
        if (this.disposed) return;
        this.inputFailed.add(deviceId);
        this.onError?.(
          "No se pudo abrir una entrada de audio. Revisa los permisos.",
        );
      });
  }

  private usesInput(deviceId: string): boolean {
    if (
      this.config.mixerChannels.some(
        (ch) =>
          ch.input.kind === "device" &&
          normDevice(ch.input.deviceId) === deviceId,
      )
    )
      return true;
    for (const ret of this.insertReturns.values())
      if (ret.deviceId === deviceId) return true;
    return false;
  }
}

function levelOf(an: AnalyserNode, data: Float32Array<ArrayBuffer>): { level: number; db: number } {
  an.getFloatTimeDomainData(data);
  let sum = 0;
  for (const sample of data) sum += sample * sample;
  const rms = Math.sqrt(sum / data.length);
  const db = 20 * Math.log10(Math.max(rms, 0.000001));
  return { level: Math.max(0, Math.min(1, (db + 48) / 48)), db: Math.max(-60, db) };
}
