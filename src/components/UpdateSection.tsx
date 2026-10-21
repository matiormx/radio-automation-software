import { useEffect, useState } from "react";
import {
  DEFAULT_UPDATE_FEED,
  checkForUpdate,
  installUpdate,
  loadUpdateFeed,
  loadUpdateToken,
  openRelease,
  saveUpdateFeed,
  saveUpdateToken,
} from "../update";
import type { AppUpdateInfo } from "../types";

/**
 * Actualizaciones de la app: busca la ultima release publicada y, si es mas
 * nueva, descarga el instalador y lo abre.
 */
export function UpdateSection({ showToast }: { showToast: (msg: string) => void }) {
  const [feed, setFeed] = useState(DEFAULT_UPDATE_FEED);
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [info, setInfo] = useState<AppUpdateInfo | null>(null);
  const [error, setError] = useState("");
  const [version, setVersion] = useState("");

  useEffect(() => {
    setFeed(loadUpdateFeed());
    setToken(loadUpdateToken());
  }, []);

  const search = async () => {
    setBusy(true);
    setError("");
    saveUpdateFeed(feed);
    saveUpdateToken(token);
    try {
      const result = await checkForUpdate(feed, token);
      setInfo(result);
      setVersion(result.current);
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
    setError("");
    try {
      const path = await installUpdate(info);
      showToast(`Instalador descargado: ${path}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      showToast(`No se pudo instalar: ${message}`);
    } finally {
      setInstalling(false);
    }
  };

  return (
    <fieldset className="fieldset">
      <legend>Actualizaciones de la app</legend>
      <p className="hint">
        Busca la última release publicada y descarga el instalador. Al instalarlo, la app se
        cierra y se actualiza. Si el origen es un repositorio privado, pega un token de GitHub
        con permiso de lectura.
      </p>
      <label className="field">
        <span className="field-label">Origen de actualizaciones</span>
        <input
          type="text"
          value={feed}
          onChange={(e) => setFeed(e.target.value)}
          spellCheck={false}
          placeholder={DEFAULT_UPDATE_FEED}
        />
      </label>
      <label className="field">
        <span className="field-label">Token de GitHub (opcional)</span>
        <input
          type="password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          spellCheck={false}
          autoComplete="off"
          placeholder="ghp_…"
        />
      </label>
      <div className="update-actions">
        <button type="button" className="btn btn-sm" onClick={() => void search()} disabled={busy || installing}>
          {busy ? "Buscando…" : "Buscar actualizaciones"}
        </button>
        {info?.available && (
          <>
            <button
              type="button"
              className="btn btn-sm btn-accent"
              onClick={() => void install()}
              disabled={busy || installing}
            >
              {installing ? "Descargando…" : `Instalar ${info.latest}`}
            </button>
            <button
              type="button"
              className="ghost-btn"
              onClick={() => void openRelease(info).catch((e) => setError(String(e)))}
              disabled={installing}
            >
              Abrir la descarga
            </button>
          </>
        )}
      </div>
      {version && (
        <p className="hint">
          Versión instalada: <strong>{version}</strong>
          {info && (
            <>
              {" "}
              · última publicada: <strong>{info.latest}</strong>
              {info.available ? " (hay una más nueva)" : " (estás al día)"}
            </>
          )}
        </p>
      )}
      {info?.notes && <p className="hint update-notes">{info.notes}</p>}
      {error && <p className="hint update-error">{error}</p>}
    </fieldset>
  );
}
