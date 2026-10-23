import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { SettingsWindow } from "./SettingsWindow";
import { MixerWindow } from "./MixerWindow";
import { LibraryWindow } from "./LibraryWindow";
import { VideoOutWindow } from "./VideoOutWindow";
import { fitToScreen, toolKind } from "./bridge";
import "./styles.css";

const kind = toolKind();
// En pantallas pequeñas la ventana principal se maximiza para que quepa todo.
if (!kind) void fitToScreen(undefined, true);

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>{kind === "settings" ? <SettingsWindow /> : kind === "mixer" ? <MixerWindow /> : kind === "library" ? <LibraryWindow /> : kind === "videoout" ? <VideoOutWindow /> : <App />}</React.StrictMode>,
);
