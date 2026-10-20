import { convertFileSrc } from "@tauri-apps/api/core";
import type { Track } from "./types";

/**
 * Motor de radio con dos decks (A/B) y transiciones suaves (crossfade).
 * Cuando una cancion se acerca al final, la siguiente empieza por debajo
 * y sube el volumen mientras la actual baja: como una radio de verdad.
 */

interface Deck {
  source: AudioBufferSourceNode;
  gain: GainNode;
  buffer: AudioBuffer;
  startedAt: number;
  offset: number;
}

const EMPTY_TRACK: Track = {
  id: "",
  title: "",
  artist: "",
  durationSecs: 0,
  fileName: "",
  originalName: "",
  filePath: "",
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

  fadeSeconds = 6;
  loop = false;

  private index = -1;

  onTick: ((current: number, total: number) => void) | null = null;
  onIndexChange: ((index: number) => void) | null = null;
  onEnded: (() => void) | null = null;

  get current(): Track {
    return this.playlist[this.index] ?? EMPTY_TRACK;
  }

  get currentIndex(): number {
    return this.index;
  }

  get isPlaying(): boolean {
    return this.ctx?.state === "running" && this.activeDeck() !== null;
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
    this.ensureCtx();
    if (!this.ctx) return;
    if (this.ctx.state === "suspended") await this.ctx.resume();

    const buffer = await this.decodeSafe(track);
    if (!buffer) return;

    await this.stopAll(0.12);

    const now = this.ctx.currentTime + 0.15;
    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    const gain = this.ctx.createGain();
    source.connect(gain);
    gain.connect(this.master!);
    source.start(now, 0);
    gain.gain.setValueAtTime(1.0, now);

    const deck: Deck = { source, gain, buffer, startedAt: now, offset: 0 };
    this.decks = { a: null, b: null };
    this.decks.a = deck;
    this.currentSlot = "a";
    this.fading = false;
    this.index = index;
    this.onIndexChange?.(index);
    this.startRaf();
  }

  async toggle(): Promise<void> {
    this.ensureCtx();
    if (!this.ctx) return;
    if (this.index < 0) {
      await this.playAt(0);
      return;
    }
    if (this.ctx.state === "suspended") {
      await this.ctx.resume();
    } else {
      await this.ctx.suspend();
    }
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
    const buffer = this.cache.get(track?.id ?? "");
    this.ensureCtx();
    if (!this.ctx || !track || !buffer) return;
    const total = buffer.duration;
    const pos = Math.max(0, Math.min(total - 0.2, seconds));
    await this.stopAll(0.08);
    const now = this.ctx.currentTime + 0.1;
    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    const gain = this.ctx.createGain();
    source.connect(gain);
    gain.connect(this.master!);
    source.start(now, pos);
    gain.gain.setValueAtTime(1.0, now);
    this.decks.a = { source, gain, buffer, startedAt: now, offset: pos };
    this.currentSlot = "a";
    this.startRaf();
  }

  setVolume(v: number) {
    if (this.master) this.master.gain.value = Math.max(0, Math.min(1, v));
  }

  dispose() {
    this.disposed = true;
    this.stopRaf();
    this.playlist = [];
    this.cache.clear();
    if (this.decks.a) this.hardStop(this.decks.a);
    if (this.decks.b) this.hardStop(this.decks.b);
    this.decks = { a: null, b: null };
    this.ctx?.close().catch(() => undefined);
    this.ctx = null;
  }

  // ---------------------------------------------------------------- internals

  private activeDeck(): Deck | null {
    return this.decks[this.currentSlot];
  }

  private ensureCtx() {
    if (this.disposed) return;
    if (!this.ctx) {
      this.ctx = new AudioContext();
      this.master = this.ctx.createGain();
      this.master.connect(this.ctx.destination);
    }
  }

  private async decodeSafe(track: Track): Promise<AudioBuffer | null> {
    this.ensureCtx();
    if (!this.ctx) return null;
    const cached = this.cache.get(track.id);
    if (cached) return cached;
    try {
      const res = await fetch(convertFileSrc(track.filePath));
      const bytes = await res.arrayBuffer();
      const buffer = await this.ctx.decodeAudioData(bytes);
      this.cache.set(track.id, buffer);
      if (this.cache.size > 40) {
        const oldest = this.cache.keys().next().value;
        if (oldest) this.cache.delete(oldest);
      }
      return buffer;
    } catch {
      return null;
    }
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

    const total = deck.buffer.duration;
    const pos = ctx.currentTime - deck.startedAt + deck.offset;
    const remaining = total - pos;

    if (pos < 0) {
      this.onTick?.(0, total);
      return;
    }

    if (this.fading && pos > this.fadeOverlap + 0.2) {
      this.fading = false;
    }

    if (pos >= total) {
      this.finish(deck);
      return;
    }

    if (!this.fading && this.index >= 0 && this.fadeSeconds > 0 && remaining <= this.fadeSeconds) {
      const nextIdx =
        this.index + 1 < this.playlist.length ? this.index + 1 : this.loop && this.playlist.length > 1 ? 0 : -1;
      if (nextIdx >= 0 && nextIdx !== this.index) {
        void this.beginCrossfade(deck, remaining, nextIdx);
        return;
      }
    }

    this.onTick?.(pos, total);
  }

  /** Empieza la cancion siguiente por abajo y baja la actual. */
  private async beginCrossfade(deck: Deck, remaining: number, nextIdx: number) {
    if (!this.ctx) return;
    this.fading = true;
    const overlap = Math.max(0.3, Math.min(this.fadeSeconds, remaining));
    this.fadeOverlap = overlap;

    const nextTrack = this.playlist[nextIdx];
    const buffer = await this.decodeSafe(nextTrack);
    if (!buffer || !this.ctx) {
      this.fading = false;
      return;
    }

    const ctx = this.ctx;
    try {
      const now = ctx.currentTime + 0.05;
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      const gain = ctx.createGain();
      source.connect(gain);
      gain.connect(this.master!);
      source.start(now, 0);
      gain.gain.setValueAtTime(0.001, now);
      gain.gain.linearRampToValueAtTime(1.0, now + overlap);

      // La cancion actual baja y se detiene sola al terminar el cruce.
      deck.gain.gain.cancelScheduledValues(ctx.currentTime);
      deck.gain.gain.setValueAtTime(Math.max(deck.gain.gain.value, 0.001), ctx.currentTime);
      deck.gain.gain.linearRampToValueAtTime(0.001, ctx.currentTime + overlap);
      deck.source.stop(ctx.currentTime + overlap + 0.1);

      const newDeck: Deck = { source, gain, buffer, startedAt: now, offset: 0 };
      const oldSlot = this.currentSlot;
      this.currentSlot = this.otherSlot();
      this.decks[oldSlot] = null;
      this.decks[this.currentSlot] = newDeck;
      this.index = nextIdx;
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
