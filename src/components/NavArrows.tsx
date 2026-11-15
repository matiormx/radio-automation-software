import { useEffect } from "react";

interface Props {
  /** Lista desde la que se abrió */
  ids: string[];
  /** Canción actual */
  id: string;
  busy?: boolean;
  onStep: (dir: -1 | 1) => void;
  /** Texto de ayuda («Guarda los cambios y pasa a la» / «Ir a la») */
  hint?: string;
  /** Teclas: «plain» = ← →, «alt» = Alt+← Alt+→ (con campos de texto) */
  keys?: "plain" | "alt";
}

/** ‹ 3 de 120 › para pasar a la canción anterior o siguiente de la lista. */
export function NavArrows({ ids, id, busy, onStep, hint = "Ir a la", keys = "alt" }: Props) {
  const i = ids.indexOf(id);
  const canPrev = i > 0;
  const canNext = i >= 0 && i < ids.length - 1;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      if (keys === "alt" ? !e.altKey : e.altKey || e.ctrlKey || e.metaKey) return;
      if (keys === "plain") {
        const el = document.activeElement as HTMLElement | null;
        if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable)) return;
      }
      const dir = e.key === "ArrowLeft" ? -1 : 1;
      if ((dir < 0 && !canPrev) || (dir > 0 && !canNext) || busy) return;
      e.preventDefault();
      onStep(dir);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [keys, canPrev, canNext, busy, onStep]);

  if (ids.length < 2 || i < 0) return <span style={{ flex: 1 }} />;
  const k = keys === "alt" ? "Alt+" : "";
  return (
    <span className="nav-arrows">
      <button type="button" className="ghost-btn" disabled={!canPrev || busy} onClick={() => onStep(-1)} title={`${hint} canción anterior (${k}←)`}>
        ‹
      </button>
      <span className="nav-pos">
        {i + 1} de {ids.length}
      </span>
      <button type="button" className="ghost-btn" disabled={!canNext || busy} onClick={() => onStep(1)} title={`${hint} canción siguiente (${k}→)`}>
        ›
      </button>
    </span>
  );
}
