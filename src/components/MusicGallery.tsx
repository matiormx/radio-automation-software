import { useEffect, useMemo, useRef, useState } from "react";
import { artistImage, trackUrl } from "../api";
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

/**
 * Artistas de una canción: «A, B», «A / B», «A; B», «A feat. B» o los que
 * venían separados por un carácter nulo cuentan para cada uno.
 */
export function splitArtists(raw: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const part of raw.split(/\u0000|\s*[,;]\s*|\s+\/\s+|\s+(?:feat\.?|ft\.?|featuring)\s+/i)) {
    const name = part.trim();
    const k = name.toLowerCase();
    if (!name || seen.has(k)) continue;
    seen.add(k);
    out.push(name);
  }
  return out.length > 0 ? out : [UNKNOWN_ARTIST];
}

export const artistsOf = (t: Track) => splitArtists(t.artist);
/** Primer artista (el principal) */
export const artistOf = (t: Track) => artistsOf(t)[0];

const norm = (s: string) => s.trim().toLowerCase();
/** «Artista del álbum» limpio (puede venir vacío) */
const albumArtistOf = (t: Track) => splitArtists(t.albumArtist ?? "").join(", ").replace(UNKNOWN_ARTIST, "");

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
  if (p.kind === "artist") return artistsOf(t).some((a) => norm(a) === norm(p.a));
  if (p.kind === "genre") return (t.genre.trim() || "Sin estilo") === p.a;
  // Álbum: por su nombre y, si lo tiene, por el «artista del álbum».
  if (norm(t.album) !== norm(p.b)) return false;
  return norm(albumArtistOf(t)) === norm(p.a);
}

/** Álbumes agrupados: nombre + artista del álbum (si lo hay). */
function albumCards(tracks: Track[]): Card[] {
  const map = new Map<string, Card & { artists: Map<string, number> }>();
  for (const t of tracks) {
    const name = t.album.trim();
    if (!name) continue;
    const aa = albumArtistOf(t);
    const id = `${norm(aa)}\u0001${norm(name)}`;
    const c = map.get(id) ?? { key: sel.album(aa, name), title: name, sub: aa, cover: "", count: 0, artists: new Map() };
    c.count++;
    if (!c.cover && t.cover) c.cover = t.cover;
    const first = artistOf(t);
    c.artists.set(first, (c.artists.get(first) ?? 0) + 1);
    map.set(id, c);
  }
  return [...map.values()].map(({ artists, ...c }) => ({
    ...c,
    // Sin «artista del álbum»: el artista si es el mismo en todo el álbum.
    sub: c.sub || (artists.size === 1 ? [...artists.keys()][0] : "Varios artistas"),
  }));
}

// ---- fotos de artistas (Deezer), con caché y pocas peticiones a la vez ----
const photoCache = new Map<string, string | null>();
const photoWaiting = new Map<string, ((v: string | null) => void)[]>();
const photoQueue: string[] = [];
let photoActive = 0;

function pumpPhotos() {
  while (photoActive < 3 && photoQueue.length > 0) {
    const name = photoQueue.shift()!;
    photoActive++;
    void artistImage(name)
      .catch(() => null)
      .then((path) => {
        photoCache.set(name, path ?? null);
        for (const cb of photoWaiting.get(name) ?? []) cb(path ?? null);
        photoWaiting.delete(name);
      })
      .finally(() => {
        photoActive--;
        pumpPhotos();
      });
  }
}

function requestPhoto(name: string, cb: (v: string | null) => void) {
  if (photoCache.has(name)) {
    cb(photoCache.get(name) ?? null);
    return;
  }
  const list = photoWaiting.get(name);
  if (list) {
    list.push(cb);
    return;
  }
  photoWaiting.set(name, [cb]);
  photoQueue.push(name);
  pumpPhotos();
}

/** Foto del artista cuando la tarjeta se ve (no se piden las 800 de golpe). */
function useArtistPhoto(name: string, enabled: boolean): [React.RefObject<HTMLSpanElement | null>, string | null] {
  const ref = useRef<HTMLSpanElement | null>(null);
  const [photo, setPhoto] = useState<string | null>(() => photoCache.get(name) ?? null);
  useEffect(() => {
    if (!enabled || name === UNKNOWN_ARTIST) return;
    let alive = true;
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        io.disconnect();
        requestPhoto(name, (v) => alive && setPhoto(v));
      }
    });
    io.observe(el);
    return () => {
      alive = false;
      io.disconnect();
    };
  }, [name, enabled]);
  return [ref, photo];
}

/** Imagen de una tarjeta: foto del artista, portada o iniciales. */
function CardArt({ className, title, cover, artist }: { className: string; title: string; cover: string; artist?: string }) {
  const [ref, photo] = useArtistPhoto(artist ?? "", !!artist);
  const src = photo || cover;
  return (
    <span ref={ref} className={className} style={src ? undefined : { background: `hsl(${hue(title)} 35% 26%)` }}>
      {src ? <img src={coverSrc(src)} alt="" loading="lazy" draggable={false} /> : <span>{initials(title)}</span>}
    </span>
  );
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

/** Álbumes de un artista (para su página): donde canta o es el artista del álbum. */
export function albumsOf(tracks: Track[], artist: string): Card[] {
  const mine = tracks.filter(
    (t) => artistsOf(t).some((a) => norm(a) === norm(artist)) || norm(albumArtistOf(t)) === norm(artist),
  );
  const keys = new Set(albumCards(mine).map((c) => c.key));
  const years = new Map<string, string>();
  for (const t of mine) if (t.year) years.set(sel.album(albumArtistOf(t), t.album.trim()), t.year);
  return albumCards(tracks)
    .filter((c) => keys.has(c.key))
    .map((c) => ({ ...c, sub: years.get(c.key) ?? "" }))
    .sort((a, b) => (a.sub || "9999").localeCompare(b.sub || "9999") || a.title.localeCompare(b.title, "es"));
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
    let list: Card[];
    if (view === "albums") {
      list = albumCards(tracks);
    } else {
      const map = new Map<string, Card>();
      for (const t of tracks) {
        // Una canción con varios artistas cuenta para cada uno.
        const names = view === "artists" ? artistsOf(t) : [t.genre.trim() || "Sin estilo"];
        for (const title of names) {
          const id = norm(title);
          const key = view === "artists" ? sel.artist(title) : sel.genre(title);
          const c = map.get(id) ?? { key, title, sub: "", cover: "", count: 0 };
          c.count++;
          if (!c.cover && t.cover) c.cover = t.cover;
          map.set(id, c);
        }
      }
      list = [...map.values()];
    }
    const q = query.trim().toLowerCase();
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
            <CardArt className="gcard-art" title={c.title} cover={c.cover} artist={view === "artists" ? c.title : undefined} />
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
  const albumBy = p.kind === "album" ? p.a || (() => {
    const set = new Set(tracks.filter((t) => matchesSel(t, selection)).map(artistOf));
    return set.size === 1 ? [...set][0] : "Varios artistas";
  })() : "";
  const sub =
    p.kind === "album"
      ? albumBy
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
        <CardArt className="gpage-art" title={title} cover={cover} artist={p.kind === "artist" ? p.a : undefined} />
        <div className="gpage-info">
          <strong title={title}>{title || "Sin título"}</strong>
          <span>
            {sub} · {count === 1 ? "1 canción" : `${count} canciones`}
          </span>
          {p.kind === "album" && albumBy !== "Varios artistas" && (
            <button type="button" className="ghost-btn gpage-link" onClick={() => onOpen(sel.artist(splitArtists(albumBy)[0]))}>
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
