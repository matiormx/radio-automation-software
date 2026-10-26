import { useCallback, useEffect, useState } from "react";
import type { Settings } from "../types";
import { pickVstFolder, vstScan, type VstScanResult } from "../api";

/**
 * Ajustes > Sonido > Plugins VST3: en qué carpetas se buscan, añadir otras y
 * ocultar del selector de la mesa los plugins que no interesan.
 */
export function VstSettings({ settings, onChange }: { settings: Settings; onChange: (next: Settings) => void }) {
  const vst = settings.vst ?? { extraFolders: [], hidden: [] };
  const [res, setRes] = useState<VstScanResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState("");
  const [showHidden, setShowHidden] = useState(true);

  const set = (patch: Partial<typeof vst>) => onChange({ ...settings, vst: { ...vst, ...patch } });

  const scan = useCallback(async () => {
    setBusy(true);
    setError("");
    try {
      setRes(await vstScan());
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }, []);

  // Se vuelve a buscar cuando cambian las carpetas (los ajustes ya se guardaron).
  const foldersKey = vst.extraFolders.join("|");
  useEffect(() => {
    const t = window.setTimeout(() => void scan(), 400);
    return () => window.clearTimeout(t);
  }, [foldersKey, scan]);

  const hidden = new Set(vst.hidden.map((h) => h.toLowerCase()));
  const isHidden = (path: string) => hidden.has(path.toLowerCase());
  const toggle = (path: string) =>
    set({
      hidden: isHidden(path)
        ? vst.hidden.filter((h) => h.toLowerCase() !== path.toLowerCase())
        : [...vst.hidden, path],
    });
  const plugins = (res?.plugins ?? []).filter(
    (p) =>
      (showHidden || !isHidden(p.path)) &&
      `${p.name} ${p.vendor} ${p.category}`.toLowerCase().includes(filter.toLowerCase()),
  );
  const visibleCount = (res?.plugins ?? []).filter((p) => !isHidden(p.path)).length;

  return (
    <section className="settings-section vst-settings">
      <h3>Plugins VST3</h3>
      <p className="hint">
        Los plugins se cargan en las ranuras FX de cada canal y bus de la mesa (suenan con el motor nativo). Haz clic en
        el nombre del plugin en la ranura para abrir su ventana.
      </p>

      <div className="field-label">Carpetas donde se buscan</div>
      <ul className="vst-folders">
        {(res?.folders ?? []).map((f) => (
          <li key={f.path} className={f.exists ? "" : "vst-folder-missing"}>
            <code>{f.path}</code>
            <span className="vst-folder-meta">
              {f.standard ? "del sistema" : "añadida"} ·{" "}
              {f.exists ? `${f.count} plugin${f.count === 1 ? "" : "s"}` : "no existe"}
            </span>
            {!f.standard && (
              <button
                type="button"
                className="ghost-btn"
                title="Quitar carpeta"
                onClick={() => set({ extraFolders: vst.extraFolders.filter((x) => x !== f.path) })}
              >
                ✕
              </button>
            )}
          </li>
        ))}
        {/* Carpetas añadidas que aun no aparecen en el resultado (buscando) */}
        {vst.extraFolders
          .filter((x) => !(res?.folders ?? []).some((f) => f.path.toLowerCase() === x.toLowerCase()))
          .map((x) => (
            <li key={x}>
              <code>{x}</code>
              <span className="vst-folder-meta">añadida · buscando…</span>
            </li>
          ))}
      </ul>
      <div className="vst-actions">
        <button
          type="button"
          className="btn btn-sm"
          onClick={() =>
            void pickVstFolder().then((dir) => {
              if (dir && !vst.extraFolders.some((x) => x.toLowerCase() === dir.toLowerCase())) {
                set({ extraFolders: [...vst.extraFolders, dir] });
              }
            })
          }
        >
          + Añadir carpeta
        </button>
        <button type="button" className="ghost-btn" disabled={busy} onClick={() => void scan()}>
          {busy ? "Buscando…" : "Volver a buscar"}
        </button>
      </div>

      <div className="field-label vst-list-head">
        Plugins encontrados {res ? `(${visibleCount} visibles de ${res.plugins.length})` : ""}
      </div>
      <div className="vst-filter">
        <label className="field vst-search">
          <input placeholder="Buscar…" value={filter} onChange={(e) => setFilter(e.target.value)} />
        </label>
        <label className="check-field">
          <input type="checkbox" checked={showHidden} onChange={(e) => setShowHidden(e.target.checked)} />
          Mostrar ocultos
        </label>
        {vst.hidden.length > 0 && (
          <button type="button" className="ghost-btn" onClick={() => set({ hidden: [] })}>
            Mostrar todos
          </button>
        )}
      </div>
      <div className="vst-table">
        {busy && !res && <p className="hint">Buscando plugins…</p>}
        {res && plugins.length === 0 && <p className="hint">No hay plugins que mostrar.</p>}
        {plugins.map((p) => (
          <label key={p.path} className={`vst-plugin ${isHidden(p.path) ? "vst-plugin-hidden" : ""}`} title={p.path}>
            <input type="checkbox" checked={!isHidden(p.path)} onChange={() => toggle(p.path)} />
            <strong>{p.name}</strong>
            <span>{p.vendor}</span>
            <small>{p.category}</small>
          </label>
        ))}
      </div>
      <p className="hint">Desmarca los que no quieras ver al añadir un plugin en la mesa. No se borran del equipo.</p>
      {error && <p className="form-error">{error}</p>}
    </section>
  );
}
