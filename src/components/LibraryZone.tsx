import { useState } from "react";
import type { Track } from "../types";
import { IconPlus, IconSearch, IconTrash, IconImport } from "../icons";

interface LibraryZoneProps {
  tracks: Track[];
  onAdd: (track: Track) => void;
  onDelete: (track: Track) => void;
  onPickFiles: () => void;
}

function fmtTime(secs: number): string {
  if (!secs || secs <= 0) return "--:--";
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function LibraryZone({ tracks, onAdd, onDelete, onPickFiles }: LibraryZoneProps) {
  const [query, setQuery] = useState("");

  const q = query.trim().toLowerCase();
  const visible = q
    ? tracks.filter(
        (t) =>
          t.title.toLowerCase().includes(q) ||
          t.artist.toLowerCase().includes(q) ||
          t.originalName.toLowerCase().includes(q),
      )
    : tracks;

  return (
    <section className="panel" aria-label="Biblioteca">
      <div className="panel-head">
        <h2>Biblioteca</h2>
        <span className="panel-count">{tracks.length} canciones</span>
      </div>

      <div className="panel-toolbar">
        <div className="search-box">
          <IconSearch size={15} />
          <input
            type="search"
            placeholder="Buscar titulo, artista..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <button type="button" className="btn" onClick={onPickFiles} title="Importar canciones desde el disco">
          <IconImport size={16} />
          Importar
        </button>
      </div>

      <div className="drop-strip" aria-hidden="true">
        Suelta archivos de audio en la ventana y se copian aquí, a buen recaudo
      </div>

      {visible.length === 0 ? (
        <div className="empty-note">
          {tracks.length === 0
            ? "Biblioteca vacía. Importa canciones con el botón «Importar» o arrastrando archivos de audio a esta ventana."
            : "Sin resultados para la búsqueda."}
        </div>
      ) : (
        <div className="rows" role="list">
          {visible.map((t) => (
            <div
              key={t.id}
              className="lrow"
              role="listitem"
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData("text/miradio-track", t.id);
              }}
            >
              <div className="lrow-txt">
                <span className="lrow-title" title={t.title}>{t.title}</span>
                <span className="lrow-sub" title={`${t.artist} · ${t.originalName}`}>{t.artist}</span>
              </div>
              <span className="lrow-dur">{fmtTime(t.durationSecs)}</span>
              <div className="lrow-acts">
                <button
                  type="button"
                  className="act-btn"
                  title="Añadir a la lista"
                  aria-label={`Añadir ${t.title} a la lista`}
                  onClick={() => onAdd(t)}
                >
                  <IconPlus size={15} />
                </button>
                <button
                  type="button"
                  className="act-btn act-danger"
                  title="Eliminar de la biblioteca"
                  aria-label={`Eliminar ${t.title} de la biblioteca`}
                  onClick={() => onDelete(t)}
                >
                  <IconTrash size={13} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
