import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DragEvent } from "react";
import { analyzeTrack, moveTracksBlock } from "../api";
import type { AnalysisResult, Block, Track } from "../types";
import { effectiveDuration } from "../types";
import { IconWave, IconX } from "../icons";
import type { SoundMixer } from "../mixer";
import { WindowControls } from "./WindowControls";
import { TrackEditor } from "./TrackEditor";
import { mediaRule, mediaTypeLabel, useMediaTypes } from "../mediaTypes";

type Mode = "folders" | "artists" | "blocks" | "genres" | "tags" | "types";
type Side = "a" | "b";

const MODES: { id: Mode; label: string }[] = [
  { id: "folders", label: "Carpetas" },
  { id: "artists", label: "Artistas" },
  { id: "blocks", label: "Listas" },
  { id: "genres", label: "Estilos" },
  { id: "tags", label: "Etiquetas" },
  { id: "types", label: "Tipos" },
];

const NO_FOLDER = "";

function fileDir(p: string): string {
  const s = p.replace(/\\/g, "/");
  const i = s.lastIndexOf("/");
  return i > 0 ? s.slice(0, i) : "";
}

function parentDir(p: string): string {
  const i = p.lastIndexOf("/");
  return i > 0 ? p.slice(0, i) : "";
}

function normDir(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

function matchesSearch(t: Track, q: string): boolean {
  if (!q) return true;
  const hay = [t.title, t.artist, t.album, t.genre, t.year, ...t.tags, t.file]
    .join(" ")
    .toLowerCase();
  return hay.includes(q);
}

function fmtTrim(secs: number): string {
  const m = Math.floor(secs / 60);
  const s = (secs % 60).toFixed(1).replace(".", ",");
  return `${m}:${s.padStart(4, "0")}`;
}

function fmtGain(v: number | null): string {
  if (v == null || !Number.isFinite(v)) return "—";
  const s = Math.abs(v).toFixed(1);
  return `${v >= 0 ? "+" : "-"}${s}`;
}

/** Lo que muestra una columna: si es una lista, se le pueden pasar canciones. */
export interface PaneView {
  blockId: string | null;
  label: string;
}

interface PaneProps {
  side: Side;
  tracks: Track[];
  blocks: Block[];
  /** Bloque que se abre al empezar (vacio = toda la musica) */
  initialBlock: string;
  onView: (side: Side, view: PaneView) => void;
  /** Lo que muestra la otra columna */
  other: PaneView;
  selected: Set<string>;
  onSelected: (next: Set<string>) => void;
  /** Pasar canciones a la columna `to` (a su bloque) */
  onMove: (ids: string[], to: Side) => void;
  onAnalyze: (ids: string[]) => void;
  onTrim: (id: string) => void;
  onPick: () => void;
  busy: boolean;
  errors: Map<string, string>;
  skipAnalyzed: boolean;
  onSkipAnalyzed: (skip: boolean) => void;
}

function Pane({
  side,
  tracks,
  blocks,
  initialBlock,
  onView,
  other,
  selected,
  onSelected,
  onMove,
  onAnalyze,
  onTrim,
  onPick,
  busy,
  errors,
  skipAnalyzed,
  onSkipAnalyzed,
}: PaneProps) {
  const [mode, setMode] = useState<Mode>("blocks");
  const [search, setSearch] = useState("");
  const [pick, setPick] = useState(initialBlock);
  const firstMode = useRef(true);
  const touched = useRef(false);
  const choose = (v: string) => {
    touched.current = true;
    setPick(v);
  };
  // Los bloques llegan despues del primer render: abrir el inicial al llegar.
  useEffect(() => {
    if (!touched.current && !pick && initialBlock) setPick(initialBlock);
  }, [initialBlock, pick]);

  useEffect(() => {
    if (firstMode.current) {
      firstMode.current = false;
      return;
    }
    setPick("");
  }, [mode]);

  // Que ve esta columna (para el titulo y para poder pasarle canciones).
  const view: PaneView = useMemo(() => {
    if (mode === "blocks" && pick && pick !== "__none__") {
      const b = blocks.find((x) => x.id === pick);
      if (b) return { blockId: b.id, label: b.name };
    }
    if (!pick) return { blockId: null, label: "Toda la música" };
    if (mode === "blocks") return { blockId: null, label: "Sin lista" };
    if (mode === "folders") return { blockId: null, label: pick.split("/").pop() || pick };
    return { blockId: null, label: pick };
  }, [mode, pick, blocks]);
  useEffect(() => onView(side, view), [side, view, onView]);

  const q = search.trim().toLowerCase();

  const base = useMemo(() => {
    if (!pick) return tracks;
    if (mode === "folders") {
      const key = normDir(pick);
      return tracks.filter((t) => {
        if (!key) return true;
        const f = t.file.replace(/\\/g, "/").toLowerCase();
        return f.startsWith(`${key}/`);
      });
    }
    if (mode === "blocks") {
      if (pick === "__none__") return tracks.filter((t) => t.blocks.length === 0);
      return tracks.filter((t) => t.blocks.includes(pick));
    }
    if (mode === "artists") {
      return tracks.filter((t) => (t.artist.trim() || "Artista desconocido") === pick);
    }
    if (mode === "genres") {
      return tracks.filter((t) => (t.genre.trim() || "Sin estilo") === pick);
    }
    if (mode === "types") {
      const id = pick === "__music__" ? "" : pick;
      return tracks.filter((t) => (t.mediaType ?? "") === id);
    }
    return tracks.filter((t) => t.tags.includes(pick));
  }, [tracks, mode, pick]);

  const visible = useMemo(() => {
    const list = base.filter((t) => matchesSearch(t, q));
    return list.sort((a, b) =>
      (a.title || "").localeCompare(b.title || "", "es", { sensitivity: "base" }),
    );
  }, [base, q]);

  const folders = useMemo(() => {
    const map = new Map<string, { path: string; count: number }>();
    for (const t of tracks) {
      let dir = fileDir(t.file);
      if (!dir) continue;
      while (dir) {
        const key = normDir(dir);
        if (!key) break;
        const cur = map.get(key);
        if (cur) cur.count += 1;
        else map.set(key, { path: dir, count: 1 });
        const up = parentDir(dir);
        if (up === dir) break;
        dir = up;
      }
    }
    return Array.from(map.entries())
      .map(([key, v]) => ({ key, path: v.path, count: v.count }))
      .sort((a, b) => a.path.localeCompare(b.path, "es", { sensitivity: "base" }));
  }, [tracks]);

  const artists = useMemo(() => {
    const map = new Map<string, number>();
    for (const t of tracks) {
      const name = t.artist.trim() || "Artista desconocido";
      map.set(name, (map.get(name) ?? 0) + 1);
    }
    return Array.from(map.entries()).sort((a, b) => a[0].localeCompare(b[0], "es"));
  }, [tracks]);

  const genres = useMemo(() => {
    const map = new Map<string, number>();
    for (const t of tracks) {
      const name = t.genre.trim() || "Sin estilo";
      map.set(name, (map.get(name) ?? 0) + 1);
    }
    return Array.from(map.entries()).sort((a, b) => a[0].localeCompare(b[0], "es"));
  }, [tracks]);

  const mtypes = useMediaTypes();
  const typeCounts = useMemo(() => {
    const map = new Map<string, number>();
    for (const t of tracks) map.set(t.mediaType ?? "", (map.get(t.mediaType ?? "") ?? 0) + 1);
    return map;
  }, [tracks]);

  const tags = useMemo(() => {
    const map = new Map<string, number>();
    for (const t of tracks) for (const tag of t.tags) map.set(tag, (map.get(tag) ?? 0) + 1);
    return Array.from(map.entries()).sort((a, b) => a[0].localeCompare(b[0], "es"));
  }, [tracks]);

  const blockCounts = useMemo(() => {
    const map = new Map<string, number>();
    for (const t of tracks) for (const id of t.blocks) map.set(id, (map.get(id) ?? 0) + 1);
    return map;
  }, [tracks]);

  const allVisibleSelected = visible.length > 0 && visible.every((t) => selected.has(t.id));

  const toggle = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onSelected(next);
  };

  const toggleAll = () => {
    const next = new Set(selected);
    if (allVisibleSelected) for (const t of visible) next.delete(t.id);
    else for (const t of visible) next.add(t.id);
    onSelected(next);
  };

  const dragStart = (e: DragEvent, id: string) => {
    const ids = selected.has(id) ? Array.from(selected) : [id];
    e.dataTransfer.setData("text/miradio-ids", JSON.stringify({ from: side, ids }));
    e.dataTransfer.effectAllowed = "copyMove";
  };

  const drop = (e: DragEvent) => {
    e.preventDefault();
    try {
      const data = JSON.parse(e.dataTransfer.getData("text/miradio-ids")) as { from: Side; ids: string[] };
      if (data.from !== side && Array.isArray(data.ids) && data.ids.length > 0) onMove(data.ids, side);
    } catch {
      /* sin datos */
    }
  };

  const sidebarRows = () => {
    if (mode === "folders") {
      return (
        <>
          <button
            type="button"
            className={`nside-item ${pick === NO_FOLDER ? "nside-on" : ""}`}
            onClick={() => choose(NO_FOLDER)}
          >
            <span className="nside-name">Todas las carpetas</span>
            <span className="nside-count">{tracks.length}</span>
          </button>
          {folders.map((f) => {
            const depth = Math.max(0, f.path.split("/").length - 2);
            return (
              <button
                key={f.key}
                type="button"
                className={`nside-item ${pick === f.path ? "nside-on" : ""}`}
                style={{ paddingLeft: 8 + Math.min(5, depth) * 9 }}
                title={f.path}
                onClick={() => choose(f.path)}
              >
                <span className="nside-name">{f.path.split("/").pop() || f.path}</span>
                <span className="nside-count">{f.count}</span>
              </button>
            );
          })}
        </>
      );
    }
    if (mode === "artists") {
      return artists.map(([name, count]) => (
        <button
          key={name}
          type="button"
          className={`nside-item ${pick === name ? "nside-on" : ""}`}
          title={name}
          onClick={() => choose(name)}
        >
          <span className="nside-name">{name}</span>
          <span className="nside-count">{count}</span>
        </button>
      ));
    }
    if (mode === "genres") {
      return genres.map(([name, count]) => (
        <button
          key={name}
          type="button"
          className={`nside-item ${pick === name ? "nside-on" : ""}`}
          title={name}
          onClick={() => choose(name)}
        >
          <span className="nside-name">{name}</span>
          <span className="nside-count">{count}</span>
        </button>
      ));
    }
    if (mode === "types") {
      return mtypes.map((m) => {
        const key = m.id || "__music__";
        return (
          <button
            key={key}
            type="button"
            className={`nside-item ${pick === key ? "nside-on" : ""}`}
            onClick={() => choose(key)}
          >
            <span className="nside-name">
              <span className="ntype-dot" style={{ background: m.color }} /> {m.label}
            </span>
            <span className="nside-count">{typeCounts.get(m.id) ?? 0}</span>
          </button>
        );
      });
    }
    if (mode === "tags") {
      if (tags.length === 0) return <span className="side-hint">Sin etiquetas todavía.</span>;
      return tags.map(([name, count]) => (
        <button
          key={name}
          type="button"
          className={`nside-item ${pick === name ? "nside-on" : ""}`}
          title={name}
          onClick={() => choose(name)}
        >
          <span className="nside-name">{name}</span>
          <span className="nside-count">{count}</span>
        </button>
      ));
    }
    const none = tracks.filter((t) => t.blocks.length === 0).length;
    return (
      <>
        <button
          type="button"
          className={`nside-item ${pick === NO_FOLDER ? "nside-on" : ""}`}
          onClick={() => choose(NO_FOLDER)}
        >
          <span className="nside-name">Todas las listas</span>
          <span className="nside-count">{tracks.length}</span>
        </button>
        {blocks.map((b) => (
          <button
            key={b.id}
            type="button"
            className={`nside-item ${pick === b.id ? "nside-on" : ""}`}
            title={b.name}
            onClick={() => choose(b.id)}
          >
            <span className="nside-name">{b.name}</span>
            <span className="nside-count">{blockCounts.get(b.id) ?? 0}</span>
          </button>
        ))}
        <button
          type="button"
          className={`nside-item ${pick === "__none__" ? "nside-on" : ""}`}
          onClick={() => choose("__none__")}
        >
          <span className="nside-name">Sin lista</span>
          <span className="nside-count">{none}</span>
        </button>
      </>
    );
  };

  const title = view.blockId ? `Lista «${view.label}»` : view.label;

  return (
    <section className="npane" onDragOver={(e) => e.preventDefault()} onDrop={drop}>
      <div className="npane-head">
        <strong title={title}>{title}</strong>
        <span className="npane-count">{visible.length} canciones</span>
        <button type="button" className="btn btn-sm" disabled={busy} onClick={() => onPick()}>
          Importar
        </button>
      </div>

      <div className="ntabs">
        {MODES.map((m) => (
          <button
            key={m.id}
            type="button"
            className={`ntab ${mode === m.id ? "ntab-on" : ""}`}
            onClick={() => {
              touched.current = true;
              setMode(m.id);
            }}
          >
            {m.label}
          </button>
        ))}
      </div>

      <div className="npane-tools">
        <input
          className="nsearch"
          placeholder="Filtrar por título, artista, etiqueta…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <button
          type="button"
          className="btn btn-sm"
          disabled={busy || visible.length === 0}
          onClick={() => onAnalyze(visible.map((t) => t.id))}
          title="Analizar todas las canciones visibles con el objetivo actual"
        >
          Analizar visibles
        </button>
      </div>

      <div className="npane-body">
        <div className="nside">{sidebarRows()}</div>

        <div className="nlist-wrap">
          <div className="ncols">
            <input
              type="checkbox"
              checked={allVisibleSelected}
              onChange={toggleAll}
              aria-label="Seleccionar visibles"
            />
            <span>Canción</span>
            <span className="nright">LUFS</span>
            <span className="nright">Ganancia</span>
            <span />
          </div>
          <div className="nrows">
            {visible.map((t) => {
              const err = errors.get(t.id);
              const isSel = selected.has(t.id);
              const trimmed = t.trimStart > 0.05 || t.trimEnd != null;
              return (
                <div
                  key={t.id}
                  className={`nrow ${isSel ? "nrow-sel" : ""} ${t.missing ? "nrow-missing" : ""} ${
                    err ? "nrow-error" : ""
                  }`}
                  draggable={!t.missing}
                  onDragStart={(e) => dragStart(e, t.id)}
                  onClick={() => toggle(t.id)}
                  title={
                    err
                      ? `Error: ${err}`
                      : `${t.title}${trimmed ? ` · recorte ${fmtTrim(t.trimStart)}–${fmtTrim(t.trimEnd ?? t.durationSecs)}` : ""}${t.limited ? " · limitada por pico" : ""}`
                  }
                >
                  <input type="checkbox" checked={isSel} readOnly tabIndex={-1} />
                  <div className="nrow-main">
                    <span className="nrow-title">{t.title || t.originalName || "Sin título"}</span>
                    <span className="nrow-sub">
                      {t.mediaType ? (
                        <span
                          className="ntype-chip"
                          style={{ color: mediaRule(t.mediaType).color, background: `${mediaRule(t.mediaType).color}22` }}
                        >
                          {mediaTypeLabel(t.mediaType)}
                        </span>
                      ) : (t.energy ?? 0) > 0 ? (
                        <span className="energy-dots ntype-energy" title={`Energía ${t.energy} de 5`}>
                          {"●".repeat(t.energy!)}
                          <span className="off">{"●".repeat(5 - t.energy!)}</span>
                        </span>
                      ) : null}
                      {t.artist || "Artista desconocido"}
                      {t.missing && <em> · archivo no disponible</em>}
                      {t.trimManual && <em> · recorte manual</em>}
                    </span>
                  </div>
                  <span
                    className={`nlufs ${
                      t.limited ? "nlufs-limited" : t.lufs == null ? "nlufs-none" : ""
                    }`}
                  >
                    {t.lufs == null ? "—" : t.lufs.toFixed(1)}
                  </span>
                  <span className={`ngain ${t.gainDb == null ? "ngain-none" : ""}`}>
                    {fmtGain(t.gainDb)}
                  </span>
                  <button
                    type="button"
                    className="nact"
                    title="Marcadores (inicio, final, intro, mix y fade)"
                    onClick={(e) => {
                      e.stopPropagation();
                      onTrim(t.id);
                    }}
                  >
                    <IconWave size={13} />
                  </button>
                </div>
              );
            })}
            {visible.length === 0 && (
              <span className="empty-note">
                {tracks.length === 0
                  ? "La biblioteca está vacía. Importa canciones o arrástralas desde el explorador."
                  : view.blockId
                    ? "Esta lista está vacía. Pasa canciones desde la otra columna."
                    : "Ninguna canción coincide con el filtro."}
              </span>
            )}
          </div>
        </div>
      </div>

      <div className="npane-foot">
        <span className="side-hint">
          {selected.size > 0
            ? `${selected.size} seleccionadas`
            : `${visible.length} visibles · ${effectiveDurationLabel(visible)}`}
        </span>
        <label
          className="nskip"
          title="No volver a analizar canciones que ya tengan un análisis previo"
        >
          <input
            type="checkbox"
            checked={skipAnalyzed}
            disabled={busy}
            onChange={(e) => onSkipAnalyzed(e.target.checked)}
          />
          Omitir ya analizadas
        </label>
        <button
          type="button"
          className="btn btn-sm"
          disabled={busy || selected.size === 0}
          onClick={() => onAnalyze(Array.from(selected))}
        >
          Analizar selección
        </button>
        <button
          type="button"
          className="btn btn-sm"
          disabled={busy || selected.size === 0 || !other.blockId}
          title={other.blockId ? undefined : "Elige una lista en la otra columna"}
          onClick={() => onMove(Array.from(selected), side === "a" ? "b" : "a")}
        >
          {side === "a" ? `Pasar a «${other.blockId ? other.label : "…"}» →` : `← Pasar a «${other.blockId ? other.label : "…"}»`}
        </button>
      </div>
    </section>
  );
}

