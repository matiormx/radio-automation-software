import { useMemo, useState } from "react";
import type { Campaign, CampaignKind, Settings, Track } from "../types";
import { effectiveDuration } from "../types";
import { trackUrl } from "../api";
import { IconFolder, IconPlus, IconTrash, LogoRadio } from "../icons";

interface SettingsPanelProps {
  settings: Settings;
  tracks: Track[];
  onChange: (s: Settings) => void;
  onClose: () => void;
  onPickMusicFolder: () => Promise<void>;
  onPickLogo: () => Promise<void>;
  onClearLogo: () => Promise<void>;
  onImportAudio: () => Promise<Track[]>;
}

const DAYS: { value: number; label: string; long: string }[] = [
  { value: 1, label: "L", long: "lunes" },
  { value: 2, label: "M", long: "martes" },
  { value: 3, label: "X", long: "miércoles" },
  { value: 4, label: "J", long: "jueves" },
  { value: 5, label: "V", long: "viernes" },
  { value: 6, label: "S", long: "sábado" },
  { value: 7, label: "D", long: "domingo" },
];

const KIND_LABEL: Record<CampaignKind, string> = { ads: "Anuncio", jingle: "Jingle" };

function fmtDur(secs: number): string {
  const m = Math.floor(secs / 60);
  const s = Math.round(secs % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

function scheduleText(c: Campaign): string {
  if (c.hourly) return `Cada hora a las :${String(c.minute).padStart(2, "0")}`;
  if (c.times.length === 0) return "Sin horas";
  return c.times.join(" · ");
}

function daysText(c: Campaign): string {
  if (c.days.length === 7) return "Todos los días";
  return DAYS.filter((d) => c.days.includes(d.value))
    .map((d) => d.label)
    .join(" ");
}

function MinField({
  label,
  value,
  onCommit,
}: {
  label: string;
  value: number;
  onCommit: (v: number) => void;
}) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      <span className="field-unit">
        <input
          type="number"
          min={0}
          max={10080}
          value={value}
          onChange={(e) => onCommit(Math.max(0, Number(e.target.value) || 0))}
        />
        min
      </span>
    </label>
  );
}

type Tab = "general" | "autodj" | "campaigns";

