import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openDialog } from "../api";
import type { Settings } from "../types";

interface RemoteStatus {
  supported: boolean;
  vncInstalled: boolean;
  vncRunning: boolean;
  vncPasswordSet: boolean;
  vncPort: number;
  addresses: string[];
  wgHelper: boolean;
  wgConfigured: boolean;
  wgUp: boolean;
  wgAddress: string;
  wgEndpoint: string;
  wgHandshakeSecs: number;
  smbInstalled: boolean;
  smbEnabled: boolean;
  smbPath: string;
  smbDownloads: string;
  smbShare: string;
  error: string;
}

interface Props {
  settings: Settings;
  onChange: (s: Settings) => void;
  showToast: (msg: string) => void;
}

const INSTALL_HINT = "Vuelve a ejecutar el instalador del quiosco (wget matiormx.github.io/q && sudo bash q) para instalarlo.";

function ago(secs: number): string {
  if (secs < 0) return "nunca";
  if (secs < 90) return `hace ${secs} s`;
  if (secs < 5400) return `hace ${Math.round(secs / 60)} min`;
  return `hace ${Math.round(secs / 3600)} h`;
}

/**
 * Linux (equipo de quiosco): control remoto por VNC, túnel WireGuard y la
 * carpeta de música compartida por la red (Samba), sin usar la terminal.
 */
