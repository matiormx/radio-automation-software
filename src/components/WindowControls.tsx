import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";

/**
 * Botones de ventana propios (la barra de Windows esta oculta): minimizar,
 * maximizar/restaurar y cerrar, al estilo de las apps de Windows 11.
 * Cerrar pasa por la confirmacion de cierre (onCloseRequested).
 */
export function WindowControls() {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    let off: (() => void) | undefined;
    let alive = true;
    try {
      const win = getCurrentWindow();
      const sync = () => {
        void win
          .isMaximized()
          .then((m) => alive && setMaximized(m))
          .catch(() => undefined);
      };
      sync();
      void win
        .onResized(sync)
        .then((fn) => {
          if (alive) off = fn;
          else fn();
        })
        .catch(() => undefined);
    } catch {
      /* fuera de Tauri (navegador) */
    }
    return () => {
      alive = false;
      off?.();
    };
  }, []);

  const act = (fn: (w: ReturnType<typeof getCurrentWindow>) => Promise<void>) => () => {
    try {
      void fn(getCurrentWindow()).catch(() => undefined);
    } catch {
      /* fuera de Tauri */
    }
  };

  return (
    <div className="win-controls">
      <button type="button" className="win-btn" title="Minimizar" aria-label="Minimizar" onClick={act((w) => w.minimize())}>
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <path d="M0 5h10" stroke="currentColor" strokeWidth="1" />
        </svg>
      </button>
      <button
        type="button"
        className="win-btn"
        title={maximized ? "Restaurar" : "Maximizar"}
        aria-label={maximized ? "Restaurar" : "Maximizar"}
        onClick={act((w) => w.toggleMaximize())}
      >
        {maximized ? (
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
            <path d="M2.5 0.5h7v7M0.5 2.5h7v7h-7z" fill="none" stroke="currentColor" strokeWidth="1" />
          </svg>
        ) : (
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
            <rect x="0.5" y="0.5" width="9" height="9" fill="none" stroke="currentColor" strokeWidth="1" />
          </svg>
        )}
      </button>
      <button type="button" className="win-btn win-close" title="Cerrar" aria-label="Cerrar" onClick={act((w) => w.close())}>
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <path d="M0 0l10 10M10 0L0 10" stroke="currentColor" strokeWidth="1" />
        </svg>
      </button>
    </div>
  );
}
