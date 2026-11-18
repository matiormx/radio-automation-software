import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";

/**
 * Ayuda plegada: un pequeño (i) que al pulsarlo enseña la explicación.
 * Dentro de un recuadro con título (fieldset), el (i) va junto al título y
 * reúne todas las ayudas de ese recuadro; dentro de una opción, junto a ella;
 * en otro sitio, donde se ponga.
 */

interface Host {
  items: Map<number, ReactNode>;
  subs: Set<() => void>;
}
const hosts = new WeakMap<Element, Host>();
let seq = 0;

function hostOf(el: Element): Host {
  let h = hosts.get(el);
  if (!h) {
    h = { items: new Map(), subs: new Set() };
    hosts.set(el, h);
  }
  return h;
}
const notify = (h: Host) => h.subs.forEach((f) => f());

export function Help({ children }: { children: ReactNode }) {
  const anchor = useRef<HTMLSpanElement>(null);
  const id = useRef(0);
  if (!id.current) id.current = ++seq;
  const [legend, setLegend] = useState<Element | null>(null);

  // ¿Hay un título de recuadro donde poner el (i)?
  useLayoutEffect(() => {
    // Dentro de una opción (etiqueta), el (i) va junto a ella.
    if (anchor.current?.closest("label")) return;
    const fs = anchor.current?.closest("fieldset");
    const lg = fs ? Array.from(fs.children).find((c) => c.tagName === "LEGEND") : null;
    if (!lg) return;
    let slot = lg.querySelector(":scope > .help-slot");
    if (!slot) {
      slot = document.createElement("span");
      slot.className = "help-slot";
      lg.appendChild(slot);
    }
    setLegend(slot);
  }, []);

  // Se apunta en el recuadro (y se borra al irse)
  useEffect(() => {
    if (!legend) return;
    const h = hostOf(legend);
    h.items.set(id.current, children);
    notify(h);
  });
  useEffect(() => {
    if (!legend) return;
    const h = hostOf(legend);
    const me = id.current;
    return () => {
      h.items.delete(me);
      notify(h);
    };
  }, [legend]);

  const host = legend ? hostOf(legend) : null;
  const owner = useSyncExternalStore(
    (f) => {
      if (!host) return () => undefined;
      host.subs.add(f);
      return () => host.subs.delete(f);
    },
    () => (host ? Math.min(...host.items.keys(), Infinity) : 0),
  );

  if (legend && host) {
    // Solo el primero del recuadro pinta el (i), con todas las ayudas.
    return (
      <span ref={anchor} className="help-anchor">
        {owner === id.current && createPortal(<HelpButton>{Array.from(host.items.values())}</HelpButton>, legend)}
      </span>
    );
  }
  return (
    <span ref={anchor} className="help-anchor help-inline">
      <HelpButton>{children}</HelpButton>
    </span>
  );
}

function HelpButton({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useEffect(() => {
    if (!open) return;
    const r = btn.current?.getBoundingClientRect();
    if (r) {
      const w = Math.min(380, window.innerWidth - 16);
      setPos({ left: Math.max(8, Math.min(r.left - 12, window.innerWidth - w - 8)), top: r.bottom + 6 });
    }
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent && e.key !== "Escape") return;
      if (e instanceof MouseEvent && (e.target as HTMLElement).closest?.(".help-pop, .help-i")) return;
      setOpen(false);
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", close);
    window.addEventListener("scroll", close, true);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", close);
      window.removeEventListener("scroll", close, true);
    };
  }, [open]);

  return (
    <>
      <button
        ref={btn}
        type="button"
        className={`help-i ${open ? "help-i-on" : ""}`}
        aria-label="Más información"
        aria-expanded={open}
        title="Más información"
        onClick={(e) => {
          // Dentro de una etiqueta no debe marcar la casilla
          e.preventDefault();
          e.stopPropagation();
          setOpen((o) => !o);
        }}
      >
        i
      </button>
      {open &&
        pos &&
        createPortal(
          <div className="help-pop" role="note" style={{ left: pos.left, top: pos.top }}>
            {Array.isArray(children)
              ? children.map((c, i) => (
                  <p key={i} className="help-par">
                    {c}
                  </p>
                ))
              : <p className="help-par">{children}</p>}
          </div>,
          document.body,
        )}
    </>
  );
}
