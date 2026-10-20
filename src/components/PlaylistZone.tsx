import { useEffect, useState } from "react";
import type { Playlist, PlaylistRow } from "../types";
import { trackUrl } from "../api";
import { IconUp, IconDown, IconX, IconPlus, IconNote } from "../icons";
import { TrackDetailsModal } from "./TrackDetailsModal";

interface PlaylistZoneProps {
  playlists: Playlist[];
  activeId: string;
  rows: PlaylistRow[];
  playingRow: number;
  autoIds: Set<string>;
  estStart: string[];
  onSelect: (id: string) => void;
  onNew: () => void;
  onRemovePlaylist: () => void;
  onRename: (name: string) => void;
  onPlayRow: (index: number) => void;
  onReorder: (from: number, to: number) => void;
  onRemove: (index: number) => void;
  onDropTrack: (trackId: string, at: number) => void;
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
  rows,
  playingRow,
  autoIds,
  estStart,
  onSelect,
  onNew,
  onRemovePlaylist,
  onRename,
  onPlayRow,
  onReorder,
  onRemove,
  onDropTrack,
}: PlaylistZoneProps) {
  const active = playlists.find((p) => p.id === activeId) ?? playlists[0];
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(active?.name ?? "");
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [overIndex, setOverIndex] = useState<number | null>(null);
  const [extOver, setExtOver] = useState(false);
  const [detailsId, setDetailsId] = useState("");

  useEffect(() => {
    if (!editing) setDraft(active?.name ?? "");
  }, [active?.name, editing]);

  const commitRename = () => {
    setEditing(false);
    const clean = draft.trim();
    if (clean && clean !== active?.name) onRename(clean);
  };

  const totalSecs = rows.reduce((acc, r) => acc + r.durationSecs, 0);

  return (
    <section className="panel flex-1" aria-label="Lista de emisión">
      <div className="panel-head">
        <div className="tabs">
          {playlists.map((p) => (
            <button
              key={p.id}
              type="button"
              className={`tab ${p.id === active?.id ? "tab-on" : ""}`}
              onClick={() => onSelect(p.id)}
              title={p.name}
            >
              {p.name}
            </button>
          ))}
          <button type="button" className="tab tab-new" onClick={onNew} title="Nueva lista de emisión">
            <IconPlus size={13} />
            Nueva
          </button>
        </div>
        <div className="head-actions">
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
          {playlists.length > 1 && (
            <button type="button" className="ghost-btn ghost-danger" onClick={onRemovePlaylist}>
              Eliminar lista
            </button>
          )}
        </div>
      </div>

      <div className="pl-meta">
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

      <div className="pl-head">
        <span className="col-hour">HORA</span>
        <span className="col-num">#</span>
        <span className="col-cover" />
        <span className="col-main">TÍTULO</span>
        <span className="col-dur">DURACIÓN</span>
        <span className="col-acts" />
      </div>

      {rows.length === 0 ? (
        <div
          className={`empty-note ${extOver ? "drop-hot" : ""}`}
          onDragOver={(e) => {
            if (e.dataTransfer.types.includes("text/miradio-track")) {
              e.preventDefault();
              setExtOver(true);
            }
          }}
          onDragLeave={() => setExtOver(false)}
          onDrop={(e) => {
            const id = e.dataTransfer.getData("text/miradio-track");
            setExtOver(false);
            if (id) onDropTrack(id, 0);
          }}
        >
          Lista vacía. Arrastra canciones desde la biblioteca o activa el
          piloto automático para que se llene sola.
        </div>
      ) : (
        <div className="rows flex-1">
          {rows.map((r, i) => (
            <div
              key={`${r.id}-${i}`}
              className={`plrow ${i === playingRow ? "plrow-now" : ""} ${overIndex === i ? "plrow-over" : ""} ${extOver ? "plrow-ext" : ""}`}
              draggable
              onDragStart={(e) => {
                setDragIndex(i);
                e.dataTransfer.setData("text/miradio-index", String(i));
              }}
              onDragEnd={() => {
                setDragIndex(null);
                setOverIndex(null);
                setExtOver(false);
              }}
              onDragOver={(e) => {
                e.preventDefault();
                if (e.dataTransfer.types.includes("text/miradio-track")) {
                  setExtOver(true);
                } else {
                  setOverIndex(i);
                }
              }}
              onDragLeave={() => setExtOver(false)}
              onDrop={(e) => {
                e.preventDefault();
                const trackId = e.dataTransfer.getData("text/miradio-track");
                if (trackId) {
                  onDropTrack(trackId, i);
                } else if (dragIndex !== null && dragIndex !== i) {
                  onReorder(dragIndex, i);
                }
                setDragIndex(null);
                setOverIndex(null);
                setExtOver(false);
              }}
            >
              <span className="col-hour">{estStart[i] ?? ""}</span>
              <button type="button" className="plrow-num" onClick={() => onPlayRow(i)} title="Emitir desde esta pista">
                {i + 1}
              </button>
              <button
                type="button"
                className="plrow-cover"
                onClick={() => setDetailsId(r.id)}
                title="Ver detalles de la canción"
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
                  {autoIds.has(r.id) && <span className="badge-auto">AUTO</span>}
                  {i === playingRow && <span className="badge-live">AL AIRE</span>}
                </span>
                <span className="plrow-sub">{r.artist}</span>
              </button>
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
          ))}
        </div>
      )}

      {detailsId && (
        <TrackDetailsModal trackId={detailsId} onClose={() => setDetailsId("")} />
      )}
    </section>
  );
}
