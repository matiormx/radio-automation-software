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
  listHistory,
  loadSession,
  saveSession,
  writeNowPlaying,
  writeNowPlayingImage,
  pickNowPlayingFile,
  getStreamStatus,
  startStreaming,
  stopStreaming,
} from "./api";
import type {
  HistoryEntry,
  SessionState,
  Track,
  Playlist,
  PlaylistRow,
  Settings,
  Block,
  Campaign,
  StationEvent,
  StreamStatus,
} from "./types";
import { DEFAULT_SETTINGS, effectiveDuration } from "./types";
import { RadioPlayer } from "./audio";
import { SoundMixer } from "./mixer";
import { StreamEncoder } from "./streaming";
import { LiveBar } from "./components/LiveBar";
import {
  DEFAULT_NOW_PLAYING_TEMPLATE,
  buildCoverJpeg,
  liveFilePath,
  liveImagePath,
  nowPlayingImagePath,
  nowPlayingLine,
  renderNowPlaying,
  type NowPlayingFields,
} from "./nowplaying";
import { MusicBrowser } from "./components/MusicBrowser";
import { PlaylistZone } from "./components/PlaylistZone";
import { DeckZone } from "./components/DeckZone";
import { VuMeter } from "./components/VuMeter";
import { PlayerBar } from "./components/PlayerBar";
import { SettingsPanel, type SettingsTab } from "./components/SettingsPanel";
import { Normalizer } from "./components/Normalizer";
import type { NormalizerApi, NormalizerStatus } from "./components/Normalizer";
import { IconGear, IconList, IconWave, LogoRadio } from "./icons";

const CAMPAIGN_GRACE_MS = 15 * 60 * 1000;
const EVENT_GRACE_MS = 15 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

function parseHM(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const h = Number(match[1]);
  const m = Number(match[2]);
  if (!Number.isInteger(h) || !Number.isInteger(m) || h < 0 || h > 23 || m < 0 || m > 59) {
    return null;
  }
  return h * 60 + m;
}

/** Inicio más reciente de una franja, o null si el evento no aplica. */
function eventStartAt(event: StationEvent, now: Date): Date | null {
  const start = parseHM(event.start);
  if (start === null) return null;
  for (let offset = 0; offset <= 7; offset++) {
    const day = new Date(now);
    day.setDate(day.getDate() - offset);
    day.setHours(Math.floor(start / 60), start % 60, 0, 0);
    if (day.getTime() > now.getTime()) continue;
    if (!event.days.includes(dayIso(day))) continue;
    return day;
  }
  return null;
}

/** Próximo inicio de cualquier franja AutoDJ después de `after`. */
function nextAutoStartAfter(events: StationEvent[], after: Date): number {
  let best = Number.POSITIVE_INFINITY;
  for (let offset = 0; offset <= 7; offset++) {
    const day = new Date(after);
    day.setDate(day.getDate() + offset);
    for (const event of events) {
      if (!event.enabled || event.kind !== "auto") continue;
      const start = parseHM(event.start);
      if (start === null) continue;
      if (!event.days.includes(dayIso(day))) continue;
      const at = new Date(day);
      at.setHours(Math.floor(start / 60), start % 60, 0, 0);
      if (at.getTime() <= after.getTime()) continue;
      if (at.getTime() < best) best = at.getTime();
    }
  }
  return best;
}

function eventSourceLabel(event: StationEvent, blocks: Block[]): string {
  if (event.sourceKind === "library") {
    return event.sourceId === "b" ? "Biblioteca B" : "Biblioteca A";
  }
  return blocks.find((b) => b.id === event.sourceId)?.name ?? "Bloque eliminado";
}

interface PendingInsert {
  eventId: string;
  eventName: string;
  playlistId: string;
  trackId: string;
  deadline: number;
  onTimeout: "force" | "cancel";
}

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

function campaignTime(value: string): number | null {
  if (!value) return null;
  const t = new Date(value).getTime();
  return Number.isNaN(t) ? null : t;
}

