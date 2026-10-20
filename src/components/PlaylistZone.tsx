import { useEffect, useState } from "react";
import type { PlaylistRow } from "../types";
import { IconUp, IconDown, IconX, IconPlus } from "../icons";

interface PlaylistZoneProps {
  name: string;
  rows: PlaylistRow[];
  playingRow: number;
  onRename: (name: string) => void;
  onPlayRow: (index: number) => void;
  onReorder: (from: number, to: number) => void;
  onRemove: (index: number) => void;
  onNewPlaylist: () => void;
}

export function PlaylistZone({
  name,
  rows,
  playingRow,
  onRename,
  onPlayRow,
  onReorder,
  onRemove,
  onNewPlaylist,
}: PlaylistZoneProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [overIndex, setOverIndex] = useState<number | null>(null);

  useEffect(() => {
    if (!editing) setDraft(name);
  }, [name, editing]);

  const commitRename = () => {
    setEditing(false);
    const clean = draft.trim();
    if (clean && clean !== name) onRename(clean);
  };

  return (
    <section className="panel playlist" aria-label="Lista para poner al aire">
      <div className="panel-head">
        <h2>Al aire</h2>
        {editing ? (
          <input
            className="name-input"
            value={draft}
            autoFocus
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commitRename}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitRename();
              if (e.key === "Escape") setEditing(false);
            }}
          />
        ) : (
          <button type="button" className="pl-name" onClick={() => setEditing(true)} title="Cambiar el nombre">
            {name}
          </button>
        )}
        <button type="button" className="chip-btn" onClick={onNewPlaylist} title="Nueva lista">
          <IconPlus size={16} />
          Nueva
        </button>
      </div>

      {rows.length === 0 ? (
        <div className="empty-note">
          La lista esta vacia. Toca el boton mas de una cancion de la Biblio para sumarla.
        </div>
      ) : (
        <div className="playlist-scroll">
          {rows.map((r, i) => (
            <div
              key={`${r.id}-${i}`}
              className={`prow color-${i % 8} ${i === playingRow ? "prow-active" : ""} ${overIndex === i ? "prow-over" : ""}`}
              draggable
              onDragStart={() => setDragIndex(i)}
              onDragEnd={() => {
                setDragIndex(null);
                setOverIndex(null);
              }}
              onDragOver={(e) => {
                e.preventDefault();
                setOverIndex(i);
              }}
              onDrop={(e) => {
                e.preventDefault();
                if (dragIndex !== null && dragIndex !== i) onReorder(dragIndex, i);
                setDragIndex(null);
                setOverIndex(null);
              }}
            >
              <button type="button" className="prow-num" onClick={() => onPlayRow(i)} title="Sonar ahora">
                {i + 1}
              </button>
              <button type="button" className="prow-main" onClick={() => onPlayRow(i)} title="Sonar ahora">
                <span className="prow-title" title={r.title}>{r.title}</span>
                <span className="prow-artist">{r.artist}</span>
              </button>
              <div className="prow-btns">
                <button type="button" className="mini-btn" onClick={() => onReorder(i, i - 1)} disabled={i === 0} aria-label={`Subir ${r.title}`}>
                  <IconUp size={14} />
                </button>
                <button type="button" className="mini-btn" onClick={() => onReorder(i, i + 1)} disabled={i === rows.length - 1} aria-label={`Bajar ${r.title}`}>
                  <IconDown size={14} />
                </button>
                <button type="button" className="mini-btn mini-danger" onClick={() => onRemove(i)} aria-label={`Quitar ${r.title} de la lista`}>
                  <IconX size={14} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
