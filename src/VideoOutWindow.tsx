import { useCallback, useEffect, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { VideoSurface, type VideoState } from "./videoSurface";

/**
 * Ventana de video de la emision: pantalla completa en el monitor elegido.
 * Recibe de la ventana principal lo que suena y su posicion.
 */
export function VideoOutWindow() {
  const state = useRef<{ s: VideoState; at: number } | null>(null);

  useEffect(() => {
    const off = listen<VideoState>("video://state", (e) => {
      state.current = { s: e.payload, at: performance.now() };
    });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") void getCurrentWindow().setFullscreen(false);
      if (e.key === "f" || e.key === "F" || e.key === "F11") {
        void getCurrentWindow()
          .isFullscreen()
          .then((f) => getCurrentWindow().setFullscreen(!f));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      void off.then((f) => f());
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  // La posicion avanza entre mensajes si esta sonando.
  const source = useCallback((): VideoState | null => {
    const cur = state.current;
    if (!cur) return null;
    const pos = cur.s.playing ? cur.s.pos + (performance.now() - cur.at) / 1000 : cur.s.pos;
    return { ...cur.s, pos };
  }, []);

  return (
    <div
      className="vs-window"
      data-tauri-drag-region
      onDoubleClick={() =>
        void getCurrentWindow()
          .isFullscreen()
          .then((f) => getCurrentWindow().setFullscreen(!f))
      }
    >
      <VideoSurface source={source} output />
    </div>
  );
}