export function SettingsPanel({
  settings,
  tracks,
  onChange,
  onClose,
  onPickMusicFolder,
  onPickLogo,
  onClearLogo,
  onImportAudio,
}: SettingsPanelProps) {
  const [tab, setTab] = useState<Tab>("general");
  const s = settings;
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal settings-modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Ajustes"
      >
        <div className="modal-head">
          <h3>Ajustes</h3>
          <button type="button" className="ghost-btn" onClick={onClose}>
            Cerrar
          </button>
        </div>

        <div className="settings-body">
          <nav className="settings-nav">
            <button
              type="button"
              className={`settings-nav-btn ${tab === "general" ? "settings-nav-on" : ""}`}
              onClick={() => setTab("general")}
            >
              General
              <span>Identidad, logo y carpeta</span>
            </button>
            <button
              type="button"
              className={`settings-nav-btn ${tab === "autodj" ? "settings-nav-on" : ""}`}
              onClick={() => setTab("autodj")}
            >
              AutoDJ
              <span>Rotación y cola automática</span>
            </button>
            <button
              type="button"
              className={`settings-nav-btn ${tab === "campaigns" ? "settings-nav-on" : ""}`}
              onClick={() => setTab("campaigns")}
            >
              Campañas
              <span>Anuncios y jingles</span>
            </button>
          </nav>

          <div className="settings-content">
            {tab === "general" && (
              <GeneralTab
                settings={s}
                onChange={onChange}
                onPickMusicFolder={onPickMusicFolder}
                onPickLogo={onPickLogo}
                onClearLogo={onClearLogo}
              />
            )}
            {tab === "autodj" && <AutoDjTab settings={s} onChange={onChange} />}
            {tab === "campaigns" && (
              <CampaignsTab
                settings={s}
                tracks={tracks}
                onChange={onChange}
                onImportAudio={onImportAudio}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function GeneralTab({
  settings: s,
  onChange,
  onPickMusicFolder,
  onPickLogo,
  onClearLogo,
}: {
  settings: Settings;
  onChange: (s: Settings) => void;
  onPickMusicFolder: () => Promise<void>;
  onPickLogo: () => Promise<void>;
  onClearLogo: () => Promise<void>;
}) {
  return (
    <>
      <fieldset className="fieldset">
        <legend>Identidad de la emisora</legend>
        <p className="hint">
          Estos datos sustituyen la marca por defecto de la esquina superior izquierda.
        </p>
        <div className="field-row">
          <label className="field">
            <span className="field-label">Nombre de la radio</span>
            <input
              type="text"
              value={s.radioName}
              maxLength={60}
              placeholder="MiRadio"
              onChange={(e) => onChange({ ...s, radioName: e.target.value })}
            />
          </label>
          <label className="field">
            <span className="field-label">Eslogan</span>
            <input
              type="text"
              value={s.slogan}
              maxLength={90}
              placeholder="Estudio de automatización"
              onChange={(e) => onChange({ ...s, slogan: e.target.value })}
            />
          </label>
        </div>
      </fieldset>

      <fieldset className="fieldset">
        <legend>Logo</legend>
        <div className="branding-row">
          <div className="branding-preview">
            {s.logoPath ? (
              <img src={trackUrl({ file: s.logoPath })} alt="Logo de la emisora" />
            ) : (
              <LogoRadio size={42} />
            )}
          </div>
          <div className="branding-actions">
            <div className="branding-btns">
              <button type="button" className="btn btn-sm" onClick={() => void onPickLogo()}>
                Elegir imagen
              </button>
              {s.logoPath && (
                <button type="button" className="ghost-btn" onClick={() => void onClearLogo()}>
                  Quitar logo
                </button>
              )}
            </div>
            <p className="hint">
              PNG, JPG, WebP o GIF. Se copia a los datos de la app; el original no se toca.
              Recomendado: cuadrado o horizontal con fondo transparente.
            </p>
          </div>
        </div>
      </fieldset>

      <fieldset className="fieldset">
        <legend>Carpeta de música</legend>
        <p className="hint">
          Las canciones que importes se copian aquí, para que la biblioteca siempre tenga su
          propia copia. La canción es sus metadatos: si mueves el archivo, sigue viva y se puede
          relinkar.
        </p>
        <div className="music-path-row">
          <span className="music-path" title={s.musicPath || "Carpeta interna de la app"}>
            {s.musicPath || "Carpeta interna de la app"}
          </span>
          <button type="button" className="btn btn-sm" onClick={() => void onPickMusicFolder()}>
            <IconFolder size={14} />
            Elegir carpeta
          </button>
          {s.musicPath !== "" && (
            <button
              type="button"
              className="ghost-btn"
              onClick={() => onChange({ ...s, musicPath: "" })}
            >
              Usar la interna
            </button>
          )}
        </div>
      </fieldset>
    </>
  );
}

function AutoDjTab({
  settings: s,
  onChange,
}: {
  settings: Settings;
  onChange: (s: Settings) => void;
}) {
  return (
    <>
      <fieldset className="fieldset">
        <legend>Reglas de rotación</legend>
        <p className="hint">
          El piloto automático respeta estas reglas cuando añade pistas a la lista. Si no hay
          ninguna que las cumpla, elige la que más tiempo lleve sin sonar.
        </p>
        <MinField
          label="Sin repetir mismo tema"
          value={s.repeatTrackMinutes}
          onCommit={(v) => onChange({ ...s, repeatTrackMinutes: v })}
        />
        <MinField
          label="Sin repetir mismo título"
          value={s.repeatTitleMinutes}
          onCommit={(v) => onChange({ ...s, repeatTitleMinutes: v })}
        />
        <MinField
          label="Sin repetir mismo artista"
          value={s.repeatArtistMinutes}
          onCommit={(v) => onChange({ ...s, repeatArtistMinutes: v })}
        />
        <label className="check-field">
          <input
            type="checkbox"
            checked={s.avoidConsecutiveArtist}
            onChange={(e) => onChange({ ...s, avoidConsecutiveArtist: e.target.checked })}
          />
          No emparejar dos temas del mismo artista seguidos
        </label>
      </fieldset>

      <fieldset className="fieldset">
        <legend>Piloto automático</legend>
        <MinField
          label="Añadir pistas cuando queden menos de"
          value={s.autopilotMinUpcoming}
          onCommit={(v) => onChange({ ...s, autopilotMinUpcoming: v })}
        />
        <MinField
          label="Dejar la lista con al menos"
          value={s.autopilotFillTo}
          onCommit={(v) => onChange({ ...s, autopilotFillTo: v })}
        />
        <p className="hint">
          Los bloques musicales de los que saca canciones se eligen en el navegador «Música», con
          el rayo de cada bloque. Las campañas programadas se configuran en la pestaña Campañas.
        </p>
      </fieldset>
    </>
  );
}

function CampaignsTab({
  settings: s,
  tracks,
  onChange,
  onImportAudio,
}: {
  settings: Settings;
  tracks: Track[];
  onChange: (s: Settings) => void;
  onImportAudio: () => Promise<Track[]>;
}) {
  const [draft, setDraft] = useState<Campaign | null>(null);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [timeInput, setTimeInput] = useState("12:00");
  const [importing, setImporting] = useState(false);

  const byId = useMemo(() => new Map(tracks.map((t) => [t.id, t])), [tracks]);

  const newCampaign = () => {
    setError("");
    setSearch("");
    setTimeInput("12:00");
    setDraft({
      id: `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`,
      name: "",
      kind: "ads",
      enabled: true,
      days: [1, 2, 3, 4, 5, 6, 7],
      times: [],
      hourly: false,
      minute: 0,
      trackIds: [],
      cursor: 0,
      lastFired: "",
    });
  };

  const edit = (c: Campaign) => {
    setError("");
    setSearch("");
    setDraft({ ...c, days: [...c.days], times: [...c.times], trackIds: [...c.trackIds] });
  };

  const save = () => {
    if (!draft) return;
    const name = draft.name.trim();
    if (!name) {
      setError("Ponle un nombre a la campaña.");
      return;
    }
    if (!draft.hourly && draft.times.length === 0) {
      setError("Añade al menos una hora o activa «cada hora».");
      return;
    }
    if (draft.days.length === 0) {
      setError("Selecciona al menos un día.");
      return;
    }
    if (draft.trackIds.length === 0) {
      setError("Añade al menos un anuncio o jingle.");
      return;
    }
    const clean: Campaign = { ...draft, name };
    const exists = s.campaigns.some((c) => c.id === clean.id);
    const campaigns = exists
      ? s.campaigns.map((c) => (c.id === clean.id ? clean : c))
      : [...s.campaigns, clean];
    onChange({ ...s, campaigns });
    setDraft(null);
    setError("");
  };

  const remove = (c: Campaign) => {
    if (!window.confirm(`¿Eliminar la campaña «${c.name}»?`)) return;
    onChange({ ...s, campaigns: s.campaigns.filter((x) => x.id !== c.id) });
    if (draft?.id === c.id) setDraft(null);
  };

  const toggle = (c: Campaign) => {
    onChange({
      ...s,
      campaigns: s.campaigns.map((x) => (x.id === c.id ? { ...x, enabled: !x.enabled } : x)),
    });
  };

  if (draft) {
    return (
      <CampaignEditor
        draft={draft}
        setDraft={setDraft}
        error={error}
        search={search}
        setSearch={setSearch}
        timeInput={timeInput}
        setTimeInput={setTimeInput}
        byId={byId}
        onSave={save}
        onCancel={() => {
          setDraft(null);
          setError("");
        }}
        importing={importing}
        onImport={async () => {
          setImporting(true);
          try {
            const added = await onImportAudio();
            if (added.length > 0) {
              setDraft((prev) =>
                prev
                  ? {
                      ...prev,
                      trackIds: [
                        ...prev.trackIds,
                        ...added.map((t) => t.id).filter((id) => !prev.trackIds.includes(id)),
                      ],
                    }
                  : prev,
              );
            }
          } finally {
            setImporting(false);
          }
        }}
      />
    );
  }

  return (
    <>
      <div className="camp-head">
        <div>
          <h4>Campañas de anuncios y jingles</h4>
          <p className="hint">
            Cada campaña se inserta en la lista del AutoDJ a las horas indicadas. El spot suena
            después del tema que esté sonando cuando llega la hora, sin cortarlo.
          </p>
        </div>
        <button type="button" className="btn btn-accent btn-sm" onClick={newCampaign}>
          <IconPlus size={14} /> Nueva campaña
        </button>
      </div>

      {s.campaigns.length === 0 ? (
        <div className="camp-empty">
          Todavía no hay campañas. Crea una para programar anuncios o jingles.
        </div>
      ) : (
        <div className="camp-list">
          {s.campaigns.map((c) => {
            const spots = c.trackIds.map((id) => byId.get(id)).filter((t): t is Track => !!t);
            const total = spots.reduce((acc, t) => acc + effectiveDuration(t), 0);
            return (
              <div key={c.id} className={`camp-card ${c.enabled ? "" : "camp-off"}`}>
                <label className="camp-toggle" title="Activar o desactivar la campaña">
                  <input type="checkbox" checked={c.enabled} onChange={() => toggle(c)} />
                </label>
                <div className="camp-card-main">
                  <div className="camp-card-title">
                    <strong>{c.name}</strong>
                    <span className={`camp-kind camp-kind-${c.kind}`}>{KIND_LABEL[c.kind]}</span>
                  </div>
                  <div className="camp-card-meta">
                    <span>{scheduleText(c)}</span>
                    <span>{daysText(c)}</span>
                    <span>
                      {spots.length} {spots.length === 1 ? "spot" : "spots"} · {fmtDur(total)}
                    </span>
                  </div>
                  {c.lastFired && (
                    <div className="camp-card-last">Última emisión: {c.lastFired}</div>
                  )}
                </div>
                <div className="camp-card-actions">
                  <button type="button" className="btn btn-sm" onClick={() => edit(c)}>
                    Editar
                  </button>
                  <button
                    type="button"
                    className="ghost-btn camp-del"
                    onClick={() => remove(c)}
                    title="Eliminar campaña"
                  >
                    <IconTrash size={14} />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}

function CampaignEditor({
  draft,
  setDraft,
  error,
  search,
  setSearch,
  timeInput,
  setTimeInput,
  byId,
  onSave,
  onCancel,
  importing,
  onImport,
}: {
  draft: Campaign;
  setDraft: (c: Campaign | null) => void;
  error: string;
  search: string;
  setSearch: (v: string) => void;
  timeInput: string;
  setTimeInput: (v: string) => void;
  byId: Map<string, Track>;
  onSave: () => void;
  onCancel: () => void;
  importing: boolean;
  onImport: () => Promise<void>;
}) {
  const q = search.trim().toLowerCase();
  const options = useMemo(
    () =>
      Array.from(byId.values())
        .filter((t) => !draft.trackIds.includes(t.id))
        .filter(
          (t) =>
            !q ||
            [t.title, t.artist, t.album].join(" ").toLowerCase().includes(q),
        )
        .slice(0, 80),
    [byId, draft.trackIds, q],
  );

  const set = (patch: Partial<Campaign>) => setDraft({ ...draft, ...patch });

  const addTime = () => {
    const v = timeInput.trim();
    if (!/^\d{2}:\d{2}$/.test(v)) return;
    if (draft.times.includes(v)) return;
    set({ times: [...draft.times, v].sort() });
  };

  const moveSpot = (index: number, dir: -1 | 1) => {
    const to = index + dir;
    if (to < 0 || to >= draft.trackIds.length) return;
    const ids = [...draft.trackIds];
    const [x] = ids.splice(index, 1);
    ids.splice(to, 0, x);
    set({ trackIds: ids });
  };

  return (
    <div className="camp-editor">
      <div className="camp-editor-head">
        <button type="button" className="ghost-btn" onClick={onCancel}>
          ← Volver
        </button>
        <h4>{draft.name ? "Editar campaña" : "Nueva campaña"}</h4>
      </div>

      <fieldset className="fieldset">
        <legend>Datos</legend>
        <div className="field-row">
          <label className="field">
            <span className="field-label">Nombre</span>
            <input
              type="text"
              value={draft.name}
              maxLength={70}
              placeholder="Ej.: Anuncios mañana"
              onChange={(e) => set({ name: e.target.value })}
            />
          </label>
          <label className="field camp-kind-field">
            <span className="field-label">Tipo</span>
            <select
              value={draft.kind}
              onChange={(e) => set({ kind: e.target.value as CampaignKind })}
            >
              <option value="ads">Anuncio</option>
              <option value="jingle">Jingle</option>
            </select>
          </label>
        </div>
        <label className="check-field">
          <input
            type="checkbox"
            checked={draft.enabled}
            onChange={(e) => set({ enabled: e.target.checked })}
          />
          Campaña activa
        </label>
      </fieldset>

      <fieldset className="fieldset">
        <legend>Programación</legend>
        <div className="camp-days">
          {DAYS.map((d) => (
            <button
              key={d.value}
              type="button"
              className={`camp-day ${draft.days.includes(d.value) ? "camp-day-on" : ""}`}
              title={d.long}
              onClick={() =>
                set({
                  days: draft.days.includes(d.value)
                    ? draft.days.filter((x) => x !== d.value)
                    : [...draft.days, d.value].sort(),
                })
              }
            >
              {d.label}
            </button>
          ))}
        </div>

        <label className="check-field">
          <input
            type="checkbox"
            checked={draft.hourly}
            onChange={(e) => set({ hourly: e.target.checked })}
          />
          Emitir cada hora al minuto
          <input
            className="camp-minute"
            type="number"
            min={0}
            max={59}
            value={draft.minute}
            disabled={!draft.hourly}
            onChange={(e) =>
              set({ minute: Math.max(0, Math.min(59, Number(e.target.value) || 0)) })
            }
          />
        </label>

        {!draft.hourly && (
          <>
            <div className="camp-time-add">
              <input
                type="time"
                value={timeInput}
                onChange={(e) => setTimeInput(e.target.value)}
              />
              <button type="button" className="btn btn-sm" onClick={addTime}>
                Añadir hora
              </button>
            </div>
            <div className="camp-times">
              {draft.times.length === 0 && <span className="hint">Sin horas todavía.</span>}
              {draft.times.map((t) => (
                <span key={t} className="camp-time-chip">
                  {t}
                  <button
                    type="button"
                    onClick={() => set({ times: draft.times.filter((x) => x !== t) })}
                    title="Quitar hora"
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          </>
        )}
        <p className="hint">
          Si la app está cerrada a esa hora no se emite; al abrirla solo se recupera la emisión si
          han pasado menos de 15 minutos.
        </p>
      </fieldset>

      <fieldset className="fieldset">
        <legend>Spots de la campaña</legend>
        <div className="camp-spots">
          {draft.trackIds.length === 0 && (
            <span className="hint">Añade anuncios o jingles desde la lista de abajo.</span>
          )}
          {draft.trackIds.map((id, i) => {
            const t = byId.get(id);
            return (
              <div key={id} className="camp-spot">
                <span className="camp-spot-n">{i + 1}</span>
                <span className="camp-spot-title">
                  {t ? t.title : "Pista no disponible"}
                  <em>{t ? t.artist : ""}</em>
                </span>
                <span className="camp-spot-dur">{t ? fmtDur(effectiveDuration(t)) : "—"}</span>
                <button
                  type="button"
                  className="ghost-btn"
                  disabled={i === 0}
                  onClick={() => moveSpot(i, -1)}
                  title="Subir"
                >
                  ↑
                </button>
                <button
                  type="button"
                  className="ghost-btn"
                  disabled={i === draft.trackIds.length - 1}
                  onClick={() => moveSpot(i, 1)}
                  title="Bajar"
                >
                  ↓
                </button>
                <button
                  type="button"
                  className="ghost-btn camp-del"
                  onClick={() => set({ trackIds: draft.trackIds.filter((x) => x !== id) })}
                  title="Quitar"
                >
                  <IconTrash size={13} />
                </button>
              </div>
            );
          })}
        </div>

        <div className="camp-add-head">
          <input
            className="nsearch"
            type="search"
            placeholder="Buscar en la biblioteca…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <button
            type="button"
            className="btn btn-sm"
            disabled={importing}
            onClick={() => void onImport()}
          >
            {importing ? "Importando…" : "Importar audio"}
          </button>
        </div>
        <div className="camp-options">
          {options.map((t) => (
            <button
              key={t.id}
              type="button"
              className="camp-option"
              onClick={() => set({ trackIds: [...draft.trackIds, t.id] })}
            >
              <span className="camp-option-title">{t.title}</span>
              <span className="camp-option-artist">{t.artist}</span>
              <span className="camp-option-plus">+</span>
            </button>
          ))}
          {options.length === 0 && (
            <span className="hint">No hay más canciones que coincidan.</span>
          )}
        </div>
      </fieldset>

      {error && <div className="form-error">{error}</div>}

      <div className="edit-actions">
        <button type="button" className="ghost-btn" onClick={onCancel}>
          Cancelar
        </button>
        <span className="spacer" />
        <button type="button" className="btn btn-accent btn-sm" onClick={onSave}>
          Guardar campaña
        </button>
      </div>
    </div>
  );
}
