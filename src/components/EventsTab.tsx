import { useMemo, useState } from "react";
import { DEFAULT_AIR_MINS, DEFAULT_EVENT_DAYS, DEFAULT_SLOT_DAYS, isRandom, randomPool } from "../eventPick";
import type {
  Block,
  Settings,
  StationEvent,
  StationEventKind,
  StationEventSource,
  StationEventTimeout,
  Track,
} from "../types";
import { effectiveDuration, eventSchedules } from "../types";
import { ScheduleEditor, newScheduleBlock } from "./ScheduleEditor";
import { EMPTY_STREAM_META, MetaFields } from "./MetaFields";
import { IconPlus, IconTrash } from "../icons";
import { pickImageFile, trackUrl } from "../api";

const DAYS: { value: number; label: string; long: string }[] = [
  { value: 1, label: "L", long: "lunes" },
  { value: 2, label: "M", long: "martes" },
  { value: 3, label: "X", long: "miércoles" },
  { value: 4, label: "J", long: "jueves" },
  { value: 5, label: "V", long: "viernes" },
  { value: 6, label: "S", long: "sábado" },
  { value: 7, label: "D", long: "domingo" },
];

const KIND_LABEL: Record<StationEventKind, string> = {
  auto: "Franja AutoDJ",
  insert: "Evento de audio",
  stream: "Evento de audio",
};

const EMPTY_META = { title: "", artist: "", album: "", year: "", genre: "", comment: "", cover: "" };

function hostOf(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url.split(/[\\/]/).pop() || url;
  }
}

