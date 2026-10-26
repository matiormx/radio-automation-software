import { Fragment, useEffect, useRef, useState } from "react";
import type { Block, Playlist, PlaylistRow } from "../types";
import { trackUrl } from "../api";
import { IconUp, IconDown, IconX, IconPlus, IconNote, IconPlay, IconTag, IconWave, IconNext } from "../icons";
import { TrackDetailsModal } from "./TrackDetailsModal";
import { beginDrag, registerDropZone } from "../dnd";

interface PlaylistZoneProps {
  playlists: Playlist[];
  /** Lista que se ve */
  activeId: string;
  /** Lista que suena (la activa: la que rellena el AutoDJ) */
  airId: string;
  rows: PlaylistRow[];
  /** Fila que sonara a continuacion en esta lista (-1 = ninguna) */
  nextRow: number;
  /** La siguiente esta en otra lista: "titulo · lista" */
  nextElsewhere: string;
  blocks: Block[];
  playingRow: number;
  autoIds: Set<string>;
  estStart: string[];
  onSelect: (id: string) => void;
  onNew: () => void;
  onRemovePlaylist: () => void;
  onClearPlaylist: () => void;
  onRename: (name: string) => void;
  onPlayRow: (index: number) => void;
  onReorder: (from: number, to: number) => void;
  onRemove: (index: number) => void;
  onDropTrack: (trackId: string, at: number) => void;
  /** Suelta una lista entero: todas sus canciones a partir de `at` */
  onDropBlock?: (blockId: string, at: number) => void;
  /** Archivos del Explorador: se importan si hace falta y entran en `at` */
  onDropFiles?: (paths: string[], at: number) => void;
  onPreview: (index: number) => void;
  onEditMeta: (index: number) => void;
  onEditCuts: (index: number) => void;
  onToggleBlock: (trackId: string, blockId: string) => void;
  onSetNext: (index: number) => void;
  onClearNext: () => void;
  onGenerate: () => void;
  /** Canciones emitidas que siguen visibles (opacas) antes de ocultarse */
  pastVisible: number;
  /** Fila que sale de la lista cuando termine de sonar */
  leavingRow: number;
}