export function RemoteTab({ settings, onChange, showToast }: Props) {
  const remote = settings.remote ?? { vnc: false, vncOnlyWg: false };
  const [st, setSt] = useState<RemoteStatus | null>(null);
  const [vncPass, setVncPass] = useState("");
  const [smbPass, setSmbPass] = useState("");
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(() => {
    void invoke<RemoteStatus>("remote_status").then(setSt).catch(() => undefined);
  }, []);
  useEffect(() => {
    refresh();
    const t = window.setInterval(refresh, 5000);
    return () => window.clearInterval(t);
  }, [refresh]);

  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    try {
      await fn();
      showToast(ok);
    } catch (e) {
      showToast(String(e));
    } finally {
      setBusy(false);
      refresh();
    }
  };

  const setVnc = (vnc: boolean, vncOnlyWg = remote.vncOnlyWg, password?: string) =>
    run(async () => {
      await invoke("remote_vnc", { enabled: vnc, onlyWg: vncOnlyWg, password: password || null });
      onChange({ ...settings, remote: { vnc, vncOnlyWg } });
      setVncPass("");
    }, vnc ? "Control remoto (VNC) activado" : "Control remoto (VNC) apagado");

  if (!st) return <p className="hint">Comprobando…</p>;
  if (!st.supported) {
    return <p className="hint">El acceso remoto se configura aquí solo en Linux (equipo de quiosco).</p>;
  }
  const lan = st.addresses.filter((a) => a !== st.wgAddress);

  return (
    <>
      <fieldset className="fieldset">
        <legend>Control remoto (VNC)</legend>
        <p className="hint">
          Maneja OmniCaster desde otro ordenador con un visor VNC (TightVNC, RealVNC…). Se ve y se controla la misma
          pantalla del equipo.
        </p>
        {!st.vncInstalled ? (
          <p className="hint update-error">Falta x11vnc. {INSTALL_HINT}</p>
        ) : (
          <>
            <label className="field">
              <span className="field-label">{st.vncPasswordSet ? "Cambiar contraseña" : "Contraseña"}</span>
              <input
                type="password"
                value={vncPass}
                placeholder={st.vncPasswordSet ? "(sin cambios)" : "Al menos 6 caracteres (VNC usa los 8 primeros)"}
                onChange={(e) => setVncPass(e.target.value)}
              />
            </label>
            <label className="check-field">
              <input
                type="checkbox"
                checked={remote.vncOnlyWg}
                disabled={busy}
                onChange={(e) => void setVnc(remote.vnc, e.target.checked)}
              />
              Solo a través de WireGuard (recomendado si el equipo está en internet)
            </label>
            <div className="update-actions">
              {remote.vnc ? (
                <>
                  {vncPass && (
                    <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void setVnc(true, remote.vncOnlyWg, vncPass)}>
                      Guardar contraseña
                    </button>
                  )}
                  <button type="button" className="btn btn-sm btn-danger" disabled={busy} onClick={() => void setVnc(false)}>
                    Apagar VNC
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  className="btn btn-sm btn-primary"
                  disabled={busy || (!st.vncPasswordSet && vncPass.length < 6)}
                  onClick={() => void setVnc(true, remote.vncOnlyWg, vncPass)}
                >
                  Activar VNC
                </button>
              )}
            </div>
            <p className="hint">
              {st.vncRunning
                ? `Activo. Conéctate a ${(remote.vncOnlyWg ? [st.wgAddress] : [...lan, st.wgAddress])
                    .filter(Boolean)
                    .map((a) => `${a}:${st.vncPort}`)
                    .join(" · ") || `la IP del equipo, puerto ${st.vncPort}`}`
                : remote.vnc
                  ? "Activado, pero no está en marcha (si es «solo WireGuard», espera a que el túnel conecte)."
                  : "Apagado."}
            </p>
          </>
        )}
      </fieldset>

      <fieldset className="fieldset">
        <legend>WireGuard</legend>
        <p className="hint">
          Red privada cifrada para llegar a este equipo desde fuera del estudio (VNC, carpeta de música…). Importa el
          archivo .conf que te da tu servidor de WireGuard.
        </p>
        {!st.wgHelper ? (
          <p className="hint update-error">Falta el ayudante de WireGuard. {INSTALL_HINT}</p>
        ) : (
          <>
            <p className="hint">
              {!st.wgConfigured
                ? "Sin configurar."
                : st.wgUp
                  ? `Conectado${st.wgAddress ? ` · IP ${st.wgAddress}` : ""}${st.wgEndpoint && st.wgEndpoint !== "(none)" ? ` · servidor ${st.wgEndpoint}` : ""} · último contacto ${ago(st.wgHandshakeSecs)}`
                  : "Configurado, pero desconectado."}
            </p>
            <div className="update-actions">
              <button
                type="button"
                className="btn btn-sm"
                disabled={busy}
                onClick={async () => {
                  const file = await openDialog({ multiple: false, filters: [{ name: "WireGuard", extensions: ["conf"] }] });
                  if (typeof file === "string") void run(() => invoke("remote_wg", { action: "import", path: file }), "Configuración de WireGuard importada");
                }}
              >
                Importar .conf…
              </button>
              {st.wgConfigured && !st.wgUp && (
                <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={() => void run(() => invoke("remote_wg", { action: "up" }), "WireGuard conectado")}>
                  Conectar
                </button>
              )}
              {st.wgUp && (
                <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void run(() => invoke("remote_wg", { action: "down" }), "WireGuard desconectado")}>
                  Desconectar
                </button>
              )}
              {st.wgConfigured && (
                <button type="button" className="btn btn-sm btn-danger" disabled={busy} onClick={() => void run(() => invoke("remote_wg", { action: "remove" }), "Configuración de WireGuard quitada")}>
                  Quitar
                </button>
              )}
            </div>
            {st.error && <p className="hint update-error">{st.error}</p>}
          </>
        )}
      </fieldset>

      <fieldset className="fieldset">
        <legend>Carpetas en la red (Samba)</legend>
        <p className="hint">
          Comparte tres carpetas para usarlas desde Windows (Explorador › <code>\\IP</code>) o desde un Mac:{" "}
          <strong>Musica</strong> (la de OmniCaster, para copiar canciones), <strong>Plugins</strong> (los plugins
          .vst3 para Linux que pongas ahí aparecen en la mesa al pulsar «Volver a buscar» en Plugins VST) y{" "}
          <strong>Descargas</strong> (otros archivos). La carpeta <strong>Personal</strong> no se comparte. El usuario
          es <strong>radio</strong> (o el del quiosco) con la contraseña que pongas aquí.
        </p>
        {!st.smbInstalled ? (
          <p className="hint update-error">Falta Samba. {INSTALL_HINT}</p>
        ) : (
          <>
            <label className="field">
              <span className="field-label">Contraseña</span>
              <input
                type="password"
                value={smbPass}
                placeholder={st.smbEnabled ? "(sin cambios)" : "Al menos 6 caracteres (solo la primera vez)"}
                onChange={(e) => setSmbPass(e.target.value)}
              />
            </label>
            <div className="update-actions">
              {st.smbEnabled ? (
                <>
                  {smbPass && (
                    <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void run(() => invoke("remote_smb", { enabled: true, password: smbPass }).then(() => setSmbPass("")), "Contraseña cambiada")}>
                      Guardar contraseña
                    </button>
                  )}
                  <button type="button" className="btn btn-sm btn-danger" disabled={busy} onClick={() => void run(() => invoke("remote_smb", { enabled: false }), "Carpetas compartidas apagadas")}>
                    Dejar de compartir
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  className="btn btn-sm btn-primary"
                  disabled={busy}
                  onClick={() => void run(() => invoke("remote_smb", { enabled: true, password: smbPass || null }).then(() => setSmbPass("")), "Carpetas compartidas")}
                >
                  Compartir carpetas
                </button>
              )}
            </div>
            <p className="hint">
              {st.smbEnabled
                ? `Compartidas: ${[...lan, st.wgAddress]
                    .filter(Boolean)
                    .map((a) => `\\\\${a}\\${st.smbShare}, Plugins y Descargas`)
                    .join(" · ")}`
                : "No compartidas."}
            </p>
          </>
        )}
      </fieldset>
    </>
  );
}
