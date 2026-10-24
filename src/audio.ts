import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import type { Track } from "./types";
import type { SoundMixer } from "./mixer";

/**
 * Motor de radio con dos decks (A/B) y transiciones suaves (crossfade).
 * Cuando una cancion se acerca al final, la siguiente empieza por debajo
 * y sube el volumen mientras la actual baja: como una radio de verdad.
 */

interface Deck {
  source: AudioBufferSourceNode;
  gain: GainNode;
  /** Ganancia fija de normalizacion (no la toca el crossfade) */
  norm: GainNode;
  buffer: AudioBuffer;
  startedAt: number;
  /** Base de la pista: inicio del recorte (de aqui se mide la duracion) */
  offset: number;
  /** Posicion absoluta del buffer donde arranco este source */
  from: number;
  /** Posicion absoluta del buffer donde termina la pista */
  end: number;
  /** Intro superpuesto sobre esta pista */
  overlay?: { source: AudioBufferSourceNode; gain: GainNode };
}

function trimStartOf(t: Track): number {
  return Math.max(0, t.trimStart || 0);
}

function trimEndOf(t: Track, duration: number): number {
  const start = trimStartOf(t);
  let raw = t.trimEnd ?? duration;
  // Un recorte automatico que se come mas de la mitad de la cancion es un
  // error del analisis, no silencio: se ignora. El recorte manual se respeta.
  if (!t.trimManual && t.trimEnd != null && raw < duration / 2) raw = duration;
  return Math.max(start + 0.2, Math.min(duration, raw));
}

function fmtDiag(secs: number): string {
  return `${secs.toFixed(1)} s`;
}

function normGainOf(t: Track): number {
  const db = t.gainDb;
  if (db == null || !Number.isFinite(db)) return 1;
  return Math.min(16, Math.max(0.01, 10 ** (db / 20)));
}

export const EMPTY_TRACK: Track = {
  id: "",
  title: "",
  artist: "",
  album: "",
  genre: "",
  year: "",
  durationSecs: 0,
  file: "",
  originalName: "",
  blocks: [],
  tags: [],
  library: "a",
  lufs: null,
  gainDb: null,
  truePeakDb: null,
  limited: false,
  trimStart: 0,
  trimEnd: null,
  autoTrimStart: 0,
  autoTrimEnd: null,
  trimManual: false,
  introPoint: 0,
  mixPoint: 0,
  fadeOutStart: 0,
  analyzedAt: 0,
  missing: false,
  cover: "",
};

type Slot = "a" | "b" | "c";
const SLOTS: Slot[] = ["a", "b", "c"];

export class RadioPlayer {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private decks: Record<Slot, Deck | null> = { a: null, b: null, c: null };
  private currentSlot: Slot = "a";
  private cache = new Map<string, AudioBuffer>();
  private playlist: Track[] = [];
  private rafId: number | null = null;
  private fading = false;
  private fadeOverlap = 0;
  private disposed = false;
  private preloadedFor = -1;
  private fadeAttemptFor = -1;
  private decoding = new Map<string, Promise<AudioBuffer | null>>();
  private silenceAnalyser: AnalyserNode | null = null;
  private silenceData: Float32Array<ArrayBuffer> | null = null;
  private silentSince = 0;

  /** Buffers PCM que se conservan en memoria (uno son ~85 MB en f32) */
  private static readonly CACHE_LIMIT = 4;
  /** Antelacion con la que se decodifica la siguiente pista */
  private static readonly PRELOAD_LEAD = 30;
  private static readonly SILENCE_SECONDS = 3;

  fadeSeconds = 6;
  loop = false;
  silenceSkip = false;
  /** Umbral de silencio (dBFS, RMS). */
  silenceThresholdDb = -55;

  private index = -1;
  /** Posicion del buffer donde quedo la reproduccion al pausar */
  private pausedOffset: number | null = null;
  /** Invalida operaciones asincronas antiguas (play, seek, crossfade) */
  private playGeneration = 0;

  onTick: ((current: number, total: number) => void) | null = null;
  onIndexChange: ((index: number) => void) | null = null;
  onEnded: (() => void) | null = null;
  /** Avisa cuando una pista se acaba mucho antes de lo esperado, con el motivo. */
  onDiag: ((message: string) => void) | null = null;

  constructor(private mixer: SoundMixer) {}

  get current(): Track {
    return this.playlist[this.index] ?? EMPTY_TRACK;
  }