function fmtDuration(secs: number): string {
  const total = Math.max(0, Math.round(secs));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
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
  const [settingsTab, setSettingsTab] = useState<SettingsTab>("general");
  const [settingsMounted, setSettingsMounted] = useState(false);
  const [normalizerOpen, setNormalizerOpen] = useState(false);
  const [normalizerMounted, setNormalizerMounted] = useState(false);
  const [normStatus, setNormStatus] = useState<NormalizerStatus | null>(null);
  const [autoIds, setAutoIds] = useState<Set<string>>(new Set());
  const [dropHover, setDropHover] = useState(false);
  const [importing, setImporting] = useState(false);
  const [toast, setToast] = useState("");
  const [clock, setClock] = useState("");
  const [nowTick, setNowTick] = useState(() => Date.now());
  const [pendingInserts, setPendingInserts] = useState<PendingInsert[]>([]);
  const [manualAuto, setManualAuto] = useState<{ id: string; until: number } | null>(null);
  const [streamStatus, setStreamStatus] = useState<StreamStatus | null>(null);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [streamBusy, setStreamBusy] = useState(false);
  const autopilotOn = settings.autopilotEnabled;
  const defaultBlockId = blocks.some((block) => block.id === settings.defaultBlockId)
    ? settings.defaultBlockId
    : "";
  const hasStreamOutputs = useMemo(
    () =>
      settings.streaming.icecast.some((stream) => stream.enabled) ||
      settings.streaming.rtsp.enabled ||
      (settings.video.enabled && settings.video.outputs.some((output) => output.enabled)),
    [settings.streaming.icecast, settings.streaming.rtsp.enabled, settings.video.enabled, settings.video.outputs],
  );

  const playerRef = useRef<RadioPlayer | null>(null);
  const mixerRef = useRef<SoundMixer | null>(null);
  const streamEncoderRef = useRef<StreamEncoder | null>(null);
  const userPausedRef = useRef(false);
  const autoPlayStartedRef = useRef(false);
  const pausedRef = useRef(true);
  const sessionRef = useRef<SessionState | null>(null);
  const sessionRestoredRef = useRef(false);
  const restoringRef = useRef(false);
  const [mixer, setMixer] = useState<SoundMixer | null>(null);
  const posRef = useRef(pos);
  const toastTimer = useRef(0);
  const topupBusy = useRef(false);
  const normalizerRef = useRef(false);
  const normApiRef = useRef<NormalizerApi | null>(null);
  const eventFiring = useRef<Set<string>>(new Set());
  const pendingInsertsRef = useRef(pendingInserts);
  pendingInsertsRef.current = pendingInserts;
  const playRowRef = useRef<(index: number) => void>(() => undefined);

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(""), 3200);
  }, []);

  // Reloj
  useEffect(() => {
    const tick = () => {
      const now = new Date();
      setClock(now.toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit", second: "2-digit" }));
      setNowTick(now.getTime());
    };
    tick();
    const t = window.setInterval(tick, 1000);
    return () => window.clearInterval(t);
  }, []);

  // Evita el menú contextual del navegador (actualizar, guardar, imprimir…)
  // salvo en campos editables, donde copiar/pegar sigue siendo útil.
  useEffect(() => {
    const onContextMenu = (e: MouseEvent) => {
      const el = e.target as HTMLElement | null;
      if (el?.closest("input, textarea, [contenteditable='true']")) return;
      e.preventDefault();
    };
    document.addEventListener("contextmenu", onContextMenu);
    return () => document.removeEventListener("contextmenu", onContextMenu);
  }, []);

  // Motor de emisión: al abrir la app se recupera el estado y se evita
  // dejar procesos FFmpeg huérfanos de una recarga anterior.
  useEffect(() => {
    void getStreamStatus()
      .then((status) => {
        if (status.running) {
          void stopStreaming()
            .then(setStreamStatus)
            .catch(() => undefined);
        } else {
          setStreamStatus(status);
        }
      })
      .catch(() => undefined);
    return () => {
      void streamEncoderRef.current?.stop();
      streamEncoderRef.current = null;
      void stopStreaming().catch(() => undefined);
    };
  }, []);

  // Motor de audio
  useEffect(() => {
    const mixer = new SoundMixer();
    mixer.onError = (msg) => showToast(msg);
    mixer.setMasterVolume(settingsRef.current.masterVolume);
    mixer.apply(settingsRef.current);
    mixerRef.current = mixer;
    setMixer(mixer);
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
      setMixer(null);
    };
  }, [showToast]);

  const active = useMemo(
    () => playlists.find((p) => p.id === activeId) ?? playlists[0],
    [playlists, activeId],
  );

  // Evento de franja AutoDJ activo. Si varios coinciden, manda el que
  // empezó más tarde (y a igualdad, el último de la lista).
  const activeAutoEvent = useMemo(() => {
    if (!settings.eventsEnabled) return null;
    const manual =
      manualAuto && manualAuto.until > nowTick
        ? settings.events.find(
            (event) => event.id === manualAuto.id && event.enabled && event.kind === "auto",
          )
        : null;
    if (manual) {
      const validSource =
        manual.sourceKind === "library"
          ? manual.sourceId === "a" || manual.sourceId === "b"
          : blocks.some((block) => block.id === manual.sourceId);
      if (validSource) return manual;
    }
    const now = new Date(nowTick);
    let bestEvent: StationEvent | null = null;
    let bestStart = -Infinity;
    let bestIndex = -1;
    for (let index = 0; index < settings.events.length; index++) {
      const event = settings.events[index];
      if (!event.enabled || event.kind !== "auto") continue;
      if (event.sourceKind === "block" && !blocks.some((b) => b.id === event.sourceId)) continue;
      if (event.sourceKind === "library" && event.sourceId !== "a" && event.sourceId !== "b") {
        continue;
      }
      const start = eventStartAt(event, now);
      if (!start) continue;
      const at = start.getTime();
      if (at > bestStart || (at === bestStart && index > bestIndex)) {
        bestEvent = event;
        bestStart = at;
        bestIndex = index;
      }
    }
    return bestEvent;
  }, [settings.events, settings.eventsEnabled, manualAuto, blocks, nowTick]);
  const autoScope = activeAutoEvent
    ? { kind: activeAutoEvent.sourceKind, id: activeAutoEvent.sourceId }
    : null;
  const autoScopeKey = autoScope ? `${autoScope.kind}|${autoScope.id}` : "";
  const autoScopeRef = useRef(autoScope);
  autoScopeRef.current = autoScope;

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
              album: t.album,
              durationSecs: effectiveDuration(t),
              cover: t.cover,
            },
          ]
        : [];
    });
  }, [active, tracks]);

  // Programa preparado (se elige con el LIVE apagado o encendido).
  const selectedProgram = useMemo(() => {
    const programs = settings.programs ?? [];
    return programs.find((program) => program.id === settings.liveProgramId) ?? null;
  }, [settings.liveProgramId, settings.programs]);

  // Programa en antena: solo cuando el modo LIVE esta activado.
  const liveProgram = useMemo(() => {
    if (!settings.liveMode) return null;
    return selectedProgram;
  }, [settings.liveMode, selectedProgram]);

  // Cancion que esta sonando ahora.
  const nowPlayingTrack = useMemo(() => {
    if (playingRow < 0) return null;
    const row = rows[playingRow];
    if (!row) return null;
    return tracks.find((track) => track.id === row.id) ?? null;
  }, [playingRow, rows, tracks]);

  /** Datos de la cancion que suena. */
  const songFields = useMemo<NowPlayingFields | null>(() => {
    if (!nowPlayingTrack) return null;
    const durationSec = Math.max(0, Math.round(effectiveDuration(nowPlayingTrack)));
    const blockNames = nowPlayingTrack.blocks
      .map((id) => blocks.find((block) => block.id === id)?.name ?? "")
      .filter((name) => name !== "")
      .join(", ");
    return {
      artist: nowPlayingTrack.artist ?? "",
      title: nowPlayingTrack.title ?? "",
      album: nowPlayingTrack.album ?? "",
      year: nowPlayingTrack.year ?? "",
      genre: nowPlayingTrack.genre ?? "",
      duration: fmtDuration(durationSec),
      durationSec: String(durationSec),
      radio: settings.radioName ?? "",
      block: blockNames,
      program: "",
      time: new Date().toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit" }),
    };
  }, [nowPlayingTrack, blocks, settings.radioName]);

  /** Datos del programa en antena (modo LIVE). */
  const programFields = useMemo<NowPlayingFields | null>(() => {
    if (!liveProgram) return null;
    return {
      artist: liveProgram.subtitle ?? "",
      title: liveProgram.name ?? "",
      album: "",
      year: "",
      genre: "",
      duration: "",
      durationSec: "",
      radio: settings.radioName ?? "",
      block: "",
      program: liveProgram.name ?? "",
      time: new Date().toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit" }),
    };
  }, [liveProgram, settings.radioName]);

  // Archivo "now playing": siempre la musica que esta sonando.
  const nowPlayingText = useMemo(() => {
    if (!songFields) return null;
    const template = settings.nowPlayingTemplate?.trim() || DEFAULT_NOW_PLAYING_TEMPLATE;
    return nowPlayingLine(renderNowPlaying(template, songFields));
  }, [songFields, settings.nowPlayingTemplate]);

  // Archivo "live": el programa si el modo LIVE esta activo; si no, la musica.
  const liveText = useMemo(() => {
    const fields = liveProgram ? programFields : songFields;
    if (!fields) return null;
    const template = settings.liveTemplate?.trim() || DEFAULT_NOW_PLAYING_TEMPLATE;
    return nowPlayingLine(renderNowPlaying(template, fields));
  }, [liveProgram, programFields, songFields, settings.liveTemplate]);

  const nowPlayingTextRef = useRef<string | null>(null);
  nowPlayingTextRef.current = nowPlayingText;
  const liveTextRef = useRef<string | null>(null);
  liveTextRef.current = liveText;
  const nowPlayingErrorRef = useRef("");

  const nowPlayingCoverUrl = useMemo(() => {
    const track = nowPlayingTrack;
    if (!track || !track.cover) return "";
    return trackUrl({ file: track.cover });
  }, [nowPlayingTrack]);

  const liveCoverUrl = useMemo(() => {
    if (liveProgram) return liveProgram.cover ? trackUrl({ file: liveProgram.cover }) : "";
    return nowPlayingCoverUrl;
  }, [liveProgram, nowPlayingCoverUrl]);

  const nowPlayingCoverRef = useRef({ url: "", title: "", artist: "", radio: "" });
  nowPlayingCoverRef.current = {
    url: nowPlayingCoverUrl,
    title: nowPlayingTrack?.title ?? "",
    artist: nowPlayingTrack?.artist ?? "",
    radio: settings.radioName ?? "",
  };
  const liveCoverRef = useRef({ url: "", title: "", artist: "", radio: "" });
  liveCoverRef.current = {
    url: liveCoverUrl,
    title: liveProgram ? liveProgram.name ?? "" : nowPlayingTrack?.title ?? "",
    artist: liveProgram ? liveProgram.subtitle ?? "" : nowPlayingTrack?.artist ?? "",
    radio: settings.radioName ?? "",
  };

  const reportNowPlayingError = useCallback(
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      if (message === nowPlayingErrorRef.current) return;
      nowPlayingErrorRef.current = message;
      showToast(`No se pudo escribir el nowplaying: ${message}`);
    },
    [showToast],
  );

  /** Escribe una portada como JPEG junto a su archivo de texto. */
  const publishCoverImage = useCallback(
    async (imagePath: string, cover: { url: string; title: string; artist: string; radio: string }) => {
      if (!imagePath) return;
      const data = await buildCoverJpeg(cover.url, {
        title: cover.title,
        artist: cover.artist,
        radio: cover.radio,
      });
      await writeNowPlayingImage(imagePath, data);
    },
    [],
  );

  // Rutas de los dos archivos (y de sus imagenes).
  const nowPlayingPath = settings.nowPlayingPath.trim();
  const nowPlayingImage = nowPlayingImagePath(nowPlayingPath);
  const livePath = liveFilePath(nowPlayingPath, settings.liveFilePath ?? "");
  const liveImage = liveImagePath(livePath);

  useEffect(() => {
    if (!nowPlayingPath || !nowPlayingText) return;
    void writeNowPlaying(nowPlayingPath, nowPlayingText)
      .then(() => {
        nowPlayingErrorRef.current = "";
      })
      .catch(reportNowPlayingError);
    void publishCoverImage(nowPlayingImage, nowPlayingCoverRef.current).catch(reportNowPlayingError);
  }, [
    nowPlayingText,
    nowPlayingPath,
    nowPlayingImage,
    publishCoverImage,
    reportNowPlayingError,
  ]);

  useEffect(() => {
    if (!livePath || !liveText) return;
    void writeNowPlaying(livePath, liveText)
      .then(() => {
        nowPlayingErrorRef.current = "";
      })
      .catch(reportNowPlayingError);
    void publishCoverImage(liveImage, liveCoverRef.current).catch(reportNowPlayingError);
  }, [liveText, livePath, liveImage, publishCoverImage, reportNowPlayingError]);

  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const playingRowRef = useRef(playingRow);
  playingRowRef.current = playingRow;
  const tracksRef = useRef(tracks);
  tracksRef.current = tracks;
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const activeIdRef = useRef("");
  activeIdRef.current = active?.id ?? "";
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
      p.silenceSkip = settings.silenceDetection;
      p.setVolume(settings.masterVolume);
    }
  }, [settings.fadeSeconds, settings.masterVolume, settings.silenceDetection]);

  // La mesa de sonido se reconfigura en caliente.
  useEffect(() => {
    mixerRef.current?.apply(settings);
  }, [settings.mixerChannels, settings.mixerBuses, settings.monitorBusId]);

  // Continuar donde se quedo la ultima sesion: misma lista, misma pista y
  // misma posicion. Si la app se abrio con "reproducir automaticamente",
  // ademas sigue sonando; si no, queda pausada en ese punto.
  useEffect(() => {
    if (sessionRestoredRef.current) return;
    const session = sessionRef.current;
    if (!session || !session.trackId) return;
    const player = playerRef.current;
    if (!player) return;
    const index = rows.findIndex((row) => row.id === session.trackId);
    if (index < 0) return;
    sessionRestoredRef.current = true;
    restoringRef.current = true;
    void player
      .restoreAt(index, session.positionSecs, settings.autoPlayOnStart)
      .then(() => {
        setPaused(!player.isPlaying);
        pausedRef.current = !player.isPlaying;
      })
      .catch(() => undefined);
  }, [rows, settings.autoPlayOnStart]);

  // Carga inicial de datos
  useEffect(() => {
    void (async () => {
      try {
        const [t, bs, ps, s, hist, session] = await Promise.all([
          listTracks(),
          listBlocks(),
          listPlaylists(),
          getSettings(),
          listHistory().catch(() => [] as HistoryEntry[]),
          loadSession().catch(() => null),
        ]);
        setTracks(t);
        setBlocks(bs);
        setPlaylists(ps);
        setActiveId(ps[0]?.id ?? "");
        setSettings(s);
        setHistory(hist);
        sessionRef.current = session;
        if (session?.playlistId && ps.some((pl) => pl.id === session.playlistId)) {
          setActiveId(session.playlistId);
        }
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

  const openSettings = useCallback(() => {
    setSettingsMounted(true);
    setSettingsOpen(true);
  }, []);

  const openNormalizer = useCallback(() => {
    normalizerRef.current = true;
    setNormalizerMounted(true);
    setNormalizerOpen(true);
    if (!normStatus) void refreshTracksAndBlocks();
  }, [normStatus, refreshTracksAndBlocks]);

  const hideNormalizer = useCallback(() => {
    normalizerRef.current = false;
    setNormalizerOpen(false);
    void refreshTracksAndBlocks();
  }, [refreshTracksAndBlocks]);

  // Guardar la sesion para poder continuar donde se quedo al reabrir.
  useEffect(() => {
    const save = () => {
      const index = playingRowRef.current;
      const row = index >= 0 ? rowsRef.current[index] : null;
      const session: SessionState = {
        playlistId: activeIdRef.current,
        trackId: row?.id ?? "",
        positionSecs: posRef.current.cur,
        playing: !pausedRef.current,
        updatedAt: Date.now(),
      };
      void saveSession(session).catch(() => undefined);
    };
    const timer = window.setInterval(save, 5000);
    return () => {
      window.clearInterval(timer);
      save();
    };
  }, []);

  // Historial: cada pista que empieza se anota para las reglas de rotación
  useEffect(() => {
    if (playingRow < 0) return;
    const r = rowsRef.current[playingRow];
    if (!r) return;
    if (restoringRef.current) {
      restoringRef.current = false;
      return;
    }
    void reportStarted(r.id)
      .then(() => listHistory())
      .then((entries) => setHistory(entries))
      .catch(() => undefined);
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

  const clearActivePlaylist = useCallback(async () => {
    if (!active) return;
    if (active.trackIds.length === 0) {
      showToast("La lista ya está vacía");
      return;
    }
    if (!window.confirm(`¿Vaciar la lista «${active.name}»? Se quitan todas sus pistas.`)) return;
    playerRef.current?.pause?.();
    setPlayingRow(-1);
    setPaused(true);
    pausedRef.current = true;
    userPausedRef.current = true;
    await mutateList(() => []);
    showToast(`Lista «${active.name}» vaciada`);
  }, [active, mutateList, showToast]);

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
  const playRow = useCallback(
    async (i: number) => {
      const p = playerRef.current;
      if (!p) return;
      userPausedRef.current = false;
      try {
        await p.playAt(i);
        setPaused(!p.isPlaying);
      } catch (error) {
        showToast(`No se pudo reproducir: ${String(error)}`);
      }
    },
    [showToast],
  );
  playRowRef.current = (i) => {
    void playRow(i);
  };

  const togglePlay = useCallback(async () => {
    const p = playerRef.current;
    if (!p) return;
    const wasPlaying = p.isPlaying;
    await p.toggle();
    setPaused(!p.isPlaying);
    userPausedRef.current = wasPlaying && !p.isPlaying;
  }, []);

  const next = useCallback(async () => {
    const p = playerRef.current;
    if (!p) return;
    await p.next();
    setPaused(!p.isPlaying);
    userPausedRef.current = false;
  }, []);

  const prev = useCallback(async () => {
    const p = playerRef.current;
    if (!p) return;
    await p.prev();
    setPaused(!p.isPlaying);
    userPausedRef.current = false;
  }, []);

  // Arranque automatico al abrir la app (solo una vez por sesion).
  useEffect(() => {
    if (autoPlayStartedRef.current) return;
    if (!settings.autoPlayOnStart) return;
    if (!active || rows.length === 0 || !playerRef.current) return;
    autoPlayStartedRef.current = true;
    void playRowRef.current(0);
  }, [settings.autoPlayOnStart, active, rows.length]);

  // Deteccion de silencio: si la reproduccion esta parada, la reanuda.
  useEffect(() => {
    if (!settings.silenceDetection) return;
    if (playingRow >= 0 || userPausedRef.current) return;
    if (!active || rows.length === 0) return;
    const timer = window.setTimeout(() => {
      if (userPausedRef.current || playingRowRef.current >= 0) return;
      void playRowRef.current(0);
    }, 3000);
    return () => window.clearTimeout(timer);
  }, [settings.silenceDetection, playingRow, active, rows.length]);

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

  const failStreaming = useCallback(
    (message: string) => {
      showToast(message);
      void streamEncoderRef.current?.stop();
      streamEncoderRef.current = null;
      void stopStreaming()
        .then(setStreamStatus)
        .catch(() => undefined);
    },
    [showToast],
  );

  const toggleStreaming = useCallback(async () => {
    if (streamBusy) return;
    if (streamStatus?.running) {
      setStreamBusy(true);
      try {
        await streamEncoderRef.current?.stop();
        streamEncoderRef.current = null;
        setStreamStatus(await stopStreaming());
        showToast("Emisión detenida");
      } catch (error) {
        showToast(`No se pudo detener la emisión: ${String(error)}`);
      } finally {
        setStreamBusy(false);
      }
      return;
    }
    if (!hasStreamOutputs) {
      showToast("Configura una salida Icecast, RTSP o de vídeo antes de emitir");
      return;
    }
    const mixer = mixerRef.current;
    if (!mixer) {
      showToast("La mesa de sonido todavía no está lista");
      return;
    }
    setStreamBusy(true);
    try {
      const status = await startStreaming(settings);
      if (!status.running) {
        throw new Error(status.lastError ?? "No se pudo iniciar la emisión");
      }
      setStreamStatus(status);
      if (status.needsAudio) {
        const encoder = new StreamEncoder(mixer, failStreaming);
        await encoder.start();
        streamEncoderRef.current = encoder;
      }
      showToast(status.lastError ?? "Emisión iniciada");
    } catch (error) {
      await streamEncoderRef.current?.stop();
      streamEncoderRef.current = null;
      await stopStreaming()
        .then(setStreamStatus)
        .catch(() => setStreamStatus(null));
      showToast(error instanceof Error ? error.message : String(error));
    } finally {
      setStreamBusy(false);
    }
  }, [streamBusy, streamStatus?.running, hasStreamOutputs, settings, failStreaming, showToast]);

  useEffect(() => {
    if (!streamStatus?.running) return;
    let alive = true;
    const timer = window.setInterval(() => {
      void getStreamStatus()
        .then((status) => {
          if (!alive) return;
          setStreamStatus(status);
          if (!status.running) {
            void streamEncoderRef.current?.stop();
            streamEncoderRef.current = null;
            showToast(status.lastError ?? "La emisión se detuvo");
          }
        })
        .catch(() => undefined);
    }, 3000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [streamStatus?.running, showToast]);

  const launchEvent = useCallback(
    (event: StationEvent) => {
      if (!settingsRef.current.eventsEnabled) {
        showToast("Los eventos están desactivados globalmente");
        return;
      }
      if (!event.enabled) {
        showToast(`El evento «${event.name}» está desactivado`);
        return;
      }
      if (event.kind === "auto") {
        const until = nextAutoStartAfter(settingsRef.current.events, new Date());
        setManualAuto({ id: event.id, until });
        showToast(`Evento «${event.name}» activado manualmente`);
        return;
      }

      const track = tracksRef.current.find((item) => item.id === event.trackId);
      if (!track) {
        showToast(`El evento «${event.name}» no tiene una pista disponible`);
        return;
      }
      const playing = playingRowRef.current;
      const currentId = playing >= 0 ? rowsRef.current[playing]?.id ?? "" : "";
      if (currentId === event.trackId) {
        showToast(`El evento «${event.name}» ya está sonando`);
        return;
      }
      const playlistId = activeIdRef.current;
      if (!playlistId) {
        showToast("No hay una lista activa para lanzar el evento");
        return;
      }

      void mutateListRef.current((ids) => {
        const copy = ids.filter((id) => id !== event.trackId);
        const at = Math.max(0, Math.min(copy.length, playing >= 0 ? playing + 1 : 0));
        copy.splice(at, 0, event.trackId);
        return copy;
      });

      const item: PendingInsert = {
        eventId: event.id,
        eventName: event.name,
        playlistId,
        trackId: event.trackId,
        deadline: Date.now() + Math.max(0, event.maxWaitSecs) * 1000,
        onTimeout: event.onTimeout,
      };
      setPendingInserts((prev) => [...prev.filter((p) => p.eventId !== event.id), item]);
      showToast(`Evento «${event.name}»: a continuación`);
    },
    [showToast],
  );

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

  const chooseNowPlayingFile = useCallback(async () => {
    try {
      const path = await pickNowPlayingFile(settingsRef.current.nowPlayingPath);
      if (!path) return;
      updateSettings({ ...settingsRef.current, nowPlayingPath: path });
      showToast("Archivo nowplaying elegido");
    } catch (e) {
      showToast(`No se pudo elegir el archivo: ${String(e)}`);
    }
  }, [showToast, updateSettings]);

  const chooseLiveFile = useCallback(async () => {
    try {
      const current = settingsRef.current.liveFilePath?.trim();
      const path = await pickNowPlayingFile(current || "live.txt");
      if (!path) return;
      updateSettings({ ...settingsRef.current, liveFilePath: path });
      showToast("Archivo de directo elegido");
    } catch (e) {
      showToast(`No se pudo elegir el archivo: ${String(e)}`);
    }
  }, [showToast, updateSettings]);

  const writeNowPlayingNow = useCallback(() => {
    const s = settingsRef.current;
    const path = s.nowPlayingPath.trim();
    if (!path) {
      showToast("Elige primero el archivo nowplaying");
      return;
    }
    const text = nowPlayingTextRef.current;
    if (!text) {
      showToast("Ahora mismo no suena ninguna canción");
      return;
    }
    const live = liveFilePath(path, s.liveFilePath ?? "");
    void writeNowPlaying(path, text)
      .then(async (file) => {
        showToast(`Nowplaying escrito en ${file}`);
        try {
          await publishCoverImage(nowPlayingImagePath(path), nowPlayingCoverRef.current);
        } catch (e) {
          showToast(`No se pudo escribir la portada: ${String(e)}`);
        }
        const liveText = liveTextRef.current;
        if (live && liveText) {
          try {
            await writeNowPlaying(live, liveText);
            await publishCoverImage(liveImagePath(live), liveCoverRef.current);
            showToast(`Directo escrito en ${live}`);
          } catch (e) {
            showToast(`No se pudo escribir el archivo live: ${String(e)}`);
          }
        }
      })
      .catch((e) => showToast(`No se pudo escribir: ${String(e)}`));
  }, [showToast, publishCoverImage]);

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
      const nowMs = now.getTime();
      for (const c of s.campaigns) {
        if (!c.enabled || c.trackIds.length === 0) continue;
        const startsAt = campaignTime(c.startAt);
        const endsAt = campaignTime(c.endAt);
        if (startsAt != null && nowMs < startsAt) continue;
        if (endsAt != null && nowMs > endsAt) continue;
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
          let delta = nowMs - scheduled.getTime();
          if (delta < 0) {
            scheduled.setTime(scheduled.getTime() - dayMs);
            delta = nowMs - scheduled.getTime();
          }
          if (delta > CAMPAIGN_GRACE_MS) continue;
          if (startsAt != null && scheduled.getTime() < startsAt) continue;
          if (endsAt != null && scheduled.getTime() > endsAt) continue;
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

  // Eventos de inserción: a la hora exacta, el sonido queda como siguiente.
  useEffect(() => {
    if (!active) return;
    const check = () => {
      const s = settingsRef.current;
      if (!s.eventsEnabled) return;
      const now = new Date();
      const rowsNow = rowsRef.current;
      const playing = playingRowRef.current;
      const byId = new Map(tracksRef.current.map((t) => [t.id, t]));
      const currentId = playing >= 0 ? rowsNow[playing]?.id ?? "" : "";
      const fires: { event: StationEvent; key: string; at: number }[] = [];

      for (const event of s.events) {
        if (!event.enabled || event.kind !== "insert") continue;
        if (!event.trackId || !byId.has(event.trackId)) continue;
        const minute = parseHM(event.start);
        if (minute === null) continue;
        const scheduled = new Date(now);
        scheduled.setHours(Math.floor(minute / 60), minute % 60, 0, 0);
        let delta = now.getTime() - scheduled.getTime();
        if (delta < 0) {
          scheduled.setTime(scheduled.getTime() - DAY_MS);
          delta = now.getTime() - scheduled.getTime();
        }
        if (delta > EVENT_GRACE_MS) continue;
        if (!event.days.includes(dayIso(scheduled))) continue;
        const hh = pad2(Math.floor(minute / 60));
        const mm = pad2(minute % 60);
        const key = `${dayKey(scheduled)} ${hh}:${mm}`;
        if (event.lastFired === key) continue;
        const lock = `${event.id}|${key}`;
        if (eventFiring.current.has(lock)) continue;
        eventFiring.current.add(lock);
        fires.push({ event, key, at: scheduled.getTime() });
      }

      if (fires.length === 0) return;
      fires.sort((a, b) => a.at - b.at);

      const firedKeys = new Map<string, string>();
      const already: StationEvent[] = [];
      const queue: { event: StationEvent; key: string }[] = [];
      const queuedTracks = new Set<string>();
      for (const fire of fires) {
        firedKeys.set(fire.event.id, fire.key);
        if (fire.event.trackId === currentId) {
          already.push(fire.event);
          continue;
        }
        if (queuedTracks.has(fire.event.trackId)) continue;
        queuedTracks.add(fire.event.trackId);
        queue.push({ event: fire.event, key: fire.key });
      }

      const inserted: PendingInsert[] = [];
      if (queue.length > 0) {
        let base = playing >= 0 ? playing + 1 : 0;
        void mutateListRef.current((ids) => {
          let copy = [...ids];
          for (const item of queue) {
            copy = copy.filter((id) => id !== item.event.trackId);
            const at = Math.max(0, Math.min(copy.length, base));
            copy.splice(at, 0, item.event.trackId);
            base = at + 1;
          }
          return copy;
        });
        const nowMs = Date.now();
        for (const item of queue) {
          inserted.push({
            eventId: item.event.id,
            eventName: item.event.name,
            playlistId: active.id,
            trackId: item.event.trackId,
            deadline: nowMs + Math.max(0, item.event.maxWaitSecs) * 1000,
            onTimeout: item.event.onTimeout,
          });
        }
        setPendingInserts((prev) => {
          const ids = new Set(inserted.map((p) => p.eventId));
          return [...prev.filter((p) => !ids.has(p.eventId)), ...inserted];
        });
      }

      if (firedKeys.size > 0) {
        setSettings((prev) => {
          const events = prev.events.map((event) =>
            firedKeys.has(event.id) ? { ...event, lastFired: firedKeys.get(event.id) ?? "" } : event,
          );
          const nextSettings = { ...prev, events };
          void saveSettings(nextSettings).catch(() => undefined);
          return nextSettings;
        });
      }

      if (inserted.length === 1) {
        const wait = inserted[0];
        const limit = queue[0]?.event.maxWaitSecs ?? 0;
        showToast(
          limit > 0
            ? `Evento «${wait.eventName}»: a continuación (máx. ${limit} s)`
            : `Evento «${wait.eventName}»: a continuación`,
        );
      } else if (inserted.length > 1) {
        showToast(`${inserted.length} eventos insertados en la lista`);
      } else if (already.length > 0) {
        showToast(`Evento «${already[0].name}»: ya está sonando`);
      }
    };

    check();
    const timer = window.setInterval(check, 15000);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active?.id, settings.events, settings.eventsEnabled]);

  // Temporizador de las inserciones pendientes: si la pista actual no
  // termina a tiempo, se lanza o se cancela según el evento.
  useEffect(() => {
    const timer = window.setInterval(() => {
      const pending = pendingInsertsRef.current;
      if (pending.length === 0) return;
      const rowsNow = rowsRef.current;
      const playing = playingRowRef.current;
      const playlistId = activeIdRef.current;
      const now = Date.now();
      const keep: PendingInsert[] = [];
      const force: PendingInsert[] = [];
      const cancel: PendingInsert[] = [];

      for (const item of pending) {
        if (item.playlistId !== playlistId) continue;
        const index = rowsNow.findIndex((row) => row.id === item.trackId);
        if (index < 0) continue;
        if (playing >= 0 && index <= playing) continue;
        if (now < item.deadline) {
          keep.push(item);
          continue;
        }
        if (item.onTimeout === "force") force.push(item);
        else cancel.push(item);
      }

      if (keep.length === pending.length) return;
      setPendingInserts(keep);

      for (const item of force) {
        const index = rowsRef.current.findIndex((row) => row.id === item.trackId);
        if (index >= 0) {
          playRowRef.current(index);
          showToast(`Evento «${item.eventName}» lanzado al aire`);
        }
      }
      if (cancel.length > 0) {
        const ids = new Set(cancel.map((item) => item.trackId));
        void mutateListRef.current((current) => current.filter((id) => !ids.has(id)));
        showToast(
          cancel.length === 1
            ? `Evento «${cancel[0].eventName}» cancelado: no llegó a tiempo`
            : `${cancel.length} eventos cancelados: no llegaron a tiempo`,
        );
      }
    }, 1000);

    return () => window.clearInterval(timer);
  }, [showToast]);

  // Una inserción deja de estar pendiente en cuanto suena o se cambia de lista.
  useEffect(() => {
    if (pendingInserts.length === 0) return;
    const currentId = playingRow >= 0 ? rows[playingRow]?.id ?? "" : "";
    setPendingInserts((prev) => {
      const next = prev.filter((item) => {
        if (item.playlistId !== active?.id) return false;
        return item.trackId !== currentId;
      });
      return next.length === prev.length ? prev : next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playingRow, rows, active?.id, pendingInserts.length]);

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
    const scope = autoScopeRef.current;
    void autoPick(
      rows.map((r) => r.id),
      need,
      scope?.kind,
      scope?.id,
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
  }, [autopilotOn, playingRow, rows, settings, autoScopeKey]);

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
          {autopilotOn && activeAutoEvent && (
            <span
              className="pill pill-event"
              title={`Evento «${activeAutoEvent.name}»: desde las ${activeAutoEvent.start} · ${eventSourceLabel(activeAutoEvent, blocks)}`}
            >
              Evento: {eventSourceLabel(activeAutoEvent, blocks)}
            </span>
          )}
          {autopilotOn && (
            <span className="pill pill-auto">
              Piloto automático</span>
          )}
          <label
            className={`top-switch ${settings.eventsEnabled ? "switch-on" : ""}`}
            title={
              settings.eventsEnabled
                ? "Desactivar temporalmente todos los eventos"
                : "Activar los eventos programados"
            }
          >
            <span className="top-switch-label">EVENTOS</span>
            <span className="switch-track"><span className="switch-knob" /></span>
            <input
              type="checkbox"
              className="sr-only"
              checked={settings.eventsEnabled}
              onChange={(e) => {
                if (!e.target.checked) setManualAuto(null);
                updateSettings({ ...settings, eventsEnabled: e.target.checked });
              }}
            />
          </label>
          <label
            className={`top-switch ${settings.liveMode ? "switch-on" : ""}`}
            title={
              settings.liveMode
                ? "Desactivar el modo LIVE (volver a los metadatos de la canción)"
                : "Modo LIVE: la barra auxiliar muestra el programa y sus metadatos"
            }
          >
            <span className="top-switch-label">LIVE</span>
            <span className="switch-track"><span className="switch-knob" /></span>
            <input
              type="checkbox"
              className="sr-only"
              checked={settings.liveMode}
              onChange={(e) => updateSettings({ ...settings, liveMode: e.target.checked })}
            />
          </label>
          <button
            type="button"
            className={`top-live ${streamStatus?.running ? "live" : ""} ${
              streamBusy ? "busy" : ""
            }`}
            onClick={() => void toggleStreaming()}
            disabled={streamBusy || (!streamStatus?.running && !hasStreamOutputs)}
            aria-pressed={streamStatus?.running ?? false}
            title={
              streamStatus?.running
                ? "Detener la emisión"
                : hasStreamOutputs
                  ? streamStatus?.lastError ?? "Iniciar la emisión"
                  : "Configura una salida en Ajustes > Streaming"
            }
          >
            <span className="top-live-dot" />
            <span>{streamBusy ? "CONECTANDO" : streamStatus?.running ? "EN VIVO" : "EMITIR"}</span>
          </button>
          <span className="clock" role="timer">{clock}</span>
          <button
            type="button"
            className={`btn btn-sm top-action ${normStatus ? "top-action-busy" : ""}`}
            onClick={openNormalizer}
            title="Abrir la librería: mover entre A/B, normalizar y recortar"
          >
            <IconList size={15} /> Librería
            {normStatus && (
              <span className="top-action-count">
                {normStatus.done}/{normStatus.total}
              </span>
            )}
          </button>
          <button
            type="button"
            className="icon-btn"
            onClick={openSettings}
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
          history={history}
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

        <VuMeter mixer={mixer} />

        <div className="right-col">
          <LiveBar
            programs={(settings.programs ?? []).filter((program) => program.enabled)}
            activeId={settings.liveProgramId}
            live={settings.liveMode}
            onSelect={(id) => updateSettings({ ...settings, liveProgramId: id })}
            onToggleLive={(on) => updateSettings({ ...settings, liveMode: on })}
            onOpenPrograms={() => {
              setSettingsTab("programs");
              setSettingsMounted(true);
              setSettingsOpen(true);
            }}
          />
          <DeckZone
            title={deckRow?.title ?? ""}
            artist={deckRow?.artist ?? ""}
            album={deckRow?.album ?? ""}
            cover={deckRow?.cover ?? ""}
            current={pos.cur}
            total={pos.total}
            spinning={!paused && playingRow >= 0}
            next={nextRow ? nextRow.title : null}
            nextArtist={nextRow?.artist ?? ""}
            nextAlbum={nextRow?.album ?? ""}
            nextCover={nextRow?.cover ?? ""}
            nextDuration={nextRow?.durationSecs ?? 0}
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
            onClearPlaylist={() => void clearActivePlaylist()}
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
        blocks={blocks}
        defaultBlockId={defaultBlockId}
        autoEventLabel={activeAutoEvent ? eventSourceLabel(activeAutoEvent, blocks) : null}
        onTogglePlay={() => void togglePlay()}
        onNext={() => void next()}
        onPrev={() => void prev()}
        onAutopilot={setAutopilot}
        onDefaultBlockChange={(id) => {
          updateSettings({ ...settings, defaultBlockId: id });
          const name = blocks.find((block) => block.id === id)?.name;
          showToast(
            activeAutoEvent
              ? `Bloque guardado; ahora manda el evento «${eventSourceLabel(activeAutoEvent, blocks)}»`
              : name
                ? `AutoDJ: «${name}»`
                : "AutoDJ: automático (bloques de Música)",
          );
        }}
        onFadeChange={(s) => updateSettings({ ...settings, fadeSeconds: s })}
        onVolume={setVolume}
      />

      {normalizerMounted && (
        <Normalizer
          tracks={tracks}
          blocks={blocks}
          targetLufs={settings.targetLufs}
          truePeakDb={settings.truePeakDb}
          hidden={!normalizerOpen}
          onHide={hideNormalizer}
          onStatus={setNormStatus}
          apiRef={normApiRef}
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

      {settingsMounted && (
        <SettingsPanel
          settings={settings}
          tracks={tracks}
          blocks={blocks}
          hidden={!settingsOpen}
          onChange={updateSettings}
          onClose={() => setSettingsOpen(false)}
          onPickMusicFolder={() => chooseMusicFolder()}
          onPickLogo={() => chooseLogo()}
          onPickNowPlaying={chooseNowPlayingFile}
          onPickLiveFile={chooseLiveFile}
          onWriteNowPlaying={writeNowPlayingNow}
          onClearLogo={() => removeLogo()}
          onImportAudio={() => importForCampaign()}
          onLaunchEvent={launchEvent}
          showToast={showToast}
          tab={settingsTab}
          onTabChange={setSettingsTab}
          mixer={mixerRef.current}
        />
      )}

      {normStatus && !normalizerOpen && (
        <div className={`norm-mini ${normStatus.paused ? "norm-mini-paused" : ""}`} role="status">
          <button
            type="button"
            className="norm-mini-main"
            onClick={openNormalizer}
            title="Abrir la librería"
          >
            <IconWave size={15} />
            <span className="norm-mini-txt">
              <strong>Librería</strong>
              <span title={normStatus.label}>
                {normStatus.paused ? "En pausa" : "Normalizando"} · {normStatus.done}/
                {normStatus.total}
                {normStatus.errors > 0 ? ` · ${normStatus.errors} con error` : ""}
                {normStatus.label ? ` · ${normStatus.label}` : ""}
              </span>
            </span>
            <span className="norm-mini-bar">
              <span
                style={{
                  width: `${(normStatus.done / Math.max(1, normStatus.total)) * 100}%`,
                }}
              />
            </span>
          </button>
          <button
            type="button"
            className="btn btn-sm"
            onClick={() =>
              normStatus.paused ? normApiRef.current?.resume() : normApiRef.current?.pause()
            }
          >
            {normStatus.paused ? "Reanudar" : "Pausar"}
          </button>
          <button
            type="button"
            className="ghost-btn norm-mini-cancel"
            onClick={() => normApiRef.current?.cancel()}
          >
            Cancelar
          </button>
        </div>
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
