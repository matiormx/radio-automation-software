import { useState } from "react";
import type { Track } from "../types";
import { IconPlus, IconSearch, IconTrash, IconNote } from "../icons";

interface LibraryZoneProps {
  tracks: Track[];
  onAdd: (track: Track) => void;
  onDelete: (track: Track) => void;
  onPickFiles: () => void;
}

function fmtTime(secs: number): string {
  if (!secs || secs <= 0) return "?";
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
    <section className="panel library" aria-label="Biblioteca de canciones">
      <div className="panel-head">
        <h2>Biblio</h2>
        <div className="search-box">
          <IconSearch size={18} />
          <input
            type="search"
            placeholder="Buscar cancion..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
      </div>

      <button type="button" className="drop-banner" onClick={onPickFiles}>
        <span className="drop-banner-title">Suelta tus canciones aca</span>
        <span className="drop-banner-sub">Arrastralas a la ventana, quedan guardadas. O toca aca para buscarlas</span>
      </button>

      {visible.length === 0 ? (
        <div className="empty-note">
          {tracks.length === 0
            ? "Todavia no hay canciones. Suelta archivos de musica aca arriba y aparecen solitos."
            : "Nada encontro con esa busqueda."}
        </div>
      ) : (
        <div className="grid" role="list">
          {visible.map((t, i) => (
            <div key={t.id} className={`card color-${i % 8}`} role="listitem">
              <button type="button" className="card-main" onClick={() => onAdd(t)} title="Agregar a la lista">
                <span className="card-note">
                  <IconNote size={22} />
                </span>
                <span className="card-title" title={t.title}>{t.title}</span>
                <span className="card-artist" title={t.artist}>{t.artist}</span>
                <span className="card-dur">{fmtTime(t.durationSecs)}</span>
              </button>
              <button
                type="button"
                className="card-x"
                title="Borrar de la biblioteca"
                aria-label={`Borrar ${t.title} de la biblioteca`}
                onClick={() => onDelete(t)}
              >
                <IconTrash size={14} />
              </button>
              <button
                type="button"
                className="card-add"
                title="Agregar a la lista"
                aria-label={`Agregar ${t.title} a la lista`}
                onClick={() => onAdd(t)}
              >
                <IconPlus size={18} />
              </button>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