  get currentIndex(): number {
    return this.index;
  }

  get isPlaying(): boolean {
    return this.ctx?.state === "running" && this.activeDeck() !== null;
  }

  get isPaused(): boolean {
    return this.pausedOffset !== null;
  }

  setPlaylist(tracks: Track[]) {
    const prevId = this.index >= 0 ? this.playlist[this.index]?.id : undefined;
    this.playlist = tracks;
    // Prepara las dos primeras pistas: arrancar el play es inmediato.
    for (const track of tracks.slice(0, 2)) {
      if (!this.cache.has(track.id)) void this.decodeSafe(track);
    }
    for (const track of tracks.slice(Math.max(0, this.index), Math.max(0, this.index) + 3)) void this.preloadOverlay(track);
    if (prevId) {
      this.index = tracks.findIndex((t) => t.id === prevId);
    } else if (this.index >= tracks.length) {
      this.index = -1;
    }
    this.onIndexChange?.(this.index);
  }

  async playAt(index: number): Promise<void> {
    const track = this.playlist[index];
    if (!track) return;
    const generation = ++this.playGeneration;
    this.ensureCtx();
    if (!this.ctx) return;
    await this.mixer.resume();
    if (generation !== this.playGeneration) return;

    const buffer = await this.decodeSafe(track);
    if (!buffer || generation !== this.playGeneration) return;

    // El fundido del deck anterior va en paralelo: la pista entra ya.
    void this.stopAll(0.05);
    if (generation !== this.playGeneration) return;

    const start = Math.min(trimStartOf(track), Math.max(0, buffer.duration - 0.2));
    this.pausedOffset = null;
    this.index = index;
    this.onIndexChange?.(index);
    this.startDeck(track, buffer, start);
    // La siguiente ya se decodifica en segundo plano para que el boton
    // "siguiente" sea instantaneo.
    this.prefetchNext(index);
  }

  /**
   * Prepara una pista y una posicion sin ponerla a sonar. Al pulsar el play
   * sigue desde ahi. Se usa al reabrir la app para continuar donde se quedo
   * la ultima sesion.
   */
  async prepare(index: number, positionSecs: number): Promise<void> {
    const track = this.playlist[index];
    if (!track) return;
    const buffer = await this.decodeSafe(track);
    if (!buffer) return;
    const start = Math.min(trimStartOf(track), Math.max(0, buffer.duration - 0.2));
    const end = trimEndOf(track, buffer.duration);
    this.index = index;
    this.pausedOffset = Math.max(start, Math.min(end - 0.2, start + Math.max(0, positionSecs)));
    this.onIndexChange?.(index);
    this.onTick?.(this.pausedOffset - start, end - start);
  }

  /**
   * Deja el reproductor en una pista y una posicion concretos. Si no se pide
   * que suene, queda preparada para seguir desde ahi.
   */
  async restoreAt(index: number, positionSecs: number, autoplay: boolean): Promise<void> {
    if (!autoplay) {
      await this.prepare(index, positionSecs);
      return;
    }
    await this.playAt(index);
    if (positionSecs > 0) await this.seek(positionSecs);
  }

  async toggle(): Promise<void> {
    this.ensureCtx();
    if (!this.ctx) return;
    if (this.index < 0) {
      await this.playAt(0);
      return;
    }
    if (this.pausedOffset !== null) {
      await this.resumePaused();
      return;
    }
    const deck = this.activeDeck();
    if (deck) {
      this.pauseDeck(deck);
      return;
    }
    await this.playAt(this.index);
  }

  async next(): Promise<void> {
    if (this.playlist.length === 0) return;
    await this.playAt((this.index + 1) % this.playlist.length);
  }

  async prev(): Promise<void> {
    if (this.playlist.length === 0) return;
    await this.playAt((this.index - 1 + this.playlist.length) % this.playlist.length);
  }

