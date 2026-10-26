import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { SettingsWindow } from "./SettingsWindow";
import { MixerWindow } from "./MixerWindow";
import { LibraryWindow } from "./LibraryWindow";
import { VideoOutWindow } from "./VideoOutWindow";
import { ChatWindow } from "./ChatWindow";
import { fitToScreen, toolKind } from "./bridge";
import "./styles.css";

const kind = toolKind();
// Sin el menu contextual del navegador (Atrás, Actualizar, Imprimir...): la
// aplicacion pone los suyos. En los campos de texto se deja (copiar/pegar).
window.addEventListener("contextmenu", (e) => {
  const t = e.target as HTMLElement | null;
  if (t?.closest("input, textarea, [contenteditable='true']")) return;
  e.preventDefault();
});
// En pantallas pequeñas la ventana principal se maximiza para que quepa todo.
if (!kind) void fitToScreen(undefined, true);

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>{kind === "settings" ? <SettingsWindow /> : kind === "mixer" ? <MixerWindow /> : kind === "library" ? <LibraryWindow /> : kind === "videoout" ? <VideoOutWindow /> : kind === "videonp" ? <VideoOutWindow programOnly /> : kind === "chat" ? <ChatWindow /> : <App />}</React.StrictMode>,
);
