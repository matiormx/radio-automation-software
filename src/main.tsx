import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { SettingsWindow } from "./SettingsWindow";
import { MixerWindow } from "./MixerWindow";
import { LibraryWindow } from "./LibraryWindow";
import { toolKind } from "./bridge";
import "./styles.css";

const kind = toolKind();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>{kind === "settings" ? <SettingsWindow /> : kind === "mixer" ? <MixerWindow /> : kind === "library" ? <LibraryWindow /> : <App />}</React.StrictMode>,
);
