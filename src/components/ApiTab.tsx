import { useCallback, useEffect, useState } from "react";
import { apiNewToken, apiSetLogin, apiSetUpdateToken, apiStatus, type ApiStatus } from "../api";
import type { ApiSettings, Settings } from "../types";

interface Props {
  settings: Settings;
  onChange: (s: Settings) => void;
  showToast: (msg: string) => void;
}

/**
 * API compatible con RadioBOSS para el worker de ngradio.es. Las claves se
 * guardan aparte (cifradas con hash) y nunca vuelven a mostrarse.
 */
export function ApiTab({ settings, onChange, showToast }: Props) {
  const api: ApiSettings = settings.api ?? {
    enabled: false,
    port: 9000,
    bindAll: false,
    icecastStatusUrl: "",
    updateUrl: "",
  };
  const set = (patch: Partial<ApiSettings>) => onChange({ ...settings, api: { ...api, ...patch } });
  const [status, setStatus] = useState<ApiStatus | null>(null);
  const [user, setUser] = useState("");
  const [pass, setPass] = useState("");
  const [token, setToken] = useState("");
  const [updateToken, setUpdateToken] = useState("");

  const refresh = useCallback(() => {
    void apiStatus()
      .then((s) => {
        setStatus(s);
        setUser((u) => u || s.user);
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    refresh();
    const t = window.setInterval(refresh, 2000);
    return () => window.clearInterval(t);
  }, [refresh]);

  const ice = settings.streaming.icecast.find((x) => x.enabled) ?? settings.streaming.icecast[0];
  const icePlaceholder = ice ? `${ice.tls ? "https" : "http"}://${ice.host}:${ice.port}/status-json.xsl` : "http://servidor:8000/status-json.xsl";

  return (
    <>
      <div className="camp-head">
        <div>
          <h4>API para ngradio.es</h4>
          <p className="hint">
            Sustituye a RadioBOSS como fuente de datos: responde a las mismas peticiones
            (<code>?action=playbackinfo</code>, <code>getlastplayed</code>, <code>library</code>…) con el
            mismo XML. Publícala con un túnel de Cloudflare hacia este equipo y apunta{" "}
            <code>API_BASE</code> del worker a esa dirección.
          </p>
        </div>
      </div>

      <fieldset className="fieldset">
        <legend>Servidor</legend>
        <label className="check-field">
          <input type="checkbox" checked={api.enabled} onChange={(e) => set({ enabled: e.target.checked })} />
          Activar la API
        </label>
        <div className="field-row">
          <label className="field">
            <span className="field-label">Puerto</span>
            <input
              type="number"
              min={1024}
              max={65535}
              value={api.port}
              onChange={(e) => set({ port: Math.max(1024, Math.min(65535, Number(e.target.value) || 9000)) })}
            />
          </label>
          <label className="check-field" title="Normalmente no: el túnel de Cloudflare entra por este mismo equipo">
            <input type="checkbox" checked={api.bindAll} onChange={(e) => set({ bindAll: e.target.checked })} />
            Aceptar conexiones de la red local
          </label>
        </div>
        <p className={`hint ${status?.error ? "hint-error" : ""}`}>
          {status?.error
            ? status.error
            : status?.running
              ? `En marcha en http://${status.address}/ · túnel: cloudflared tunnel --url http://127.0.0.1:${api.port}`
              : "Parada."}
        </p>
      </fieldset>

      <fieldset className="fieldset">
        <legend>Acceso</legend>
        <p className="hint">
          Credenciales propias de la API (no las del panel). Se guardan cifradas en este equipo, fuera de los
          ajustes y del repositorio. El worker puede usar <code>user</code>/<code>pass</code> en la URL o la cabecera{" "}
          <code>Authorization: Bearer</code>.
        </p>
        <div className="field-row">
          <label className="field">
            <span className="field-label">Usuario</span>
            <input value={user} onChange={(e) => setUser(e.target.value)} autoComplete="off" />
          </label>
          <label className="field">
            <span className="field-label">{status?.hasPassword ? "Nueva clave" : "Clave"}</span>
            <input type="password" value={pass} onChange={(e) => setPass(e.target.value)} autoComplete="new-password" />
          </label>
          <button
            type="button"
            className="btn btn-sm"
            disabled={!user.trim() || pass.length < 8}
            title={pass.length < 8 ? "Mínimo 8 caracteres" : undefined}
            onClick={() =>
              void apiSetLogin(user, pass)
                .then((s) => {
                  setStatus(s);
                  setPass("");
                  showToast("Credenciales de la API guardadas");
                })
                .catch((e) => showToast(String(e)))
            }
          >
            Guardar
          </button>
        </div>
        <div className="field-row">
          <button
            type="button"
            className="btn btn-sm"
            onClick={() =>
              void apiNewToken()
                .then((t) => {
                  setToken(t);
                  refresh();
                })
                .catch((e) => showToast(String(e)))
            }
          >
            {status?.hasToken ? "Generar token nuevo" : "Generar token Bearer"}
          </button>
          {token ? (
            <>
              <code className="api-token">{token}</code>
              <button type="button" className="ghost-btn" onClick={() => void navigator.clipboard?.writeText(token)}>
                Copiar
              </button>
            </>
          ) : (
            <span className="hint">
              {status?.hasToken ? "Hay un token activo (solo se muestra al generarlo)." : "Sin token."}
            </span>
          )}
        </div>
        {token && <p className="hint">Cópialo ahora: no se vuelve a mostrar. Al generar otro, el anterior deja de valer.</p>}
      </fieldset>

      <fieldset className="fieldset">
        <legend>Oyentes</legend>
        <label className="field">
          <span className="field-label">Estadísticas de Icecast (status-json.xsl)</span>
          <input
            value={api.icecastStatusUrl}
            placeholder={icePlaceholder}
            onChange={(e) => set({ icecastStatusUrl: e.target.value })}
          />
        </label>
        <p className="hint">Vacío: se usa el servidor de tu primera emisión Icecast. Se suman los oyentes de todos los mounts.</p>
      </fieldset>

      <fieldset className="fieldset">
        <legend>Aviso de cambio de canción</legend>
        <label className="field">
          <span className="field-label">URL del worker</span>
          <input
            value={api.updateUrl}
            placeholder="https://core.ngradio.es/update"
            onChange={(e) => set({ updateUrl: e.target.value })}
          />
        </label>
        <div className="field-row">
          <label className="field">
            <span className="field-label">AUTH_TOKEN del worker</span>
            <input
              type="password"
              value={updateToken}
              placeholder={status?.hasUpdateToken ? "•••••••• (guardado)" : ""}
              onChange={(e) => setUpdateToken(e.target.value)}
              autoComplete="off"
            />
          </label>
          <button
            type="button"
            className="btn btn-sm"
            disabled={!updateToken.trim()}
            onClick={() =>
              void apiSetUpdateToken(updateToken)
                .then((s) => {
                  setStatus(s);
                  setUpdateToken("");
                  showToast("Token del worker guardado");
                })
                .catch((e) => showToast(String(e)))
            }
          >
            Guardar
          </button>
        </div>
        <p className="hint">
          Cada vez que cambia la canción que suena, MiRadio llama una sola vez a{" "}
          <code>{(api.updateUrl || "https://core.ngradio.es/update") + "?token=…"}</code>, sin reintentos.
          {status?.lastUpdate ? ` Último aviso: ${status.lastUpdate}.` : ""}
        </p>
        <p className="hint">
          FILENAME (la identidad de cada canción) es la ruta completa del archivo: si lo renombras o lo mueves,
          para tu base de datos será una canción nueva.
        </p>
      </fieldset>
    </>
  );
}
