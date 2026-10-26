import { useMemo, useState } from "react";
import { trackUrl } from "../api";
import type { Track } from "../types";

export type GalleryView = "artists" | "albums" | "genres";

const VIEW_KEY = "miradio.music.view";
export const UNKNOWN_ARTIST = "Artista desconocido";
const PAGE = 120;

export function loadGalleryView(): GalleryView {
  try {
    const v = localStorage.getItem(VIEW_KEY);
    if (v === "artists" || v === "albums" || v === "genres") return v;
  } catch {
    /* sin almacenamiento */
  }
  return "artists";
}

export function coverSrc(cover: string): string {
  if (!cover) return "";
  return /^(https?:|data:|blob:)/.test(cover) ? cover : trackUrl({ file: cover });
}

export const artistOf = (t: Track) => t.artist.trim() || UNKNOWN_ARTIST;

/** Selecciones de la vista Música (se guardan como texto). */
export const sel = {
  artist: (name: string) => `artist:${name}`,
  album: (artist: string, album: string) => `album:${artist}\u0001${album}`,
  genre: (name: string) => `genre:${name}`,
};

export function parseSel(s: string): { kind: "artist" | "album" | "genre"; a: string; b: string } | null {
  const i = s.indexOf(":");
  if (i < 0) return null;
  const kind = s.slice(0, i);
  const rest = s.slice(i + 1);
  if (kind === "artist" || kind === "genre") return { kind, a: rest, b: "" };
  if (kind === "album") {
    const [a, b = ""] = rest.split("\u0001");
    return { kind, a, b };
  }
  return null;
}

export function matchesSel(t: Track, s: string): boolean {
  const p = parseSel(s);
  if (!p) return true;
  if (p.kind === "artist") return artistOf(t) === p.a;
  if (p.kind === "genre") return (t.genre.trim() || "Sin estilo") === p.a;
  return artistOf(t) === p.a && t.album.trim() === p.b;
}

interface Card {
  key: string;
  title: string;
  sub: string;
  cover: string;
  count: number;
}

/** Color estable para los estilos sin portada. */
function hue(name: string): number {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return h % 360;
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? "")
    .join("");
}

/** Albumes de un artista (para su pagina). */
export function albumsOf(tracks: Track[], artist: string): Card[] {
  const map = new Map<string, Card>();
  for (const t of tracks) {
    if (artistOf(t) !== artist || !t.album.trim()) continue;
    const name = t.album.trim();
    const c = map.get(name) ?? { key: sel.album(artist, name), title: name, sub: t.year || "", cover: "", count: 0 };
    c.count++;
    if (!c.cover && t.cover) c.cover = t.cover;
    if (!c.sub && t.year) c.sub = t.year;
    map.set(name, c);
  }
  return [...map.values()].sort((a, b) => (a.sub || "9999").localeCompare(b.sub || "9999") || a.title.localeCompare(b.title, "es"));
}

/**
 * Musica al estilo iTunes/MusicBee: cuadricula de artistas, albumes o estilos
 * con sus portadas. Al elegir uno se abre su pagina (la lista de canciones).
 */