function fmtDur(secs: number): string {
  if (!secs || secs <= 0) return "--:--";
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function PlaylistZone({
  playlists,
  activeId,
  airId,
  rows,
  nextRow,
  nextElsewhere,
  blocks,
  playingRow,
  autoIds,
  estStart,
  onSelect,
  onNew,
  onRemovePlaylist,
  onClearPlaylist,
  onRename,
  onPlayRow,
  onReorder,
  onRemove,
  onDropTrack,
  onDropBlock,
  onDropFiles,
  onPreview,
  onEditMeta,
  onEditCuts,
  onToggleBlock,
  onSetNext,
  onClearNext,
  onGenerate,
  pastVisible,
  leavingRow,
}: PlaylistZoneProps) {
  const PAST_VISIBLE = Math.max(0, Math.round(pastVisible));
  const isAir = activeId === airId;
  const active = playlists.find((p) => p.id === activeId) ?? playlists[0];
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(active?.name ?? "");
  // Soltar en la lista (con el puntero; ver dnd.ts): canciones, bloques y filas.
  const dropRef = useRef({ onDropTrack, onDropBlock, onDropFiles, onReorder, count: rows.length });
  dropRef.current = { onDropTrack, onDropBlock, onDropFiles, onReorder, count: rows.length };
  useEffect(() => {
    const at = (el: HTMLElement, after: boolean) => {
      if (el.dataset.dropZone === "playlist-end") return dropRef.current.count;
      const i = Number(el.dataset.index ?? 0);
      return after ? i + 1 : i;
    };
    const zone = {
      accepts: (p: { kind: string; blockId?: string }) => p.kind === "track" || p.kind === "row" || p.kind === "files" || (p.kind === "blockItem" && !!p.blockId),
      drop: (p: import("../dnd").DragPayload, el: HTMLElement, pos: { after: boolean }) => {
        const to = at(el, pos.after);
        const h = dropRef.current;
        if (p.kind === "track") h.onDropTrack(p.trackId, to);
        else if (p.kind === "blockItem") h.onDropBlock?.(p.blockId, to);
        else if (p.kind === "files") h.onDropFiles?.(p.paths, to);
        else if (p.kind === "row") {
          const t = p.index < to ? to - 1 : to;
          if (t !== p.index) h.onReorder(p.index, t);
        }
      },
    };
    const a = registerDropZone("playlist-row", zone);
    const b = registerDropZone("playlist-end", zone);
    return () => {
      a();
      b();
    };
  }, []);
  const [detailsId, setDetailsId] = useState("");
  const [ctx, setCtx] = useState<{ index: number; x: number; y: number } | null>(null);
  const [blockMenu, setBlockMenu] = useState<string | null>(null);
  const blockMenuRef = useRef<HTMLDivElement | null>(null);
  const rowsRef = useRef<HTMLDivElement | null>(null);
  const [showAllPast, setShowAllPast] = useState(false);
  // Emitidas que se ocultan (o que se muestran al pulsar «ver»): el aviso queda
  // siempre en la frontera entre esas y las que se ven normalmente.
  const pastCut = Math.max(0, playingRow - PAST_VISIBLE);
  const hiddenPast = showAllPast ? 0 : pastCut;
  // Un clic en la portada abre los detalles; doble clic emite la cancion.
  const coverClick = useRef<number | null>(null);

  // Al cambiar de cancion, deja a la vista las ultimas emitidas y la que suena.
  useEffect(() => {
    const box = rowsRef.current;
    if (!box || playingRow < 0) return;
    const first = Math.max(0, playingRow - PAST_VISIBLE);
    const el = box.querySelector<HTMLElement>(`[data-row="${first}"]`);
    if (!el) return;
    box.scrollTop += el.getBoundingClientRect().top - box.getBoundingClientRect().top;
    // Solo al cambiar de cancion o de lista: al soltar o reordenar, la lista
    // no debe saltar a otra parte.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playingRow, activeId]);

  useEffect(() => {
    if (!editing) setDraft(active?.name ?? "");
  }, [active?.name, editing]);

  const commitRename = () => {
    setEditing(false);
    const clean = draft.trim();
    if (clean && clean !== active?.name) onRename(clean);
  };

  const totalSecs = rows.reduce((acc, r) => acc + r.durationSecs, 0);

  const blockName = (id: string) => blocks.find((b) => b.id === id)?.name ?? "Lista";

  // Cierra el menu contextual con Escape.
  useEffect(() => {
    if (!ctx) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setCtx(null);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [ctx]);

  // Cierra el menu de bloques al pulsar fuera.
  useEffect(() => {
    if (!blockMenu) return;
    const onDoc = (e: MouseEvent) => {
      if (!blockMenuRef.current?.contains(e.target as Node)) setBlockMenu(null);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [blockMenu]);

  return (
    <section className="panel flex-1 playlist-panel" aria-label="Lista de emisión">
      <div className="panel-head">
        <div className="tabs">
          {playlists.map((p) => (
            <button
              key={p.id}
              type="button"
              className={`tab ${p.id === active?.id ? "tab-on" : ""} ${p.id === airId ? "tab-air" : ""}`}
              onClick={() => onSelect(p.id)}
              title={p.id === airId ? `${p.name} · lista activa (la que suena)` : p.name}
            >
              {p.id === airId && <span className="tab-air-dot" aria-label="Activa" />}
              {p.name}
            </button>
          ))}
          <button type="button" className="tab tab-new" onClick={onNew} title="Nueva lista de emisión">
            <IconPlus size={13} />
            Nueva
          </button>
        </div>
        <div className="head-actions">
          {!isAir && (
            <button
              type="button"
              className="btn btn-sm"
              onClick={onGenerate}
              title="Rellenar esta lista con el AutoDJ (no toca la que suena)"
            >
              Generar lista
            </button>
          )}
          {editing ? (
            <input
              className="name-input"
              value={draft}
              autoFocus
              size={10}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={commitRename}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitRename();
                if (e.key === "Escape") setEditing(false);
              }}
            />
          ) : (
            <button type="button" className="ghost-btn" onClick={() => setEditing(true)} title="Renombrar lista">
              {active?.name}
            </button>
          )}
          {rows.length > 0 && (
            <button
              type="button"
              className="ghost-btn ghost-danger"
              onClick={onClearPlaylist}
              title="Quitar todas las pistas de esta lista"
            >
              Vaciar
            </button>
          )}
          {playlists.length > 1 && (
            <button type="button" className="ghost-btn ghost-danger" onClick={onRemovePlaylist}>
              Eliminar lista
            </button>
          )}
        </div>
      </div>

      <div className="pl-meta">
        {!isAir && <span className="pl-notair">No está sonando · la lista activa es la marcada con ●</span>}
        {!isAir && <span className="sep">·</span>}
        <span>{rows.length} pistas</span>
        <span className="sep">·</span>
        <span>total {fmtDur(totalSecs)}</span>
        {autoIds.size > 0 && (
          <>
            <span className="sep">·</span>
            <span className="auto-note">{autoIds.size} añadidas por el piloto automático</span>
          </>
        )}
      </div>

      {nextElsewhere && (
        <div className="pl-nextelse">
          <span>Siguiente: {nextElsewhere}</span>
          <button type="button" className="ghost-btn" onClick={onClearNext}>
            Quitar
          </button>
        </div>
      )}

      <div className="pl-head">
        <span className="col-hour">HORA</span>
        <span className="col-num">#</span>
        <span className="col-cover" />
        <span className="col-main">TÍTULO</span>
        <span className="col-blocks">LISTAS</span>
        <span className="col-dur">DURACIÓN</span>
        <span className="col-acts" />
      </div>

      {rows.length === 0 ? (
        <div
          className="empty-note"
          data-drop-zone="playlist-end"
        >
          Lista vacía. Arrastra canciones desde la biblioteca o activa el
          piloto automático para que se llene sola.
        </div>
      ) : (
        <div className="rows flex-1" ref={rowsRef} data-drop-zone="playlist-end">
          {rows.map((r, i) => i < hiddenPast ? null : (
            <Fragment key={`${r.id}-${i}`}>
            {pastCut > 0 && i === pastCut && (
              <button
                type="button"
                className="plrow-pastnote"
                onClick={() => setShowAllPast((v) => !v)}
              >
                {showAllPast
                  ? `▲ ${pastCut} ${pastCut === 1 ? "canción emitida" : "canciones emitidas"} · ocultar`
                  : `${pastCut} ${pastCut === 1 ? "canción emitida oculta" : "canciones emitidas ocultas"} · ver`}
              </button>
            )}
            <div
              data-row={i}
              className={`plrow ${i === playingRow ? "plrow-now" : ""} ${i === nextRow ? "plrow-next" : ""} ${i === leavingRow ? "plrow-leaving" : ""} ${playingRow >= 0 && i < playingRow ? "plrow-past" : ""} `}
              data-drop-zone="playlist-row"
              data-index={i}
              onPointerDown={(e) => beginDrag(e, { kind: "row", index: i, trackId: r.id, label: `${r.title}${r.artist ? ` — ${r.artist}` : ""}` })}
              onContextMenu={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setCtx({ index: i, x: e.clientX, y: e.clientY });
              }}
            >
              <span className="col-hour">{estStart[i] ?? ""}</span>
              <button type="button" className="plrow-num" onClick={() => onPlayRow(i)} title="Emitir desde esta pista">
                {i + 1}
              </button>
              <button
                type="button"
                className="plrow-cover"
                onClick={() => {
                  if (coverClick.current !== null) window.clearTimeout(coverClick.current);
                  coverClick.current = window.setTimeout(() => {
                    coverClick.current = null;
                    setDetailsId(r.id);
                  }, 260);
                }}
                onDoubleClick={() => {
                  if (coverClick.current !== null) window.clearTimeout(coverClick.current);
                  coverClick.current = null;
                  onPlayRow(i);
                }}
                title="Clic: detalles · doble clic: emitir esta canción"
                aria-label={`Ver detalles de ${r.title}`}
              >
                <span className="plrow-cover-ph">
                  <IconNote size={14} />
                </span>
                {r.cover && (
                  <img
                    src={trackUrl({ file: r.cover })}
                    alt=""
                    loading="lazy"
                    onError={(e) => e.currentTarget.remove()}
                  />
                )}
              </button>
              <button type="button" className="plrow-main" onClick={() => onPlayRow(i)} title="Emitir desde esta pista">
                <span className="plrow-line">
                  <span className="plrow-title">{r.title}</span>
                  {r.video && <span className="badge-video">VÍDEO</span>}
                  {autoIds.has(r.id) && <span className="badge-auto">AUTO</span>}
                  {i === playingRow && <span className="badge-live">AL AIRE</span>}
                  {i === nextRow && <span className="badge-next">SIGUIENTE</span>}
                  {i === leavingRow && <span className="badge-leaving">SALE AL TERMINAR</span>}
                </span>
                <span className="plrow-sub">{r.artist}</span>
              </button>
              <div className="plrow-blocks" ref={blockMenu === r.id ? blockMenuRef : undefined}>
                {r.blocks.map((blockId) => (
                  <button
                    key={blockId}
                    type="button"
                    className="plrow-block"
                    title={`Quitar «${blockName(blockId)}» (clic para quitar, clic derecho para más)`}
                    onClick={(e) => {
                      e.stopPropagation();
                      onToggleBlock(r.id, blockId);
                    }}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      onToggleBlock(r.id, blockId);
                    }}
                  >
                    {blockName(blockId)}
                    <span className="plrow-block-x">×</span>
                  </button>
                ))}
                <button
                  type="button"
                  className="plrow-block plrow-block-add"
                  title="Añadir a una lista"
                  onClick={(e) => {
                    e.stopPropagation();
                    setBlockMenu((prev) => (prev === r.id ? null : r.id));
                  }}
                >
                  <IconPlus size={11} />
                </button>
                {blockMenu === r.id && (
                  <div className="plrow-block-menu" role="menu">
                    {blocks.length === 0 && (
                      <span className="hint">Todavía no hay listas. Créalas en Música › Listas.</span>
                    )}
                    {blocks.map((block) => {
                      const inside = r.blocks.includes(block.id);
                      return (
                        <button
                          key={block.id}
                          type="button"
                          className="plrow-block-item"
                          onClick={(e) => {
                            e.stopPropagation();
                            onToggleBlock(r.id, block.id);
                            setBlockMenu(null);
                          }}
                        >
                          <span className={inside ? "plrow-block-check on" : "plrow-block-check"}>
                            {inside ? "✓" : ""}
                          </span>
                          {block.name}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
              <span className="col-dur">{fmtDur(r.durationSecs)}</span>
              <div className="plrow-acts">
                <button type="button" className="act-btn" onClick={() => onReorder(i, i - 1)} disabled={i === 0} aria-label={`Subir ${r.title}`}>
                  <IconUp size={13} />
                </button>
                <button type="button" className="act-btn" onClick={() => onReorder(i, i + 1)} disabled={i === rows.length - 1} aria-label={`Bajar ${r.title}`}>
                  <IconDown size={13} />
                </button>
                <button type="button" className="act-btn act-danger" onClick={() => onRemove(i)} aria-label={`Quitar ${r.title} de la lista`}>
                  <IconX size={13} />
                </button>
              </div>
            </div>
            </Fragment>
          ))}
          <div className="pl-end-drop" data-drop-zone="playlist-end" aria-hidden="true" />
        </div>
      )}

      {ctx && rows[ctx.index] && (
        <div
          className="ctx-backdrop"
          onClick={() => setCtx(null)}
          onContextMenu={(e) => {
            e.preventDefault();
            setCtx(null);
          }}
        >
          <div
            className="ctx-menu"
            style={{ left: ctx.x, top: ctx.y }}
            onClick={(e) => e.stopPropagation()}
            role="menu"
          >
            <div className="ctx-title" title={rows[ctx.index].title}>
              {rows[ctx.index].title}
            </div>
            {ctx.index !== playingRow && (
              <button
                type="button"
                className="ctx-item"
                onClick={() => {
                  onSetNext(ctx.index);
                  setCtx(null);
                }}
              >
                <IconNext size={13} /> Marcar como siguiente
              </button>
            )}
            <button
              type="button"
              className="ctx-item"
              onClick={() => {
                onPreview(ctx.index);
                setCtx(null);
              }}
            >
              <IconPlay size={13} /> Preescucha
            </button>
            <button
              type="button"
              className="ctx-item"
              onClick={() => {
                onEditCuts(ctx.index);
                setCtx(null);
              }}
            >
              <IconWave size={13} /> Cortes y puntos
            </button>
            <button
              type="button"
              className="ctx-item"
              onClick={() => {
                onEditMeta(ctx.index);
                setCtx(null);
              }}
            >
              <IconTag size={13} /> Editar metadatos
            </button>
            <div className="ctx-title">Añadir a una lista</div>
            <div className="ctx-blocks">
              {blocks.length === 0 && <span className="hint">No hay listas creadas.</span>}
              {blocks.map((block) => {
                const inside = rows[ctx.index].blocks.includes(block.id);
                return (
                  <button
                    key={block.id}
                    type="button"
                    className="ctx-item"
                    onClick={() => onToggleBlock(rows[ctx.index].id, block.id)}
                  >
                    <span className="plrow-block-check">{inside ? "✓" : ""}</span>
                    {block.name}
                  </button>
                );
              })}
            </div>
            <div className="ctx-sep" />
            <button
              type="button"
              className="ctx-item ctx-danger"
              onClick={() => {
                onRemove(ctx.index);
                setCtx(null);
              }}
            >
              <IconX size={13} /> Quitar de la lista
            </button>
          </div>
        </div>
      )}

      {detailsId && (
        <TrackDetailsModal trackId={detailsId} onClose={() => setDetailsId("")} />
      )}
    </section>
  );
}