function effectiveDurationLabel(tracks: Track[]): string {
  const total = tracks.reduce((acc, t) => acc + effectiveDuration(t), 0);
  const h = Math.floor(total / 3600);
  const m = Math.round((total % 3600) / 60);
  return h > 0 ? `${h} h ${m} min` : `${m} min`;
}

interface RunningState {
  total: number;
  done: number;
  errors: number;
  label: string;
}

interface NormalizerProps {
  tracks: Track[];
  blocks: Block[];
  targetLufs: number;
  truePeakDb: number;
  hidden: boolean;
  onHide: () => void;
  onStatus: (status: NormalizerStatus | null) => void;
  apiRef: { current: NormalizerApi | null };
  onRefresh: () => Promise<void>;
  onPick: () => void;
  onTarget: (lufs: number, peak: number) => void;
  showToast: (msg: string) => void;
  mixer: PreviewPlayer | null;
  /** En su propia ventana: la cabecera hace de barra de titulo */
  windowed?: boolean;
}

/** Lo que el normalizador necesita para el cue. */
export type PreviewPlayer = Pick<SoundMixer, "playPreview" | "stopPreview">;

export interface NormalizerStatus {
  total: number;
  done: number;
  errors: number;
  label: string;
  paused: boolean;
}

export interface NormalizerApi {
  pause: () => void;
  resume: () => void;
  cancel: () => void;
}

