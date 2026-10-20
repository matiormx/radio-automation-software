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
  getSettings,
  saveSettings,
  reportStarted,
  autoPick,
  AUDIO_EXTENSIONS,
} from "./api";
import type { Track, Playlist, PlaylistRow, Settings } from "./types";
import { DEFAULT_SETTINGS } from "./types";
import { RadioPlayer } from "./audio";
import { LibraryZone } from "./components/LibraryZone";
import { PlaylistZone } from "./components/PlaylistZone";
import { DeckZone } from "./components/DeckZone";
import { PlayerBar } from "./components/PlayerBar";
import { SettingsPanel } from "./components/SettingsPanel";
import { IconGear, LogoRadio } from "./icons";

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
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [autoIds, setAutoIds] = useState<Set<string>>(new Set());
  const [dropHover, setDropHover] = useState(false);
  const [importing, setImporting] = useState(false);
  const [toast, setToast] = useState("");
  const [clock, setClock] = useState("");

  const playerRef = useRef<RadioPlayer | null>(null);
  const posRef = useRef(pos);
  const toastTimer = useRef(0);
  const topupBusy = useRef(false);

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(""), 3200);
  }, []);

  // Reloj
  useEffect(() => {
    const tick = () =>
      setClock(new Date().toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit", second: "2-digit" }));
    tick();
    const t = window.setInterval(tick, 1000);
    return () => window.clearInterval(t);
  }, []);

  // Motor de audio
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

  const active = useMemo(
    () => playlists.find((p) => p.id === activeId) ?? playlists[0],
    [playlists, activeId],
  );

  // Filas resueltas con datos de la biblioteca
  const rows: PlaylistRow[] = useMemo(() => {
    if (!active) return [];
    const byId = new Map(tracks.map((t) => [t.id, t]));
    return active.trackIds.flatMap((id) => {
      const t = byId.get(id);
      return t ? [{ id: t.id, title: t.title, artist: t.artist, durationSecs: t.durationSecs }] : [];
    });
  }, [active, tracks]);

  const rowsRef = useRef(rows);
  rowsRef.current = rows;

  // La lista en pantalla es la misma que suena
  useEffect(() => {
    const byId = new Map(tracks.map((t) => [t.id, t]));
    const full = rows.flatMap((r) => {
      const t = byId.get(r.id);
      return t ? [t] : [];
    });
    playerRef.current?.setPlaylist(full);
  }, [rows, tracks]);

  // Persistir la carga inicial de ajustes en el motor
  useEffect(() => {
    const p = playerRef.current;
    if (p) {
      p.fadeSeconds = settings.fadeSeconds;
      p.loop = false;
      p.setVolume(settings.masterVolume);
    }
  }, [settings.fadeSeconds, settings.masterVolume]);

  // Carga inicial de datos
  useEffect(() => {
    void (async () => {
      try {
        const [t, ps, s] = await Promise.all([listTracks(), listPlaylists(), getSettings()]);
        setTracks(t);
        setPlaylists(ps);
        setActiveId(ps[0]?.id ?? "");
        setSettings(s);
      } catch (e) {
        showToast(`Error al cargar: ${String(e)}`);
      }
    })();
  }, [showToast]);

  // Historial: cada pista que empieza se anota para las reglas de rotación
  useEffect(() => {
    if (playingRow < 0) return;
    const r = rowsRef.current[playingRow];
    if (r) void reportStarted(r.id).catch(() => undefined);
  }, [playingRow]);

  // Arrastrar archivos desde el escritorio
  const doImport = useCallback(
    async (paths: string[]) => {
      const ok = paths.filter(extOk);
      if (ok.length === 0) {
        showToast("Formato no reconocido. Usa audio: mp3, wav, flac, ogg, m4a…");
        return;
      }
      setImporting(true);
      try {
        const added = await importFiles(ok);
        setTracks(await listTracks());
        showToast(added.length === 1 ? "1 canción importada" : `${added.length} canciones importadas`);
      } catch (e) {
        showToast(`No se pudieron importar: ${String(e)}`);
      } finally {
        setImporting(false);
      }
    },
    [showToast],
  );

  useEffect(() => {
    let alive = true;
    let unlisten: (() => void) | undefined;
    void onWindowFileDrop({
      onDrop: (paths) => {
        if (!alive) return;
        setDropHover(false);
        void doImport(paths);
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

  const pickFiles = useCallback(async () => {
    const paths = await pickAudioFiles();
    if (paths && paths.length > 0) await doImport(paths);
  }, [doImport]);

  const removeTrack = useCallback(
    async (t: Track) => {
      try {
        await deleteTrack(t.id);
        setTracks((prev) => prev.filter((x) => x.id !== t.id));
        showToast(`«${t.title}» eliminada de la biblioteca`);
      } catch (e) {
        showToast(`No se pudo eliminar: ${String(e)}`);
      }
    },
    [showToast],
  );

  // Editar la lista activa
  const mutateList = useCallback(
    async (fn: (ids: string[]) => string[]) => {
      if (!active) return;
      const updated: Playlist = { ...active, trackIds: fn(active.trackIds) };
      setPlaylists((prev) => prev.map((p) => (p.id === updated.id ? updated : p)));
      try {
        await savePlaylist(updated);
      } catch (e) {
        showToast(`No se pudo guardar la lista: ${String(e)}`);
      }
    },
    [active, showToast],
  );

  const addTrack = useCallback(
    (t: Track) => {
      void mutateList((ids) => [...ids, t.id]);
    },
    [mutateList],
  );

  const dropTrackAt = useCallback(
    (trackId: string, at: number) => {
      void mutateList((ids) => {
        if (ids.includes(trackId)) return ids; // sin duplicados
        const copy = [...ids];
        copy.splice(Math.max(0, Math.min(copy.length, at)), 0, trackId);
        return copy;
      });
    },
    [mutateList],
  );

  const removeRow = useCallback(
    (i: number) => {
      void mutateList((ids) => ids.filter((_, idx) => idx !== i));
    },
    [mutateList],
  );

  const reorderRow = useCallback(
    (from: number, to: number) => {
      void mutateList((ids) => {
        const copy = [...ids];
        const [moved] = copy.splice(from, 1);
        copy.splice(Math.max(0, Math.min(copy.length, to)), 0, moved);
        return copy;
      });
    },
    [mutateList],
  );

  const renamePlaylist = useCallback(
    (name: string) => {
      if (!active) return;
      void (async () => {
        const updated: Playlist = { ...active, name };
        setPlaylists((prev) => prev.map((p) => (p.id === updated.id ? updated : p)));
        await savePlaylist(updated);
      })();
    },
    [active],
  );

  const newPlaylist = useCallback(async () => {
    const pl: Playlist = {
      id: `pl-${Date.now()}`,
      name: `Lista ${playlists.length + 1}`,
      trackIds: [],
    };
    try {
      await savePlaylist(pl);
      setPlaylists((prev) => [...prev, pl]);
      setActiveId(pl.id);
      setPlayingRow(-1);
    } catch (e) {
      showToast(`No se pudo crear la lista: ${String(e)}`);
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
      showToast("Lista eliminada");
    } catch (e) {
      showToast(`No se pudo eliminar la lista: ${String(e)}`);
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

  const setVolume = useCallback(
    (v: number) => {
      playerRef.current?.setVolume(v);
      setSettings((prev) => {
        if (Math.abs(prev.masterVolume - v) < 0.001) return prev;
        const nextS = { ...prev, masterVolume: v };
        void saveSettings(nextS).catch(() => undefined);
        return nextS;
      });
    },
    [],
  );

  const updateSettings = useCallback((s: Settings) => {
    setSettings(s);
    void saveSettings(s).catch(() => undefined);
  }, []);

  // Piloto automático
  const autopilotOn = settings.autopilotEnabled;
  const setAutopilot = useCallback(
    (on: boolean) => updateSettings({ ...settings, autopilotEnabled: on }),
    [settings, updateSettings],
  );

  useEffect(() => {
    if (!autopilotOn || !active) return;
    const upComing = rows.length - (playingRow >= 0 ? playingRow + 1 : 0);
    if (upComing >= settings.autopilotMinUpcoming) return;
    if (topupBusy.current) return;
    topupBusy.current = true;
    const need = Math.max(1, settings.autopilotFillTo - Math.max(0, upComing));
    void autoPick(
      rows.map((r) => r.id),
      need,
    )
      .then((picked) => {
        if (picked.length > 0) {
          setAutoIds((prev) => {
            const nextSet = new Set(prev);
            for (const id of picked) nextSet.add(id);
            return nextSet;
          });
          void mutateList((ids) => {
            const copy = [...ids];
            for (const id of picked) {
              if (!copy.includes(id)) copy.push(id);
            }
            return copy;
          });
        }
      })
      .catch((e) => showToast(`Piloto automático: ${String(e)}`))
      .finally(() => {
        topupBusy.current = false;
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autopilotOn, playingRow, rows, settings]);

  // Horas estimadas de emisión de cada pista pendiente
  const estStart = useMemo(() => {
    const out: string[] = new Array(rows.length).fill("");
    if (rows.length === 0) return out;
    let t = Date.now();
    const current = playingRow; // -1 = parado
    for (let i = 0; i < rows.length; i++) {
      if (i === current) {
        t += Math.max(0, pos.total - pos.cur) * 1000;
      } else {
        if (i > current) {
          out[i] = new Date(t).toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit" });
        }
        t += rows[i].durationSecs * 1000;
      }
    }
    return out;
  }, [rows, playingRow, pos]);

  const deckRow = rows[playingRow] ?? null;
  const nextRow = playingRow >= 0 && playingRow + 1 < rows.length ? rows[playingRow + 1] : null;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <LogoRadio size={32} />
          <div className="brand-txt">
            <span className="brand-name">MiRadio</span>
            <span className="brand-sub">Estudio de automatización</span>
          </div>
        </div>
        <div className="top-right">
          {importing && <span className="pill pill-warn">Importando…</span>}
          {autopilotOn && (
            <span className="pill pill-auto">
              Piloto automático</span>
          )}
          <span className="clock" role="timer">{clock}</span>
          <button
            type="button"
            className="icon-btn"
            onClick={() => setSettingsOpen(true)}
            title="Ajustes de rotación y piloto automático"
            aria-label="Ajustes"
          >
            <IconGear size={18} />
          </button>
        </div>
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
            next={nextRow ? nextRow.title : null}
            onSeek={seek}
          />
          <PlaylistZone
            playlists={playlists}
            activeId={active?.id ?? ""}
            rows={rows}
            playingRow={playingRow}
            autoIds={autoIds}
            estStart={estStart}
            onSelect={setActiveId}
            onNew={() => void newPlaylist()}
            onRemovePlaylist={() => void removeActivePlaylist()}
            onRename={renamePlaylist}
            onPlayRow={(i) => void playRow(i)}
            onReorder={reorderRow}
            onRemove={removeRow}
            onDropTrack={dropTrackAt}
          />
        </div>
      </main>

      <PlayerBar
        paused={paused}
        autopilot={autopilotOn}
        fadeSeconds={settings.fadeSeconds}
        hasPlaylist={rows.length > 0}
        onTogglePlay={() => void togglePlay()}
        onNext={() => void next()}
        onPrev={() => void prev()}
        onAutopilot={setAutopilot}
        onFadeChange={(s) => updateSettings({ ...settings, fadeSeconds: s })}
        onVolume={setVolume}
      />

      {settingsOpen && (
        <SettingsPanel
          settings={settings}
          onChange={updateSettings}
          onClose={() => setSettingsOpen(false)}
        />
      )}

      {dropHover && (
        <div className="drop-overlay" aria-hidden="true">
          <div className="drop-overlay-box">
            <strong>Suelta los archivos</strong>
            <span>Se copian a la biblioteca, los originales no se tocan</span>
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