function fmtDur(secs: number): string {
  const m = Math.floor(secs / 60);
  const s = Math.round(secs % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

function addHour(value: string): string {
  const start = parseHM(value);
  if (start === null) return "07:00";
  const total = (start + 60) % (24 * 60);
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

function parseHM(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const h = Number(match[1]);
  const m = Number(match[2]);
  if (!Number.isInteger(h) || !Number.isInteger(m) || h < 0 || h > 23 || m < 0 || m > 59) {
    return null;
  }
  return h * 60 + m;
}

/** Ordena, quita repetidas y deja al final las que aun no son validas. */
function normalizeTimes(values: string[]): string[] {
  const valid = Array.from(new Set(values.map((v) => v.trim()).filter((v) => parseHM(v) !== null)));
  valid.sort((a, b) => (parseHM(a) ?? 0) - (parseHM(b) ?? 0));
  return [...valid, ...values.filter((v) => parseHM(v.trim()) === null)];
}

/** "08:15, 08:45, 09:15 … (+5)" para la tarjeta del evento. */
function timesText(event: StationEvent, max = 8): string {
  const all = normalizeTimes(eventTimes(event));
  return all.length <= max ? all.join(", ") : `${all.slice(0, max).join(", ")} … (+${all.length - max})`;
}

/** Horas configuradas de un evento sin fin (auto/insert). */
function eventTimes(event: StationEvent): string[] {
  const schedules = eventSchedules(event);
  const all = schedules.flatMap((block) => (block.times?.length ? block.times : [block.start ?? event.start]));
  const times = all.filter((value) => parseHM(value) !== null);
  return times.length > 0 ? times : [event.start];
}

function daysText(event: StationEvent): string {
  return eventSchedules(event)
    .map((block) => {
      if (block.days.length === 7) return "Todos los días";
      return DAYS.filter((d) => block.days.includes(d.value))
        .map((d) => d.label)
        .join(" ");
    })
    .join(" | ");
}

function sourceLabel(event: StationEvent, blocks: Block[]): string {
  if (event.sourceKind === "library") {
    return event.sourceId === "b" ? "Biblioteca B" : "Biblioteca A";
  }
  return blocks.find((b) => b.id === event.sourceId)?.name ?? "Lista eliminada";
}

function eventMeta(event: StationEvent, blocks: Block[], byId: Map<string, Track>): string[] {
  if (event.kind === "auto") {
    return [
      `Desde las ${timesText(event)}`,
      daysText(event),
      `Fuente: ${sourceLabel(event, blocks)}`,
    ];
  }
  if (event.kind === "stream") {
    const ranges = eventSchedules(event)
      .map((block) => `${block.start ?? event.start}–${block.end ?? event.end ?? "?"}`)
      .join(" | ");
    return [
      `De ${ranges}`,
      daysText(event),
      event.meta?.title
        ? `Internet: ${event.meta.title}${event.meta.artist ? ` · ${event.meta.artist}` : ""}`
        : "Internet sin título",
      hostOf(event.streamUrl ?? ""),
    ];
  }
  const track = byId.get(event.trackId);
  const random = isRandom(event);
  const custom = event.meta?.title?.trim() || event.meta?.artist?.trim() || "";
  return [
    `A las ${timesText(event)}`,
    daysText(event),
    random
      ? `Aleatoria: ${sourceLabel(event, blocks)} · ${randomPool(event, Array.from(byId.values())).length} pistas`
      : track
        ? `Biblioteca: ${track.title} · ${track.artist}`
        : "Pista no disponible",
    ...(custom ? [`Al aire: ${custom}`] : []),
    event.maxWaitSecs > 0
      ? `Máx. ${event.maxWaitSecs} s · ${event.onTimeout === "force" ? "forzar" : "cancelar"}`
      : event.onTimeout === "force"
        ? "Inmediato · forzar"
        : "Inmediato · cancelar",
  ];
}

function newEvent(): StationEvent {
  return {
    id: `e${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`,
    name: "",
    enabled: true,
    kind: "auto",
    days: [1, 2, 3, 4, 5, 6, 7],
    start: "06:00",
    schedules: [newScheduleBlock("event")],
    sourceKind: "library",
    sourceId: "a",
    trackId: "",
    trackMode: "fixed",
    noRepeatSlotDays: DEFAULT_SLOT_DAYS,
    noRepeatEventDays: DEFAULT_EVENT_DAYS,
    noRepeatAirMins: DEFAULT_AIR_MINS,
    maxWaitSecs: 60,
    onTimeout: "cancel",
    lastFired: "",
  };
}

export function EventsTab({
  settings,
  tracks,
  blocks,
  onChange,
  onImportAudio,
  onLaunchEvent,
}: {
  settings: Settings;
  tracks: Track[];
  blocks: Block[];
  onChange: (s: Settings) => void;
  onImportAudio: () => Promise<Track[]>;
  onLaunchEvent: (event: StationEvent) => void;
}) {
  const [draft, setDraft] = useState<StationEvent | null>(null);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [importing, setImporting] = useState(false);

  const byId = useMemo(() => new Map(tracks.map((t) => [t.id, t])), [tracks]);

  const startNew = () => {
    setError("");
    setSearch("");
    setDraft(newEvent());
  };

  const edit = (event: StationEvent) => {
    setError("");
    setSearch("");
    setDraft({
      ...event,
      days: [...event.days],
      times:
        event.kind === "stream"
          ? []
          : event.times?.length
            ? [...event.times]
            : [event.start],
      schedules: eventSchedules(event).map((block) => ({
        ...block,
        days: [...block.days],
        times: [...block.times],
      })),
      meta: { ...EMPTY_STREAM_META, ...(event.meta ?? {}) },
    });
  };

  const save = () => {
    if (!draft) return;
    const name = draft.name.trim();
    if (!name) {
      setError("Ponle un nombre al evento.");
      return;
    }
    const schedules = eventSchedules(draft).map((block) => ({
      ...block,
      days: [...block.days].sort(),
      times: [...block.times],
    }));
    if (schedules.some((block) => block.days.length === 0)) {
      setError("Cada franja debe tener al menos un día.");
      return;
    }

    let times: string[] = [];
    if (draft.kind === "stream") {
      for (const block of schedules) {
        const start = parseHM(block.start ?? draft.start);
        const end = parseHM(block.end ?? draft.end ?? "");
        if (start === null) {
          setError("La hora de inicio no es válida.");
          return;
        }
        if (end === null) {
          setError("La hora de fin no es válida.");
          return;
        }
        if (end === start) {
          setError("La hora de fin debe ser distinta de la de inicio.");
          return;
        }
        block.times = [];
      }
      const url = (draft.streamUrl ?? "").trim();
      if (!/^(https?|rtmp|rtsp|srt):\/\//i.test(url) && !/^([a-z]:\\|\/|\\\\)/i.test(url)) {
        setError("Escribe la dirección del audio (http/https…) o la ruta de un archivo.");
        return;
      }
      if (!(draft.meta?.title ?? "").trim()) {
        setError("Ponle al menos un título a lo que se mostrará.");
        return;
      }
    } else {
      for (const block of schedules) {
        const raw = (block.times?.length ? block.times : [block.start ?? draft.start]).map((value) =>
          value.trim(),
        );
        if (raw.some((value) => parseHM(value) === null)) {
          setError("Alguna de las horas no es válida.");
          return;
        }
        const normalized = Array.from(new Set(raw)).sort(
          (a, b) => (parseHM(a) ?? 0) - (parseHM(b) ?? 0),
        );
        if (normalized.length === 0) {
          setError("Añade al menos un horario a cada franja.");
          return;
        }
        block.times = normalized;
        block.start = normalized[0];
      }
      times = Array.from(new Set(schedules.flatMap((block) => block.times))).sort(
        (a, b) => (parseHM(a) ?? 0) - (parseHM(b) ?? 0),
      );
      if (draft.kind === "auto") {
        if (draft.sourceKind === "block" && !blocks.some((b) => b.id === draft.sourceId)) {
          setError("Elige un lista para la franja.");
          return;
        }
        if (draft.sourceKind === "library" && draft.sourceId !== "a" && draft.sourceId !== "b") {
          setError("Elige la Biblioteca A o la B.");
          return;
        }
      } else if (draft.trackMode === "random") {
        if (draft.sourceKind === "block" && !blocks.some((b) => b.id === draft.sourceId)) {
          setError("Elige la lista del que saldrán las pistas.");
          return;
        }
        if (randomPool(draft, tracks).length === 0) {
          setError("La fuente elegida no tiene pistas disponibles.");
          return;
        }
        if (draft.maxWaitSecs < 0 || draft.maxWaitSecs > 3600) {
          setError("La espera máxima debe estar entre 0 y 3600 segundos.");
          return;
        }
      } else {
        if (!byId.has(draft.trackId)) {
          setError("Elige el sonido que se insertará.");
          return;
        }
        if (draft.maxWaitSecs < 0 || draft.maxWaitSecs > 3600) {
          setError("La espera máxima debe estar entre 0 y 3600 segundos.");
          return;
        }
      }
    }

    const first = schedules[0];
    const clean: StationEvent = {
      ...draft,
      name,
      schedules,
      days: first.days,
      times: draft.kind === "stream" ? [] : times,
      start:
        draft.kind === "stream" ? first.start ?? draft.start : times[0] ?? draft.start,
      end: draft.kind === "stream" ? first.end ?? draft.end ?? "" : draft.end,
      meta: { ...EMPTY_STREAM_META, ...(draft.meta ?? {}) },
    };
    const current = settings.events.find((event) => event.id === clean.id);
    if (current) {
      // El planificador sigue anotando mientras se edita: se conserva lo mas reciente
      // (salvo que el historial se haya borrado a proposito).
      clean.lastFired = current.lastFired;
      if ((clean.pickLog?.length ?? 0) >= (current.pickLog?.length ?? 0)) clean.pickLog = current.pickLog;
    }
    const exists = !!current;
    const events = exists
      ? settings.events.map((event) => (event.id === clean.id ? clean : event))
      : [...settings.events, clean];
    onChange({ ...settings, events });
    setDraft(null);
    setError("");
  };

  const remove = (event: StationEvent) => {
    if (!window.confirm(`¿Eliminar el evento «${event.name}»?`)) return;
    onChange({ ...settings, events: settings.events.filter((x) => x.id !== event.id) });
    if (draft?.id === event.id) setDraft(null);
  };

  const toggle = (event: StationEvent) => {
    onChange({
      ...settings,
      events: settings.events.map((x) =>
        x.id === event.id ? { ...x, enabled: !x.enabled } : x,
      ),
    });
  };

  if (draft) {
    return (
      <EventEditor
        draft={draft}
        setDraft={setDraft}
        error={error}
        search={search}
        setSearch={setSearch}
        byId={byId}
        blocks={blocks}
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
              setDraft((prev) => (prev ? { ...prev, trackId: added[0].id } : prev));
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
          <h4>Eventos de programación</h4>
          <p className="hint">
            Una franja cambia la fuente del AutoDJ a partir de una o varias horas. Un evento de
            audio puede ser una pista de la biblioteca (se coloca como siguiente a una o varias
            horas exactas) o un audio de internet (se emite durante una franja con sus metadatos).
          </p>
        </div>
        <button type="button" className="btn btn-accent btn-sm" onClick={startNew}>
          <IconPlus size={14} /> Nuevo evento
        </button>
      </div>

      {!settings.eventsEnabled && (
        <div className="form-error">
          Los eventos están desactivados globalmente. Actívalos con el interruptor EVENTOS de la
          pantalla principal para que vuelvan a ejecutarse.
        </div>
      )}

      {settings.events.length === 0 ? (
        <div className="camp-empty">
          Todavía no hay eventos. Crea una franja de AutoDJ o un evento de audio.
        </div>
      ) : (
        <div className="camp-list">
          {settings.events.map((event) => {
            const random = isRandom(event);
            const missingTrack =
              event.kind === "insert" && !random && !!event.trackId && !byId.has(event.trackId);
            const missingBlock =
              (event.kind === "auto" || random) &&
              event.sourceKind === "block" &&
              !blocks.some((b) => b.id === event.sourceId);
            const emptyPool =
              random && !missingBlock && randomPool(event, tracks).length === 0;
            return (
              <div key={event.id} className={`camp-card ${event.enabled ? "" : "camp-off"}`}>
                <div className="camp-card-main">
                  <div className="camp-card-title">
                    <strong>{event.name}</strong>
                    <span className={`camp-kind camp-kind-${event.kind}`}>
                      {KIND_LABEL[event.kind]}
                    </span>
                  </div>
                  <div className="camp-card-meta">
                    {eventMeta(event, blocks, byId).map((text, i) => (
                      <span key={i}>{text}</span>
                    ))}
                  </div>
                  {(missingTrack || missingBlock || emptyPool) && (
                    <div className="camp-card-last">
                      {missingTrack
                        ? "La pista ya no está en la biblioteca."
                        : emptyPool
                          ? "La fuente no tiene pistas disponibles."
                          : "La lista ya no existe."}
                    </div>
                  )}
                  {event.lastFired && (
                    <div className="camp-card-last">Última emisión: {event.lastFired}</div>
                  )}
                </div>
                <div className="camp-card-actions">
                  <button
                    type="button"
                    className={`btn btn-sm ${event.enabled ? "" : "btn-accent"}`}
                    onClick={() => toggle(event)}
                    title={event.enabled ? "Desactivar el evento" : "Activar el evento"}
                  >
                    {event.enabled ? "Desactivar" : "Activar"}
                  </button>
                  <button
                    type="button"
                    className="btn btn-sm btn-accent"
                    onClick={() => onLaunchEvent(event)}
                    disabled={
                      !settings.eventsEnabled || !event.enabled || missingTrack || missingBlock || emptyPool
                    }
                    title={
                      !settings.eventsEnabled
                        ? "Activa los eventos globalmente para poder lanzarlo"
                        : !event.enabled
                          ? "Activa el evento para poder lanzarlo"
                          : missingTrack || missingBlock || emptyPool
                            ? "Completa la fuente del evento para poder lanzarlo"
                            : "Lanzar el evento ahora"
                    }
                  >
                    Lanzar
                  </button>
                  <button type="button" className="btn btn-sm" onClick={() => edit(event)}>
                    Editar
                  </button>
                  <button
                    type="button"
                    className="ghost-btn camp-del"
                    onClick={() => remove(event)}
                    title="Eliminar evento"
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

function EventEditor({
  draft,
  setDraft,
  error,
  search,
  setSearch,
  byId,
  blocks,
  onSave,
  onCancel,
  importing,
  onImport,
}: {
  draft: StationEvent;
  setDraft: (event: StationEvent | null) => void;
  error: string;
  search: string;
  setSearch: (value: string) => void;
  byId: Map<string, Track>;
  blocks: Block[];
  onSave: () => void;
  onCancel: () => void;
  importing: boolean;
  onImport: () => Promise<void>;
}) {
  const q = search.trim().toLowerCase();
  const selected = byId.get(draft.trackId);
  const [trackBlock, setTrackBlock] = useState("");
  const random = isRandom(draft);
  const allTracks = useMemo(() => Array.from(byId.values()), [byId]);
  const pool = useMemo(() => (random ? randomPool(draft, allTracks).length : 0), [random, draft, allTracks]);
  const options = useMemo(
    () =>
      Array.from(byId.values())
        .filter((track) => track.id !== draft.trackId)
        .filter((track) => !trackBlock || track.blocks.includes(trackBlock))
        .filter(
          (track) =>
            !q || [track.title, track.artist, track.album].join(" ").toLowerCase().includes(q),
        )
        .slice(0, 80),
    [byId, draft.trackId, q, trackBlock],
  );

  const set = (patch: Partial<StationEvent>) => setDraft({ ...draft, ...patch });

  const setKind = (kind: StationEventKind) => {
    if (kind === "auto" && draft.sourceKind === "block" && blocks.length === 0) {
      set({ kind, sourceKind: "library", sourceId: "a" });
      return;
    }
    set({ kind });
  };

  const setType = (value: "auto" | "audio") => {
    if (value === "auto") {
      setKind("auto");
      return;
    }
    if (draft.kind === "auto") setKind("insert");
  };

  const setSource = (value: "track" | "random" | "url") => {
    const block = eventSchedules(draft)[0];
    const first = block?.start || block?.times?.[0] || draft.start || "06:00";
    if (value === "random") {
      set({
        kind: "insert",
        trackMode: "random",
        times: draft.times?.length ? draft.times : [draft.start],
        ...(draft.sourceKind === "block" || draft.sourceId === "a" || draft.sourceId === "b"
          ? {}
          : { sourceKind: "library" as const, sourceId: "a" }),
      });
      return;
    }
    if (value === "url") {
      const schedules = eventSchedules(draft).map((item, index) =>
        index === 0
          ? {
              ...item,
              start: item.start || first,
              end: item.end || draft.end || addHour(first),
              times: [],
            }
          : { ...item, times: [] },
      );
      set({
        kind: "stream",
        start: first,
        times: [],
        end: draft.end || addHour(first),
        schedules,
        fadeSecs: draft.fadeSecs ?? 3,
      });
      return;
    }
    set({ kind: "insert", trackMode: "fixed", times: draft.times?.length ? draft.times : [draft.start] });
  };

  const setSourceKind = (sourceKind: StationEventSource) => {
    if (sourceKind === "block") {
      set({ sourceKind, sourceId: blocks[0]?.id ?? "" });
    } else {
      set({ sourceKind, sourceId: "a" });
    }
  };

  return (
    <div className="camp-editor">
      <div className="camp-editor-head">
        <button type="button" className="ghost-btn" onClick={onCancel}>
          ← Volver
        </button>
        <h4>{draft.name ? "Editar evento" : "Nuevo evento"}</h4>
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
              placeholder="Ej.: Mañana musical o Himno de la emisora"
              onChange={(e) => set({ name: e.target.value })}
            />
          </label>
          <label className="field camp-kind-field">
            <span className="field-label">Tipo</span>
            <select
              value={draft.kind === "auto" ? "auto" : "audio"}
              onChange={(e) => setType(e.target.value as "auto" | "audio")}
            >
              <option value="auto">Franja AutoDJ</option>
              <option value="audio">Evento de audio</option>
            </select>
          </label>
        </div>
        {draft.kind !== "auto" && (
          <label className="field">
            <span className="field-label">Fuente del audio</span>
            <select
              value={draft.kind === "stream" ? "url" : random ? "random" : "track"}
              onChange={(e) => setSource(e.target.value as "track" | "random" | "url")}
            >
              <option value="track">Pista de la biblioteca</option>
              <option value="random">Pista aleatoria</option>
              <option value="url">Audio de internet</option>
            </select>
          </label>
        )}
        <label className="check-field">
          <input
            type="checkbox"
            checked={draft.enabled}
            onChange={(e) => set({ enabled: e.target.checked })}
          />
          Evento activo
        </label>
      </fieldset>

      <fieldset className="fieldset">
        <legend>Programación</legend>
        <ScheduleEditor
          blocks={eventSchedules(draft)}
          onChange={(schedules) => set({ schedules })}
          mode={draft.kind === "stream" ? "stream" : "event"}
        />
        {draft.kind === "stream" && (
          <label className="field">
            <span className="field-label">Fundido de entrada y salida</span>
            <span className="field-unit">
              <input
                type="number"
                min={0}
                max={30}
                value={draft.fadeSecs ?? 3}
                onChange={(e) =>
                  set({ fadeSecs: Math.max(0, Math.min(30, Number(e.target.value) || 0)) })
                }
              />
              s
            </span>
          </label>
        )}

        {draft.kind === "stream" ? (
          <p className="hint">
            A la hora de inicio la música se funde y entra el audio de internet; a la hora de fin se funde y la lista
            sigue con la siguiente canción. Si la hora de fin es menor que la de inicio, termina al día siguiente.
          </p>
        ) : draft.kind === "auto" ? (
          <p className="hint">
            La franja se activa a cada uno de los horarios indicados y se mantiene hasta que
            empiece otro evento. Las próximas canciones que elija el AutoDJ saldrán de la fuente
            indicada; la cola que ya está cargada no se toca.
          </p>
        ) : (
          <>
            <div className="field-row">
              <label className="field">
                <span className="field-label">Espera máxima</span>
                <span className="field-unit">
                  <input
                    type="number"
                    min={0}
                    max={3600}
                    value={draft.maxWaitSecs}
                    onChange={(e) =>
                      set({
                        maxWaitSecs: Math.max(
                          0,
                          Math.min(3600, Number(e.target.value) || 0),
                        ),
                      })
                    }
                  />
                  s
                </span>
              </label>
              <label className="field">
                <span className="field-label">Si no llega a tiempo</span>
                <select
                  value={draft.onTimeout}
                  onChange={(e) =>
                    set({ onTimeout: e.target.value as StationEventTimeout })
                  }
                >
                  <option value="cancel">Cancelar y quitarlo de la lista</option>
                  <option value="force">Forzarlo al aire (corta el tema actual)</option>
                </select>
              </label>
            </div>
            <p className="hint">
              {random ? "Una pista elegida al azar" : "El sonido"} se coloca justo después del tema que esté sonando en cada una de las horas
              indicadas. Si el tema actual dura más que la espera, el evento se fuerza con el
              fundido de salida o se descarta.
            </p>
          </>
        )}
        <p className="hint">
          Si la app está cerrada a alguna de esas horas no se emite; al abrirla solo se recupera
          el horario más reciente si han pasado menos de 15 minutos.
        </p>
      </fieldset>

      {draft.kind === "auto" && (
        <fieldset className="fieldset">
          <legend>Fuente de la franja</legend>
          <div className="field-row">
            <label className="field">
              <span className="field-label">Tipo de fuente</span>
              <select
                value={draft.sourceKind}
                onChange={(e) => setSourceKind(e.target.value as StationEventSource)}
              >
                <option value="block" disabled={blocks.length === 0}>
                  Lista
                </option>
                <option value="library">Biblioteca completa</option>
              </select>
            </label>
            <label className="field">
              <span className="field-label">
                {draft.sourceKind === "block" ? "Lista" : "Biblioteca"}
              </span>
              {draft.sourceKind === "block" ? (
                <select
                  value={draft.sourceId}
                  onChange={(e) => set({ sourceId: e.target.value })}
                >
                  {blocks.length === 0 && <option value="">Sin listas</option>}
                  {blocks.map((block) => (
                    <option key={block.id} value={block.id}>
                      {block.name}
                    </option>
                  ))}
                </select>
              ) : (
                <select
                  value={draft.sourceId}
                  onChange={(e) => set({ sourceId: e.target.value })}
                >
                  <option value="a">Biblioteca A</option>
                  <option value="b">Biblioteca B</option>
                </select>
              )}
            </label>
          </div>
          <p className="hint">
            Si la fuente se queda sin canciones disponibles, el AutoDJ vuelve a la biblioteca
            completa para no dejar la lista sin gas.
          </p>
        </fieldset>
      )}

      {draft.kind === "insert" && random && (
        <RandomFields draft={draft} set={set} blocks={blocks} pool={pool} byId={byId} />
      )}

      {draft.kind === "insert" && !random && (
        <fieldset className="fieldset">
          <legend>Pista de la biblioteca</legend>
          <div className="camp-spots">
            {!selected && (
              <span className="hint">Elige una pista de la biblioteca o importa un audio.</span>
            )}
            {selected && (
              <div className="camp-spot">
                <span className="camp-spot-n">1</span>
                <span className="camp-spot-title">
                  {selected.title} <em>{selected.artist}</em>
                </span>
                <span className="camp-spot-dur">{fmtDur(effectiveDuration(selected))}</span>
                <button
                  type="button"
                  className="ghost-btn"
                  onClick={() => set({ trackId: "" })}
                >
                  Quitar
                </button>
              </div>
            )}
            <div className="camp-add-head">
              <select
                value={trackBlock}
                onChange={(e) => setTrackBlock(e.target.value)}
                title="Filtrar las pistas por lista"
                aria-label="Lista"
              >
                <option value="">Toda la biblioteca</option>
                {blocks.map((block) => (
                  <option key={block.id} value={block.id}>
                    {block.name}
                  </option>
                ))}
              </select>
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
          </div>
          <div className="camp-options">
            {options.map((track) => (
              <button
                key={track.id}
                type="button"
                className="camp-option"
                onClick={() => {
                  set({ trackId: track.id });
                  setSearch("");
                }}
              >
                <span className="camp-option-title">{track.title}</span>
                <span className="camp-option-artist">{track.artist}</span>
                <span className="camp-option-plus">+</span>
              </button>
            ))}
            {options.length === 0 && (
              <span className="hint">No hay más canciones que coincidan.</span>
            )}
          </div>
        </fieldset>
      )}

      {draft.kind === "insert" && (
        <MetaFields
          meta={{ ...EMPTY_STREAM_META, ...(draft.meta ?? {}) }}
          onChange={(meta) => set({ meta })}
          legend="Metadatos al emitirse"
        />
      )}

      {draft.kind === "stream" && (
        <StreamFields draft={draft} set={set} />
      )}

      {error && <div className="form-error">{error}</div>}

      <div className="edit-actions">
        <button type="button" className="ghost-btn" onClick={onCancel}>
          Cancelar
        </button>
        <span className="spacer" />
        <button type="button" className="btn btn-accent btn-sm" onClick={onSave}>
          Guardar evento
        </button>
      </div>
    </div>
  );
}

function RandomFields({
  draft,
  set,
  blocks,
  pool,
  byId,
}: {
  draft: StationEvent;
  set: (patch: Partial<StationEvent>) => void;
  blocks: Block[];
  pool: number;
  byId: Map<string, Track>;
}) {
  const num = (value: number | undefined, fallback: number) => (Number.isFinite(value) ? (value as number) : fallback);
  const source = draft.sourceKind === "block" ? `block:${draft.sourceId}` : `library:${draft.sourceId === "b" ? "b" : "a"}`;
  const recent = [...(draft.pickLog ?? [])].sort((a, b) => b.at - a.at).slice(0, 6);
  const rule = (
    key: "noRepeatSlotDays" | "noRepeatEventDays" | "noRepeatAirMins",
    label: string,
    unit: string,
    fallback: number,
    max: number,
    hint: string,
  ) => (
    <label className="field">
      <span className="field-label">{label}</span>
      <span className="field-unit">
        <input
          type="number"
          min={0}
          max={max}
          value={num(draft[key], fallback)}
          onChange={(e) => set({ [key]: Math.max(0, Math.min(max, Math.round(Number(e.target.value) || 0))) })}
        />
        {unit}
      </span>
      <span className="hint rule-hint">{hint}</span>
    </label>
  );
  return (
    <fieldset className="fieldset">
      <legend>Pista aleatoria</legend>
      <div className="field-row">
        <label className="field">
          <span className="field-label">Tomarla de</span>
          <select
            value={source}
            onChange={(e) => {
              const [kind, id] = e.target.value.split(":");
              set({ sourceKind: kind === "block" ? "block" : "library", sourceId: id });
            }}
          >
            <optgroup label="Biblioteca">
              <option value="library:a">Biblioteca A</option>
              <option value="library:b">Biblioteca B</option>
            </optgroup>
            {blocks.length > 0 && (
              <optgroup label="Lista">
                {blocks.map((block) => (
                  <option key={block.id} value={`block:${block.id}`}>
                    {block.name}
                  </option>
                ))}
              </optgroup>
            )}
            {draft.sourceKind === "block" && !blocks.some((b) => b.id === draft.sourceId) && (
              <option value={source}>Lista eliminada</option>
            )}
          </select>
        </label>
        <div className="field">
          <span className="field-label">Disponibles</span>
          <span className={`rule-count ${pool === 0 ? "rule-count-zero" : ""}`}>
            {pool} {pool === 1 ? "pista" : "pistas"}
          </span>
        </div>
      </div>

      <div className="field-row rules-row">
        {rule(
          "noRepeatSlotDays",
          "Misma hora",
          "días",
          DEFAULT_SLOT_DAYS,
          365,
          "No repetir la misma pista a esa hora durante tantos días (0 = sin regla).",
        )}
        {rule(
          "noRepeatEventDays",
          "En este evento",
          "días",
          DEFAULT_EVENT_DAYS,
          365,
          "No repetir la misma pista a ninguna hora de este evento.",
        )}
        {rule(
          "noRepeatAirMins",
          "Ya emitida",
          "min",
          DEFAULT_AIR_MINS,
          10080,
          "No elegir una pista que haya sonado en antena hace menos de esto.",
        )}
      </div>
      <p className="hint">
        Si la fuente tiene pocas pistas y no queda ninguna que cumpla las reglas, se van saltando de la última
        a la primera para que el evento siempre suene, y se avisa al lanzarlo.
      </p>

      {recent.length > 0 && (
        <div className="pick-log">
          <div className="pick-log-head">
            <span className="field-label">Últimas elegidas</span>
            <button type="button" className="ghost-btn" onClick={() => set({ pickLog: [] })}>
              Borrar historial
            </button>
          </div>
          {recent.map((e, i) => (
            <div className="pick-log-row" key={i}>
              <span>{new Date(e.at).toLocaleDateString([], { day: "2-digit", month: "2-digit" })}</span>
              <span>{e.slot}</span>
              <span className="pick-log-title">{byId.get(e.trackId)?.title ?? "Pista eliminada"}</span>
            </div>
          ))}
        </div>
      )}
    </fieldset>
  );
}

function StreamFields({ draft, set }: { draft: StationEvent; set: (patch: Partial<StationEvent>) => void }) {
  const meta = { ...EMPTY_META, ...(draft.meta ?? {}) };
  const setMeta = (patch: Partial<typeof meta>) => set({ meta: { ...meta, ...patch } });
  const field = (key: keyof typeof meta, label: string, placeholder = "") => (
    <label className="field" key={key}>
      <span className="field-label">{label}</span>
      <input type="text" value={meta[key]} placeholder={placeholder} maxLength={200} onChange={(e) => setMeta({ [key]: e.target.value })} />
    </label>
  );
  return (
    <>
      <fieldset className="fieldset">
        <legend>Audio de internet</legend>
        <label className="field">
          <span className="field-label">Dirección</span>
          <input
            type="text"
            value={draft.streamUrl ?? ""}
            placeholder="https://servidor/stream.mp3, …/playlist.m3u8 o la ruta de un archivo"
            spellCheck={false}
            onChange={(e) => set({ streamUrl: e.target.value })}
          />
        </label>
        <p className="hint">
          Vale cualquier cosa que abra FFmpeg: Icecast/Shoutcast, HLS (.m3u8), MP3/AAC por HTTP, RTMP o un archivo. Si
          la conexión se corta, se reintenta sola. Hace falta FFmpeg junto a MiRadio.
        </p>
      </fieldset>
      <fieldset className="fieldset">
        <legend>Lo que se muestra mientras suena</legend>
        <div className="stream-meta">
          <button
            type="button"
            className="stream-cover"
            title="Elegir la portada"
            onClick={() => void pickImageFile().then((p) => p && setMeta({ cover: p }))}
          >
            {meta.cover ? <img src={trackUrl({ file: meta.cover })} alt="" /> : <span>Elegir portada</span>}
          </button>
          <div className="stream-meta-fields">
            <div className="field-row">
              {field("title", "Título", "Nombre del programa")}
              {field("artist", "Artista", "Presentador o emisora")}
            </div>
            <div className="field-row">
              {field("album", "Álbum")}
              {field("year", "Año")}
              {field("genre", "Género")}
            </div>
            {field("comment", "Comentario")}
            {meta.cover && (
              <button type="button" className="ghost-btn" onClick={() => setMeta({ cover: "" })}>
                Quitar portada
              </button>
            )}
          </div>
        </div>
        <p className="hint">
          Se usan como los de una canción: zona «En emisión», archivos nowplaying, API, notificaciones y ventana de vídeo.
        </p>
      </fieldset>
    </>
  );
}
