import { useEffect, useRef, useState } from "react";
import type { DeezerTrack } from "../types";
import { deezerSearch, deezerTrack } from "../api";
import { IconSearch } from "../icons";

interface Props {
  /** Texto inicial de busqueda (p. ej. "artista titulo") */
  initialQuery?: string;
  onClose: () => void;
  /** Resultado elegido, con año y género ya completados si Deezer los da */
  onPick: (track: DeezerTrack) => void;
  showToast: (msg: string) => void;
}

function fmt(secs: number): string {
  return `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`;
}

/**
 * Busca una cancion en Deezer (solo metadatos y preview de 30 s) para
 * rellenar los datos de una cancion de la biblioteca. No descarga audio.
 */
export function DeezerSearch({ initialQuery = "", onClose, onPick, showToast }: Props) {
  const [query, setQuery] = useState(initialQuery);
  const [results, setResults] = useState<DeezerTrack[]>([]);
  const [busy, setBusy] = useState(false);
  const [searched, setSearched] = useState(false);
  const [playing, setPlaying] = useState<number | null>(null);
  const [pickingId, setPickingId] = useState<number | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => () => audioRef.current?.pause(), []);
  useEffect(() => {
    if (initialQuery.trim()) void search();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const search = async () => {
    if (!query.trim()) return;
    setBusy(true);
    try {
      setResults(await deezerSearch(query));
      setSearched(true);
    } catch (e) {
      showToast(String(e));
    } finally {
      setBusy(false);
    }
  };

  const togglePreview = (t: DeezerTrack) => {
    if (!audioRef.current) audioRef.current = new Audio();
    const a = audioRef.current;
    if (playing === t.id) {
      a.pause();
      setPlaying(null);
      return;
    }
    a.src = t.preview;
    a.onended = () => setPlaying(null);
    void a.play().catch(() => showToast("No se pudo reproducir la preview"));
    setPlaying(t.id);
  };

  const pick = async (t: DeezerTrack) => {
    setPickingId(t.id);
    let info = t;
    try {
      info = await deezerTrack(t.id);
    } catch {
      // sin detalle extra: se usan los datos de la busqueda
    }
    audioRef.current?.pause();
    onPick(info);
  };

  return (
    <div className="modal-backdrop deezer-modal" onClick={onClose}>
      <div
        className="modal modal-wide"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Buscar datos en Deezer"
      >
        <div className="modal-head">
          <h3>Datos de Deezer</h3>
          <button type="button" className="ghost-btn" onClick={onClose}>
            Cerrar
          </button>
        </div>
        <div className="modal-body">
          <p className="hint">
            Elige el resultado correcto para rellenar título, artista, álbum, año y género.
            Revisa los datos antes de guardar. Deezer solo aporta información y una preview de 30 s.
          </p>
          <form
            className="deezer-form"
            onSubmit={(e) => {
              e.preventDefault();
              void search();
            }}
          >
            <div className="search-box">
              <IconSearch size={14} />
              <input
                autoFocus
                type="search"
                placeholder="Artista, canción o álbum…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
            <button type="submit" className="btn btn-sm" disabled={busy || !query.trim()}>
              {busy ? "Buscando…" : "Buscar"}
            </button>
          </form>

          {searched && results.length === 0 && <p className="hint">Sin resultados.</p>}
          <ul className="deezer-list">
            {results.map((t) => (
              <li key={t.id} className="deezer-row">
                {t.cover ? <img src={t.cover} alt="" width={44} height={44} /> : <div className="deezer-nocover" />}
                <div className="deezer-info">
                  <strong>{t.title}</strong>
                  <span>
                    {t.artist} · {t.album} · {fmt(t.durationSecs)}
                  </span>
                </div>
                {t.preview && (
                  <button type="button" className="btn btn-sm" onClick={() => togglePreview(t)}>
                    {playing === t.id ? "Parar" : "Preview"}
                  </button>
                )}
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={pickingId !== null}
                  onClick={() => void pick(t)}
                >
                  {pickingId === t.id ? "Cargando…" : "Usar estos datos"}
                </button>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}
