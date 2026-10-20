import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  listTracks,
  listPlaylists,
  savePlaylist,
  deletePlaylist,
  importFiles,
  deleteTrack,
  pickAudioFiles,
  onWindowFileDrop,
  AUDIO_EXTENSIONS,
} from "./api";
import type { Track, Playlist, PlaylistRow } from "./types";
import { RadioPlayer } from "./audio";import { LibraryZone } from "./components/LibraryZone";
import { PlaylistZone } from "./components/PlaylistZone";
import { DeckZone } from "./components/DeckZone";
import { PlayerBar } from "./components/PlayerBar";
import { LogoRadio } from "./icons";

function extOk(path: string): boolean {
  const dot = path.lastIndexOf(".");
  if (dot < 0) return false;
  return AUDIO_EXTENSIONS.includes(path.slice(dot + 1).toLowerCase());
}

export default function App() {
  const [tracks, setTracks] = useState<Track[]>([]);
  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  const [activeId, setActiveId] = useState("");
  const [playingRow, setPlayingRow] = useState(-1);
  const [paused, setPaused] = useState(true);
  const [pos, setPos] = useState({ cur: 0, total: 0 });
  const [fadeSeconds, setFadeSeconds] = useState(6);
  const [loopOn, setLoopOn] = useState(false);
  const [dropHover, setDropHover] = useState(false);
  const [importing, setImporting] = useState(false);
  const [toast, setToast] = useState("");

  const playerRef = useRef<RadioPlayer | null>(null);
  const posRef = useRef(pos);
  const toastTimer = useRef(0);

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(""), 2600);
  }, []);

  // Motor de audio (una sola vez)
  useEffect(() => {
    const player = new RadioPlayer();
    player.onIndexChange = (i) => setPlayingRow(i);
    player.onEnded = () => {
      setPlayingRow(-1);
      setPaused(true);
    };
    player.onTick = (cur, total) => {
      const curS = Math.floor(cur);
      const totalS = Math.floor(total);
      if (curS !== posRef.current.cur || totalS !== posRef.current.total) {
        posRef.current = { cur: curS, total: totalS };
        setPos(posRef.current);
      }
    };
    playerRef.current = player;
    return () => {
      player.onIndexChange = null;
      player.onTick = null;
      player.onEnded = null;
      player.dispose();
      playerRef.current = null;
    };
  }, []);

  // Datos iniciales
  useEffect(() => {
    void (async () => {
      try {
        const [t, ps] = await Promise.all([listTracks(), listPlaylists()]);
        setTracks(t);
        setPlaylists(ps);
        setActiveId(ps[0]?.id ?? "");
      } catch (e) {
        showToast(`Algo fallo al cargar: ${String(e)}`);
      }
    })();
  }, [showToast]);

  const active = useMemo(
    () => playlists.find((p) => p.id === activeId) ?? playlists[0],
    [playlists, activeId],
  );

  // Filas de la lista activa, resueltas con datos de la Biblio
  const rows: PlaylistRow[] = useMemo(() => {
    if (!active) return [];
    const byId = new Map(tracks.map((t) => [t.id, t]));
    return active.trackIds.flatMap((id) => {
      const t = byId.get(id);
      return t
        ? [{ id: t.id, title: t.title, artist: t.artist, durationSecs: t.durationSecs }]
        : [];
    });
  }, [active, tracks]);

  // La lista que ve la pantalla es la misma que suena
  useEffect(() => {
    const byId = new Map(tracks.map((t) => [t.id, t]));
    const full = rows.flatMap((r) => {
      const t = byId.get(r.id);
      return t ? [t] : [];
    });
    playerRef.current?.setPlaylist(full);
  }, [rows, tracks]);

  // Preferencias
  useEffect(() => {
    if (playerRef.current) playerRef.current.fadeSeconds = fadeSeconds;
  }, [fadeSeconds]);
  useEffect(() => {
    if (playerRef.current) playerRef.current.loop = loopOn;
  }, [loopOn]);

  // Arrastrar archivos desde el escritorio: quedan guardados
  useEffect(() => {
    let alive = true;
    let unlisten: (() => void) | undefined;
    void onWindowFileDrop({
      onDrop: (paths) => {
        if (!alive) return;
        setDropHover(false);
        doImport(paths);
      },
      onEnter: () => setDropHover(true),
      onLeave: () => setDropHover(false),
    }).then((u) => {
      unlisten = u;
    });
    return () => {
      alive = false;
      unlisten?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const doImport = useCallback(
    async (paths: string[]) => {
      const ok = paths.filter(extOk);
      if (ok.length === 0) {
        showToast("Eso no es una cancion. Prueba con mp3, wav, ogg o m4a");
        return;
      }
      setImporting(true);
      try {
        const added = await importFiles(ok);
        const fresh = await listTracks();
        setTracks(fresh);
        showToast(
          added.length === 1 ? "1 cancion guardada" : `${added.length} canciones guardadas`,
        );
      } catch (e) {
        showToast(`No pude guardar las canciones: ${String(e)}`);
      } finally {
        setImporting(false);
      }
    },
    [showToast],
  );

  const pickFiles = useCallback(async () => {
    const paths = await pickAudioFiles();
    if (paths && paths.length > 0) await doImport(paths);
  }, [doImport]);

  const removeTrack = useCallback(
    async (t: Track) => {
      try {
        await deleteTrack(t.id);
        setTracks((prev) => prev.filter((x) => x.id !== t.id));
        showToast(`Se borro "${t.title}" de la Biblio`);
      } catch (e) {
        showToast(`No pude borrar: ${String(e)}`);
      }
    },
    [showToast],
  );

  // Mutar la lista activa
  const mutateActive = useCallback(
    async (fn: (ids: string[]) => string[], nextName?: string) => {
      if (!active) return;
      const updated: Playlist = {
        ...active,
        name: nextName ?? active.name,
        trackIds: fn(active.trackIds),
      };
      setPlaylists((prev) => prev.map((p) => (p.id === updated.id ? updated : p)));
      try {
        await savePlaylist(updated);
      } catch (e) {
        showToast(`No pude guardar la lista: ${String(e)}`);
      }
    },
    [active, showToast],
  );

  const addTrack = useCallback(
    (t: Track) => {
      void mutateActive((ids) => [...ids, t.id]);
      showToast(`Se agrego "${t.title}" a la lista`);
    },
    [mutateActive, showToast],
  );

  const removeRow = useCallback(
    (i: number) => {
      void mutateActive((ids) => ids.filter((_, idx) => idx !== i));
    },
    [mutateActive],
  );

  const reorderRow = useCallback(
    (from: number, to: number) => {
      void mutateActive((ids) => {
        const copy = [...ids];
        const [moved] = copy.splice(from, 1);
        copy.splice(Math.max(0, Math.min(copy.length, to)), 0, moved);
        return copy;
      });
    },
    [mutateActive],
  );

  const renamePlaylist = useCallback(
    (name: string) => {
      void mutateActive((ids) => ids, name);
    },
    [mutateActive],
  );

  const newPlaylist = useCallback(async () => {
    const n = playlists.length + 1;
    const pl: Playlist = {
      id: `pl-${Date.now()}`,
      name: `Lista ${n}`,
      trackIds: [],
    };
    try {
      await savePlaylist(pl);
      setPlaylists((prev) => [...prev, pl]);
      setActiveId(pl.id);
      setPlayingRow(-1);
      showToast(`Lista "${pl.name}" creada`);
    } catch (e) {
      showToast(`No pude crear la lista: ${String(e)}`);
    }
  }, [playlists, showToast]);

  const removeActivePlaylist = useCallback(async () => {
    if (!active || playlists.length <= 1) return;
    try {
      await deletePlaylist(active.id);
      const rest = playlists.filter((p) => p.id !== active.id);
      setPlaylists(rest);
      setActiveId(rest[0].id);
      setPlayingRow(-1);
      showToast("Lista borrada");
    } catch (e) {
      showToast(`No pude borrar la lista: ${String(e)}`);
    }
  }, [active, playlists, showToast]);

  // ---- audio ----
  const playRow = useCallback(async (i: number) => {
    const p = playerRef.current;
    if (!p) return;
    await p.playAt(i);
    setPaused(!p.isPlaying);
  }, []);

  const togglePlay = useCallback(async () => {
    const p = playerRef.current;
    if (!p) return;
    await p.toggle();
    setPaused(!p.isPlaying);
  }, []);

  const next = useCallback(async () => {
    const p = playerRef.current;
    if (!p) return;
    await p.next();
    setPaused(!p.isPlaying);
  }, []);

  const prev = useCallback(async () => {
    const p = playerRef.current;
    if (!p) return;
    await p.prev();
    setPaused(!p.isPlaying);
  }, []);

  const seek = useCallback((seconds: number) => {
    void playerRef.current?.seek(seconds);
  }, []);

  const setVolume = useCallback((v: number) => {
    playerRef.current?.setVolume(v);
  }, []);

  const deckRow = rows[playingRow] ?? null;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <LogoRadio size={42} />
          <div>
            <h1>MiRadio</h1>
            <p>Tu radio, facil y divertida</p>
          </div>
        </div>
        <nav className="pl-tabs" aria-label="Listas de reproduccion">
          {playlists.map((p) => (
            <button
              key={p.id}
              type="button"
              className={`pl-tab ${p.id === active?.id ? "pl-tab-on" : ""}`}
              onClick={() => setActiveId(p.id)}
            >
              {p.name}
            </button>
          ))}
          {playlists.length > 1 && (
            <button
              type="button"
              className="chip-btn danger"
              onClick={() => void removeActivePlaylist()}
              title="Borrar la lista que esta abierta"
            >
              Borrar lista
            </button>
          )}
        </nav>
        {importing && <span className="badge-busy">Guardando canciones...</span>}
      </header>

      <main className="main">
        <LibraryZone
          tracks={tracks}
          onAdd={addTrack}
          onDelete={(t) => void removeTrack(t)}
          onPickFiles={() => void pickFiles()}
        />

        <div className="right-col">
          <DeckZone
            title={deckRow?.title ?? ""}
            artist={deckRow?.artist ?? ""}
            current={pos.cur}
            total={pos.total}
            spinning={!paused && playingRow >= 0}
            onSeek={seek}
          />
          <PlaylistZone
            name={active?.name ?? ""}
            rows={rows}
            playingRow={playingRow}
            onRename={renamePlaylist}
            onPlayRow={(i) => void playRow(i)}
            onReorder={reorderRow}
            onRemove={removeRow}
            onNewPlaylist={() => void newPlaylist()}
          />
        </div>
      </main>

      <PlayerBar
        paused={paused}
        loop={loopOn}
        fadeSeconds={fadeSeconds}
        hasPlaylist={rows.length > 0}
        onTogglePlay={() => void togglePlay()}
        onNext={() => void next()}
        onPrev={() => void prev()}
        onLoopChange={setLoopOn}
        onFadeChange={setFadeSeconds}
        onVolume={setVolume}
      />

      {dropHover && (
        <div className="drop-overlay" aria-hidden="true">
          <div className="drop-overlay-box">
            <strong>Sueltalas!</strong>
            <span>Las canciones quedan guardadas aca</span>
          </div>
        </div>
      )}

      {toast && (
        <div className="toast" role="status">
          {toast}
        </div>
      )}
    </div>
  );
}
