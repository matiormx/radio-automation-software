/**
 * Arrastrar y soltar dentro de la ventana con eventos de puntero.
 *
 * El arrastre HTML5 no sirve en Windows: con la recepcion de archivos del
 * sistema activada (necesaria para soltar canciones desde el Explorador),
 * WebView2 no entrega dragover/drop dentro de la pagina. Este gestor no
 * depende de eso: sigue el puntero, busca debajo un elemento con
 * `data-drop-zone` y le pasa lo arrastrado a su manejador.
 */
import type React from "react";

export type DragPayload =
  /** Cancion de la biblioteca (o de un bloque) */
  | { kind: "track"; trackId: string; label: string }
  /** Fila de la lista de emision */
  | { kind: "row"; index: number; trackId: string; label: string }
  /** Bloque o separador de la lista de bloques */
  | { kind: "blockItem"; key: string; blockId: string; label: string };

export interface DropZone {
  /** ¿Acepta esto aqui? (si no, no se resalta ni se suelta) */
  accepts: (payload: DragPayload, el: HTMLElement) => boolean;
  drop: (payload: DragPayload, el: HTMLElement, pos: { x: number; y: number; after: boolean }) => void;
}

const zones = new Map<string, DropZone>();

/** Registra el manejador de una zona; devuelve la funcion para quitarlo. */
export function registerDropZone(name: string, zone: DropZone): () => void {
  zones.set(name, zone);
  return () => {
    if (zones.get(name) === zone) zones.delete(name);
  };
}

const THRESHOLD = 6;
let active = false;

/** ¿Hay un arrastre en curso? (para no abrir menus ni seleccionar) */
export function isDragging(): boolean {
  return active;
}

function scrollParent(el: HTMLElement | null): HTMLElement | null {
  let n = el;
  while (n && n !== document.body) {
    const s = getComputedStyle(n);
    if (/(auto|scroll)/.test(s.overflowY) && n.scrollHeight > n.clientHeight) return n;
    n = n.parentElement;
  }
  return null;
}

/**
 * Empieza (si el puntero se mueve lo bastante) a arrastrar `payload`.
 * Se usa en `onPointerDown` de lo que se puede arrastrar.
 */
export function beginDrag(e: React.PointerEvent, payload: DragPayload | (() => DragPayload | null)) {
  if (e.button !== 0 || active) return;
  const target = e.target as HTMLElement;
  if (target.closest("input, textarea, select, [data-no-drag]")) return;
  const startX = e.clientX;
  const startY = e.clientY;
  let started = false;
  let data: DragPayload | null = null;
  let ghost: HTMLDivElement | null = null;
  let over: HTMLElement | null = null;
  let overAfter = false;

  const clearOver = () => {
    over?.classList.remove("dnd-over", "dnd-over-after");
    over = null;
  };

  const find = (x: number, y: number): HTMLElement | null => {
    const hit = document.elementFromPoint(x, y) as HTMLElement | null;
    const el = hit?.closest<HTMLElement>("[data-drop-zone]") ?? null;
    if (!el || !data) return null;
    const zone = zones.get(el.dataset.dropZone ?? "");
    return zone && zone.accepts(data, el) ? el : null;
  };

  const move = (ev: PointerEvent) => {
    if (!started) {
      if (Math.abs(ev.clientX - startX) < THRESHOLD && Math.abs(ev.clientY - startY) < THRESHOLD) return;
      data = typeof payload === "function" ? payload() : payload;
      if (!data) {
        stop();
        return;
      }
      started = true;
      active = true;
      document.body.classList.add("dnd-active");
      ghost = document.createElement("div");
      ghost.className = "dnd-ghost";
      ghost.textContent = data.label;
      document.body.appendChild(ghost);
      window.getSelection()?.removeAllRanges();
    }
    ev.preventDefault();
    if (ghost) {
      ghost.style.left = `${ev.clientX + 14}px`;
      ghost.style.top = `${ev.clientY + 10}px`;
    }
    const el = find(ev.clientX, ev.clientY);
    const r = el?.getBoundingClientRect();
    const after = !!r && ev.clientY > r.top + r.height / 2;
    if (el !== over || after !== overAfter) {
      clearOver();
      if (el) {
        el.classList.add("dnd-over");
        if (after) el.classList.add("dnd-over-after");
      }
      over = el;
      overAfter = after;
    }
    // Desplaza la lista si el puntero esta cerca del borde.
    const sp = scrollParent((document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null) ?? null);
    if (sp) {
      const b = sp.getBoundingClientRect();
      if (ev.clientY < b.top + 36) sp.scrollTop -= 14;
      else if (ev.clientY > b.bottom - 36) sp.scrollTop += 14;
    }
  };

  const up = (ev: PointerEvent) => {
    if (started && data) {
      const el = find(ev.clientX, ev.clientY);
      if (el) {
        const r = el.getBoundingClientRect();
        const zone = zones.get(el.dataset.dropZone ?? "");
        zone?.drop(data, el, { x: ev.clientX, y: ev.clientY, after: ev.clientY > r.top + r.height / 2 });
      }
      // El clic que sigue al soltar no debe activar el boton de debajo.
      const swallow = (c: MouseEvent) => {
        c.stopPropagation();
        c.preventDefault();
      };
      window.addEventListener("click", swallow, { capture: true, once: true });
      window.setTimeout(() => window.removeEventListener("click", swallow, { capture: true }), 50);
    }
    stop();
  };

  const key = (ev: KeyboardEvent) => {
    if (ev.key === "Escape") stop();
  };

  function stop() {
    window.removeEventListener("pointermove", move, true);
    window.removeEventListener("pointerup", up, true);
    window.removeEventListener("pointercancel", stop, true);
    window.removeEventListener("keydown", key, true);
    clearOver();
    ghost?.remove();
    ghost = null;
    if (started) document.body.classList.remove("dnd-active");
    active = false;
  }

  window.addEventListener("pointermove", move, true);
  window.addEventListener("pointerup", up, true);
  window.addEventListener("pointercancel", stop, true);
  window.addEventListener("keydown", key, true);
}
