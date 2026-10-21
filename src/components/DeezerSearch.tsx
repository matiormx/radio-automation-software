import { useEffect, useRef, useState } from "react";
import type { DeezerTrack } from "../types";
import { deezerSearch, deezerTrack, importFiles, pickSingleAudioFile, updateTrack } from "../api";
import { IconSearch } from "../icons";

interface Props {
  onClose: () => void;
  /** Refresca la biblioteca tras importar */
  onImported: () => Promise<void>;
  showToast: (msg: string) => void;
}

function fmt(secs: number): string {
  return `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`;
}

/**
 * Busca una cancion en Deezer (solo metadatos y preview de 30 s) y la
 * importa a la carpeta de musica usando un archivo de audio que el usuario
 * ya tiene. No descarga audio de Deezer.
 */
export function DeezerSearch({ onClose, onImported, showToast }: Props) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<DeezerTrack[]>([]);
  const [busy, setBusy] = useState(false);
  const [searched, setSearched] = useState(false);
  const [playing, setPlaying] = useState<number | null>(null);
  const [importingId, setImportingId] = useState<number | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => () => audioRef.current?.pause(), []);

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

  const importWith = async (t: DeezerTrack) => {
    const path = await pickSingleAudioFile();
    if (!path) return;
    setImportingId(t.id);
    try {
      const [added] = await importFiles([path], "a");
      if (!added) {
        showToast("No se pudo importar el archivo");
        return;
      }
      let info = t;
      try {
        info = await deezerTrack(t.id);
      } catch {
        // sin detalle extra: se usan los datos de la busqueda
      }
      await updateTrack(added.id, {
        title: info.title,
        artist: info.artist,
        album: info.album,
        year: info.year || undefined,
        genre: info.genre || undefined,
      });
      await onImported();
      showToast(`Importada: ${info.artist} - ${info.title}`);
    } catch (e) {
      showToast(`No se pudo importar: ${String(e)}`);
    } finally {
      setImportingId(null);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal modal-wide"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Buscar en Deezer"
      >
        <div className="modal-head">
          <h3>Buscar en Deezer</h3>
          <button type="button" className="ghost-btn" onClick={onClose}>
            Cerrar
          </button>
        </div>
        <div className="modal-body">
          <p className="hint">
            Busca la canción para obtener título, artista, álbum, año y género, y elige tu
            archivo de audio (FLAC, MP3…) para importarlo a la carpeta de música con esos
            datos. Deezer solo aporta la información y una preview de 30 s.
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
                  disabled={importingId !== null}
                  onClick={() => void importWith(t)}
                  title="Elegir tu archivo de audio e importarlo con estos datos"
                >
                  {importingId === t.id ? "Importando…" : "Importar"}
                </button>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}
