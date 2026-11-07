import { useEffect, useState } from "react";
import { cloudGet, cloudJoinPick, cloudLeave, cloudMediaSet, cloudMediaStatus, cloudNode, type CloudStatus, type MediaStatus } from "../cloud";

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
        {j && j.node.role !== "backup" && <MediaUpload showToast={showToast} />}
        <p className="hint">
          Por ahora el maestro ve el estado de este equipo (qué suena, si emite, oyentes) y puede
          manejarlo como el control desde el móvil. La sincronización de la biblioteca, las listas
          y los eventos entre equipos llega en la siguiente fase.
        </p>
      </fieldset>
    </div>
  );
}

const LIMITS = [25, 50, 100, 150, 300, 0];

function gb(b: number) {
  return b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : `${Math.round(b / 1e6)} MB`;
}

/** Subida de la música de la biblioteca a la nube, en segundo plano. */
function MediaUpload({ showToast }: { showToast: (m: string) => void }) {
  const [m, setM] = useState<MediaStatus | null>(null);
  useEffect(() => {
    let alive = true;
    const tick = () => void cloudMediaStatus().then((x) => alive && setM(x)).catch(() => undefined);
    tick();
    const t = window.setInterval(tick, 2000);
    return () => {
      alive = false;
      window.clearInterval(t);
    };
  }, []);
  if (!m) return null;
  const set = (enabled: boolean, limit: number) =>
    void cloudMediaSet(enabled, limit).then(setM).catch((e) => showToast(String(e)));

  const left = Math.max(0, m.pendingBytes - m.uploadedBytes);
  const pct = m.pendingBytes > 0 ? Math.min(100, (m.uploadedBytes / m.pendingBytes) * 100) : m.phase === "done" ? 100 : 0;
  const eta = m.rateMbps > 0 && left > 0 ? Math.round((left * 8) / 1e6 / m.rateMbps / 60) : 0;
  const text: Record<MediaStatus["phase"], string> = {
    idle: "Sin empezar",
    hashing: `Preparando: huellas de ${m.hashed} de ${m.totalFiles} archivos (solo la primera vez)…`,
    checking: "Mirando qué falta en la nube…",
    uploading: `Subiendo ${m.uploadedFiles} de ${m.pendingFiles} · ${gb(m.uploadedBytes)} de ${gb(m.pendingBytes)}${m.rateMbps ? ` · ${m.rateMbps} Mb/s` : ""}${eta ? ` · quedan ~${eta >= 60 ? `${Math.floor(eta / 60)} h ${eta % 60} min` : `${eta} min`}` : ""}`,
    done: `Toda la música está en la nube (${m.totalFiles} archivos, ${gb(m.totalBytes)}). Lo nuevo se sube solo.`,
    paused: `En pausa${m.pendingFiles ? ` · subidos ${m.uploadedFiles} de ${m.pendingFiles}` : ""}`,
    error: `Error: ${m.error} (se reintenta solo)`,
    nomaster: "Este equipo no está unido al maestro",
  };
  return (
    <fieldset className="fieldset" style={{ marginTop: 12 }}>
      <legend>Música en la nube</legend>
      <p className="hint">
        Sube la música de la biblioteca al maestro, en segundo plano y con la velocidad limitada para
        no quitarle ancho de banda a la emisión. Solo sube lo que falta, y si se pausa o se cierra el
        programa, sigue donde iba.
      </p>
      <div className="field-row">
        <button type="button" className={m.enabled ? "btn" : "btn btn-accent"} onClick={() => set(!m.enabled, m.limitMbps)}>
          {m.enabled ? "Pausar" : m.uploadedFiles || m.hashed ? "Reanudar" : "Subir la música"}
        </button>
        <label className="field">
          <span className="field-label">Velocidad máxima</span>
          <select value={m.limitMbps} onChange={(e) => set(m.enabled, Number(e.target.value))}>
            {LIMITS.map((l) => (
              <option key={l} value={l}>
                {l ? `${l} Mb/s` : "Sin límite"}
              </option>
            ))}
          </select>
        </label>
      </div>
      {(m.enabled || m.phase !== "idle") && (
        <>
          <div style={{ height: 6, background: "var(--bg-2, #333)", borderRadius: 3, overflow: "hidden", margin: "8px 0 4px" }}>
            <div style={{ width: `${pct}%`, height: "100%", background: "var(--accent, #3fb950)", transition: "width .5s" }} />
          </div>
          <p className={m.phase === "error" ? "hint update-error" : "hint"}>{text[m.phase] ?? m.phase}</p>
          {m.phase === "uploading" && m.current && <p className="hint">↑ {m.current}</p>}
          {m.failed > 0 && <p className="hint update-error">{m.failed} archivos no se pudieron subir; se reintentarán en la próxima pasada.</p>}
        </>
      )}
    </fieldset>
  );
}
