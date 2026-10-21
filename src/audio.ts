import { convertFileSrc } from "@tauri-apps/api/core";
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
  offset: number;
  /** Posicion absoluta del buffer donde termina la pista */
  end: number;
}

function trimStartOf(t: Track): number {
  return Math.max(0, t.trimStart || 0);
}

function trimEndOf(t: Track, duration: number): number {
  const start = trimStartOf(t);
  const raw = t.trimEnd ?? duration;
  return Math.max(start + 0.2, Math.min(duration, raw));
}

function normGainOf(t: Track): number {
  const db = t.gainDb;
  if (db == null || !Number.isFinite(db)) return 1;
  return Math.min(16, Math.max(0.01, 10 ** (db / 20)));
}

const EMPTY_TRACK: Track = {
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
  analyzedAt: 0,
  missing: false,
  cover: "",
};

type Slot = "a" | "b";

export class RadioPlayer {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private decks: Record<Slot, Deck | null> = { a: null, b: null };
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
  private static readonly SILENCE_RMS = 0.0018;
  private static readonly SILENCE_SECONDS = 3;

  fadeSeconds = 6;
  loop = false;
  silenceSkip = false;

  private index = -1;
  /** Posicion del buffer donde quedo la reproduccion al pausar */
  private pausedOffset: number | null = null;
  /** Invalida operaciones asincronas antiguas (play, seek, crossfade) */
  private playGeneration = 0;

  onTick: ((current: number, total: number) => void) | null = null;
  onIndexChange: ((index: number) => void) | null = null;
  onEnded: (() => void) | null = null;

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

    await this.stopAll(0.12);
    if (generation !== this.playGeneration) return;

    const start = Math.min(trimStartOf(track), Math.max(0, buffer.duration - 0.2));
    this.pausedOffset = null;
    this.index = index;
    this.onIndexChange?.(index);
    this.startDeck(track, buffer, start);
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
    if (this.index < 0 || this.fading) return;
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
    await this.stopAll(0.08);
    if (generation !== this.playGeneration || !this.ctx) return;
    const now = this.ctx.currentTime + 0.1;
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
    this.decks.a = { source, gain, norm, buffer, startedAt: now, offset: pos, end };
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
    if (this.decks.a) this.hardStop(this.decks.a);
    if (this.decks.b) this.hardStop(this.decks.b);
    this.decks = { a: null, b: null };
    this.pausedOffset = null;
    this.silenceAnalyser?.disconnect();
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

    const deck: Deck = { source, gain, norm, buffer, startedAt: now, offset: start, end };
    this.decks = { a: null, b: null };
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
    const pos = ctx.currentTime - deck.startedAt + deck.offset;
    this.pausedOffset = Math.max(deck.offset, Math.min(deck.end, pos));
    this.onTick?.(this.pausedOffset - deck.offset, deck.end - deck.offset);
    if (this.decks.a) this.hardStop(this.decks.a);
    if (this.decks.b) this.hardStop(this.decks.b);
    this.decks = { a: null, b: null };
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

  private ensureCtx() {
    if (this.disposed) return;
    if (!this.ctx) {
      this.ctx = this.mixer.ctx;
      this.master = this.mixer.musicInput;
      const analyser = this.ctx.createAnalyser();
      analyser.fftSize = 512;
      this.silenceAnalyser = analyser;
      this.silenceData = new Float32Array(new ArrayBuffer(analyser.fftSize * 4));
      this.master.connect(analyser);
      const silent = this.ctx.createGain();
      silent.gain.value = 0;
      analyser.connect(silent);
      silent.connect(this.ctx.destination);
    }
  }

  private isSilent(): boolean {
    const analyser = this.silenceAnalyser;
    const data = this.silenceData;
    if (!analyser || !data) return false;
    analyser.getFloatTimeDomainData(data);
    let sum = 0;
    for (let i = 0; i < data.length; i += 1) sum += data[i] * data[i];
    return Math.sqrt(sum / data.length) < RadioPlayer.SILENCE_RMS;
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
        const res = await fetch(convertFileSrc(track.file));
        if (!res.ok) return null;
        const bytes = await res.arrayBuffer();
        const buffer = await this.ctx!.decodeAudioData(bytes);
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
    const a = this.decks.a;
    const b = this.decks.b;
    this.decks = { a: null, b: null };
    this.fading = false;
    if (this.ctx) {
      if (a) this.fadeOutAndStop(a, fadeDur);
      if (b) this.fadeOutAndStop(b, fadeDur);
    }
    if (fadeDur > 0) await new Promise((r) => setTimeout(r, fadeDur * 1000 + 80));
  }

  private hardStop(deck: Deck) {
    try {
      deck.source.onended = null;
      deck.source.stop();
    } catch {
      /* ya detenido */
    }
  }

  private fadeOutAndStop(deck: Deck, dur: number) {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
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
    const pos = ctx.currentTime - deck.startedAt + deck.offset;
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
      this.finish(deck);
      return;
    }

    if (!this.fading && this.index >= 0 && this.fadeSeconds > 0 && remaining <= this.fadeSeconds) {
      if (nextIdx >= 0 && nextIdx !== this.index) {
        void this.beginCrossfade(deck, remaining, nextIdx);
        return;
      }
    }

    this.onTick?.(pos - deck.offset, total);
  }

  /** Empieza la cancion siguiente por abajo y baja la actual. */
  private async beginCrossfade(deck: Deck, remaining: number, nextIdx: number) {
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
    const deckEnd = deck.startedAt + (deck.end - deck.offset);
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
        offset: nextStart,
        end: nextEnd,
      };

      if (available <= 0.05) {
        // La decodificacion tardo mas que la pista: empalme limpio, sin hueco.
        this.hardStop(deck);
        gain.gain.setValueAtTime(1, startAt);
        this.fadeOverlap = 0;
      } else {
        const overlap = Math.min(fadeTarget, available);
        gain.gain.setValueAtTime(0.001, startAt);
        gain.gain.linearRampToValueAtTime(1, startAt + overlap);
        deck.gain.gain.cancelScheduledValues(now);
        deck.gain.gain.setValueAtTime(Math.max(deck.gain.gain.value, 0.001), now);
        deck.gain.gain.linearRampToValueAtTime(0.001, now + overlap);
        try {
          deck.source.stop(now + overlap + 0.1);
        } catch {
          /* ya detenido */
        }
        this.fadeOverlap = overlap;
      }

      const oldSlot = this.currentSlot;
      this.currentSlot = this.otherSlot();
      this.decks[oldSlot] = null;
      this.decks[this.currentSlot] = newDeck;
      this.index = nextIdx;
      this.fadeAttemptFor = -1;
      this.onIndexChange?.(nextIdx);
    } catch {
      this.fading = false;
    }
  }

  private otherSlot(): Slot {
    return this.currentSlot === "a" ? "b" : "a";
  }

  private finish(deck: Deck) {
    this.hardStop(deck);
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

  private callEnded() {
    this.stopRaf();
    this.onEnded?.();
  }
}
