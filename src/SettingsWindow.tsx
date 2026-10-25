import { useCallback, useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { SettingsPanel, type SettingsTab } from "./components/SettingsPanel";
import { WindowControls } from "./components/WindowControls";
import { callMainTimeout, onMainState, readStateSnapshot } from "./bridge";
import { listBlocks, listTracks } from "./api";
import type { Block, Settings, StationEvent, StreamStatus, Track } from "./types";
import type { StudioSnapshot } from "./studioCalls";

/** Estado que la ventana principal comparte con las demas. */
export interface SharedState {
  settings: Settings;
  studio: StudioSnapshot;
  callMuted: boolean;
  streaming?: boolean;
  streamStatus?: StreamStatus | null;
  streamBusy?: boolean;
}

/**
 * Ajustes en su propia ventana. La ventana principal manda: aqui se edita y
 * cada cambio se le envia; el estado vuelve por `bridge://state`.
 */
export function SettingsWindow() {
  // Se pinta ya con el ultimo estado conocido; la principal lo confirma enseguida.
  const [shared, setShared] = useState<SharedState | null>(() => readStateSnapshot<SharedState>());
  const [tracks, setTracks] = useState<Track[]>([]);
  const [blocks, setBlocks] = useState<Block[]>([]);
  const [tab, setTab] = useState<SettingsTab>(() => {
    const t = new URLSearchParams(window.location.search).get("tab");
    return (t as SettingsTab) || "general";
  });
  const [toast, setToast] = useState("");
  const toastTimer = useRef(0);
  // Mientras se escribe, el eco de la principal no debe pisar lo tecleado.
  const lastLocalEdit = useRef(0);

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(""), 3200);
  }, []);

  const refreshLibrary = useCallback(async () => {
    const [t, b] = await Promise.all([listTracks(), listBlocks()]);
    setTracks(t);
    setBlocks(b);
  }, []);

  useEffect(() => {
    const offs: Array<Promise<() => void>> = [];
    offs.push(
      onMainState<SharedState>((s) => {
        setShared((prev) => {
          if (prev && Date.now() - lastLocalEdit.current < 800) {
            return { ...s, settings: prev.settings };
          }
          return s;
        });
      }),
    );
    offs.push(listen("library://changed", () => void refreshLibrary()));
    // Pide el estado real; si la principal esta ocupada, reintenta en vez de esperar.
    let alive = true;
    let got = false;
    const ask = () => {
      if (!alive || got) return;
      void callMainTimeout<SharedState>(2500, "getState")
        .then((s) => {
          got = true;
          setShared((prev) => (prev && Date.now() - lastLocalEdit.current < 800 ? { ...s, settings: prev.settings } : s));
        })
        .catch(() => window.setTimeout(ask, 300));
    };
    ask();
    void refreshLibrary();
    return () => {
      alive = false;
      for (const off of offs) void off.then((fn) => fn());
    };
  }, [refreshLibrary, showToast]);

  const call = useCallback(
    async <T,>(name: string, ...args: unknown[]): Promise<T | undefined> => {
      try {
        return await callMainTimeout<T>(120000, name, ...args);
      } catch (e) {
        showToast(String(e instanceof Error ? e.message : e));
        return undefined;
      }
    },
    [showToast],
  );

  const onChange = useCallback(
    (s: Settings) => {
      lastLocalEdit.current = Date.now();
      setShared((prev) => (prev ? { ...prev, settings: s } : prev));
      void call("updateSettings", s);
    },
    [call],
  );

  if (!shared) {
    return (
      <div className="tool-window">
        <ToolTitle title="Ajustes" />
        <div className="tool-loading">Conectando con MiRadio…</div>
      </div>
    );
  }

  return (
    <div className="tool-window">
      <ToolTitle title="Ajustes" />
      <SettingsPanel
        windowed
        settings={shared.settings}
        tracks={tracks}
        blocks={blocks}
        hidden={false}
        onChange={onChange}
        onClose={() => void getCurrentWindow().close()}
        onPickMusicFolder={async () => {
          await call("chooseMusicFolder");
        }}
        onPickLogo={async () => {
          await call("chooseLogo");
        }}
        onPickNowPlaying={() => void call("chooseNowPlayingFile")}
        onPickLiveFile={() => void call("chooseLiveFile")}
        onWriteNowPlaying={() => void call("writeNowPlayingNow")}
        onClearLogo={async () => {
          await call("removeLogo");
        }}
        onImportAudio={async () => (await call<Track[]>("importForCampaign")) ?? []}
        onLaunchEvent={(event: StationEvent) => void call("launchEvent", event)}
        showToast={showToast}
        tab={tab}
        onTabChange={setTab}
        studio={shared.studio}
        callMuted={shared.callMuted}
        onCallMute={(muted) => void call("muteCaller", muted)}
        streamStatus={shared.streamStatus ?? null}
        streamBusy={!!shared.streamBusy}
        onRestartStream={() => void call("restartStreaming")}
        onToggleStreamGroup={(group, on) => void call("streamGroup", group, on)}
      />
      {toast && (
        <div className="toast" role="status">
          {toast}
        </div>
      )}
    </div>
  );
}

function ToolTitle({ title }: { title: string }) {
  return (
    <header className="tool-titlebar" data-tauri-drag-region>
      <span className="tool-title" data-tauri-drag-region>
        {title}
      </span>
      <div className="top-drag" data-tauri-drag-region />
      <WindowControls />
    </header>
  );
}