export function MusicGallery({
  tracks,
  query,
  onOpen,
}: {
  tracks: Track[];
  query: string;
  onOpen: (selection: string) => void;
}) {
  const [view, setViewState] = useState<GalleryView>(loadGalleryView);
  const [shown, setShown] = useState(PAGE);
  const setView = (v: GalleryView) => {
    setViewState(v);
    setShown(PAGE);
    try {
      localStorage.setItem(VIEW_KEY, v);
    } catch {
      /* sin almacenamiento */
    }
  };

  const cards = useMemo<Card[]>(() => {
    const map = new Map<string, Card>();
    for (const t of tracks) {
      let key: string;
      let title: string;
      let sub = "";
      if (view === "artists") {
        title = artistOf(t);
        key = sel.artist(title);
      } else if (view === "albums") {
        if (!t.album.trim()) continue;
        title = t.album.trim();
        sub = artistOf(t);
        key = sel.album(sub, title);
      } else {
        title = t.genre.trim() || "Sin estilo";
        key = sel.genre(title);
      }
      const c = map.get(key) ?? { key, title, sub, cover: "", count: 0 };
      c.count++;
      if (!c.cover && t.cover) c.cover = t.cover;
      map.set(key, c);
    }
    const q = query.trim().toLowerCase();
    let list = [...map.values()];
    if (q) list = list.filter((c) => `${c.title} ${c.sub}`.toLowerCase().includes(q));
    return list.sort((a, b) =>
      view === "genres" ? b.count - a.count || a.title.localeCompare(b.title, "es") : a.title.localeCompare(b.title, "es"),
    );
  }, [tracks, view, query]);

  const unit = (n: number) => (n === 1 ? "1 canción" : `${n} canciones`);

  return (
    <div className="gallery">
      <div className="gallery-views" role="tablist" aria-label="Ver por">
        {(
          [
            ["artists", "Artistas"],
            ["albums", "Álbumes"],
            ["genres", "Estilos"],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={view === id}
            className={`gallery-view ${view === id ? "gallery-view-on" : ""}`}
            onClick={() => setView(id)}
          >
            {label}
          </button>
        ))}
        <span className="gallery-count">{cards.length}</span>
      </div>
      <div
        className="gallery-grid"
        onScroll={(e) => {
          const el = e.currentTarget;
          if (el.scrollTop + el.clientHeight > el.scrollHeight - 300 && shown < cards.length) {
            setShown((n) => Math.min(cards.length, n + PAGE));
          }
        }}
      >
        {cards.length === 0 && (
          <div className="empty-note">
            {tracks.length === 0 ? "La biblioteca está vacía." : "Nada coincide con la búsqueda."}
          </div>
        )}
        {cards.slice(0, shown).map((c) => (
          <button
            key={c.key}
            type="button"
            className={`gcard ${view === "artists" ? "gcard-artist" : ""}`}
            onClick={() => onOpen(c.key)}
            title={`${c.title}${c.sub ? ` — ${c.sub}` : ""} · ${unit(c.count)}`}
          >
            <span
              className="gcard-art"
              style={c.cover ? undefined : { background: `hsl(${hue(c.title)} 35% 26%)` }}
            >
              {c.cover ? <img src={coverSrc(c.cover)} alt="" loading="lazy" draggable={false} /> : <span>{initials(c.title)}</span>}
            </span>
            <span className="gcard-title">{c.title}</span>
            <span className="gcard-sub">{c.sub ? `${c.sub} · ` : ""}{unit(c.count)}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

/** Cabecera de la pagina de un artista, album o estilo. */
export function GalleryHeader({
  tracks,
  selection,
  count,
  backTo,
  onBack,
  onOpen,
}: {
  tracks: Track[];
  selection: string;
  count: number;
  /** Seleccion anterior (volver a ella); vacio = a la cuadricula */
  backTo: string;
  onBack: () => void;
  onOpen: (selection: string) => void;
}) {
  const p = parseSel(selection);
  const cover = useMemo(() => tracks.find((t) => matchesSel(t, selection) && t.cover)?.cover ?? "", [tracks, selection]);
  const albums = useMemo(() => (p?.kind === "artist" ? albumsOf(tracks, p.a) : []), [tracks, p?.kind, p?.a]);
  if (!p) return null;
  const title = p.kind === "album" ? p.b : p.a;
  const sub =
    p.kind === "album"
      ? p.a
      : p.kind === "artist"
        ? `${albums.length === 1 ? "1 álbum" : `${albums.length} álbumes`}`
        : "Estilo";
  const prev = backTo ? parseSel(backTo) : null;
  const backLabel = prev
    ? prev.kind === "album"
      ? prev.b
      : prev.a
    : p.kind === "album"
      ? "Álbumes"
      : p.kind === "artist"
        ? "Artistas"
        : "Estilos";
  return (
    <div className="gpage">
      <div className="gpage-head">
        <button type="button" className="gpage-back" onClick={onBack} title={`Volver a ${backLabel}`}>
          ‹ {backLabel}
        </button>
        <span className="gpage-art" style={cover ? undefined : { background: `hsl(${hue(title)} 35% 26%)` }}>
          {cover ? <img src={coverSrc(cover)} alt="" draggable={false} /> : <span>{initials(title)}</span>}
        </span>
        <div className="gpage-info">
          <strong title={title}>{title || "Sin título"}</strong>
          <span>
            {sub} · {count === 1 ? "1 canción" : `${count} canciones`}
          </span>
          {p.kind === "album" && (
            <button type="button" className="ghost-btn gpage-link" onClick={() => onOpen(sel.artist(p.a))}>
              Ver artista
            </button>
          )}
        </div>
      </div>
      {albums.length > 0 && (
        <div className="gpage-albums">
          {albums.map((a) => (
            <button key={a.key} type="button" className="galbum" onClick={() => onOpen(a.key)} title={`${a.title} · ${a.count} canciones`}>
              <span className="galbum-art" style={a.cover ? undefined : { background: `hsl(${hue(a.title)} 35% 26%)` }}>
                {a.cover ? <img src={coverSrc(a.cover)} alt="" loading="lazy" draggable={false} /> : <span>{initials(a.title)}</span>}
              </span>
              <span className="galbum-title">{a.title}</span>
              {a.sub && <span className="galbum-sub">{a.sub}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
