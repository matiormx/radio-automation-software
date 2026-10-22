/**
 * Nivelador automatico de ganancia para un canal o un bus de la mesa.
 *
 * Mide la sonoridad de los ultimos segundos de la senal que entra (con un
 * filtro tipo K simplificado) y mueve despacio una ganancia hacia el objetivo,
 * dentro de un rango maximo. Detras va un limitador de pico para no saturar.
 * Es "feed-forward": mide a la entrada, asi no puede oscilar.
 *
 * Por debajo de un umbral de silencio la ganancia se congela, para no subir
 * el ruido de fondo cuando nadie habla.
 */

export interface LevelerConfig {
  enabled: boolean;
  /** Sonoridad objetivo en LUFS */
  targetLufs: number;
  /** Maximo de subida o bajada en dB */
  maxGainDb: number;
}

export const DEFAULT_LEVELER: LevelerConfig = { enabled: false, targetLufs: -16, maxGainDb: 9 };

const STEP_MS = 50;
/** Ventana de medida (constante de tiempo del promedio) */
const WINDOW_S = 3;
/** Por debajo de esto no se mide ni se corrige */
const GATE_LUFS = -50;
/** Subir es lento y bajar es mas rapido, para que un golpe fuerte no se cuele */
const UP_DB_PER_S = 2;
const DOWN_DB_PER_S = 6;

export function levelerOf(x: { leveler?: Partial<LevelerConfig> } | undefined): LevelerConfig {
  const l = x?.leveler;
  return {
    enabled: !!l?.enabled,
    targetLufs: Number.isFinite(l?.targetLufs) ? (l!.targetLufs as number) : DEFAULT_LEVELER.targetLufs,
    maxGainDb: Number.isFinite(l?.maxGainDb) ? (l!.maxGainDb as number) : DEFAULT_LEVELER.maxGainDb,
  };
}

export class Leveler {
  /** Conectar aqui la senal */
  readonly input: GainNode;
  /** Salida con el limitador; conectar de aqui al siguiente nodo */
  readonly output: DynamicsCompressorNode;

  private readonly rider: GainNode;
  private readonly nodes: AudioNode[] = [];
  private readonly analyser: AnalyserNode;
  private readonly data: Float32Array<ArrayBuffer>;
  private cfg: LevelerConfig;
  private ms = 0;
  private primed = false;
  private gainDb = 0;
  private timer: number | null = null;

  constructor(
    private readonly ctx: AudioContext,
    cfg: LevelerConfig,
  ) {
    this.cfg = cfg;
    this.input = ctx.createGain();
    this.rider = ctx.createGain();
    this.output = ctx.createDynamicsCompressor();
    // Limitador: umbral cerca de 0 dBFS, razon alta, ataque muy corto.
    this.output.threshold.value = -1;
    this.output.knee.value = 0;
    this.output.ratio.value = 20;
    this.output.attack.value = 0.002;
    this.output.release.value = 0.12;
    this.input.connect(this.rider);
    this.rider.connect(this.output);

    // Medida: paso alto + realce de agudos (aproximacion del filtro K).
    const hp = ctx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = 38;
    hp.Q.value = 0.5;
    const shelf = ctx.createBiquadFilter();
    shelf.type = "highshelf";
    shelf.frequency.value = 1500;
    shelf.gain.value = 4;
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.data = new Float32Array(new ArrayBuffer(this.analyser.fftSize * 4));
    const sink = ctx.createGain();
    sink.gain.value = 0;
    this.input.connect(hp);
    hp.connect(shelf);
    shelf.connect(this.analyser);
    this.analyser.connect(sink);
    sink.connect(ctx.destination);
    this.nodes.push(this.rider, hp, shelf, this.analyser, sink);

    this.timer = window.setInterval(() => this.step(), STEP_MS);
  }

  update(cfg: LevelerConfig) {
    this.cfg = cfg;
  }

  /** Ganancia que esta aplicando ahora mismo, en dB (para mostrarla). */
  get currentGainDb(): number {
    return this.gainDb;
  }

  dispose() {
    if (this.timer !== null) {
      window.clearInterval(this.timer);
      this.timer = null;
    }
    this.input.disconnect();
    this.output.disconnect();
    for (const node of this.nodes) node.disconnect();
  }

  private step() {
    this.analyser.getFloatTimeDomainData(this.data);
    let sum = 0;
    for (const sample of this.data) sum += sample * sample;
    const inst = sum / this.data.length;
    const instLufs = -0.691 + 10 * Math.log10(Math.max(inst, 1e-12));
    if (instLufs < GATE_LUFS) return; // silencio: se congela la ganancia

    const dt = STEP_MS / 1000;
    if (!this.primed) {
      this.ms = inst;
      this.primed = true;
    } else {
      this.ms += (1 - Math.exp(-dt / WINDOW_S)) * (inst - this.ms);
    }
    const lufs = -0.691 + 10 * Math.log10(Math.max(this.ms, 1e-12));
    const range = Math.max(0, this.cfg.maxGainDb);
    const wanted = Math.max(-range, Math.min(range, this.cfg.targetLufs - lufs));
    const delta = wanted - this.gainDb;
    this.gainDb += delta > 0 ? Math.min(delta, UP_DB_PER_S * dt) : Math.max(delta, -DOWN_DB_PER_S * dt);
    this.rider.gain.setTargetAtTime(10 ** (this.gainDb / 20), this.ctx.currentTime, 0.05);
  }
}
