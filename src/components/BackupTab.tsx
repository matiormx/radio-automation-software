import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { relaunch } from "@tauri-apps/plugin-process";
import {
  backupExport,
  backupImport,
  backupInspect,
  pickBackupDestination,
  pickBackupFile,
  pickAnyFolder,
  type BackupInfo,
} from "../api";

interface Props {
  showToast: (msg: string) => void;
}

function size(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1e3))} KB`;
}

/** Copia de seguridad completa y su importacion en otro equipo. */
export function BackupTab({ showToast }: Props) {
  const [withAudio, setWithAudio] = useState(false);
  const [busy, setBusy] = useState<"" | "export" | "import">("");
  const [prog, setProg] = useState<{ done: number; total: number } | null>(null);
  const [lastExport, setLastExport] = useState("");
  const [file, setFile] = useState("");
  const [info, setInfo] = useState<BackupInfo | null>(null);
  const [maps, setMaps] = useState<Record<string, string>>({});
  const [audioDest, setAudioDest] = useState("");
  const [confirm, setConfirm] = useState(false);

  useEffect(() => {
    const off = listen<{ phase: string; done: number; total: number }>("backup://progress", (e) =>
      setProg({ done: e.payload.done, total: e.payload.total }),
    );
    return () => {
      void off.then((f) => f());
    };
  }, []);

  const doExport = async () => {
    const dest = await pickBackupDestination();
    if (!dest) return;
    setBusy("export");
    setProg(null);
    try {
      const r = await backupExport(dest, withAudio);
      setLastExport(
        `Copia guardada en ${r.path} (${size(r.bytes)}, ${r.files} archivos de datos` +
          (withAudio ? `, ${r.audioFiles} canciones` : "") +
          ")" +
          (r.missingAudio ? `. ${r.missingAudio} canciones no se encontraron y no van incluidas.` : "."),
      );
      showToast("Copia de seguridad creada");
    } catch (e) {
      showToast(`No se pudo crear la copia: ${String(e)}`);
    } finally {
      setBusy("");
      setProg(null);
    }
  };

  const chooseImport = async () => {
    const p = await pickBackupFile();
    if (!p) return;
    try {
      const i = await backupInspect(p);
      setFile(p);
      setInfo(i);
      setMaps(Object.fromEntries(i.roots.map((r) => [r.prefix, r.prefix])));
      setAudioDest("");
      setConfirm(false);
    } catch (e) {
      showToast(String(e));
    }
  };

  const doImport = async () => {
    if (!info) return;
    setBusy("import");
    setProg(null);
    try {
      const mappings = Object.entries(maps)
        .filter(([from, to]) => to.trim() && to.trim() !== from)
        .map(([from, to]) => ({ from, to: to.trim() }));
      await backupImport(file, mappings, info.manifest.includeAudio && audioDest ? audioDest : null);
      showToast("Importación preparada: MiRadio se reinicia");
      window.setTimeout(() => void relaunch(), 800);
    } catch (e) {
      showToast(`No se pudo importar: ${String(e)}`);
      setBusy("");
    }
  };

  const pct = prog && prog.total > 0 ? Math.min(100, Math.round((prog.done / prog.total) * 100)) : null;

  return (
    <>
      <div className="camp-head">
        <div>
          <h4>Copia de seguridad</h4>
          <p className="hint">
            Guarda todo MiRadio en un único archivo .zip: biblioteca y bloques, listas, historial, programas, eventos,
            campañas, ajustes (mesa, emisión, API, notificaciones…), carátulas y logo. Sirve para recuperarlo o para
            pasarlo a otro equipo.
          </p>
        </div>
      </div>

      <fieldset className="fieldset bk-fieldset">
        <legend>Crear copia</legend>
        <label className="check-field">
          <input type="checkbox" checked={withAudio} onChange={(e) => setWithAudio(e.target.checked)} />
          Incluir también la música (los archivos de audio de la biblioteca)
        </label>
        <p className="hint">
          Sin la música la copia ocupa poco; las canciones se buscan en las mismas rutas (o en las que indiques al
          importar). Con la música puede ocupar muchos GB.
        </p>
        <div className="field-row">
          <button type="button" className="btn btn-sm" disabled={!!busy} onClick={() => void doExport()}>
            {busy === "export" ? "Creando copia…" : "Crear copia de seguridad…"}
          </button>
          {busy === "export" && pct !== null && <span className="hint">{pct}%</span>}
        </div>
        {lastExport && <p className="hint">{lastExport}</p>}
        <p className="hint">
          La copia incluye las claves de emisión y de la API: guárdala en un sitio seguro.
        </p>
      </fieldset>

      <fieldset className="fieldset bk-fieldset">
        <legend>Importar copia</legend>
        <p className="hint">
          Sustituye todo lo de este equipo por lo de la copia. Antes se guarda automáticamente una copia de lo actual
          en la carpeta de datos (backups). MiRadio se reinicia al terminar.
        </p>
        <div className="field-row">
          <button type="button" className="btn btn-sm" disabled={!!busy} onClick={() => void chooseImport()}>
            Elegir copia (.zip)…
          </button>
        </div>
        {info && (
          <>
            <p className="hint">
              <strong>{file.split(/[\\/]/).pop()}</strong> · creada el {info.manifest.created} con MiRadio{" "}
              {info.manifest.appVersion} · {info.manifest.tracks} canciones · {info.manifest.playlists} listas
              {info.manifest.includeAudio ? ` · incluye ${info.manifest.audioFiles} archivos de música (${size(info.manifest.audioBytes)})` : " · sin música"}
            </p>

            {info.manifest.includeAudio && (
              <div className="bk-roots">
                <span className="field-label">Carpeta donde copiar la música</span>
                <div className="bk-root-line">
                  <input
                    value={audioDest}
                    placeholder="Vacío: no copiar la música"
                    onChange={(e) => setAudioDest(e.target.value)}
                    aria-label="Carpeta donde copiar la música"
                  />
                  <button type="button" className="btn btn-sm" onClick={() => void pickAnyFolder().then((p) => p && setAudioDest(p))}>
                    Elegir…
                  </button>
                </div>
              </div>
            )}

            {info.roots.length > 0 && (
              <div className="bk-roots">
                <span className="field-label">Rutas de la música</span>
                <p className="hint">
                  Si en este equipo la música está en el mismo sitio (por ejemplo la misma unidad M:), déjalo igual.
                  Si está en otra carpeta, escribe o elige la nueva ruta.
                  {info.manifest.includeAudio && audioDest ? " Las rutas incluidas en la copia irán a la carpeta elegida arriba." : ""}
                </p>
                {info.roots.map((r) => {
                  const locked = info.manifest.includeAudio && !!audioDest && r.included;
                  return (
                    <div className="bk-root" key={r.prefix}>
                      <div className="bk-root-line">
                        <code className="bk-from" title={r.prefix}>{r.prefix}</code>
                        <span aria-hidden="true">→</span>
                        <input
                          value={locked ? `${audioDest} (copiada)` : (maps[r.prefix] ?? r.prefix)}
                          onChange={(e) => setMaps({ ...maps, [r.prefix]: e.target.value })}
                          disabled={locked}
                          aria-label={`Nueva ruta para ${r.prefix}`}
                        />
                        <button
                          type="button"
                          className="btn btn-sm"
                          disabled={locked}
                          onClick={() => void pickAnyFolder().then((p) => p && setMaps({ ...maps, [r.prefix]: p }))}
                        >
                          Elegir…
                        </button>
                      </div>
                      <span className={`hint ${r.exists || locked ? "" : "hint-error"}`}>
                        {r.tracks} {r.tracks === 1 ? "canción" : "canciones"} ·{" "}
                        {locked
                          ? "se copia desde la copia de seguridad"
                          : (maps[r.prefix] ?? r.prefix) !== r.prefix
                            ? "se cambiará la ruta"
                            : r.exists
                              ? "la carpeta existe en este equipo"
                              : "esta carpeta no existe en este equipo"}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}

            {!confirm ? (
              <div className="field-row">
                <button type="button" className="btn btn-sm" disabled={!!busy} onClick={() => setConfirm(true)}>
                  Importar…
                </button>
              </div>
            ) : (
              <div className="form-error" role="alertdialog">
                <p>
                  <strong>Se sustituirán la biblioteca, las listas y todos los ajustes de este equipo.</strong> Lo actual
                  queda guardado en backups. ¿Continuar?
                </p>
                <div className="field-row">
                  <button type="button" className="btn btn-sm" disabled={!!busy} onClick={() => void doImport()}>
                    {busy === "import" ? (pct !== null ? `Copiando música… ${pct}%` : "Preparando…") : "Sí, importar y reiniciar"}
                  </button>
                  <button type="button" className="btn btn-sm" disabled={!!busy} onClick={() => setConfirm(false)}>
                    Cancelar
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </fieldset>
    </>
  );
}