  async seek(seconds: number): Promise<void> {
    if (this.index < 0) return;
    const track = this.playlist[this.index];
    const generation = ++this.playGeneration;
    this.ensureCtx();
    if (!this.ctx || !track) return;
    const buffer = this.cache.get(track.id) ?? (await this.decodeSafe(track));
    if (!buffer || !this.ctx || generation !== this.playGeneration) return;
    const start = trimStartOf(track);
    const end = trimEndOf(track, buffer.duration);
    const rel = Math.max(0, Math.min(end - start - 0.2, seconds));
    const pos = start + rel;
    if (this.pausedOffset !== null) {
      this.pausedOffset = pos;
      this.onTick?.(rel, end - start);
      return;
    }
    // El fundido del deck anterior va en paralelo: la pista entra ya.
    void this.stopAll(0.05);
    if (generation !== this.playGeneration || !this.ctx) return;
    const now = this.ctx.currentTime + 0.03;
    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    const gain = this.ctx.createGain();
    const norm = this.ctx.createGain();
    norm.gain.value = normGainOf(track);
    source.connect(gain);
    gain.connect(norm);
    norm.connect(this.master!);
    source.start(now, pos);
    gain.gain.setValueAtTime(1.0, now);
    this.decks.a = {
      source,
      gain,
      norm,
      buffer,
      startedAt: now,
      offset: start,
      from: pos,
      end,
    };
    this.currentSlot = "a";
    this.startRaf();
  }

  setVolume(v: number) {
    this.mixer.setMasterVolume(v);
  }

  dispose() {
    this.disposed = true;
    this.playGeneration += 1;
    this.stopRaf();
    this.playlist = [];
    this.cache.clear();
    this.decoding.clear();
    for (const slot of SLOTS) {
      if (this.decks[slot]) this.hardStop(this.decks[slot]);
    }
    this.decks = { a: null, b: null, c: null };
    this.pausedOffset = null;
    this.silenceAnalyser = null;
    this.silenceData = null;
    this.silentSince = 0;
    this.master = null;
    this.ctx = null;
  }

  // ---------------------------------------------------------------- internals

  private activeDeck(): Deck | null {
    return this.decks[this.currentSlot];
  }

  private ovlCache = new Map<string, AudioBuffer>();

  /** Decodifica el audio del intro por adelantado (suena sin esperas). */
  private async preloadOverlay(track: Track | undefined) {
    const o = track?.introOverlay;
    if (!o || this.ovlCache.has(o.file)) return;
    this.ensureCtx();
    if (!this.ctx) return;
    try {
      const res = await fetch(convertFileSrc(o.file));
      if (!res.ok) return;
      const buf = await this.ctx.decodeAudioData(await res.arrayBuffer());
      this.ovlCache.set(o.file, buf);
      while (this.ovlCache.size > 8) this.ovlCache.delete(this.ovlCache.keys().next().value as string);
    } catch {
      /* sin intro esta vez */
    }
  }

  /** Programa el intro sobre la pista que acaba de arrancar en `startedAt` desde `from`. */
  private attachOverlay(deck: Deck, track: Track) {
    const o = track.introOverlay;
    const ctx = this.ctx;
    if (!o || !ctx || !this.master) return;
    const buf = this.ovlCache.get(o.file);
    if (!buf) {
      void this.preloadOverlay(track);
      return;
    }
    const delay = o.at - deck.from;
    if (delay < -0.05) return; // ya se paso el momento
    const when = deck.startedAt + Math.max(0, delay);
    const source = ctx.createBufferSource();
    source.buffer = buf;
    const gain = ctx.createGain();
    gain.gain.value = Math.pow(10, (o.gainDb || 0) / 20);
    source.connect(gain);
    gain.connect(this.master);
    source.start(when);
    deck.overlay = { source, gain };
  }

  private stopOverlay(deck: Deck, fade = 0) {
    const ov = deck.overlay;
    if (!ov || !this.ctx) return;
    deck.overlay = undefined;
    try {
      if (fade > 0) {
        const now = this.ctx.currentTime;
        ov.gain.gain.cancelScheduledValues(now);
        ov.gain.gain.setValueAtTime(ov.gain.gain.value, now);
        ov.gain.gain.linearRampToValueAtTime(0.001, now + fade);
        ov.source.stop(now + fade + 0.05);
      } else {
        ov.source.stop();
      }
    } catch {
      /* ya terminado */
    }
  }

