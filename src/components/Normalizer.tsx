import { useEffect, useMemo, useRef, useState } from "react";
import type { DragEvent, PointerEvent as ReactPointerEvent } from "react";
import {
  analyzeTrack,
  autoTrackTrim,
  getTrackWaveform,
  saveTrackTrim,
  trackUrl,
} from "../api";
import type { AnalysisResult, Block, Track, Waveform } from "../types";
import { effectiveDuration } from "../types";
import { IconWave, IconX } from "../icons";

type Mode = "folders" | "artists" | "blocks" | "genres" | "tags";
type Side = "a" | "b";

const MODES: { id: Mode; label: string }[] = [
  { id: "folders", label: "Carpetas" },
  { id: "artists", label: "Artistas" },
  { id: "blocks", label: "Bloques" },
  { id: "genres", label: "Estilos" },
  { id: "tags", label: "Etiquetas" },
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

function fmtTime(secs: number): string {
  if (!Number.isFinite(secs) || secs < 0) return "0:00";
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
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

interface PaneProps {
  side: Side;
  tracks: Track[];
  blocks: Block[];
  selected: Set<string>;
  onSelected: (next: Set<string>) => void;
  onMove: (ids: string[], to: Side) => void;
  onAnalyze: (ids: string[]) => void;
  onTrim: (id: string) => void;
  onPick: (side: Side) => void;
  busy: boolean;
  errors: Map<string, string>;
}

function Pane({
  side,
  tracks,
  blocks,
  selected,
  onSelected,
  onMove,
  onAnalyze,
  onTrim,
  onPick,
  busy,
  errors,
}: PaneProps) {
  const [mode, setMode] = useState<Mode>("folders");
  const [search, setSearch] = useState("");
  const [pick, setPick] = useState("");

  useEffect(() => setPick(""), [mode]);

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
    e.dataTransfer.setData("text/miradio-ids", JSON.stringify(ids));
    e.dataTransfer.effectAllowed = "move";
  };

  const drop = (e: DragEvent) => {
    e.preventDefault();
    try {
      const ids = JSON.parse(e.dataTransfer.getData("text/miradio-ids")) as string[];
      if (Array.isArray(ids) && ids.length > 0) onMove(ids, side);
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
            onClick={() => setPick(NO_FOLDER)}
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
                onClick={() => setPick(f.path)}
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
          onClick={() => setPick(name)}
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
          onClick={() => setPick(name)}
        >
          <span className="nside-name">{name}</span>
          <span className="nside-count">{count}</span>
        </button>
      ));
    }
    if (mode === "tags") {
      if (tags.length === 0) return <span className="side-hint">Sin etiquetas todavía.</span>;
      return tags.map(([name, count]) => (
        <button
          key={name}
          type="button"
          className={`nside-item ${pick === name ? "nside-on" : ""}`}
          title={name}
          onClick={() => setPick(name)}
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
          onClick={() => setPick(NO_FOLDER)}
        >
          <span className="nside-name">Todos los bloques</span>
          <span className="nside-count">{tracks.length}</span>
        </button>
        {blocks.map((b) => (
          <button
            key={b.id}
            type="button"
            className={`nside-item ${pick === b.id ? "nside-on" : ""}`}
            title={b.name}
            onClick={() => setPick(b.id)}
          >
            <span className="nside-name">{b.name}</span>
            <span className="nside-count">{blockCounts.get(b.id) ?? 0}</span>
          </button>
        ))}
        <button
          type="button"
          className={`nside-item ${pick === "__none__" ? "nside-on" : ""}`}
          onClick={() => setPick("__none__")}
        >
          <span className="nside-name">Sin bloque</span>
          <span className="nside-count">{none}</span>
        </button>
      </>
    );
  };

  const title = side === "a" ? "Biblioteca A" : "Biblioteca B";

  return (
    <section className="npane" onDragOver={(e) => e.preventDefault()} onDrop={drop}>
      <div className="npane-head">
        <strong>{title}</strong>
        <span className="npane-count">{tracks.length} canciones</span>
        <button type="button" className="btn btn-sm" disabled={busy} onClick={() => onPick(side)}>
          Importar
        </button>
      </div>

      <div className="ntabs">
        {MODES.map((m) => (
          <button
            key={m.id}
            type="button"
            className={`ntab ${mode === m.id ? "ntab-on" : ""}`}
            onClick={() => setMode(m.id)}
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
                    title="Ajustar inicio y final"
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
                  ? "Esta biblioteca está vacía. Importa canciones o arrástralas desde el explorador."
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
        <button
          type="button"
          className="btn btn-sm"
          disabled={busy || selected.size === 0}
          onClick={() => onAnalyze(Array.from(selected))}
        >
          Analizar selección
        </button>
        <button type="button" className="btn btn-sm" disabled={busy} onClick={() => onMove(Array.from(selected), side === "a" ? "b" : "a")}>
          {side === "a" ? "Pasar a B →" : "← Pasar a A"}
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

interface TrimEditorProps {
  track: Track;
  onClose: () => void;
  onSaved: (track: Track) => void;
  showToast: (msg: string) => void;
}

function TrimEditor({ track, onClose, onSaved, showToast }: TrimEditorProps) {
  const [wave, setWave] = useState<Waveform | null>(null);
  const [error, setError] = useState("");
  const [start, setStart] = useState(track.trimStart);
  const [end, setEnd] = useState(track.trimEnd ?? track.durationSecs);
  const [drag, setDrag] = useState<"start" | "end" | null>(null);
  const [saving, setSaving] = useState(false);
  const [playPos, setPlayPos] = useState(-1);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const endRef = useRef(end);
  const startRef = useRef(start);
  endRef.current = end;
  startRef.current = start;

  useEffect(() => {
    let alive = true;
    setWave(null);
    setError("");
    void getTrackWaveform(track.id, 900)
      .then((w) => {
        if (!alive) return;
        setWave(w);
        const s = Math.min(track.trimStart, Math.max(0, w.durationSecs - 0.3));
        const e = Math.min(w.durationSecs, track.trimEnd ?? w.durationSecs);
        setStart(s);
        setEnd(Math.max(s + 0.3, e));
      })
      .catch((e) => {
        if (alive) setError(String(e));
      });
    return () => {
      alive = false;
    };
  }, [track.id]);

  useEffect(() => {
    return () => {
      audioRef.current?.pause();
      audioRef.current = null;
    };
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !wave) return;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    canvas.width = Math.max(1, Math.round(w * dpr));
    canvas.height = Math.max(1, Math.round(h * dpr));
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const mid = h / 2;
    const dur = wave.durationSecs || 1;
    const xOf = (secs: number) => (secs / dur) * w;
    const n = wave.peaks.length;
    for (let i = 0; i < n; i++) {
      const x = (i / n) * w;
      const p = Math.pow(Math.min(1, wave.peaks[i]), 0.6);
      const amp = Math.max(0.6, p * (h * 0.44));
      const inside = i / n >= start / dur && i / n <= end / dur;
      ctx.strokeStyle = inside ? "#5b9cff" : "#38445a";
      ctx.beginPath();
      ctx.moveTo(x + 0.5, mid - amp);
      ctx.lineTo(x + 0.5, mid + amp);
      ctx.stroke();
    }

    ctx.fillStyle = "rgba(4, 7, 12, 0.58)";
    ctx.fillRect(0, 0, xOf(start), h);
    ctx.fillRect(xOf(end), 0, w - xOf(end), h);

    const handle = (secs: number, color: string) => {
      const x = xOf(secs);
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x + 7, 0);
      ctx.lineTo(x, 9);
      ctx.closePath();
      ctx.fill();
    };
    handle(start, "#59d98c");
    handle(end, "#ffb84d");

    if (playPos >= 0) {
      const x = xOf(playPos);
      ctx.strokeStyle = "#ffffffcc";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();
    }
  }, [wave, start, end, playPos]);

  const duration = wave?.durationSecs ?? track.durationSecs;

  const secsAt = (clientX: number): number => {
    const canvas = canvasRef.current;
    if (!canvas || !wave) return 0;
    const r = canvas.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (clientX - r.left) / r.width));
    return ratio * wave.durationSecs;
  };

  const pointerDown = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!wave) return;
    const secs = secsAt(e.clientX);
    const tol = Math.max(0.08, wave.durationSecs / 220);
    if (Math.abs(secs - start) <= tol) {
      setDrag("start");
      e.currentTarget.setPointerCapture(e.pointerId);
    } else if (Math.abs(secs - end) <= tol) {
      setDrag("end");
      e.currentTarget.setPointerCapture(e.pointerId);
    } else {
      setPlayPos(secs);
      const audio = audioRef.current;
      if (audio) {
        audio.currentTime = secs;
        setPlayPos(secs);
      }
    }
  };

  const pointerMove = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!drag || !wave) return;
    const secs = secsAt(e.clientX);
    if (drag === "start") setStart(Math.max(0, Math.min(end - 0.3, secs)));
    else setEnd(Math.min(wave.durationSecs, Math.max(start + 0.3, secs)));
  };

  const pointerUp = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    if (drag) {
      setDrag(null);
      try {
        e.currentTarget.releasePointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
    }
  };

  const preview = () => {
    let audio = audioRef.current;
    if (!audio) {
      audio = new Audio(trackUrl(track));
      audio.preload = "auto";
      audio.ontimeupdate = () => {
        if (!audio) return;
        setPlayPos(audio.currentTime);
        if (audio.currentTime >= endRef.current) {
          audio.pause();
          audio.currentTime = startRef.current;
          setPlayPos(startRef.current);
        }
      };
      audio.onended = () => setPlayPos(startRef.current);
      audioRef.current = audio;
    }
    if (!audio.paused) {
      audio.pause();
      return;
    }
    if (audio.currentTime < start || audio.currentTime >= end) audio.currentTime = start;
    void audio.play().catch((e) => showToast(`No se pudo escuchar: ${String(e)}`));
  };

  const save = async () => {
    setSaving(true);
    try {
      await saveTrackTrim(track.id, start, end);
      onSaved({
        ...track,
        trimStart: start,
        trimEnd: end >= duration - 0.02 ? null : end,
        trimManual: true,
      });
      showToast("Recorte guardado");
      onClose();
    } catch (e) {
      showToast(`No se pudo guardar el recorte: ${String(e)}`);
      setSaving(false);
    }
  };

  const useAuto = async () => {
    try {
      await autoTrackTrim(track.id);
      const s = track.autoTrimStart;
      const e = track.autoTrimEnd ?? duration;
      setStart(s);
      setEnd(e);
      onSaved({ ...track, trimStart: s, trimEnd: track.autoTrimEnd, trimManual: false });
      showToast("Recorte automático restablecido");
    } catch (e) {
      showToast(String(e));
    }
  };

  return (
    <div className="modal-backdrop norm-modal" onClick={onClose}>
      <div className="modal modal-wide trim-modal" onClick={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <h3>Inicio y final de la pista</h3>
          <button type="button" className="ghost-btn" onClick={onClose}>
            <IconX size={16} />
          </button>
        </header>
        <div className="modal-body">
          <div className="trim-title">
            <strong>{track.title}</strong>
            <span>{track.artist || "Artista desconocido"}</span>
            <span className="trim-meta">
              {track.lufs != null ? `${track.lufs.toFixed(1)} LUFS · ${fmtGain(track.gainDb)} dB` : "Sin analizar"}
            </span>
          </div>

          {error && <div className="form-error">{error}</div>}
          {!wave && !error && <div className="trim-loading">Calculando la onda…</div>}
          {wave && (
            <>
              <canvas
                ref={canvasRef}
                className="trim-canvas"
                onPointerDown={pointerDown}
                onPointerMove={pointerMove}
                onPointerUp={pointerUp}
                onPointerCancel={pointerUp}
              />
              <div className="trim-legend">
                <span><i className="dot dot-green" /> Inicio {fmtTrim(start)}</span>
                <span><i className="dot dot-amber" /> Final {fmtTrim(end)}</span>
                <span>{fmtTime(end - start)} de música</span>
              </div>
            </>
          )}

          <div className="trim-controls">
            <label>
              Inicio (s)
              <input
                type="number"
                min={0}
                max={Math.max(0, end - 0.3)}
                step="0.01"
                value={start.toFixed(2)}
                onChange={(e) => setStart(Math.max(0, Math.min(end - 0.3, Number(e.target.value) || 0)))}
              />
            </label>
            <label>
              Final (s)
              <input
                type="number"
                min={start + 0.3}
                max={duration}
                step="0.01"
                value={end.toFixed(2)}
                onChange={(e) =>
                  setEnd(Math.min(duration, Math.max(start + 0.3, Number(e.target.value) || 0)))
                }
              />
            </label>
            <button type="button" className="btn btn-sm" onClick={preview} disabled={!wave}>
              {playPos >= 0 ? "Escuchar / parar" : "Escuchar"}
            </button>
            <button
              type="button"
              className="btn btn-sm"
              onClick={useAuto}
              disabled={track.analyzedAt === 0}
              title="Volver al recorte calculado por el analizador"
            >
              Automático
            </button>
          </div>

          <div className="trim-note">
            El archivo no se modifica: el reproductor empieza y termina en estas marcas. El margen
            automático conserva 0,10 s a cada lado.
          </div>

          <div className="edit-actions">
            <button type="button" className="btn btn-sm" onClick={onClose}>
              Cancelar
            </button>
            <span className="spacer" />
            <button type="button" className="btn btn-accent btn-sm" onClick={() => void save()} disabled={saving || !wave}>
              Guardar recorte
            </button>
          </div>
        </div>
      </div>
    </div>
  );
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
  onClose: () => void;
  onRefresh: () => Promise<void>;
  onPick: (side: Side) => void;
  onMove: (ids: string[], to: Side) => Promise<number>;
  onTarget: (lufs: number, peak: number) => void;
  showToast: (msg: string) => void;
}

