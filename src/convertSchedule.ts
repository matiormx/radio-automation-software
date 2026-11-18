import type { Block, Campaign, StationEvent, Track } from "./types";
import { campaignSchedules, eventSchedules } from "./types";

/**
 * Pasar un evento de audio a campaña (y al revés): se conservan nombre,
 * estado, franjas, horas, metadatos y las pistas.
 */

/** Por qué no se puede pasar a campaña ("" = sí se puede). */
export function eventToCampaignBlocker(ev: StationEvent): string {
  if (ev.kind === "auto") return "Una franja AutoDJ no es una campaña: solo se pueden pasar los eventos de audio.";
  if (ev.kind === "stream") return "Un audio de internet no se puede pasar a campaña (las campañas emiten pistas de la biblioteca).";
  return "";
}

export function eventToCampaign(ev: StationEvent, tracks: Track[]): Campaign {
  const pool =
    ev.trackMode === "random" || ev.trackMode === "latest"
      ? ev.sourceKind === "block"
        ? tracks.filter((t) => t.blocks.includes(ev.sourceId) && !t.disabled && !t.missing).map((t) => t.id)
        : []
      : ev.trackId
        ? [ev.trackId]
        : [];
  const allJingles = pool.length > 0 && pool.every((id) => tracks.find((t) => t.id === id)?.mediaType === "jingle");
  const schedules = eventSchedules(ev).map((b, i) => ({
    id: `${b.id || "f"}-c${i}`,
    days: [...b.days],
    times: (b.times?.length ? b.times : [b.start || ev.start]).filter(Boolean),
    hourly: false,
    minute: 0,
  }));
  return {
    id: `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`,
    name: ev.name,
    kind: allJingles ? "jingle" : "ads",
    enabled: ev.enabled,
    days: schedules[0]?.days ?? [1, 2, 3, 4, 5, 6, 7],
    times: schedules[0]?.times ?? [],
    hourly: false,
    minute: 0,
    schedules,
    meta: ev.meta,
    startAt: "",
    endAt: "",
    trackIds: pool,
    cursor: 0,
    lastFired: "",
  };
}

/** Por qué no se puede pasar a evento ("" = sí se puede). */
export function campaignToEventBlocker(c: Campaign, blocks: Block[]): string {
  void blocks;
  if (c.trackIds.length > 1)
    return "Esta campaña rota varias cuñas; un evento lanza una sola pista (o una al azar de una lista). Déjale una sola cuña para pasarla a evento.";
  if (campaignSchedules(c).some((b) => b.hourly))
    return "Tiene franjas «cada hora»: cámbialas por horas concretas para pasarla a evento.";
  return "";
}

export function campaignToEvent(c: Campaign): StationEvent {
  const schedules = campaignSchedules(c).map((b, i) => ({
    id: `${b.id || "f"}-e${i}`,
    days: [...b.days],
    times: [...b.times],
    start: b.times[0] ?? "06:00",
  }));
  return {
    id: `e${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`,
    name: c.name,
    enabled: c.enabled,
    kind: "insert",
    days: schedules[0]?.days ?? [1, 2, 3, 4, 5, 6, 7],
    start: schedules[0]?.start ?? "06:00",
    times: schedules[0]?.times ?? [],
    schedules,
    sourceKind: "library",
    sourceId: "a",
    trackId: c.trackIds[0] ?? "",
    trackMode: "fixed",
    maxWaitSecs: 60,
    onTimeout: "next",
    lastFired: "",
    meta: c.meta,
  };
}