  private startDeck(track: Track, buffer: AudioBuffer, position: number) {
    const ctx = this.ctx;
    if (!ctx || !this.master) return;
    if (this.decks.a) this.hardStop(this.decks.a);
    if (this.decks.b) this.hardStop(this.decks.b);
    const start = Math.max(
      trimStartOf(track),
      Math.min(trimEndOf(track, buffer.duration) - 0.3, position),
    );
    const end = trimEndOf(track, buffer.duration);
    const now = ctx.currentTime + 0.15;
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    const gain = ctx.createGain();
    const norm = ctx.createGain();
    norm.gain.value = normGainOf(track);
    source.connect(gain);
    gain.connect(norm);
    norm.connect(this.master);
    source.start(now, start);
    gain.gain.setValueAtTime(1.0, now);

    const deck: Deck = {
      source,
      gain,
      norm,
      buffer,
      startedAt: now,
      offset: trimStartOf(track),
      from: start,
      end,
    };
    this.attachOverlay(deck, track);
    this.decks = { a: null, b: null, c: null };
    this.decks.a = deck;
    this.currentSlot = "a";
    this.fading = false;
    this.preloadedFor = -1;
    this.fadeAttemptFor = -1;
    this.silentSince = 0;
    this.startRaf();
  }

  /** Detiene la reproduccion dejando el cursor donde estaba. */
  pause(): void {
    const deck = this.activeDeck();
    if (deck) this.pauseDeck(deck);
  }

  private pauseDeck(deck: Deck) {
    const ctx = this.ctx;
    if (!ctx) return;
    this.playGeneration += 1;
    const pos = ctx.currentTime - deck.startedAt + deck.from;
    this.pausedOffset = Math.max(deck.from, Math.min(deck.end, pos));
    this.onTick?.(this.pausedOffset - deck.offset, deck.end - deck.offset);
    for (const slot of SLOTS) {
      if (this.decks[slot]) this.hardStop(this.decks[slot]);
    }
    this.decks = { a: null, b: null, c: null };
    this.currentSlot = "a";
    this.fading = false;
    this.stopRaf();
  }

  private async resumePaused(): Promise<void> {
    const track = this.playlist[this.index];
    const position = this.pausedOffset;
    if (position === null) return;
    if (!track) {
      this.pausedOffset = null;
      return;
    }
    const generation = ++this.playGeneration;
    await this.mixer.resume();
    if (generation !== this.playGeneration) return;
    const buffer = this.cache.get(track.id) ?? (await this.decodeSafe(track));
    if (!buffer || generation !== this.playGeneration) return;
    this.pausedOffset = null;
    this.startDeck(track, buffer, position);
  }

  // ------------------------------------------------------------ directo (eventos)

  private live: { gain: GainNode; node: AudioWorkletNode; abort: AbortController } | null = null;
  private liveModule: Promise<void> | null = null;
  /** Avisos del audio en directo: "started", "error" (con mensaje) */
  onLive: ((state: string, message: string) => void) | null = null;

  /** Pausa con fundido (entra un evento en directo). */
  fadePause(secs: number) {
    const ctx = this.ctx;
    const deck = this.activeDeck();
    if (!ctx || !deck) return;
    this.playGeneration += 1;
    const pos = ctx.currentTime - deck.startedAt + deck.from;
    this.pausedOffset = Math.max(deck.from, Math.min(deck.end, pos));
    this.onTick?.(this.pausedOffset - deck.offset, deck.end - deck.offset);
    const old = SLOTS.map((slot) => this.decks[slot]).filter((d): d is Deck => d !== null);
    for (const d of old) {
      d.source.onended = null;
      this.fadeOutAndStop(d, Math.max(0.05, secs));
    }
    this.decks = { a: null, b: null, c: null };
    this.currentSlot = "a";
    this.fading = false;
    this.stopRaf();
  }

