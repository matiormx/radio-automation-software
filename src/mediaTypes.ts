import { useSyncExternalStore } from "react";
import type { MediaTypeCfg } from "./types";

/** Tipos de medio de serie (Ajustes › Tipos de medio los cambia). */
export const DEFAULT_MEDIA_TYPES: MediaTypeCfg[] = [
  { id: "", label: "Música", color: "#5b9cff", transition: "music", crossfade: 1, inMusic: true, autodj: true, energy: true, normalize: true, meta: null },
  { id: "jingle", label: "Jingle", color: "#ffb84d", transition: "constant", crossfade: 1, inMusic: false, autodj: false, energy: false, normalize: true, meta: null },
  { id: "program", label: "Programa", color: "#59d98c", transition: "constant", crossfade: 1, inMusic: false, autodj: false, energy: false, normalize: true, meta: null },
  { id: "podcast", label: "Podcast", color: "#4dd6ff", transition: "music", crossfade: 1, inMusic: false, autodj: false, energy: false, normalize: true, meta: null },
  { id: "commercial", label: "Comercial", color: "#ff7ab6", transition: "constant", crossfade: 1, inMusic: false, autodj: false, energy: false, normalize: true, meta: null },
];

let current: MediaTypeCfg[] = DEFAULT_MEDIA_TYPES;
const subs = new Set<() => void>();

/** Lo llama quien lee los ajustes (ventana principal, web…). */
export function setMediaTypes(list: MediaTypeCfg[] | undefined) {
  const next = list && list.length ? withMusic(list) : DEFAULT_MEDIA_TYPES;
  if (JSON.stringify(next) === JSON.stringify(current)) return;
  current = next;
  subs.forEach((f) => f());
}

/** La música siempre está (y va la primera). */
function withMusic(list: MediaTypeCfg[]): MediaTypeCfg[] {
  const music = list.find((m) => m.id === "") ?? DEFAULT_MEDIA_TYPES[0];
  return [music, ...list.filter((m) => m.id !== "")];
}

export function mediaTypes(): MediaTypeCfg[] {
  return current;
}

/** Para que los componentes se repinten al cambiar los tipos. */
export function useMediaTypes(): MediaTypeCfg[] {
  return useSyncExternalStore(
    (f) => {
      subs.add(f);
      return () => subs.delete(f);
    },
    () => current,
  );
}

/** Tratamiento de un tipo (desconocido o vacío = música). */
export function mediaRule(id?: string | null): MediaTypeCfg {
  const k = id === "music" ? "" : (id ?? "");
  return current.find((m) => m.id === k) ?? DEFAULT_MEDIA_TYPES.find((m) => m.id === k) ?? current[0];
}

export function mediaTypeLabel(id?: string | null): string {
  return mediaRule(id).label || "Música";
}

/** Sale en la vista Música (y en OmniCaster Music). */
export const inMusic = (id?: string | null): boolean => !id || mediaRule(id).inMusic;
/** Lleva ficha IA de energía. */
export const wantsEnergy = (id?: string | null): boolean => !id || mediaRule(id).energy;
/** Sin fundidos automáticos (suena entero). */
export const noAutoFades = (id?: string | null): boolean => !!id && mediaRule(id).transition !== "music";
