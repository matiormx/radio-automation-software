import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { SettingsWindow } from "./SettingsWindow";
import { MixerWindow } from "./MixerWindow";
import { LibraryWindow } from "./LibraryWindow";
import { VideoOutWindow } from "./VideoOutWindow";
import { ChatWindow } from "./ChatWindow";
import { AiWindow } from "./AiWindow";
import { fitToScreen, toolKind } from "./bridge";
import "./styles.css";
import { uiStateRestore, uiStateSave } from "./api";
import { IS_WEB } from "./platform";
import { installMenuFit } from "./ctxfit";
import { getSettings } from "./api";
import { setMediaTypes } from "./mediaTypes";

installMenuFit();
// Ventanas secundarias (biblioteca…): los tipos de medio de los ajustes.
if (!IS_WEB) void getSettings().then((s) => setMediaTypes(s.mediaTypes)).catch(() => undefined);

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

// Ventana principal: tras importar una copia se recupera el estado de la
// interfaz (antes de pintar); después se guarda para las próximas copias.
const ready = !kind && !IS_WEB ? uiStateRestore().finally(() => {
  void uiStateSave();
  window.setInterval(() => void uiStateSave(), 10 * 60 * 1000);
}) : Promise.resolve();

void ready.then(() => ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>{kind === "settings" ? <SettingsWindow /> : kind === "mixer" ? <MixerWindow /> : kind === "library" ? <LibraryWindow /> : kind === "videoout" ? <VideoOutWindow /> : kind === "videonp" ? <VideoOutWindow programOnly /> : kind === "chat" ? <ChatWindow /> : kind === "ai" ? <AiWindow /> : <App />}</React.StrictMode>,
));
