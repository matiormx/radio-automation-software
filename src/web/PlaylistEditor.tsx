import { useMemo, useState } from "react";
import type { Playlist, Track } from "../types";

function fmt(secs: number): string {
  if (!secs || secs <= 0) return "--:--";
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = Math.floor(secs % 60);
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
}

function playable(t: Track): number {
  const end = t.trimEnd ?? t.durationSecs;
  return Math.max(0, end - (t.trimStart || 0));
}

/**
 * Playlists en la web: crear, renombrar, ordenar (arrastrando o con las
 * flechas), quitar y añadir canciones buscándolas en la biblioteca.
 */
export function PlaylistEditor({
  playlists,
  tracks,
  selected,
  onSelect,
  onSave,
  onDelete,
  onPreview,
  onStop,
  onEditCuts,
}: {
  playlists: Playlist[];
  tracks: Track[];
  selected: string;
  onSelect: (id: string) => void;
  onSave: (p: Playlist) => void;
  onDelete: (id: string) => void;
  onPreview: (t: Track) => void;
  onStop: () => void;
  onEditCuts: (t: Track) => void;
}) {
  const [q, setQ] = useState("");
  const [drag, setDrag] = useState(-1);
  const byId = useMemo(() => new Map(tracks.map((t) => [t.id, t])), [tracks]);
  const pl = playlists.find((p) => p.id === selected) ?? null;
  const rows = pl ? pl.trackIds.map((id, i) => ({ i, id, t: byId.get(id) })) : [];
  const total = rows.reduce((a, r) => a + (r.t ? playable(r.t) : 0), 0);

  const hits = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (s.length < 2) return [];
    return tracks.filter((t) => `${t.title} ${t.artist} ${t.album}`.toLowerCase().includes(s)).slice(0, 40);
  }, [q, tracks]);

  const change = (ids: string[], meta: Playlist["meta"]) => pl && onSave({ ...pl, trackIds: ids, meta });
  const metaOf = (p: Playlist) => p.trackIds.map((_, i) => p.meta?.[i] ?? null);
  const move = (from: number, to: number) => {
    if (!pl || from === to || to < 0 || to >= pl.trackIds.length) return;
    const ids = [...pl.trackIds];
    const meta = metaOf(pl);
    const [x] = ids.splice(from, 1);
    const [m] = meta.splice(from, 1);
    ids.splice(to, 0, x);
    meta.splice(to, 0, m);
    change(ids, meta);
  };
  const remove = (i: number) => {
    if (!pl) return;
    change(
      pl.trackIds.filter((_, k) => k !== i),
      metaOf(pl).filter((_, k) => k !== i),
    );
  };
  const add = (t: Track) => pl && change([...pl.trackIds, t.id], [...metaOf(pl), null]);

  const create = () => {
    const name = window.prompt("Nombre de la nueva playlist")?.trim();
    if (!name) return;
    const id = crypto.randomUUID();
    onSave({ id, name, trackIds: [], meta: [] });
    onSelect(id);
  };

  return (
    <div className="web-pl">
      <div className="web-pl-bar">
        <select value={selected} onChange={(e) => onSelect(e.target.value)}>
          {playlists.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name} ({p.trackIds.length})
            </option>
          ))}
        </select>
        <button type="button" className="btn btn-sm" onClick={create}>
          Nueva
        </button>
        {pl && (
          <>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => {
                const name = window.prompt("Nuevo nombre", pl.name)?.trim();
                if (name) onSave({ ...pl, name });
              }}
            >
              Renombrar
            </button>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => window.confirm(`¿Vaciar «${pl.name}»?`) && change([], [])}
            >
              Vaciar
            </button>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => window.confirm(`¿Borrar la playlist «${pl.name}» en todos los equipos?`) && onDelete(pl.id)}
            >
              Borrar
            </button>
            <span className="hint">
              {rows.length} canciones · {fmt(total)}
            </span>
          </>
        )}
      </div>
      <p className="hint">
        La playlist que esté sonando en un equipo no cambia desde aquí hasta que deje de sonar allí.
      </p>
      {pl && (
        <div className="web-pl-add">
          <input type="search" placeholder="Buscar canciones para añadir…" value={q} onChange={(e) => setQ(e.target.value)} />
          {hits.length > 0 && (
            <ul className="web-hits">
              {hits.map((t) => (
                <li key={t.id}>
                  <button type="button" className="btn btn-sm" onClick={() => add(t)} title="Añadir al final">
                    +
                  </button>
                  <span>
                    <b>{t.title}</b> {t.artist && `· ${t.artist}`}
                  </span>
                  <small>{fmt(playable(t))}</small>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      <ol className="web-rows">
        {rows.map((r) => (
          <li
            key={`${r.i}-${r.id}`}
            draggable
            onDragStart={() => setDrag(r.i)}
            onDragOver={(e) => e.preventDefault()}
            onDrop={() => {
              move(drag, r.i);
              setDrag(-1);
            }}
            className={drag === r.i ? "dragging" : ""}
          >
            <span className="n">{r.i + 1}</span>
            <span className="t">
              {r.t ? (
                <>
                  <b>{r.t.title}</b>
                  {r.t.artist && <small> · {r.t.artist}</small>}
                </>
              ) : (
                <i>Canción borrada de la biblioteca</i>
              )}
            </span>
            <small className="d">{r.t ? fmt(playable(r.t)) : ""}</small>
            {r.t && (
              <>
                <button type="button" className="btn btn-sm" title="Escuchar" onClick={() => onPreview(r.t!)}>
                  ▶
                </button>
                <button type="button" className="btn btn-sm" title="Parar" onClick={onStop}>
                  ■
                </button>
                <button type="button" className="btn btn-sm" title="Cortes y puntos" onClick={() => onEditCuts(r.t!)}>
                  ✂
                </button>
              </>
            )}
            <button type="button" className="btn btn-sm" title="Subir" onClick={() => move(r.i, r.i - 1)}>
              ↑
            </button>
            <button type="button" className="btn btn-sm" title="Bajar" onClick={() => move(r.i, r.i + 1)}>
              ↓
            </button>
            <button type="button" className="btn btn-sm" title="Quitar" onClick={() => remove(r.i)}>
              ✕
            </button>
          </li>
        ))}
      </ol>
      {pl && rows.length === 0 && <p className="hint">Playlist vacía. Busca canciones arriba o añádelas desde Música con «+».</p>}
      {!pl && <p className="hint">Aún no hay playlists. Crea una con «Nueva».</p>}
    </div>
  );
}
