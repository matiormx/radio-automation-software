import { useState } from "react";
import type { Settings } from "../types";
import { pickFolder, pickScanFolder, scanFolder } from "../api";
import { cloudJoinPick, cloudNode, cloudSetMediaDir, cloudSyncSet, type CloudJoin } from "../cloud";

type Mode = "broadcast" | "workstation";

/**
 * Asistente del primer arranque: qué es este equipo, unirse a la emisora y
 * dónde está (o dónde guardar) la música. Todo se puede cambiar después en
 * Ajustes.
 */
export function Welcome({
  settings,
  onDone,
  showToast,
}: {
  settings: Settings;
  onDone: (s: Settings, rescan: boolean) => void;
  showToast: (m: string) => void;
}) {
  const [step, setStep] = useState(0);
  const [mode, setMode] = useState<Mode>("broadcast");
  const [join, setJoin] = useState<CloudJoin | null>(null);
  const [musicDir, setMusicDir] = useState("");
  const [cloudDir, setCloudDir] = useState("");
  const [busy, setBusy] = useState(false);
  const ws = mode === "workstation";

  const doJoin = async () => {
    try {
      const j = await cloudJoinPick();
      if (j) {
        setJoin(j);
        cloudNode.start(j);
        if (ws && j.node.role !== "studio") {
          showToast(`Ojo: ese archivo es de un equipo «${j.node.role}». Para un puesto de trabajo, créalo en el panel con el papel «studio».`);
        }
      }
    } catch (e) {
      showToast(String(e));
    }
  };

  const finish = async () => {
    setBusy(true);
    try {
      let next: Settings = { ...settings, stationMode: mode };
      if (ws) {
        next = {
          ...next,
          autopilotEnabled: false,
          eventsEnabled: false,
          autoPlayOnStart: false,
          streaming: next.streaming ? { ...next.streaming, autoStart: false } : next.streaming,
        };
      }
      if (cloudDir) {
        await cloudSetMediaDir(cloudDir);
        next = { ...next, cloudMediaDir: cloudDir };
      }
      if (join) await cloudSyncSet(true, ws ? "none" : "needed").catch(() => undefined);
      let rescan = false;
      if (!ws && musicDir) {
        await scanFolder(musicDir).catch((e) => showToast(String(e)));
        rescan = true;
      }
      onDone(next, rescan);
    } finally {
      setBusy(false);
    }
  };

  const steps = [
    // 0. Qué es este equipo
    <>
      <h2>Bienvenido a OmniCaster</h2>
      <p className="hint">¿Qué va a ser este equipo?</p>
      <div className="welcome-choices">
        <button type="button" className={`welcome-choice ${mode === "broadcast" ? "on" : ""}`} onClick={() => setMode("broadcast")}>
          <b>Emite</b>
          <span>El estudio, o un relevo. Suena, emite y lleva el AutoDJ y los eventos.</span>
        </button>
        <button type="button" className={`welcome-choice ${mode === "workstation" ? "on" : ""}`} onClick={() => setMode("workstation")}>
          <b>Puesto de trabajo</b>
          <span>Para organizar desde otro sitio: biblioteca, playlists, eventos y cortes. No emite y solo baja la música que escuches.</span>
        </button>
      </div>
    </>,
    // 1. La emisora
    <>
      <h2>Tu emisora</h2>
      <p className="hint">
        Si tu emisora tiene un maestro en la nube, ábrelo con el archivo de alta que se crea en su panel («Añadir un equipo»).
        {ws ? " Un puesto de trabajo lo necesita: de ahí saca la biblioteca y la música." : " Si no, puedes hacerlo más tarde en Ajustes › Maestro (nube)."}
      </p>
      {join ? (
        <p className="okc">
          Unido a <b>{join.station.name}</b> como «{join.node.name}».
        </p>
      ) : (
        <button type="button" className="btn btn-accent" onClick={() => void doJoin()}>
          Abrir el archivo de alta…
        </button>
      )}
    </>,
    // 2. La música
    ws ? (
      <>
        <h2>Música</h2>
        <p className="hint">
          Las canciones se bajan de la nube solo cuando las escuchas o editas sus cortes, y se guardan en esta carpeta. Desde
          Ajustes puedes ver cuánto ocupa y liberar espacio con un botón.
        </p>
        <div className="field-row">
          <input type="text" readOnly value={cloudDir || "La carpeta de datos de OmniCaster (por defecto)"} />
          <button
            type="button"
            className="btn"
            onClick={() => void pickFolder().then((p) => p && setCloudDir(p))}
          >
            Elegir…
          </button>
        </div>
      </>
    ) : (
      <>
        <h2>Tu música</h2>
        <p className="hint">
          ¿Dónde está tu música? OmniCaster la añade a la biblioteca sin mover ni copiar nada. Puedes añadir más carpetas
          después.
        </p>
        <div className="field-row">
          <input type="text" readOnly value={musicDir || (join ? "La de la emisora (se baja de la nube)" : "Ninguna por ahora")} />
          <button type="button" className="btn" onClick={() => void pickScanFolder().then((p) => p && setMusicDir(p))}>
            Elegir carpeta…
          </button>
        </div>
        {join && (
          <>
            <p className="hint" style={{ marginTop: 12 }}>
              Y la música de la emisora que este equipo no tenga, ¿dónde se guarda al bajarla?
            </p>
            <div className="field-row">
              <input type="text" readOnly value={cloudDir || "La carpeta de datos de OmniCaster (por defecto)"} />
              <button type="button" className="btn" onClick={() => void pickFolder().then((p) => p && setCloudDir(p))}>
                Elegir…
              </button>
            </div>
          </>
        )}
      </>
    ),
  ];
  const last = step === steps.length - 1;
  return (
    <div className="modal-backdrop">
      <div className="modal welcome-modal" role="dialog" aria-modal="true">
        <div className="welcome-dots">
          {steps.map((_, i) => (
            <span key={i} className={i === step ? "on" : ""} />
          ))}
        </div>
        {steps[step]}
        <div className="welcome-actions">
          {step > 0 && (
            <button type="button" className="btn" onClick={() => setStep(step - 1)} disabled={busy}>
              Atrás
            </button>
          )}
          <span style={{ flex: 1 }} />
          {last ? (
            <button type="button" className="btn btn-accent" disabled={busy} onClick={() => void finish()}>
              {busy ? "Preparando…" : "Empezar"}
            </button>
          ) : (
            <button type="button" className="btn btn-accent" onClick={() => setStep(step + 1)}>
              Siguiente
            </button>
          )}
        </div>
        <p className="hint" style={{ marginTop: 8 }}>Todo esto se puede cambiar después en Ajustes.</p>
      </div>
    </div>
  );
}
