import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { callMain, onMainState, readStateSnapshot } from "./bridge";
import { ChatPanel } from "./components/ChatPanel";
import { WindowControls } from "./components/WindowControls";
import { DEFAULT_SETTINGS, type Settings } from "./types";
import type { SharedState } from "./SettingsWindow";

/** Chat de NGRADIO en su propia ventana (flotante). */
export function ChatWindow() {
  const [settings, setSettings] = useState<Settings | null>(() => readStateSnapshot<SharedState>()?.settings ?? null);
  const [onTop, setOnTop] = useState(false);

  useEffect(() => {
    const off = onMainState<SharedState>((s) => setSettings(s.settings));
    void callMain<SharedState>("getState")
      .then((s) => setSettings(s.settings))
      .catch(() => undefined);
    // Cerrar la ventana vuelve a acoplar el chat.
    const offClose = getCurrentWindow().onCloseRequested(async (e) => {
      e.preventDefault();
      await dock();
    });
    return () => {
      void off.then((f) => f());
      void offClose.then((f) => f());
    };
  }, []);

  const dock = async () => {
    const s = (await callMain<SharedState>("getState").catch(() => null))?.settings;
    if (s) await callMain("updateSettings", { ...s, chat: { ...(s.chat ?? DEFAULT_SETTINGS.chat), floating: false } }).catch(() => undefined);
    await getCurrentWindow().destroy().catch(() => undefined);
  };

  if (!settings) return <div className="tool-window"><div className="tool-loading">Conectando con OmniCaster…</div></div>;
  const chat = settings.chat ?? DEFAULT_SETTINGS.chat;
  const sc = settings.studioCalls;

  return (
    <div className="tool-window chat-window">
      <header className="tool-titlebar" data-tauri-drag-region>
        <span className="tool-title" data-tauri-drag-region>
          Chat de NGRADIO
        </span>
        <div className="top-drag" data-tauri-drag-region />
        <button
          type="button"
          className={`ghost-btn ${onTop ? "chat-pin-on" : ""}`}
          title={onTop ? "Dejar de mantener encima" : "Mantener siempre encima"}
          aria-pressed={onTop}
          onClick={() => {
            const next = !onTop;
            setOnTop(next);
            void getCurrentWindow().setAlwaysOnTop(next).catch(() => undefined);
          }}
        >
          📌
        </button>
        <WindowControls />
      </header>
      <ChatPanel
        config={{ serverUrl: sc.serverUrl, token: sc.token, name: chat.name || settings.radioName || "Estudio", enabled: chat.enabled }}
        floating
        onToggleFloating={() => void dock()}
      />
    </div>
  );
}