export function Normalizer({
  tracks,
  blocks,
  targetLufs,
  truePeakDb,
  hidden,
  onHide,
  onStatus,
  apiRef,
  onRefresh,
  onPick,
  onTarget,
  showToast,
  mixer,
  windowed = false,
}: NormalizerProps) {
  const [all, setAll] = useState<Track[]>(tracks);
  const [selA, setSelA] = useState<Set<string>>(new Set());
  const [selB, setSelB] = useState<Set<string>>(new Set());
  const [errors, setErrors] = useState<Map<string, string>>(new Map());
  const [running, setRunning] = useState<RunningState | null>(null);
  const [paused, setPaused] = useState(false);
  const [skipAnalyzed, setSkipAnalyzed] = useState(false);
  const [trimId, setTrimId] = useState("");
  const [target, setTarget] = useState(String(targetLufs));
  const [peak, setPeak] = useState(String(truePeakDb));
  const cancelRef = useRef(false);
  const pausedRef = useRef(false);
  const busyRef = useRef(false);

  useEffect(() => setAll(tracks), [tracks]);
  useEffect(() => setTarget(String(targetLufs)), [targetLufs]);
  useEffect(() => setPeak(String(truePeakDb)), [truePeakDb]);

  useEffect(() => {
    apiRef.current = {
      pause: () => {
        if (!busyRef.current) return;
        pausedRef.current = true;
        setPaused(true);
      },
      resume: () => {
        pausedRef.current = false;
        setPaused(false);
      },
      cancel: () => {
        cancelRef.current = true;
        pausedRef.current = false;
        setPaused(false);
      },
    };
    return () => {
      apiRef.current = null;
    };
  }, [apiRef]);

  useEffect(() => {
    onStatus(running ? { ...running, paused } : null);
  }, [running, paused, onStatus]);

  useEffect(() => {
    return () => onStatus(null);
  }, [onStatus]);

  const trimTrack = useMemo(() => all.find((t) => t.id === trimId) ?? null, [all, trimId]);

  const commitTarget = () => {
    const lufs = Math.max(-40, Math.min(-5, Number(target.replace(",", ".")) || -9));
    const tp = Math.max(-6, Math.min(0, Number(peak.replace(",", ".")) || -1));
    setTarget(String(lufs));
    setPeak(String(tp));
    if (lufs !== targetLufs || tp !== truePeakDb) onTarget(lufs, tp);
  };

  // Cada columna muestra lo que elijas; pasar canciones = meterlas en el
  // bloque de la otra columna (moviendo o copiando).
  const [views, setViews] = useState<Record<Side, PaneView>>({
    a: { blockId: null, label: "Toda la música" },
    b: { blockId: null, label: "Toda la música" },
  });
  const onView = useCallback((side: Side, v: PaneView) => {
    setViews((prev) =>
      prev[side].blockId === v.blockId && prev[side].label === v.label ? prev : { ...prev, [side]: v },
    );
  }, []);
  const [transfer, setTransfer] = useState<"move" | "copy">("move");

  const move = async (ids: string[], to: Side) => {
    const target = views[to].blockId;
    if (!target) {
      showToast("Elige una lista en la columna de destino para pasarle canciones");
      return;
    }
    const from = views[to === "a" ? "b" : "a"].blockId;
    const remove = transfer === "move" && from ? from : null;
    const valid = ids.filter((id) => all.some((t) => t.id === id));
    if (valid.length === 0) return;
    try {
      const count = await moveTracksBlock(valid, target, remove);
      const set = new Set(valid);
      setAll((prev) =>
        prev.map((t) =>
          set.has(t.id)
            ? { ...t, blocks: [...t.blocks.filter((b) => b !== remove && b !== target), target] }
            : t,
        ),
      );
      if (to === "b") setSelA(new Set());
      else setSelB(new Set());
      const verb = remove ? (count === 1 ? "movida" : "movidas") : count === 1 ? "copiada" : "copiadas";
      showToast(
        count === 0
          ? `Ya estaban en «${views[to].label}»`
          : `${count} ${count === 1 ? "canción" : "canciones"} ${verb} a «${views[to].label}»`,
      );
      void onRefresh();
    } catch (e) {
      showToast(`No se pudieron pasar: ${String(e)}`);
    }
  };

  const run = async (ids: string[]) => {
    if (running || busyRef.current) return;
    busyRef.current = true;
    const wanted = Array.from(new Set(ids));
    const available = wanted.filter((id) => {
      const t = all.find((x) => x.id === id);
      return t && !t.missing;
    });
    const skipped = skipAnalyzed
      ? available.filter((id) => {
          const t = all.find((x) => x.id === id);
          return t != null && t.analyzedAt > 0;
        }).length
      : 0;
    const valid = skipAnalyzed
      ? available.filter((id) => {
          const t = all.find((x) => x.id === id);
          return t != null && t.analyzedAt <= 0;
        })
      : available;
    if (valid.length === 0) {
      busyRef.current = false;
      showToast(
        skipped > 0
          ? skipped === 1
            ? "La canción seleccionada ya estaba analizada"
            : `Las ${skipped} canciones seleccionadas ya estaban analizadas`
          : "Selecciona canciones con archivo disponible",
      );
      return;
    }
    const goal = Math.max(-40, Math.min(-5, Number(target.replace(",", ".")) || targetLufs));
    const ceiling = Math.max(-6, Math.min(0, Number(peak.replace(",", ".")) || truePeakDb));
    cancelRef.current = false;
    pausedRef.current = false;
    setPaused(false);
    setErrors(new Map());
    let failed = 0;
    setRunning({ total: valid.length, done: 0, errors: 0, label: "" });
    for (let i = 0; i < valid.length; i++) {
      while (pausedRef.current && !cancelRef.current) {
        await new Promise((resolve) => window.setTimeout(resolve, 150));
      }
      if (cancelRef.current) break;
      const id = valid[i];
      const t = all.find((x) => x.id === id);
      setRunning({ total: valid.length, done: i, errors: failed, label: t?.title ?? "" });
      try {
        const res: AnalysisResult = await analyzeTrack(id, goal, ceiling);
        setAll((prev) => prev.map((x) => (x.id === id ? { ...x, ...res } : x)));
      } catch (e) {
        failed += 1;
        setErrors((prev) => {
          const next = new Map(prev);
          next.set(id, String(e));
          return next;
        });
      }
      setRunning({ total: valid.length, done: i + 1, errors: failed, label: t?.title ?? "" });
    }
    const cancelled = cancelRef.current;
    const skippedNote =
      skipped > 0 ? ` · ${skipped} ${skipped === 1 ? "omitida" : "omitidas"}` : "";
    busyRef.current = false;
    pausedRef.current = false;
    setPaused(false);
    setRunning(null);
    void onRefresh();
    showToast(
      (cancelled
        ? `Análisis detenido: ${valid.length - failed} completadas`
        : failed > 0
          ? `Análisis terminado: ${valid.length - failed} correctas, ${failed} con error`
          : `${valid.length} canciones analizadas`) + skippedNote,
    );
  };

  const applySavedTrim = (t: Track) => {
    setAll((prev) => prev.map((x) => (x.id === t.id ? t : x)));
    void onRefresh();
  };

  return (
    <div className={`norm-overlay ${hidden ? "norm-hidden" : ""}`} aria-hidden={hidden}>
      <header className="norm-head" data-tauri-drag-region={windowed || undefined}>
        <div className="norm-brand" data-tauri-drag-region={windowed || undefined}>
          <IconWave size={20} />
          <div>
            <strong>Normalizador de bibliotecas</strong>
            <span>Ganancia no destructiva · auto-cue de silencios</span>
          </div>
        </div>

        <div className="norm-goal">
          <label>
            Objetivo
            <input
              type="number"
              step="0.5"
              min={-40}
              max={-5}
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              onBlur={commitTarget}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitTarget();
              }}
            />
            <span>LUFS</span>
          </label>
          <label>
            Techo de pico
            <input
              type="number"
              step="0.5"
              min={-6}
              max={0}
              value={peak}
              onChange={(e) => setPeak(e.target.value)}
              onBlur={commitTarget}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitTarget();
              }}
            />
            <span>dBTP</span>
          </label>
          <span className="norm-hint">
            La ganancia se calcula al analizar: si cambias el objetivo, vuelve a analizar. Si el pico
            supera el techo, se recorta y la pista queda marcada como limitada.
          </span>
        </div>

        <button
          type="button"
          className="btn btn-sm"
          disabled={running !== null}
          onClick={() => void run([...selA, ...selB])}
          title="Analizar las canciones seleccionadas en A y B"
        >
          Analizar selección ({selA.size + selB.size})
        </button>
        <label
          className="nskip norm-skip"
          title="No volver a analizar canciones que ya tengan un análisis previo"
        >
          <input
            type="checkbox"
            checked={skipAnalyzed}
            disabled={running !== null}
            onChange={(e) => setSkipAnalyzed(e.target.checked)}
          />
          Omitir ya analizadas
        </label>
        {running && (
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => (paused ? apiRef.current?.resume() : apiRef.current?.pause())}
          >
            {paused ? "Reanudar" : "Pausar"}
          </button>
        )}
        {windowed ? (
          <>
            <div className="top-drag" data-tauri-drag-region />
            <WindowControls />
          </>
        ) : (
          <button
            type="button"
            className="ghost-btn"
            onClick={onHide}
            title="Ocultar la librería; el análisis sigue en segundo plano"
          >
            <IconX size={18} />
          </button>
        )}
      </header>

      <div className="norm-body">
        <Pane
          side="a"
          tracks={all}
          blocks={blocks}
          initialBlock={blocks[0]?.id ?? ""}
          onView={onView}
          other={views.b}
          selected={selA}
          onSelected={setSelA}
          onMove={(ids, to) => void move(ids, to)}
          onAnalyze={(ids) => void run(ids)}
          onTrim={setTrimId}
          onPick={onPick}
          busy={running !== null}
          errors={errors}
          skipAnalyzed={skipAnalyzed}
          onSkipAnalyzed={setSkipAnalyzed}
        />

        <div className="norm-move">
          <button
            type="button"
            className="nmove-btn"
            disabled={running !== null || selA.size === 0 || !views.b.blockId}
            onClick={() => void move(Array.from(selA), "b")}
            title={views.b.blockId ? `Pasar la selección a «${views.b.label}»` : "Elige una lista a la derecha"}
          >
            →
          </button>
          <button
            type="button"
            className="nmove-btn"
            disabled={running !== null || selB.size === 0 || !views.a.blockId}
            onClick={() => void move(Array.from(selB), "a")}
            title={views.a.blockId ? `Pasar la selección a «${views.a.label}»` : "Elige una lista a la izquierda"}
          >
            ←
          </button>
          <div className="nmove-mode" role="radiogroup" aria-label="Al pasar canciones">
            <button
              type="button"
              role="radio"
              aria-checked={transfer === "move"}
              className={transfer === "move" ? "on" : ""}
              onClick={() => setTransfer("move")}
              title="Salen de la lista de origen y entran en el de destino"
            >
              Mover
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={transfer === "copy"}
              className={transfer === "copy" ? "on" : ""}
              onClick={() => setTransfer("copy")}
              title="Quedan en los dos listas"
            >
              Copiar
            </button>
          </div>
          <span className="nmove-hint">Arrastra<br />entre<br />columnas</span>
        </div>

        <Pane
          side="b"
          tracks={all}
          blocks={blocks}
          initialBlock={blocks[1]?.id ?? ""}
          onView={onView}
          other={views.a}
          selected={selB}
          onSelected={setSelB}
          onMove={(ids, to) => void move(ids, to)}
          onAnalyze={(ids) => void run(ids)}
          onTrim={setTrimId}
          onPick={onPick}
          busy={running !== null}
          errors={errors}
          skipAnalyzed={skipAnalyzed}
          onSkipAnalyzed={setSkipAnalyzed}
        />
      </div>

      {running && (
        <div className="norm-progress">
          <div className="norm-bar">
            <span style={{ width: `${(running.done / Math.max(1, running.total)) * 100}%` }} />
          </div>
          <span className="norm-progress-txt">
            {paused ? "En pausa · " : ""}
            {running.done}/{running.total}
            {running.errors > 0 ? ` · ${running.errors} con error` : ""}
            {running.label ? ` · ${running.label}` : ""}
          </span>
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => (paused ? apiRef.current?.resume() : apiRef.current?.pause())}
          >
            {paused ? "Reanudar" : "Pausar"}
          </button>
          <button type="button" className="ghost-btn" onClick={() => apiRef.current?.cancel()}>
            Cancelar
          </button>
        </div>
      )}

      <div className="norm-foot">
        <span>
          {all.length} canciones en la biblioteca. Pasar canciones entre bloques no mueve ni borra
          archivos.
        </span>
        <span>Cada columna muestra lo que elijas: una lista, una carpeta, un estilo…</span>
      </div>

      {trimTrack && (
        <TrackEditor
          track={trimTrack}
          mixer={mixer}
          onClose={() => setTrimId("")}
          onSaved={applySavedTrim}
          showToast={showToast}
        />
      )}
    </div>
  );
}
