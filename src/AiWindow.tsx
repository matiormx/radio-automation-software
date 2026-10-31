import { useCallback, useEffect, useState } from "react";
import { emit, listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { aiWindowClose, aiWindowPayload, IS_LINUX } from "./api";
import { AiMetadataModal } from "./components/AiMetadataModal";
import { WindowControls } from "./components/WindowControls";
import type { AiSettings, Track } from "./types";

interface Payload {
  tracks: Track[];
  ai: AiSettings;
}

/**
 * Ventana aparte del analizador de metadatos con IA. La selección la coloca
 * MusicBrowser en disco (ai_window_payload) justo antes de abrir la ventana;
 * los cambios que se aceptan guardan en la biblioteca igual que siempre y
 * avisan con un evento para que la principal refresque la lista.
 */
export function AiWindow() {
  const [payload, setPayload] = useState<Payload | null>(null);
  const [note, setNote] = useState("");
  const [loaded, setLoaded] = useState(false);

  const read = useCallback(async () => {
    try {
      const raw = await aiWindowPayload();
      if (raw) setPayload(JSON.parse(raw) as Payload);
    } catch (e) {
      setNote(`No se pudo leer la selección: ${String(e)}`);
    }
    setLoaded(true);
  }, []);

  useEffect(() => {
    void read();
    let unsubs: UnlistenFn[] = [];
    const ups = [
      // MusicBrowser vuelve a mandar la selección: renueva la lista sin cerrar
      // la ventana (así se analiza la misma ventana con otra lista).
      listen<unknown>("ai://open", () => void read()),
      // La X de la ventana: si está analizando, se queda minimizada y el
      // análisis sigue; si terminó, se cierra del todo.
      listen("ai://close", () => {
        if ((window as unknown as Record<string, unknown>).__AI_BUSY__ === true) {
          setNote("");
          // Linux (quiosco): sin barra de tareas, minimizada se perdería.
          if (!IS_LINUX) {
            void getCurrentWindow().minimize().catch(() => undefined);
          }
        } else {
          void aiWindowClose();
        }
      }),
    ];
    for (const p of ups) {
      void p.then((un) => unsubs.push(un)).catch(() => undefined);
    }
    return () => {
      for (const un of unsubs) un();
    };
  }, [read]);

  return (
    <div className="tool-window">
      <header className="tool-titlebar" data-tauri-drag-region>
        <span className="tool-title" data-tauri-drag-region>
          OmniCaster · Análisis de metadatos con IA
        </span>
        <div className="top-drag" data-tauri-drag-region />
        <WindowControls />
      </header>
      <div className="ai-window-holder">
        {!payload ? (
          <p className="hint">
            {loaded
              ? "No hay canciones cargadas. Vuelve a abrirla desde la biblioteca."
              : "Cargando selección…"}
          </p>
        ) : (
          <>
            {note && <p className="hint ai-window-note">{note}</p>}
            <AiMetadataModal
              tracks={payload.tracks}
              ai={payload.ai}
              standalone
              onClose={() => void aiWindowClose()}
              onSaved={async () => {
                // La biblioteca es del motor (Rust): la lista de la ventana
                // principal se refresca sola con este aviso.
                await emit("ai://saved", true);
              }}
              showToast={setNote}
            />
          </>
        )}
      </div>
    </div>
  );
}
