import type { HistoryEntry, PickEntry, StationEvent, Track } from "./types";

const DAY_MS = 24 * 60 * 60 * 1000;
/** Cuanto se guarda el registro de pistas elegidas */
const KEEP_DAYS = 90;
const KEEP_MAX = 600;

export const DEFAULT_SLOT_DAYS = 7;
export const DEFAULT_EVENT_DAYS = 1;
export const DEFAULT_AIR_MINS = 120;

export interface PickResult {
  track: Track | null;
  /** Pistas que cumplian todas las reglas */
  strict: number;
  /** Reglas que hubo que saltarse porque no quedaban pistas */
  relaxed: Array<"aire" | "evento" | "horario">;
  /** Pistas de la fuente (sin las que faltan en disco) */
  pool: number;
}

export function isRandom(event: StationEvent): boolean {
  return event.kind === "insert" && event.trackMode === "random";
}

/** Pistas de la fuente del evento (biblioteca A/B o bloque), sin las que faltan en disco. */
export function randomPool(event: StationEvent, tracks: Track[]): Track[] {
  return tracks.filter((t) => {
    if (t.missing) return false;
    return event.sourceKind === "block"
      ? t.blocks.includes(event.sourceId)
      : t.library === (event.sourceId === "b" ? "b" : "a");
  });
}

function lastPickAt(log: PickEntry[], id: string): number {
  let at = -1;
  for (const e of log) if (e.trackId === id && e.at > at) at = e.at;
  return at;
}

/**
 * Elige una pista al azar respetando las reglas. Si no quedan candidatas se
 * van soltando reglas (primero la de antena, luego la del evento, luego la del
 * horario) y, como ultimo recurso, sale la que hace mas tiempo que no se elige.
 * `avoid` son pistas que no conviene repetir ahora mismo (sonando o en cola).
 */
export function pickRandom(
  event: StationEvent,
  slot: string,
  tracks: Track[],
  history: HistoryEntry[],
  now: number,
  avoid: Set<string> = new Set(),
  rnd: () => number = Math.random,
): PickResult {
  const pool = randomPool(event, tracks);
  const log = event.pickLog ?? [];
  const slotDays = event.noRepeatSlotDays ?? DEFAULT_SLOT_DAYS;
  const eventDays = event.noRepeatEventDays ?? DEFAULT_EVENT_DAYS;
  const airMins = event.noRepeatAirMins ?? DEFAULT_AIR_MINS;

  const slotBlocked = new Set<string>();
  const eventBlocked = new Set<string>();
  for (const e of log) {
    const age = now - e.at;
    if (slotDays > 0 && e.slot === slot && age < slotDays * DAY_MS) slotBlocked.add(e.trackId);
    if (eventDays > 0 && age < eventDays * DAY_MS) eventBlocked.add(e.trackId);
  }
  const airBlocked = new Set<string>();
  if (airMins > 0) {
    for (const h of history) {
      if (now - h.playedAt * 1000 < airMins * 60_000) airBlocked.add(h.trackId);
    }
  }

  const rules: Array<[string, Set<string>]> = [
    ["aire", airBlocked],
    ["evento", eventBlocked],
    ["horario", slotBlocked],
  ];
  const choose = (list: Track[]) => list[Math.min(list.length - 1, Math.floor(rnd() * list.length))];
  const free = (skip: number) => {
    // Se aplican todas las reglas menos las `skip` primeras (aire, evento, horario).
    const active = rules.slice(skip);
    let c = pool.filter((t) => !avoid.has(t.id) && active.every(([, set]) => !set.has(t.id)));
    if (c.length === 0) c = pool.filter((t) => active.every(([, set]) => !set.has(t.id)));
    return c;
  };

  const strict = free(0);
  if (strict.length > 0) return { track: choose(strict), strict: strict.length, relaxed: [], pool: pool.length };
  const relaxed: PickResult["relaxed"] = [];
  for (let skip = 1; skip <= rules.length; skip += 1) {
    relaxed.push(rules[skip - 1][0] as PickResult["relaxed"][number]);
    const c = free(skip);
    if (c.length > 0) return { track: choose(c), strict: 0, relaxed, pool: pool.length };
  }
  if (pool.length === 0) return { track: null, strict: 0, relaxed: [], pool: 0 };
  // Todas se han usado hace poco: la que lleva mas tiempo sin elegirse.
  const oldest = [...pool].sort((a, b) => lastPickAt(log, a.id) - lastPickAt(log, b.id) || rnd() - 0.5)[0];
  return { track: oldest, strict: 0, relaxed, pool: pool.length };
}

/** Anade una eleccion al registro y recorta lo antiguo. */
export function logPick(log: PickEntry[] | undefined, entry: PickEntry): PickEntry[] {
  const keepFrom = entry.at - KEEP_DAYS * DAY_MS;
  return [...(log ?? []), entry].filter((e) => e.at >= keepFrom).slice(-KEEP_MAX);
}

/** Frase para el aviso cuando hubo que saltarse alguna regla. */
export function relaxedText(r: PickResult): string {
  if (r.relaxed.length === 0) return "";
  const names = { aire: "ya sonó en antena", evento: "repetición en el evento", horario: "repetición a esa hora" };
  return ` (pocas pistas: se ha saltado «${r.relaxed.map((x) => names[x]).join("», «")}»)`;
}
