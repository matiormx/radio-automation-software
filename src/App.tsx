import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  listTracks,
  listPlaylists,
  savePlaylist,
  deletePlaylist,
  importFiles,
  deleteTrack,
  scanMusicFolder,
  listBlocks,
  createBlock,
  renameBlock,
  deleteBlock,
  pickAudioFiles,
  pickFolder,
  onWindowFileDrop,
  getSettings,
  saveSettings,
  reportStarted,
  autoPick,
  AUDIO_EXTENSIONS,
  setTracksLibrary,
  pickImageFile,
  setBrandingLogo,
  trackUrl,
  backfillCovers,
} from "./api";
import type { Track, Playlist, PlaylistRow, Settings, Block, Campaign } from "./types";
import { DEFAULT_SETTINGS, effectiveDuration } from "./types";
import { RadioPlayer } from "./audio";
import { SoundMixer } from "./mixer";
import { MusicBrowser } from "./components/MusicBrowser";
import { PlaylistZone } from "./components/PlaylistZone";
import { DeckZone } from "./components/DeckZone";
import { PlayerBar } from "./components/PlayerBar";
import { SettingsPanel } from "./components/SettingsPanel";
import { Normalizer } from "./components/Normalizer";
import { IconGear, IconWave, LogoRadio } from "./icons";