export function Normalizer({
  tracks,
  blocks,
  targetLufs,
  truePeakDb,
  onClose,
  onRefresh,
  onPick,
  onMove,
  onTarget,
  showToast,
}: NormalizerProps) {
  const [all, setAll] = useState<Track[]>(tracks);
  const [selA, setSelA] = useState<Set<string>>(new Set());
  const [selB, setSelB] = useState<Set<string>>(new Set());
  const [errors, setErrors] = useState<Map<string, string>>(new Map());
  const [running, setRunning] = useState<RunningState | null>(null);
  const [trimId, setTrimId] = useState("");
  const [target, setTarget] = useState(String(targetLufs));
  const [peak, setPeak] = useState(String(truePeakDb));
  const cancelRef = useRef(false);
  const busyRef = useRef(false);

  useEffect(() => setAll(tracks), [tracks]);
  useEffect(() => setTarget(String(targetLufs)), [targetLufs]);
  useEffect(() => setPeak(String(truePeakDb)), [truePeakDb]);

  const libA = useMemo(() => all.filter((t) => t.library !== "b"), [all]);
  const libB = useMemo(() => all.filter((t) => t.library === "b"), [all]);
  const trimTrack = useMemo(() => all.find((t) => t.id === trimId) ?? null, [all, trimId]);

  const commitTarget = () => {
    const lufs = Math.max(-40, Math.min(-5, Number(target.replace(",", ".")) || -9));
    const tp = Math.max(-6, Math.min(0, Number(peak.replace(",", ".")) || -1));
    setTarget(String(lufs));
    setPeak(String(tp));
    if (lufs !== targetLufs || tp !== truePeakDb) onTarget(lufs, tp);
  };

  const move = async (ids: string[], to: Side) => {
    const valid = ids.filter((id) => all.some((t) => t.id === id));
    const targets = new Set(valid);
    const count = await onMove(valid, to);
    if (count > 0) {
      setAll((prev) =>
        prev.map((t) => (targets.has(t.id) ? { ...t, library: to } : t)),
      );
      if (to === "b") setSelA(new Set());
      else setSelB(new Set());
      showToast(
        count === 1
          ? `1 canción movida a la biblioteca ${to.toUpperCase()}`
          : `${count} canciones movidas a la biblioteca ${to.toUpperCase()}`,
      );
      void onRefresh();
    } else if (targets.size > 0) {
      setAll((prev) => prev.map((t) => (targets.has(t.id) ? { ...t, library: to } : t)));
      if (to === "b") setSelA(new Set());
      else setSelB(new Set());
    }
  };

  const run = async (ids: string[]) => {
    if (running || busyRef.current) return;
    busyRef.current = true;
    const wanted = Array.from(new Set(ids));
    const valid = wanted.filter((id) => {
      const t = all.find((x) => x.id === id);
      return t && !t.missing;
    });
    if (valid.length === 0) {
      busyRef.current = false;
      showToast("Selecciona canciones con archivo disponible");
      return;
    }
    const goal = Math.max(-40, Math.min(-5, Number(target.replace(",", ".")) || targetLufs));
    const ceiling = Math.max(-6, Math.min(0, Number(peak.replace(",", ".")) || truePeakDb));
    cancelRef.current = false;
    setErrors(new Map());
    let failed = 0;
    setRunning({ total: valid.length, done: 0, errors: 0, label: "" });
    for (let i = 0; i < valid.length; i++) {
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
    busyRef.current = false;
    setRunning(null);
    void onRefresh();
    showToast(
      cancelled
        ? `Análisis detenido: ${valid.length - failed} completadas`
        : failed > 0
          ? `Análisis terminado: ${valid.length - failed} correctas, ${failed} con error`
          : `${valid.length} canciones analizadas`,
    );
  };

  const applySavedTrim = (t: Track) => {
    setAll((prev) => prev.map((x) => (x.id === t.id ? t : x)));
  };

  return (
    <div className="norm-overlay">
      <header className="norm-head">
        <div className="norm-brand">
          <IconWave size={20} />
          <div>
            <strong>Normalizador de bibliotecas</strong>
            <span>Ganancia no destructiva · recorte automático de silencios</span>
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
        <button
          type="button"
          className="ghost-btn"
          onClick={() => {
            cancelRef.current = true;
            onClose();
          }}
          title="Cerrar normalizador"
        >
          <IconX size={18} />
        </button>
      </header>

      <div className="norm-body">
        <Pane
          side="a"
          tracks={libA}
          blocks={blocks}
          selected={selA}
          onSelected={setSelA}
          onMove={(ids, to) => void move(ids, to)}
          onAnalyze={(ids) => void run(ids)}
          onTrim={setTrimId}
          onPick={onPick}
          busy={running !== null}
          errors={errors}
        />

        <div className="norm-move">
          <button
            type="button"
            className="nmove-btn"
            disabled={running !== null || selA.size === 0}
            onClick={() => void move(Array.from(selA), "b")}
            title="Mover selección de A a B"
          >
            →
          </button>
          <button
            type="button"
            className="nmove-btn"
            disabled={running !== null || selB.size === 0}
            onClick={() => void move(Array.from(selB), "a")}
            title="Mover selección de B a A"
          >
            ←
          </button>
          <span className="nmove-hint">Arrastra<br />entre<br />bibliotecas</span>
        </div>

        <Pane
          side="b"
          tracks={libB}
          blocks={blocks}
          selected={selB}
          onSelected={setSelB}
          onMove={(ids, to) => void move(ids, to)}
          onAnalyze={(ids) => void run(ids)}
          onTrim={setTrimId}
          onPick={onPick}
          busy={running !== null}
          errors={errors}
        />
      </div>

      {running && (
        <div className="norm-progress">
          <div className="norm-bar">
            <span style={{ width: `${(running.done / Math.max(1, running.total)) * 100}%` }} />
          </div>
          <span className="norm-progress-txt">
            {running.done}/{running.total}
            {running.errors > 0 ? ` · ${running.errors} con error` : ""}
            {running.label ? ` · ${running.label}` : ""}
          </span>
          <button type="button" className="btn btn-sm" onClick={() => (cancelRef.current = true)}>
            Detener
          </button>
        </div>
      )}

      <div className="norm-foot">
        <span>
          Biblioteca A: {libA.length} · Biblioteca B: {libB.length}. Mover canciones no mueve ni
          borra archivos.
        </span>
        <span>Suelta audio desde el explorador sobre la mitad izquierda (A) o derecha (B).</span>
      </div>

      {trimTrack && (
        <TrimEditor
          track={trimTrack}
          onClose={() => setTrimId("")}
          onSaved={applySavedTrim}
          showToast={showToast}
        />
      )}
    </div>
  );
}
