import { useCallback, useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  openExternal,
  vstPkgCheck,
  vstPkgInstall,
  vstPkgList,
  vstPkgRemove,
  type VstPkg,
  type VstPkgProgress,
} from "../api";

const CATEGORY: Record<string, string> = {
  dinamica: "Dinámica",
  eq: "Ecualizador",
  reverb: "Reverb",
  varios: "Varios",
  medidor: "Medidor",
};

/**
 * Plugins recomendados: gratuitos y de código abierto, se instalan con un
 * clic desde su página oficial y se mantienen al día. Los gratuitos cerrados
 * solo se enlazan (se instalan a mano).
 */
export function VstRecommended({ onInstalled }: { onInstalled: () => void }) {
  const [list, setList] = useState<VstPkg[]>([]);
  const [prog, setProg] = useState<Record<string, VstPkgProgress>>({});
  const [checking, setChecking] = useState(false);

  const load = useCallback(() => {
    void vstPkgList().then(setList).catch(() => undefined);
  }, []);

  useEffect(() => {
    load();
    const off = listen<VstPkgProgress>("vstpkg://progress", (e) => {
      setProg((p) => ({ ...p, [e.payload.id]: e.payload }));
      if (!e.payload.busy) {
        load();
        if (e.payload.done) onInstalled();
      }
    });
    return () => {
      void off.then((f) => f());
    };
  }, [load, onInstalled]);

  const check = async () => {
    setChecking(true);
    try {
      await vstPkgCheck();
      load();
    } finally {
      setChecking(false);
    }
  };

  const shown = list.filter((p) => p.available);
  const updates = shown.filter((p) => p.installed && p.latest && p.latest !== p.installed.version && !p.installed.pending).length;

  return (
    <div className="vst-reco">
      <div className="field-label vst-reco-head">
        Plugins recomendados
        <button type="button" className="ghost-btn" disabled={checking} onClick={() => void check()}>
          {checking ? "Buscando…" : updates > 0 ? `Buscar actualizaciones (${updates} disponibles)` : "Buscar actualizaciones"}
        </button>
      </div>
      <p className="hint">
        Gratuitos. Los de código abierto se instalan con un clic desde su página oficial y se actualizan solos cada
        semana; los demás se descargan en su web y MiRadio los encuentra igual.
      </p>
      <div className="vst-reco-list">
        {shown.map((p) => {
          const pr = prog[p.item.id];
          const busy = p.busy || !!pr?.busy;
          const inst = p.installed;
          const canAuto = !!p.item.repo;
          const outdated = inst && p.latest && p.latest !== inst.version && !inst.pending;
          return (
            <div key={p.item.id} className={`vst-reco-item ${inst ? "vst-reco-on" : ""}`}>
              <div className="vst-reco-main">
                <div className="vst-reco-title">
                  <strong>{p.item.name}</strong>
                  <span className="chip">{CATEGORY[p.item.category] ?? p.item.category}</span>
                  <span className="vst-reco-lic">{p.item.license}</span>
                </div>
                <div className="vst-reco-desc">{p.item.description}</div>
                <div className="vst-reco-state">
                  {inst ? (
                    <>
                      ✓ Instalado {inst.version}
                      {inst.pending && ` · ${inst.pending} se pondrá al reiniciar MiRadio`}
                      {outdated && ` · nueva versión ${p.latest}`}
                    </>
                  ) : canAuto ? (
                    p.latest ? `Última versión: ${p.latest}` : ""
                  ) : (
                    "Se instala a mano desde su página"
                  )}
                  {pr?.error && !busy && <span className="vst-reco-err"> · {pr.error}</span>}
                  {pr?.done && !busy && !pr.error && <span> · {pr.done}</span>}
                </div>
                {busy && (
                  <div className="ff-progress">
                    <div style={{ width: `${Math.round((pr?.fraction ?? 0) * 100)}%` }} />
                  </div>
                )}
              </div>
              <div className="vst-reco-actions">
                {canAuto ? (
                  <>
                    <button
                      type="button"
                      className="btn btn-sm"
                      disabled={busy}
                      onClick={() => void vstPkgInstall(p.item.id).catch((e) => setProg((s) => ({ ...s, [p.item.id]: { id: p.item.id, busy: false, phase: "", fraction: 0, error: String(e), done: null } })))}
                    >
                      {busy
                        ? pr?.phase === "descargando"
                          ? `Descargando ${Math.round((pr.fraction || 0) * 100)} %`
                          : "Instalando…"
                        : !inst
                          ? "Instalar"
                          : outdated
                            ? "Actualizar"
                            : "Reinstalar"}
                    </button>
                    {inst && !busy && (
                      <button
                        type="button"
                        className="ghost-btn"
                        onClick={() =>
                          void vstPkgRemove(p.item.id)
                            .then(() => {
                              load();
                              onInstalled();
                            })
                            .catch((e) => setProg((s) => ({ ...s, [p.item.id]: { id: p.item.id, busy: false, phase: "", fraction: 0, error: String(e), done: null } })))
                        }
                      >
                        Quitar
                      </button>
                    )}
                  </>
                ) : (
                  <button type="button" className="btn btn-sm" onClick={() => void openExternal(p.item.homepage)}>
                    Abrir su web
                  </button>
                )}
                <button type="button" className="ghost-btn" onClick={() => void openExternal(p.item.homepage)} title={p.item.homepage}>
                  Info
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
