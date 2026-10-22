import type { IntroOverlay, IntroSettings, Track } from "./types";

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Hueco entre el inicio de la pista y su punto de intro, en segundos (0 = sin hueco). */
export function introGap(t: Track): number {
  if (!(t.introPoint > 0)) return 0;
  const start = Math.max(0, t.trimStart || 0);
  return Math.max(0, t.introPoint - start);
}

/**
 * Elige el audio de intro para una pista, o nada. `since` son las canciones
 * que han sonado desde el ultimo intro; hasta `gapSongs` no se vuelve a intentar.
 * La eleccion es estable: la misma pista y estado dan el mismo audio.
 */
export function pickIntro(
  t: Track,
  cfg: IntroSettings,
  since: number,
  library: Track[],
  lastFile: string,
): IntroOverlay | undefined {
  if (!cfg.enabled || !cfg.blockId || since < cfg.gapSongs) return undefined;
  if (t.blocks.includes(cfg.blockId)) return undefined; // un intro no lleva intro
  const gap = introGap(t);
  if (gap < 1) return undefined;
  const fits = library.filter(
    (c) => c.blocks.includes(cfg.blockId) && !c.missing && c.file && c.durationSecs > 0.3 && c.durationSecs <= gap + 0.05,
  );
  if (fits.length === 0) return undefined;
  const fresh = fits.length > 1 ? fits.filter((c) => c.file !== lastFile) : fits;
  const chosen = fresh[hash(`${t.id}:${since}`) % fresh.length];
  const dur = chosen.durationSecs;
  const start = Math.max(0, t.trimStart || 0);
  const at = cfg.align === "start" ? start : Math.max(start, t.introPoint - dur);
  return { file: chosen.file, durationSecs: dur, at, gainDb: cfg.gainDb || 0 };
}
