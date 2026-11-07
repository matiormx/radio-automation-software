import type { MouseEvent } from "react";

/**
 * Cerrar una ventana al pinchar fuera, pero solo si se pulsó y se soltó
 * fuera: al seleccionar texto o arrastrar dentro y soltar fuera, no se
 * cierra (antes se perdía lo escrito).
 */
export function closeOnBackdrop(close: () => void) {
  let downOutside = false;
  return {
    onMouseDown: (e: MouseEvent) => {
      downOutside = e.target === e.currentTarget;
    },
    onClick: (e: MouseEvent) => {
      if (downOutside && e.target === e.currentTarget) close();
      downOutside = false;
    },
  };
}
