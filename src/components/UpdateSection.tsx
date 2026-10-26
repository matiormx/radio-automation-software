import { useState } from "react";
import { openExternal, requestQuit } from "../api";
import { RELEASES_PAGE, checkForUpdate, installUpdate } from "../update";
import type { AppUpdateInfo } from "../types";

/**
 * Actualizaciones de la app: busca la ultima release publicada y, si es mas
 * nueva, la descarga, comprueba su firma, la instala y reinicia la app.
 */
export function UpdateSection({ showToast }: { showToast: (msg: string) => void }) {
  const [busy, setBusy] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [percent, setPercent] = useState<number | null>(null);
  const [info, setInfo] = useState<AppUpdateInfo | null>(null);
  const [error, setError] = useState("");

  const search = async () => {
    setBusy(true);
    setError("");
    try {
      const result = await checkForUpdate();
      setInfo(result);
      if (!result.available) {
        showToast(`Ya tienes la última versión (${result.current})`);
      }
    } catch (err) {
      setInfo(null);
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      showToast(`No se pudo buscar actualizaciones: ${message}`);
    } finally {
      setBusy(false);
    }
  };

  const install = async () => {
    if (!info) return;
    setInstalling(true);
    setPercent(null);
    setError("");
    try {
      await installUpdate((downloaded, total) => {
        setPercent(total ? Math.min(100, Math.round((downloaded / total) * 100)) : null);
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      showToast(`No se pudo instalar: ${message}`);
      setInstalling(false);
    }
  };

  const openDownloads = () => {
    void openExternal(RELEASES_PAGE).catch((e) => setError(String(e)));
  };

  return (
    <>
    <fieldset className="fieldset">
      <legend>Actualizaciones de la app</legend>
      <p className="hint">
        Busca la última versión publicada en GitHub. Al instalarla, la app descarga la
        actualización, comprueba su firma, se cierra y se vuelve a abrir ya actualizada.
      </p>
      <div className="update-actions">
        <button type="button" className="btn btn-sm" onClick={() => void search()} disabled={busy || installing}>
          {busy ? "Buscando…" : "Buscar actualizaciones"}
        </button>
        {info?.available && (
          <button
            type="button"
            className="btn btn-sm btn-accent"
            onClick={() => void install()}
            disabled={busy || installing}
          >
            {installing
              ? percent === null
                ? "Instalando…"
                : `Descargando… ${percent} %`
              : `Instalar ${info.latest}`}
          </button>
        )}
        <button type="button" className="ghost-btn" onClick={openDownloads} disabled={installing}>
          Abrir la página de descargas
        </button>
      </div>
      {info && (
        <p className="hint">
          Versión instalada: <strong>{info.current}</strong> · última publicada:{" "}
          <strong>{info.latest}</strong>
          {info.available ? " (hay una más nueva)" : " (estás al día)"}
        </p>
      )}
      {info?.notes && <p className="hint update-notes">{info.notes}</p>}
      {error && <p className="hint update-error">{error}</p>}
    </fieldset>
    <fieldset className="fieldset">
      <legend>Cerrar OmniCaster</legend>
      <p className="hint">
        La X de la ventana solo la oculta en la barra de tareas, para que la emisora no se cierre por descuido. Para
        cerrarla de verdad (mantenimiento, apagar el equipo…):
      </p>
      <div className="update-actions">
        <button type="button" className="btn btn-sm btn-danger" onClick={() => void requestQuit()}>
          Cerrar OmniCaster…
        </button>
      </div>
    </fieldset>
    </>
  );
}
