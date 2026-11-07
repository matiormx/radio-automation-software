import { useEffect, useState } from "react";
import { cloudGet, cloudJoinPick, cloudLeave, cloudNode, type CloudStatus } from "../cloud";

const ROLE: Record<string, string> = {
  main: "Principal (emite)",
  backup: "Relevo",
  studio: "Estudio (edita, no emite)",
};

/** Ajustes › Maestro (nube): unir este equipo al maestro con su archivo de alta. */
export function CloudTab({ showToast }: { showToast: (m: string) => void }) {
  const [st, setSt] = useState<CloudStatus>(cloudNode.status);
  const [busy, setBusy] = useState(false);
  useEffect(() => cloudNode.subscribe(setSt), []);

  const join = async () => {
    setBusy(true);
    try {
      const j = await cloudJoinPick();
      if (j) {
        cloudNode.start(j);
        showToast(`Unido a ${j.station.name} como «${j.node.name}»`);
      }
    } catch (e) {
      showToast(String(e));
    } finally {
      setBusy(false);
    }
  };
  const leave = async () => {
    if (!window.confirm("¿Dejar el maestro? Este equipo dejará de conectarse (podrás volver a unirlo con su archivo de alta).")) return;
    await cloudLeave().catch(() => undefined);
    cloudNode.start(null);
    showToast("Este equipo ya no está unido al maestro");
  };
  useEffect(() => {
    // Por si la pestaña se abre antes de que arranque la conexión.
    if (!cloudNode.status.join) void cloudGet().then((j) => j && cloudNode.start(j)).catch(() => undefined);
  }, []);

  const j = st.join;
  const stateText =
    st.state === "online"
      ? `Conectado desde las ${new Date(st.since).toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit" })}`
      : st.state === "connecting"
        ? "Conectando…"
        : st.state === "retrying"
          ? `Reintentando: ${st.error}`
          : st.error || "Sin conectar";

  return (
    <div className="settings-section">
      <fieldset className="fieldset">
        <legend>Maestro (nube)</legend>
        <p className="hint">
          El maestro reúne los datos de la emisora, avisa si un equipo se cae y permite manejarlo
          desde su panel web. Para unir este equipo, crea su archivo de alta en el panel del maestro
          («Añadir un equipo») y ábrelo aquí.
        </p>
        {!j ? (
          <button type="button" className="btn btn-accent" disabled={busy} onClick={() => void join()}>
            Unirse a un maestro…
          </button>
        ) : (
          <>
            <div className="field-row">
              <div className="field">
                <span className="field-label">Emisora</span>
                <b>{j.station.name}</b>
              </div>
              <div className="field">
                <span className="field-label">Este equipo</span>
                <b>
                  {j.node.name} · {ROLE[j.node.role] ?? j.node.role}
                </b>
              </div>
            </div>
            <div className="field">
              <span className="field-label">Maestro</span>
              <span>{j.api}</span>
            </div>
            <p className={st.state === "online" ? "hint" : "hint update-error"} style={st.state === "online" ? { color: "var(--ok, #3fb950)" } : undefined}>
              ● {stateText}
            </p>
            <div className="field-row">
              <button type="button" className="btn" disabled={busy} onClick={() => void join()}>
                Cambiar de archivo de alta…
              </button>
              <button type="button" className="btn" onClick={() => void leave()}>
                Dejar el maestro
              </button>
            </div>
          </>
        )}
        <p className="hint">
          Por ahora el maestro ve el estado de este equipo (qué suena, si emite, oyentes) y puede
          manejarlo como el control desde el móvil. La sincronización de la biblioteca, las listas
          y los eventos entre equipos llega en la siguiente fase.
        </p>
      </fieldset>
    </div>
  );
}