const CAMPAIGN_GRACE_MS = 15 * 60 * 1000;

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function dayKey(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function dayIso(d: Date): number {
  const n = d.getDay();
  return n === 0 ? 7 : n;
}

function extOk(path: string): boolean {
  const dot = path.lastIndexOf(".");
  if (dot < 0) return false;
  return AUDIO_EXTENSIONS.includes(path.slice(dot + 1).toLowerCase());
}

export default function App() {
  const [tracks, setTracks] = useState<Track[]>([]);
  const [blocks, setBlocks] = useState<Block[]>([]);
  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  const [activeId, setActiveId] = useState("");
  const [playingRow, setPlayingRow] = useState(-1);
  const [paused, setPaused] = useState(true);
  const [pos, setPos] = useState({ cur: 0, total: 0 });
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [normalizerOpen, setNormalizerOpen] = useState(false);
  const [autoIds, setAutoIds] = useState<Set<string>>(new Set());
  const [dropHover, setDropHover] = useState(false);
  const [importing, setImporting] = useState(false);
  const [toast, setToast] = useState("");
  const [clock, setClock] = useState("");
  const autopilotOn = settings.autopilotEnabled;

  const playerRef = useRef<RadioPlayer | null>(null);
  const mixerRef = useRef<SoundMixer | null>(null);
  const posRef = useRef(pos);
  const toastTimer = useRef(0);
  const topupBusy = useRef(false);
  const normalizerRef = useRef(false);

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
    const mixer = new SoundMixer();
    mixer.onError = (msg) => showToast(msg);
    mixer.setMasterVolume(settingsRef.current.masterVolume);
    mixer.apply(settingsRef.current);
    mixerRef.current = mixer;
    const player = new RadioPlayer(mixer);
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
      mixer.dispose();
      mixerRef.current = null;
    };
  }, [showToast]);

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
      return t
        ? [
            {
              id: t.id,
              title: t.title,
              artist: t.artist,
              durationSecs: effectiveDuration(t),
              cover: t.cover,
            },
          ]
        : [];
    });
  }, [active, tracks]);

  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const playingRowRef = useRef(playingRow);
  playingRowRef.current = playingRow;
  const tracksRef = useRef(tracks);
  tracksRef.current = tracks;
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const campaignFiring = useRef<Set<string>>(new Set());

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

  // La mesa de sonido se reconfigura en caliente.
  useEffect(() => {
    mixerRef.current?.apply(settings);
  }, [settings.mixerChannels, settings.mixerBuses]);

  // Carga inicial de datos
  useEffect(() => {
    void (async () => {
      try {
        const [t, bs, ps, s] = await Promise.all([listTracks(), listBlocks(), listPlaylists(), getSettings()]);
        setTracks(t);
        setBlocks(bs);
        setPlaylists(ps);
        setActiveId(ps[0]?.id ?? "");
        setSettings(s);
        void backfillCovers()
          .then((n) => {
            if (n > 0) void listTracks().then(setTracks).catch(() => undefined);
          })
          .catch(() => undefined);
      } catch (e) {
        showToast(`Error al cargar: ${String(e)}`);
      }
    })();
  }, [showToast]);

  const refreshTracksAndBlocks = useCallback(
    async () => {
      const [t, bs] = await Promise.all([listTracks(), listBlocks()]);
      setTracks(t);
      setBlocks(bs);
    },
    [],
  );

  // Historial: cada pista que empieza se anota para las reglas de rotación
  useEffect(() => {
    if (playingRow < 0) return;
    const r = rowsRef.current[playingRow];
    if (r) void reportStarted(r.id).catch(() => undefined);
  }, [playingRow]);

  // Arrastrar archivos desde el escritorio
  const doImport = useCallback(
    async (paths: string[], library: "a" | "b" = "a") => {
      const ok = paths.filter(extOk);
      if (ok.length === 0) {
        showToast("Formato no reconocido. Usa audio: mp3, wav, flac, ogg, m4a…");
        return;
      }
      setImporting(true);
      try {
        const added = await importFiles(ok, library);
        setTracks(await listTracks());
        const where = library === "b" ? " a la biblioteca B" : "";
        showToast(
          added.length === 1
            ? `1 canción importada${where}`
            : `${added.length} canciones importadas${where}`,
        );
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
      onDrop: (paths, position) => {
        if (!alive) return;
        setDropHover(false);
        if (normalizerRef.current) {
          const dpr = window.devicePixelRatio || 1;
          const cssX = position ? position.x / dpr : window.innerWidth / 2;
          void doImport(paths, cssX < window.innerWidth / 2 ? "a" : "b");
        } else {
          void doImport(paths);
        }
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

  const pickFilesFor = useCallback(
    async (library: "a" | "b") => {
      const paths = await pickAudioFiles();
      if (paths && paths.length > 0) await doImport(paths, library);
    },
    [doImport],
  );

  const moveTracks = useCallback(async (ids: string[], to: "a" | "b") => {
    const moved = await setTracksLibrary(ids, to);
    setTracks(await listTracks());
    return moved;
  }, []);

  const removeTrack = useCallback(
    async (t: Track) => {
      try {
        await deleteTrack(t.id);
        setTracks((prev) => prev.filter((x) => x.id !== t.id));
        setBlocks(await listBlocks());
        showToast(`«${t.title}» eliminada de la biblioteca`);
      } catch (e) {
        showToast(`No se pudo eliminar: ${String(e)}`);
      }
    },
    [showToast],
  );

  // ---- bloques musicales ----
  const handleCreateBlock = useCallback(
    async (name: string) => {
      const b = await createBlock(name);
      setBlocks((prev) => [...prev, b]);
      showToast(`Bloque «${b.name}» creado`);
    },
    [showToast],
  );

  const handleRenameBlock = useCallback(async (id: string, name: string) => {
    await renameBlock(id, name);
    setBlocks(await listBlocks());
  }, []);

  const handleDeleteBlock = useCallback(
    async (id: string) => {
      await deleteBlock(id);
      setBlocks(await listBlocks());
      setTracks(await listTracks());
      setSettings((prev) => {
        const nextS = { ...prev, autoBlocks: prev.autoBlocks.filter((x) => x !== id) };
        void saveSettings(nextS).catch(() => undefined);
        return nextS;
      });
      showToast("Bloque eliminado");
    },
    [showToast],
  );

  const toggleAutoBlock = useCallback(
    (blockId: string) => {
      setSettings((prev) => {
        const has = prev.autoBlocks.includes(blockId);
        const nextS = {
          ...prev,
          autoBlocks: has ? prev.autoBlocks.filter((x) => x !== blockId) : [...prev.autoBlocks, blockId],
        };
        void saveSettings(nextS).catch(() => undefined);
        return nextS;
      });
    },
    [],
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

  const mutateListRef = useRef(mutateList);
  mutateListRef.current = mutateList;

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

  const chooseMusicFolder = useCallback(async () => {
    try {
      const path = await pickFolder();
      if (!path) return;
      setSettings((prev) => {
        const nextS = { ...prev, musicPath: path };
        void saveSettings(nextS).catch(() => undefined);
        return nextS;
      });
      showToast("Carpeta de música actualizada");
    } catch (e) {
      showToast(`No se pudo elegir la carpeta: ${String(e)}`);
    }
  }, [showToast]);

  const chooseLogo = useCallback(async () => {
    try {
      const path = await pickImageFile();
      if (!path) return;
      const dest = await setBrandingLogo(path);
      setSettings((prev) => {
        const nextS = { ...prev, logoPath: dest };
        void saveSettings(nextS).catch(() => undefined);
        return nextS;
      });
      showToast("Logo actualizado");
    } catch (e) {
      showToast(`No se pudo usar el logo: ${String(e)}`);
    }
  }, [showToast]);

  const removeLogo = useCallback(async () => {
    try {
      await setBrandingLogo(null);
      setSettings((prev) => {
        const nextS = { ...prev, logoPath: "" };
        void saveSettings(nextS).catch(() => undefined);
        return nextS;
      });
      showToast("Logo quitado");
    } catch (e) {
      showToast(`No se pudo quitar el logo: ${String(e)}`);
    }
  }, [showToast]);

  const importForCampaign = useCallback(async (): Promise<Track[]> => {
    const paths = await pickAudioFiles();
    if (!paths || paths.length === 0) return [];
    const ok = paths.filter(extOk);
    if (ok.length === 0) {
      showToast("Formato no reconocido. Usa audio: mp3, wav, flac, ogg, m4a…");
      return [];
    }
    setImporting(true);
    try {
      const added = await importFiles(ok, "a");
      setTracks(await listTracks());
      showToast(added.length === 1 ? "1 audio importado" : `${added.length} audios importados`);
      return added;
    } catch (e) {
      showToast(`No se pudieron importar: ${String(e)}`);
      return [];
    } finally {
      setImporting(false);
    }
  }, [showToast]);

  useEffect(() => {
    if (!autopilotOn || !active) return;
    const check = () => {
      const now = new Date();
      const s = settingsRef.current;
      if (!s.autopilotEnabled) return;
      const rowsNow = rowsRef.current;
      const playing = playingRowRef.current;
      const byId = new Map(tracksRef.current.map((t) => [t.id, t]));
      const currentId = playing >= 0 ? rowsNow[playing]?.id ?? "" : "";
      const due: { campaign: Campaign; key: string; spotId: string; cursor: number }[] = [];

      const dayMs = 24 * 60 * 60 * 1000;
      for (const c of s.campaigns) {
        if (!c.enabled || c.trackIds.length === 0) continue;
        const occurrences = c.hourly ? [`${pad2(now.getHours())}:${pad2(c.minute)}`] : c.times;
        let dueAt: { when: number; key: string } | null = null;
        for (const t of occurrences) {
          const [hs, ms] = t.split(":");
          const h = Number(hs);
          const m = Number(ms);
          if (!Number.isInteger(h) || !Number.isInteger(m) || h < 0 || h > 23 || m < 0 || m > 59) {
            continue;
          }
          const scheduled = new Date(now);
          scheduled.setHours(h, m, 0, 0);
          let delta = now.getTime() - scheduled.getTime();
          if (delta < 0) {
            scheduled.setTime(scheduled.getTime() - dayMs);
            delta = now.getTime() - scheduled.getTime();
          }
          if (delta > CAMPAIGN_GRACE_MS) continue;
          if (!c.days.includes(dayIso(scheduled))) continue;
          const key = `${dayKey(scheduled)} ${pad2(h)}:${pad2(m)}`;
          if (c.lastFired === key) continue;
          if (campaignFiring.current.has(`${c.id}|${key}`)) continue;
          if (!dueAt || scheduled.getTime() > dueAt.when) {
            dueAt = { when: scheduled.getTime(), key };
          }
        }
        if (!dueAt) continue;

        const lock = `${c.id}|${dueAt.key}`;
        const len = c.trackIds.length;
        const start = ((c.cursor % len) + len) % len;
        let spot: { id: string; cursor: number } | null = null;
        for (let off = 0; off < len; off++) {
          const id = c.trackIds[(start + off) % len];
          if (!byId.has(id) || id === currentId) continue;
          spot = { id, cursor: (start + off + 1) % len };
          break;
        }
        if (!spot) continue;

        campaignFiring.current.add(lock);
        due.push({ campaign: c, key: dueAt.key, spotId: spot.id, cursor: spot.cursor });
      }

      if (due.length === 0) return;
      const base = playing >= 0 ? playing + 1 : rowsNow.length;
      void mutateListRef.current((ids) => {
        const copy = [...ids];
        due.forEach((d, i) => copy.splice(Math.min(copy.length, base + i), 0, d.spotId));
        return copy;
      });
      setSettings((prev) => {
        let campaigns = prev.campaigns;
        for (const d of due) {
          campaigns = campaigns.map((c) =>
            c.id === d.campaign.id ? { ...c, lastFired: d.key, cursor: d.cursor } : c,
          );
        }
        const nextS = { ...prev, campaigns };
        void saveSettings(nextS).catch(() => undefined);
        return nextS;
      });
      showToast(
        due.length === 1
          ? `Campaña «${due[0].campaign.name}» insertada`
          : `${due.length} campañas insertadas en la lista`,
      );
    };

    check();
    const timer = window.setInterval(check, 15000);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autopilotOn, active?.id, settings.campaigns]);

  // Piloto automático
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
          {settings.logoPath ? (
            <img
              className="brand-logo"
              src={trackUrl({ file: settings.logoPath })}
              alt=""
              onError={(e) => {
                e.currentTarget.style.display = "none";
              }}
            />
          ) : (
            <LogoRadio size={32} />
          )}
          <div className="brand-txt">
            <span className="brand-name">{settings.radioName.trim() || "MiRadio"}</span>
            <span className="brand-sub">
              {settings.slogan.trim() || "Estudio de automatización"}
            </span>
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
            className="btn btn-sm top-action"
            onClick={() => {
              normalizerRef.current = true;
              setNormalizerOpen(true);
            }}
            title="Normalizar sonoridad y recortar silencios"
          >
            <IconWave size={15} /> Normalizar
          </button>
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
        <MusicBrowser
          tracks={tracks}
          blocks={blocks}
          autoBlocks={settings.autoBlocks}
          onToggleAutoBlock={toggleAutoBlock}
          onCreateBlock={handleCreateBlock}
          onRenameBlock={handleRenameBlock}
          onDeleteBlock={handleDeleteBlock}
          onScan={scanMusicFolder}
          onPickFiles={() => void pickFiles()}
          onAdd={addTrack}
          onDelete={(t) => void removeTrack(t)}
          onTrackSaved={refreshTracksAndBlocks}
          showToast={showToast}
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

      {normalizerOpen && (
        <Normalizer
          tracks={tracks}
          blocks={blocks}
          targetLufs={settings.targetLufs}
          truePeakDb={settings.truePeakDb}
          onClose={() => {
            normalizerRef.current = false;
            setNormalizerOpen(false);
            void refreshTracksAndBlocks();
          }}
          onRefresh={refreshTracksAndBlocks}
          onPick={(side) => void pickFilesFor(side)}
          onMove={moveTracks}
          onTarget={(lufs, peak) =>
            updateSettings({ ...settings, targetLufs: lufs, truePeakDb: peak })
          }
          showToast={showToast}
          mixer={mixerRef.current}
        />
      )}

      {settingsOpen && (
        <SettingsPanel
          settings={settings}
          tracks={tracks}
          onChange={updateSettings}
          onClose={() => setSettingsOpen(false)}
          onPickMusicFolder={() => chooseMusicFolder()}
          onPickLogo={() => chooseLogo()}
          onClearLogo={() => removeLogo()}
          onImportAudio={() => importForCampaign()}
          mixer={mixerRef.current}
        />
      )}

      {dropHover && (
        <div className="drop-overlay" aria-hidden="true">
        <div className="drop-overlay-box">
          <strong>Suelta los archivos</strong>
          <span>Se copian a la carpeta de música de MiRadio; los originales no se tocan</span>
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
