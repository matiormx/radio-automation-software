import type { MediaTypeCfg, Settings } from "../types";
import { DEFAULT_MEDIA_TYPES } from "../mediaTypes";
import { EMPTY_STREAM_META, MetaFields } from "./MetaFields";
import { Help } from "./Help";

const BUILT_IN = new Set(DEFAULT_MEDIA_TYPES.map((m) => m.id));

const TRANSITIONS: { id: MediaTypeCfg["transition"]; label: string }[] = [
  { id: "music", label: "Como la música (con el CROSSFADE de la barra)" },
  { id: "constant", label: "Suena entero y crossfade corto equal power" },
  { id: "dry", label: "Suena entero y corte seco" },
];

/**
 * Ajustes › Tipos de medio: cómo se trata cada tipo (música, jingles,
 * programas, cuñas y los que se añadan).
 */
export function MediaTypesTab({ settings: s, onChange }: { settings: Settings; onChange: (s: Settings) => void }) {
  const list = withMusic(s.mediaTypes?.length ? s.mediaTypes : DEFAULT_MEDIA_TYPES);
  const save = (next: MediaTypeCfg[]) => onChange({ ...s, mediaTypes: next });
  const patch = (id: string, p: Partial<MediaTypeCfg>) => save(list.map((m) => (m.id === id ? { ...m, ...p } : m)));

  const add = () => {
    let id = "";
    do id = `tipo-${Math.random().toString(36).slice(2, 6)}`;
    while (list.some((m) => m.id === id));
    save([
      ...list,
      {
        id,
        label: "Nuevo tipo",
        color: "#c08bff",
        transition: "constant",
        crossfade: 1,
        inMusic: false,
        autodj: false,
        energy: false,
        normalize: true,
        meta: null,
      },
    ]);
  };

  return (
    <div className="settings-section">
      <Help>
        Cada archivo de la biblioteca tiene un tipo de medio (se cambia en Editar metadatos o con el clic derecho). Aquí
        decides cómo se trata cada tipo. Los puntos Segue y Fade Out que pongas a mano en Marcadores siempre mandan
        sobre el crossfade del tipo.
      </Help>

      {list.map((m) => {
        const music = m.id === "";
        return (
          <fieldset key={m.id || "music"} className="fieldset mtype-card">
            <legend>
              <span className="mtype-chip" style={{ color: m.color, background: `${m.color}22` }}>
                {(m.label || "—").toUpperCase()}
              </span>
            </legend>
            <div className="field-row">
              <label className="field">
                <span className="field-label">Nombre</span>
                <input type="text" value={m.label} maxLength={30} onChange={(e) => patch(m.id, { label: e.target.value })} />
              </label>
              <label className="field mtype-color">
                <span className="field-label">Color</span>
                <input type="color" value={m.color || "#5b9cff"} onChange={(e) => patch(m.id, { color: e.target.value })} />
              </label>
            </div>

            {!music && (
              <div className="field-row">
                <label className="field">
                  <span className="field-label">Al terminar</span>
                  <select
                    value={m.transition}
                    onChange={(e) => patch(m.id, { transition: e.target.value as MediaTypeCfg["transition"] })}
                  >
                    {TRANSITIONS.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.label}
                      </option>
                    ))}
                  </select>
                </label>
                {m.transition === "constant" && (
                  <label className="field mtype-xf">
                    <span className="field-label">Duración del crossfade</span>
                    <select value={String(m.crossfade)} onChange={(e) => patch(m.id, { crossfade: Number(e.target.value) })}>
                      {[0.5, 1, 1.5, 2, 3].map((x) => (
                        <option key={x} value={String(x)}>
                          {String(x).replace(".", ",")} s
                        </option>
                      ))}
                    </select>
                  </label>
                )}
              </div>
            )}
            {!music && m.transition !== "music" && (
              <Help>
                Sin fundidos automáticos: entra a volumen completo y suena entero. El análisis no le pone puntos de mezcla
                ni de fade solos.
              </Help>
            )}

            {!music && (
              <label className="check-field">
                <input type="checkbox" checked={m.inMusic} onChange={(e) => patch(m.id, { inMusic: e.target.checked })} />
                Visible como música
                <Help>Sale en la vista Música, en OmniCaster Music y en los programas Subsonic (MusicBee, Amperfy…).</Help>
              </label>
            )}
            <label className="check-field">
              <input type="checkbox" checked={m.autodj} onChange={(e) => patch(m.id, { autodj: e.target.checked })} />
              En la rotación general del AutoDJ
              <Help>Si no, el AutoDJ solo lo usa cuando está en una lista elegida a propósito para la rotación.</Help>
            </label>
            <label className="check-field">
              <input type="checkbox" checked={m.energy} onChange={(e) => patch(m.id, { energy: e.target.checked })} />
              Lleva energía (metadatos IA)
              <Help>La IA le asigna energía, mood y temas, y aparece en «Sin energía» de la biblioteca si le falta.</Help>
            </label>
            <label className="check-field">
              <input type="checkbox" checked={m.normalize} onChange={(e) => patch(m.id, { normalize: e.target.checked })} />
              Normalización (LUFS)
              <Help>Se nivela su volumen como el de la música. Desactívalo si estos archivos ya vienen masterizados.</Help>
            </label>

            <label className="check-field">
              <input
                type="checkbox"
                checked={!!m.meta}
                onChange={(e) => patch(m.id, { meta: e.target.checked ? { ...EMPTY_STREAM_META } : null })}
              />
              Metadatos propios al aire
              <Help>Lo que ven los oyentes mientras suena (como en los eventos). Vacío: los del propio archivo.</Help>
            </label>
            {m.meta && (
              <MetaFields
                meta={{ ...EMPTY_STREAM_META, ...m.meta }}
                onChange={(meta) => patch(m.id, { meta })}
                legend={`Metadatos al emitirse un ${m.label.toLowerCase() || "archivo de este tipo"}`}
              />
            )}

            {!BUILT_IN.has(m.id) && (
              <div className="edit-actions">
                <Help>Si lo quitas, sus archivos se tratarán como música hasta que les cambies el tipo.</Help>
                <span className="spacer" />
                <button type="button" className="btn btn-sm btn-danger" onClick={() => save(list.filter((x) => x.id !== m.id))}>
                  Quitar este tipo
                </button>
              </div>
            )}
          </fieldset>
        );
      })}

      <div className="edit-actions">
        <button type="button" className="btn btn-sm" onClick={add}>
          Añadir tipo
        </button>
        <button type="button" className="btn btn-sm" onClick={() => save(DEFAULT_MEDIA_TYPES.map((m) => ({ ...m })))}>
          Volver a los de serie
        </button>
      </div>
    </div>
  );
}

function withMusic(list: MediaTypeCfg[]): MediaTypeCfg[] {
  const music = list.find((m) => m.id === "") ?? DEFAULT_MEDIA_TYPES[0];
  // Los de serie que falten (ajustes antiguos) se añaden.
  const rest = list.filter((m) => m.id !== "");
  for (const d of DEFAULT_MEDIA_TYPES) if (d.id && !rest.some((m) => m.id === d.id)) rest.push({ ...d });
  return [music, ...rest];
}
