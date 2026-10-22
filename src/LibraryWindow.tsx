import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { emit, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Normalizer, type NormalizerApi, type NormalizerStatus, type PreviewPlayer } from "./components/Normalizer";
import { callMain, onMainState } from "./bridge";
import { listBlocks, listTracks } from "./api";
import type { Block, Track } from "./types";
import type { SharedState } from "./SettingsWindow";

/**
 * Librería (normalizador) en su propia ventana. El análisis corre aquí: al
 * cerrar, la ventana solo se oculta para que siga en segundo plano. El
 * progreso se publica para la ventana principal y la preescucha suena por la
 * mesa de la principal (respeta su enrutado).
 */
export function LibraryWindow() {
  const [shared, setShared] = useState<SharedState | null>(null);
  const [tracks, setTracks] = useState<Track[]>([]);
  const [blocks, setBlocks] = useState<Block[]>([]);
  const [toast, setToast] = useState("");
  const toastTimer = useRef(0);
  const apiRef = useRef<NormalizerApi | null>(null);

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(""), 3200);
  }, []);

  const refresh = useCallback(async () => {
    const [t, b] = await Promise.all([listTracks(), listBlocks()]);
    setTracks(t);
    setBlocks(b);
  }, []);

  useEffect(() => {
    const offs: Array<Promise<() => void>> = [];
    offs.push(onMainState<SharedState>(setShared));
    offs.push(listen("library://changed", () => void refresh()));
    // Pausar, reanudar o cancelar desde el aviso de la ventana principal.
    offs.push(
      listen<"pause" | "resume" | "cancel">("library://control", (e) => {
        const api = apiRef.current;
        if (!api) return;
        if (e.payload === "pause") api.pause();
        else if (e.payload === "resume") api.resume();
        else api.cancel();
      }),
    );
    // Cerrar solo oculta: el analisis sigue.
    offs.push(
      getCurrentWindow().onCloseRequested(async (event) => {
        event.preventDefault();
        await getCurrentWindow().hide();
        void callMain("refreshLibrary").catch(() => undefined);
      }),
    );
    void callMain<SharedState>("getState").then(setShared).catch(() => undefined);
    void refresh();
    return () => {
      for (const o of offs) void o.then((fn) => fn());
    };
  }, [refresh]);

  // Preescucha a traves de la ventana principal.
  const preview = useMemo<PreviewPlayer>(() => {
    let job = 0;
    let offs: Array<Promise<() => void>> = [];
    const clear = () => {
      for (const o of offs) void o.then((fn) => fn());
      offs = [];
    };
    return {
      async playPreview(file, start, end, onTick, onEnded) {
        clear();
        const my = ++job;
        offs.push(listen<number>("preview://pos", (e) => my === job && onTick(e.payload)));
        offs.push(
          listen("preview://end", () => {
            if (my !== job) return;
            clear();
            onEnded();
          }),
        );
        await callMain("playPreview", file, start, end);
      },
      stopPreview() {
        job += 1;
        clear();
        void callMain("stopPreview").catch(() => undefined);
      },
    };
  }, []);

  const onStatus = useCallback((status: NormalizerStatus | null) => {
    void emit("library://status", status);
  }, []);

  const s = shared?.settings;
  return (
    <div className="tool-window">
      <Normalizer
        windowed
        tracks={tracks}
        blocks={blocks}
        targetLufs={s?.targetLufs ?? -16}
        truePeakDb={s?.truePeakDb ?? -1}
        hidden={false}
        onHide={() => void getCurrentWindow().close()}
        onStatus={onStatus}
        apiRef={apiRef}
        onRefresh={async () => {
          await refresh();
          await callMain("refreshLibrary").catch(() => undefined);
        }}
        onPick={(side) => void callMain("pickFilesFor", side).catch((e) => showToast(String(e)))}
        onMove={async (ids, to) => {
          const n = await callMain<number>("moveTracks", ids, to);
          await refresh();
          return n;
        }}
        onTarget={(lufs, peak) => {
          if (s) void callMain("updateSettings", { ...s, targetLufs: lufs, truePeakDb: peak });
        }}
        showToast={showToast}
        mixer={preview}
      />
      {toast && (
        <div className="toast" role="status">
          {toast}
        </div>
      )}
    </div>
  );
}