  /** Audio de internet (o archivo) en directo, con fundido de entrada. */
  async startLive(source: string, fadeIn: number): Promise<void> {
    this.stopLive(0.05);
    this.ensureCtx();
    const ctx = this.ctx;
    if (!ctx || !this.master) return;
    await this.mixer.resume();
    if (!this.liveModule) this.liveModule = ctx.audioWorklet.addModule(new URL("/pcm-player.js", window.location.href).href);
    await this.liveModule;
    let url: string;
    try {
      url = await invoke<string>("netstream_url", { source, rate: Math.round(ctx.sampleRate) });
    } catch (e) {
      this.onLive?.("error", String(e));
      return;
    }
    const rate = ctx.sampleRate;
    const node = new AudioWorkletNode(ctx, "pcm-player", {
      numberOfInputs: 0,
      outputChannelCount: [2],
      processorOptions: { capacity: Math.round(rate * 2 * 40), prebuffer: Math.round(rate * 2 * 0.8) },
    });
    const gain = ctx.createGain();
    const now = ctx.currentTime;
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.linearRampToValueAtTime(1, now + Math.max(0.05, fadeIn));
    node.connect(gain);
    gain.connect(this.master);
    const abort = new AbortController();
    const live = { gain, node, abort };
    this.live = live;
    let consumed = 0;
    node.port.onmessage = (e) => {
      if (typeof e.data?.consumed === "number") consumed = e.data.consumed;
    };
    const ahead = rate * 2 * 10; // como mucho 10 s por delante
    void (async () => {
      let sent = 0;
      let got = false;
      try {
        const res = await fetch(url, { signal: abort.signal });
        if (!res.ok || !res.body) throw new Error(await res.text().catch(() => `HTTP ${res.status}`));
        this.onLive?.("started", "");
        const reader = res.body.getReader();
        let carry = new Uint8Array(0);
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          if (!value) continue;
          let bytes = value;
          if (carry.length) {
            const joined = new Uint8Array(carry.length + value.length);
            joined.set(carry);
            joined.set(value, carry.length);
            bytes = joined;
          }
          const whole = bytes.length - (bytes.length % 8);
          carry = bytes.slice(whole);
          if (whole === 0) continue;
          const f32 = new Float32Array(bytes.slice(0, whole).buffer);
          got = true;
          // No mandar mas de 10 s por delante de lo que ya ha sonado.
          while (sent - consumed > ahead && !abort.signal.aborted) await new Promise((r) => setTimeout(r, 50));
          if (abort.signal.aborted) break;
          node.port.postMessage(f32, [f32.buffer]);
          sent += f32.length;
        }
        if (!abort.signal.aborted) this.onLive?.("error", got ? "La emisión de internet se ha cortado" : "No se pudo abrir la emisión de internet");
      } catch (e) {
        if (!abort.signal.aborted) this.onLive?.("error", e instanceof Error ? e.message : String(e));
      }
    })();
  }

  /** Termina el directo con fundido de salida. */
  stopLive(fadeOut: number) {
    const live = this.live;
    if (!live || !this.ctx) return;
    this.live = null;
    const now = this.ctx.currentTime;
    const dur = Math.max(0.05, fadeOut);
    try {
      live.gain.gain.cancelScheduledValues(now);
      live.gain.gain.setValueAtTime(Math.max(0.0001, live.gain.gain.value), now);
      live.gain.gain.linearRampToValueAtTime(0.0001, now + dur);
    } catch {
      /* ignore */
    }
    window.setTimeout(() => {
      live.abort.abort();
      try {
        live.node.disconnect();
        live.gain.disconnect();
      } catch {
        /* ya desconectado */
      }
    }, dur * 1000 + 100);
  }

  get liveActive(): boolean {
    return this.live !== null;
  }

  private ensureCtx() {
    if (this.disposed) return;
    if (!this.ctx) {
      this.ctx = this.mixer.ctx;
      this.master = this.mixer.musicInput;
      // El medidor lo mantiene la mesa: apply() desconecta musicInput al
      // reconfigurarse y un medidor propio se quedaba mudo (falso silencio).
      // El detector de silencio mide lo que recibe el streaming, no la fuente.
      const analyser = this.mixer.getStreamAnalyser();
      this.silenceAnalyser = analyser;
      this.silenceData = new Float32Array(new ArrayBuffer(analyser.fftSize * 4));
    }
  }

  /** Punto de mezcla de la pista: donde entra la siguiente cancion. */
  private mixPointOf(index: number): number {
    const track = this.playlist[index];
    if (!track) return 0;
    const point = track.mixPoint ?? 0;
    return point > 0 ? point : 0;
  }

  /**
   * Punto de mezcla que el motor respeta. El mix va al final de la pista:
   * si queda en la primera mitad del tramo que suena (por ejemplo un marcador
   * de intro guardado antes de separar intro y mix) se ignora y la pista se
   * cruza al final, en vez de saltar a la siguiente a los pocos segundos.
   */
  private usableMixPoint(index: number, deck: Deck): number {
    const point = this.mixPointOf(index);
    if (point <= 0) return 0;
    const middle = deck.offset + (deck.end - deck.offset) / 2;
    return point > middle && point < deck.end ? point : 0;
  }

  /** Punto de fade out de la pista: desde ahi baja hasta el final. */
  private fadeOutOf(index: number): number {
    const track = this.playlist[index];
    if (!track) return 0;
    const point = track.fadeOutStart ?? 0;
    return point > 0 ? point : 0;
  }

  private isSilent(): boolean {
    const analyser = this.silenceAnalyser;
    const data = this.silenceData;
    if (!analyser || !data || !this.mixer.musicRouted) return false;
    analyser.getFloatTimeDomainData(data);
    let sum = 0;
    for (let i = 0; i < data.length; i += 1) sum += data[i] * data[i];
    return Math.sqrt(sum / data.length) < 10 ** (this.silenceThresholdDb / 20);
  }

  private async decodeSafe(track: Track): Promise<AudioBuffer | null> {
    this.ensureCtx();
    if (!this.ctx) return null;
    const cached = this.cache.get(track.id);
    if (cached) return cached;
    const inFlight = this.decoding.get(track.id);
    if (inFlight) return inFlight;
    const job = (async (): Promise<AudioBuffer | null> => {
      try {
        let buffer: AudioBuffer;
        try {
          const res = await fetch(convertFileSrc(track.file));
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          buffer = await this.ctx!.decodeAudioData(await res.arrayBuffer());
        } catch {
          // El WebView no sabe decodificarlo (p. ej. el audio de un video):
          // MiRadio lo decodifica y se usa una copia WAV en cache.
          const wav = await invoke<string>("audio_fallback", { path: track.file });
          const res = await fetch(convertFileSrc(wav));
          if (!res.ok) return null;
          buffer = await this.ctx!.decodeAudioData(await res.arrayBuffer());
        }
        if (!this.cache.has(track.id)) {
          this.cache.set(track.id, buffer);
          this.trimCache();
        }
        return buffer;
      } catch {
        return null;
      } finally {
        this.decoding.delete(track.id);
      }
    })();
    this.decoding.set(track.id, job);
    return job;
  }

  /** Deja en memoria solo las pistas alrededor de la que suena. */
  private trimCache() {
    if (this.cache.size <= RadioPlayer.CACHE_LIMIT) return;
    const keep = new Set<string>();
    const cur = this.playlist[this.index];
    if (cur) keep.add(cur.id);
    const next = this.playlist[this.index + 1];
    if (next) keep.add(next.id);
    for (const key of Array.from(this.cache.keys())) {
      if (this.cache.size <= RadioPlayer.CACHE_LIMIT) break;
      if (!keep.has(key)) this.cache.delete(key);
    }
  }

  /** Decodifica la pista siguiente en segundo plano. */
  private prefetchNext(index: number) {
    const next = this.playlist[index + 1];
    if (!next) return;
    void this.preloadOverlay(next);
    if (this.cache.has(next.id)) return;
    void this.decodeSafe(next);
  }

  /** Decodifica la siguiente pista con antelacion para que el cruce sea puntual. */
  private ensurePreload(nextIdx: number) {
    if (nextIdx < 0 || nextIdx >= this.playlist.length) return;
    if (this.preloadedFor === nextIdx) return;
    const t = this.playlist[nextIdx];
    if (!t || this.cache.has(t.id)) {
      this.preloadedFor = nextIdx;
      return;
    }
    this.preloadedFor = nextIdx;
    void this.decodeSafe(t);
  }

  private async stopAll(fadeDur: number) {
    const old = SLOTS.map((slot) => this.decks[slot]).filter((d): d is Deck => d !== null);
    this.decks = { a: null, b: null, c: null };
    this.fading = false;
    if (this.ctx) {
      for (const deck of old) this.fadeOutAndStop(deck, fadeDur);
    }
    if (fadeDur > 0) await new Promise((r) => setTimeout(r, fadeDur * 1000 + 80));
  }

  private hardStop(deck: Deck) {
    try {
      deck.source.onended = null;
      this.stopOverlay(deck);
      deck.source.stop();
    } catch {
      /* ya detenido */
    }
  }

  private fadeOutAndStop(deck: Deck, dur: number) {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    this.stopOverlay(deck, dur);
    try {
      deck.gain.gain.cancelScheduledValues(now);
      deck.gain.gain.setValueAtTime(Math.max(deck.gain.gain.value, 0.001), now);
      deck.gain.gain.linearRampToValueAtTime(0.001, now + dur);
      deck.source.stop(now + dur + 0.05);
    } catch {
      /* ignore */
    }
  }

  private startRaf() {
    if (this.rafId !== null) return;
    const loopFn = () => {
      if (this.disposed) return;
      this.tick(); // tick puede llamar a stopRaf y dejar rafId en null
      if (this.rafId === null) return;
      this.rafId = requestAnimationFrame(loopFn);
    };
    this.rafId = requestAnimationFrame(loopFn);
  }

  private stopRaf() {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }

  private tick() {
    const ctx = this.ctx;
    const deck = this.activeDeck();
    if (!ctx || !deck) {
      this.stopRaf();
      return;
    }

    const total = deck.end - deck.offset;
    const pos = ctx.currentTime - deck.startedAt + deck.from;
    const remaining = deck.end - pos;

    if (pos < deck.offset) {
      this.onTick?.(0, total);
      return;
    }

    if (this.silenceSkip && this.isSilent()) {
      const now = performance.now();
      if (this.silentSince === 0) {
        this.silentSince = now;
      } else if (now - this.silentSince >= RadioPlayer.SILENCE_SECONDS * 1000) {
        this.silentSince = 0;
        this.reportEarlyChange(deck, "Silencio detectado", pos);
        if (this.index >= 0 && this.index + 1 < this.playlist.length) {
          void this.playAt(this.index + 1);
        } else if (this.loop && this.playlist.length > 1) {
          void this.playAt(0);
        } else {
          this.finish(deck);
        }
        return;
      }
    } else {
      this.silentSince = 0;
    }

    const nextIdx =
      this.index + 1 < this.playlist.length
        ? this.index + 1
        : this.loop && this.playlist.length > 1
          ? 0
          : -1;

    // Decodifica la siguiente pista con tiempo de sobra (no en pleno cruce).
    if (
      nextIdx >= 0 &&
      nextIdx !== this.index &&
      remaining <= Math.max(RadioPlayer.PRELOAD_LEAD, this.fadeSeconds + 15)
    ) {
      this.ensurePreload(nextIdx);
    }

    if (this.fading && pos > this.fadeOverlap + 0.2) {
      this.fading = false;
    }

    if (pos >= deck.end) {
      this.reportEarlyChange(deck, "Fin de pista", pos);
      this.finish(deck);
      return;
    }

    // Fade out: desde su punto hasta el final, la pista baja hasta el silencio.
    const fadeOut = this.fadeOutOf(this.index);
    if (!this.fading && fadeOut > 0 && pos >= fadeOut && pos < deck.end) {
      const span = Math.max(0.2, deck.end - fadeOut);
      const ratio = Math.max(0, Math.min(1, (pos - fadeOut) / span));
      const target = Math.max(0.0001, 1 - ratio);
      deck.gain.gain.setTargetAtTime(target, ctx.currentTime, 0.08);
    }

    // Punto de mezcla: la siguiente cancion entra en ese punto y la actual
    // sigue sonando (su intro queda debajo). Sin punto, se cruza al final.
    const mixPoint = this.usableMixPoint(this.index, deck);
    const crossfadeAt = mixPoint > 0 ? mixPoint : deck.end - this.fadeSeconds;
    if (
      !this.fading &&
      this.index >= 0 &&
      this.fadeSeconds > 0 &&
      pos >= crossfadeAt &&
      nextIdx >= 0 &&
      nextIdx !== this.index
    ) {
      this.reportEarlyChange(deck, mixPoint > 0 ? "Cruce por punto Mix" : "Cruce", pos);
      void this.beginCrossfade(deck, remaining, nextIdx, mixPoint > 0);
      return;
    }

    this.onTick?.(pos - deck.offset, total);
  }

  /** Empieza la cancion siguiente por abajo y baja la actual. */
  private async beginCrossfade(
    deck: Deck,
    remaining: number,
    nextIdx: number,
    keepCurrent = false,
  ) {
    if (!this.ctx) return;
    if (this.fadeAttemptFor === nextIdx) return;
    const generation = this.playGeneration;
    this.fadeAttemptFor = nextIdx;
    this.fading = true;
    this.preloadedFor = -1;
    const fadeTarget = Math.max(0.3, Math.min(this.fadeSeconds, remaining));

    const nextTrack = this.playlist[nextIdx];
    const buffer = await this.decodeSafe(nextTrack);
    if (
      !buffer ||
      !this.ctx ||
      this.pausedOffset !== null ||
      generation !== this.playGeneration
    ) {
      this.fading = false;
      return;
    }

    const ctx = this.ctx;
    const now = ctx.currentTime;
    const deckEnd = deck.startedAt + (deck.end - deck.from);
    const available = deckEnd - now;
    const nextStart = Math.min(trimStartOf(nextTrack), Math.max(0, buffer.duration - 0.2));
    const nextEnd = trimEndOf(nextTrack, buffer.duration);

    try {
      const startAt = now + 0.02;
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      const gain = ctx.createGain();
      const norm = ctx.createGain();
      norm.gain.value = normGainOf(nextTrack);
      source.connect(gain);
      gain.connect(norm);
      norm.connect(this.master!);
      source.start(startAt, nextStart);

      const newDeck: Deck = {
        source,
        gain,
        norm,
        buffer,
        startedAt: startAt,
        offset: trimStartOf(nextTrack),
        from: nextStart,
        end: nextEnd,
      };
      this.attachOverlay(newDeck, nextTrack);

      const oldSlot = this.currentSlot;

      if (available <= 0.05) {
        // La decodificacion tardo mas que la pista: empalme limpio, sin hueco.
        this.hardStop(deck);
        gain.gain.setValueAtTime(1, startAt);
        this.fadeOverlap = 0;
      } else {
        const overlap = Math.min(fadeTarget, available);
        gain.gain.setValueAtTime(0.001, startAt);
        gain.gain.linearRampToValueAtTime(1, startAt + overlap);
        if (keepCurrent) {
          // Punto de mezcla: la pista actual sigue sonando (su intro queda
          // debajo de la siguiente) hasta que se acaba.
          deck.source.onended = () => {
            this.decks[oldSlot] = null;
          };
        } else {
          deck.gain.gain.cancelScheduledValues(now);
          deck.gain.gain.setValueAtTime(Math.max(deck.gain.gain.value, 0.001), now);
          deck.gain.gain.linearRampToValueAtTime(0.001, now + overlap);
          try {
            deck.source.stop(now + overlap + 0.1);
          } catch {
            /* ya detenido */
          }
        }
        this.fadeOverlap = overlap;
      }

      this.currentSlot = this.freeSlot();
      if (!keepCurrent) this.decks[oldSlot] = null;
      this.decks[this.currentSlot] = newDeck;
      this.index = nextIdx;
      this.fadeAttemptFor = -1;
      this.onIndexChange?.(nextIdx);
    } catch {
      this.fading = false;
    }
  }

  /** Slot donde colocar la siguiente pista: uno libre o el mas antiguo. */
  private freeSlot(): Slot {
    const free = SLOTS.find((slot) => slot !== this.currentSlot && !this.decks[slot]);
    if (free) return free;
    const others = SLOTS.filter((slot) => slot !== this.currentSlot);
    return others[0] ?? "b";
  }

  private finish(deck: Deck) {
    this.hardStop(deck);
    for (const slot of SLOTS) {
      if (slot !== this.currentSlot && this.decks[slot]) this.hardStop(this.decks[slot]);
    }
    this.decks[this.currentSlot] = null;
    this.currentSlot = "a";
    this.fading = false;

    if (this.index >= 0 && this.index + 1 < this.playlist.length) {
      void this.playAt(this.index + 1);
      return;
    }
    if (this.loop && this.index >= 0 && this.playlist.length > 1) {
      void this.playAt(0);
      return;
    }
    this.onTick?.(0, 0);
    this.callEnded();
  }

  /** Si la pista no llega al 80 % de su duracion, explica por que se cambio. */
  private reportEarlyChange(deck: Deck, reason: string, pos: number) {
    const total = deck.buffer.duration;
    if (!(total > 0) || pos >= total * 0.8) return;
    const track = this.playlist[this.index];
    if (!track) return;
    const parts = [
      `${reason} a los ${fmtDiag(pos)} de ${fmtDiag(total)}`,
      `recorte ${fmtDiag(track.trimStart || 0)}–${track.trimEnd == null ? "fin" : fmtDiag(track.trimEnd)}${track.trimManual ? " (manual)" : " (auto)"}`,
      `mix ${fmtDiag(track.mixPoint || 0)}`,
      `fade ${fmtDiag(track.fadeOutStart || 0)}`,
      `ficha ${fmtDiag(track.durationSecs || 0)}`,
    ];
    this.onDiag?.(`${track.title || "Pista"}: ${parts.join(" · ")}`);
  }

  private callEnded() {
    this.stopRaf();
    this.onEnded?.();
  }
}
