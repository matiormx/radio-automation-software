import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fsList, fsPlaces, type FsEntry, type FsListing, type FsPlace } from "../api";
import { beginDrag } from "../dnd";
import type { Block, Track } from "../types";
import { IconFolder, IconPlus } from "../icons";

const PATH_KEY = "miradio.explorer.path";

const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();

function fmtSize(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1e3))} KB`;
}

/** Ficha provisional para preescuchar un archivo que no esta en la biblioteca. */
export function fileTrack(path: string): Track {
  const name = path.split(/[\\/]/).pop() ?? path;
  return {
    id: `file:${path}`,
    title: name.replace(/\.[^.]+$/, ""),
    artist: "",
    album: "",
    genre: "",
    year: "",
    durationSecs: 36000,
    file: path,
    originalName: name,
    blocks: [],
    tags: [],
    library: "a",
    lufs: null,
    gainDb: null,
    truePeakDb: null,
    limited: false,
    trimStart: 0,
    trimEnd: null,
    autoTrimStart: 0,
    autoTrimEnd: null,
    trimManual: false,
    introPoint: 0,
    mixPoint: 0,
    fadeOutStart: 0,
    analyzedAt: 0,
    missing: false,
    cover: "",
  } as Track;
}

/**
 * Explorador de archivos del ordenador: unidades y carpetas con todos los
 * archivos de audio y video compatibles, esten o no en la biblioteca.
 */
export function ExplorerView({
  tracks,
  blocks,
  query,
  onPreview,
  onPreviewNow,
  onAddToPlaylist,
  onImport,
  showToast,
}: {
  tracks: Track[];
  blocks: Block[];
  query: string;
  /** Preescucha al hacer clic (si esta activada la automatica) */
  onPreview?: (track: Track) => void;
  /** Preescucha a peticion (menu) */
  onPreviewNow?: (track: Track) => void;
  /** Añade a la lista de emision (importa si hace falta) */
  onAddToPlaylist: (paths: string[]) => void;
  /** Añade a la biblioteca (y a una lista si se indica) */
  onImport: (paths: string[], blockId?: string) => void;
  showToast: (msg: string) => void;
}) {
  const [places, setPlaces] = useState<FsPlace[]>([]);
  const [listing, setListing] = useState<FsListing | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const anchor = useRef<number>(-1);
  const [ctx, setCtx] = useState<{ x: number; y: number; paths: string[] } | null>(null);

  // Que archivos ya estan en la biblioteca (por ruta).
  const known = useMemo(() => {
    const m = new Map<string, Track>();
    for (const t of tracks) if (t.file) m.set(norm(t.file), t);
    return m;
  }, [tracks]);

  const open = useCallback(async (path: string) => {
    setLoading(true);
    setError("");
    try {
      const l = await fsList(path);
      setListing(l);
      setSelected([]);
      anchor.current = -1;
      try {
        localStorage.setItem(PATH_KEY, l.path);
      } catch {
        /* sin almacenamiento */
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fsPlaces().then((p) => {
      setPlaces(p);
      let start = "";
      try {
        start = localStorage.getItem(PATH_KEY) ?? "";
      } catch {
        /* sin almacenamiento */
      }
      void open(start || p[0]?.path || "/");
    });
  }, [open]);

  const entries = useMemo(() => {
    const list = listing?.entries ?? [];
    const q = query.trim().toLowerCase();
    return q ? list.filter((e) => e.name.toLowerCase().includes(q)) : list;
  }, [listing, query]);
  const files = entries.filter((e) => !e.dir);
  const newCount = files.filter((f) => !known.has(norm(f.path))).length;

  // Migas de la ruta actual
  const crumbs = useMemo(() => {
    const p = listing?.path ?? "";
    if (!p) return [];
    const win = /^[a-zA-Z]:/.test(p);
    const sep = win ? "\\" : "/";
    const parts = p.split(/[\\/]+/).filter(Boolean);
    const out: { label: string; path: string }[] = [];
    let acc = win ? "" : "/";
    if (!win) out.push({ label: "/", path: "/" });
    for (const part of parts) {
      acc = win ? (acc ? `${acc}${acc.endsWith(sep) ? "" : sep}${part}` : `${part}${sep}`) : `${acc}${acc.endsWith("/") ? "" : "/"}${part}`;
      out.push({ label: part, path: acc });
    }
    return out;
  }, [listing?.path]);

  // La ruta larga se ve por el final (la carpeta actual).
  const crumbsRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = crumbsRef.current;
    if (el) el.scrollLeft = el.scrollWidth;
  }, [crumbs]);

  const clickFile = (e: React.MouseEvent, entry: FsEntry, index: number) => {
    e.stopPropagation();
    if (e.shiftKey && anchor.current >= 0) {
      const [a, b] = [anchor.current, index].sort((x, y) => x - y);
      setSelected(files.slice(a, b + 1).map((f) => f.path));
      return;
    }
    if (e.ctrlKey || e.metaKey) {
      setSelected((s) => (s.includes(entry.path) ? s.filter((x) => x !== entry.path) : [...s, entry.path]));
      anchor.current = index;
      return;
    }
    setSelected([entry.path]);
    anchor.current = index;
    onPreview?.(known.get(norm(entry.path)) ?? fileTrack(entry.path));
  };

  const pathsFor = (entry: FsEntry) => (selected.includes(entry.path) ? selected : [entry.path]);

  return (
    <div className="explorer" onClick={() => setSelected([])}>
      <div className="explorer-places">
        {places.map((p) => (
          <button
            key={p.path}
            type="button"
            className={`explorer-place ${listing && norm(listing.path).startsWith(norm(p.path)) && p.kind === "folder" ? "explorer-place-on" : ""}`}
            onClick={() => void open(p.path)}
            title={p.path}
          >
            {p.kind === "drive" ? "💽" : "📁"} {p.label}
          </button>
        ))}
      </div>
      <div className="explorer-bar">
        <button
          type="button"
          className="btn btn-sm"
          disabled={!listing?.parent}
          onClick={() => listing?.parent && void open(listing.parent)}
          title="Subir a la carpeta superior"
        >
          ↑
        </button>
        <div className="explorer-crumbs" ref={crumbsRef}>
          {crumbs.map((c, i) => (
            <button key={c.path} type="button" className="explorer-crumb" onClick={() => void open(c.path)}>
              {i > 0 && <span className="explorer-crumb-sep">›</span>}
              {c.label}
            </button>
          ))}
        </div>
        <span className="explorer-count">
          {files.length} archivos{newCount > 0 ? ` · ${newCount} nuevos` : ""}
        </span>
        {newCount > 0 && (
          <button
            type="button"
            className="btn btn-sm"
            title="Añadir a la biblioteca los archivos de esta carpeta que aún no están"
            onClick={(e) => {
              e.stopPropagation();
              onImport(files.filter((f) => !known.has(norm(f.path))).map((f) => f.path));
            }}
          >
            <IconPlus size={12} /> Catalogar
          </button>
        )}
      </div>
      <div className="explorer-rows" role="list">
        {loading && !listing && <div className="empty-note">Cargando…</div>}
        {error && <div className="empty-note">{error}</div>}
        {listing && entries.length === 0 && !error && (
          <div className="empty-note">No hay carpetas ni archivos compatibles aquí.</div>
        )}
        {entries.map((e) => {
          if (e.dir) {
            return (
              <div
                key={e.path}
                className="xrow xrow-dir"
                role="listitem"
                onDoubleClick={() => void open(e.path)}
                onClick={(ev) => {
                  ev.stopPropagation();
                  void open(e.path);
                }}
                title={e.path}
              >
                <IconFolder size={14} />
                <span className="xrow-name">{e.name}</span>
              </div>
            );
          }
          const index = files.indexOf(e);
          const t = known.get(norm(e.path));
          const on = selected.includes(e.path);
          return (
            <div
              key={e.path}
              className={`xrow ${on ? "xrow-on" : ""}`}
              role="listitem"
              title={e.path}
              onPointerDown={(ev) => {
                const paths = pathsFor(e);
                beginDrag(ev, {
                  kind: "files",
                  paths,
                  label: paths.length === 1 ? e.name : `${paths.length} archivos`,
                });
              }}
              onClick={(ev) => clickFile(ev, e, index)}
              onDoubleClick={() => onAddToPlaylist([e.path])}
              onContextMenu={(ev) => {
                ev.preventDefault();
                ev.stopPropagation();
                const paths = pathsFor(e);
                if (!selected.includes(e.path)) setSelected([e.path]);
                setCtx({ x: ev.clientX, y: ev.clientY, paths });
              }}
            >
              <span className={`xrow-kind xrow-${e.kind}`}>{e.kind === "video" ? "▶" : "♪"}</span>
              <span className="xrow-name">
                {t ? (
                  <>
                    {t.title}
                    {t.artist && <span className="xrow-artist"> — {t.artist}</span>}
                  </>
                ) : (
                  e.name
                )}
              </span>
              {t ? (
                <span className="xrow-badge xrow-in" title="Ya está en la biblioteca">
                  ✓
                </span>
              ) : (
                <span className="xrow-badge xrow-new" title="No está en la biblioteca">
                  nuevo
                </span>
              )}
              <span className="xrow-size">{fmtSize(e.size)}</span>
            </div>
          );
        })}
        {listing?.truncated && <div className="empty-note">Hay más elementos: se muestran los primeros 5000.</div>}
      </div>

      {ctx && (
        <div
          className="ctx-backdrop"
          onClick={(e) => {
            e.stopPropagation();
            setCtx(null);
          }}
          onContextMenu={(e) => {
            e.preventDefault();
            setCtx(null);
          }}
        >
          <div className="ctx-menu" style={{ left: ctx.x, top: ctx.y }} onClick={(e) => e.stopPropagation()} role="menu">
            <div className="ctx-title">{ctx.paths.length === 1 ? ctx.paths[0].split(/[\\/]/).pop() : `${ctx.paths.length} archivos`}</div>
            <button
              type="button"
              className="ctx-item"
              onClick={() => {
                onAddToPlaylist(ctx.paths);
                setCtx(null);
              }}
            >
              <IconPlus size={13} /> Añadir a la lista de emisión
            </button>
            <button
              type="button"
              className="ctx-item"
              onClick={() => {
                onImport(ctx.paths);
                setCtx(null);
              }}
            >
              Añadir a la biblioteca
            </button>
            {ctx.paths.length === 1 && (
              <button
                type="button"
                className="ctx-item"
                onClick={() => {
                  const fn = onPreviewNow ?? onPreview;
                  if (fn) fn(known.get(norm(ctx.paths[0])) ?? fileTrack(ctx.paths[0]));
                  else showToast("La preescucha no está disponible");
                  setCtx(null);
                }}
              >
                Preescuchar
              </button>
            )}
            <div className="ctx-title">Añadir a una lista</div>
            <div className="ctx-blocks">
              {blocks.length === 0 && <span className="hint">No hay listas creadas.</span>}
              {blocks.map((b) => (
                <button
                  key={b.id}
                  type="button"
                  className="ctx-item"
                  onClick={() => {
                    onImport(ctx.paths, b.id);
                    setCtx(null);
                  }}
                >
                  {b.name}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
