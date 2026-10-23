import { useRef } from "react";

interface Props {
  /** Ancho actual del panel (px) */
  width: number;
  min: number;
  max: number;
  /** Mientras se arrastra (sin guardar) */
  onDrag: (w: number) => void;
  /** Al soltar: guardar */
  onCommit: (w: number) => void;
  /** Doble clic: tamaño automatico */
  onReset: () => void;
}

/** Linea vertical que se arrastra para cambiar el ancho del panel izquierdo. */
export function Splitter({ width, min, max, onDrag, onCommit, onReset }: Props) {
  const start = useRef<{ x: number; w: number } | null>(null);
  const clamp = (w: number) => Math.round(Math.max(min, Math.min(max, w)));
  return (
    <div
      className="splitter"
      role="separator"
      aria-orientation="vertical"
      aria-label="Ancho del panel de música"
      aria-valuenow={Math.round(width)}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      title="Arrastra para cambiar el ancho · doble clic: automático"
      onPointerDown={(e) => {
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        start.current = { x: e.clientX, w: width };
        document.body.classList.add("is-resizing");
      }}
      onPointerMove={(e) => {
        if (!start.current) return;
        onDrag(clamp(start.current.w + e.clientX - start.current.x));
      }}
      onPointerUp={(e) => {
        if (!start.current) return;
        const w = clamp(start.current.w + e.clientX - start.current.x);
        start.current = null;
        document.body.classList.remove("is-resizing");
        onCommit(w);
      }}
      onPointerCancel={() => {
        start.current = null;
        document.body.classList.remove("is-resizing");
      }}
      onDoubleClick={onReset}
      onKeyDown={(e) => {
        const step = e.shiftKey ? 60 : 20;
        if (e.key === "ArrowLeft") onCommit(clamp(width - step));
        else if (e.key === "ArrowRight") onCommit(clamp(width + step));
        else return;
        e.preventDefault();
      }}
    />
  );
}
