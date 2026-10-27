import { WindowControls } from "./components/WindowControls";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  listTracks,
  listPlaylists,
  savePlaylist,
  deletePlaylist,
  importFiles,
  importFilesDedup,
  deleteTrack,
  scanMusicFolder,
  listBlocks,
  setTrackBlocks,
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
  VIDEO_EXTENSIONS,
  convertVideos,
  isVideoFile,
  needsVideoConversion,
  setTracksLibrary,
  pickImageFile,
  setBrandingLogo,
  trackUrl,
  backfillCovers,
  backfillQuality,
  listHistory,
  loadSession,
  saveSession,
  writeNowPlaying,
  writeNowPlayingImage,
  pickNowPlayingFile,
  getStreamStatus,
  installQuitHandler,
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
  StreamMeta,
  StreamStatus,
} from "./types";
import { DEFAULT_SETTINGS, campaignSchedules, effectiveDuration, eventSchedules, type IntroOverlay } from "./types";
import { pickIntro } from "./intros";
import { EMPTY_TRACK, RadioPlayer } from "./audio";
import { SoundMixer } from "./mixer";
import { StudioCalls, type StudioSnapshot } from "./studioCalls";
import { StreamEncoder } from "./streaming";
import { LiveBar } from "./components/LiveBar";
import { TrackEditor } from "./components/TrackEditor";
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
import { WorkspaceLayout } from "./components/WorkspaceLayout";
import { ChatPanel } from "./components/ChatPanel";
import { VideoSwitcher } from "./components/VideoSwitcher";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { NativeAppFeed } from "./nativeFeed";
import { NativePlayer } from "./nativeEngine";
import {
  closeNowPlayingOut,
  closeVideoOut,
  openNowPlayingOut,
  openToolWindow,
  openVideoOut,
  publishState,
  serveMain,
} from "./bridge";
import type { VideoState } from "./videoSurface";
import { isDragging } from "./dnd";
import { apiApply, apiPublish, backupLastImportLog, confirmAsk, cursorWall, notifyFire } from "./api";
import { availableMonitors, currentMonitor } from "@tauri-apps/api/window";
import { emit as emitEvent, listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { PlayerBar } from "./components/PlayerBar";
import { Clock } from "./components/Clock";
import { SysMonitor } from "./components/SysMonitor";
import { SettingsPanel, type SettingsTab } from "./components/SettingsPanel";
import { Normalizer } from "./components/Normalizer";
import type { NormalizerApi, NormalizerStatus } from "./components/Normalizer";
import { IconGear, IconList, IconWave, LogoRadio } from "./icons";
import { isRandom, logPick, pickRandom, randomPool, relaxedText } from "./eventPick";

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
  let best: Date | null = null;
  for (const block of eventSchedules(event)) {
    for (const value of block.times.length > 0 ? block.times : [block.start ?? event.start]) {
      const start = parseHM(value);
      if (start === null) continue;
      for (let offset = 0; offset <= 7; offset++) {
        const day = new Date(now);
        day.setDate(day.getDate() - offset);
        day.setHours(Math.floor(start / 60), start % 60, 0, 0);
        if (day.getTime() > now.getTime()) continue;
        if (!block.days.includes(dayIso(day))) continue;
        if (!best || day.getTime() > best.getTime()) best = day;
        break;
      }
    }
  }
  return best;
}

/** Próximo inicio de cualquier franja AutoDJ después de `after`. */
function nextAutoStartAfter(events: StationEvent[], after: Date): number {
  let best = Number.POSITIVE_INFINITY;
  for (let offset = 0; offset <= 7; offset++) {
    const day = new Date(after);
    day.setDate(day.getDate() + offset);
    for (const event of events) {
      if (!event.enabled || event.kind !== "auto") continue;
      for (const block of eventSchedules(event)) {
        if (!block.days.includes(dayIso(day))) continue;
        for (const value of block.times.length > 0 ? block.times : [block.start ?? event.start]) {
          const start = parseHM(value);
          if (start === null) continue;
          const at = new Date(day);
          at.setHours(Math.floor(start / 60), start % 60, 0, 0);
          if (at.getTime() <= after.getTime()) continue;
          if (at.getTime() < best) best = at.getTime();
        }
      }
    }
  }
  return best;
}

function eventSourceLabel(event: StationEvent, blocks: Block[]): string {
  if (event.sourceKind === "library") {
    return event.sourceId === "b" ? "Biblioteca B" : "Biblioteca A";
  }
  return blocks.find((b) => b.id === event.sourceId)?.name ?? "Lista eliminada";
}

/** Emision de internet de un evento que esta sonando. */
interface LiveRun {
  eventId: string;
  name: string;
  url: string;
  /** ms epoch */
  startedAt: number;
  endsAt: number;
  fade: number;
  meta: StreamMeta;
}

/** Franja [inicio, fin) de un evento de emision que contiene `now` (o null). */
function streamWindow(event: StationEvent, now: Date): { start: number; end: number; key: string } | null {
  for (const block of eventSchedules(event)) {
    const from = block.start ?? event.start;
    const to = block.end ?? event.end ?? "";
    const s = parseHM(from);
    const e = parseHM(to);
    if (s === null || e === null || s === e) continue;
    for (const back of [0, 1]) {
      const start = new Date(now);
      start.setDate(start.getDate() - back);
      start.setHours(Math.floor(s / 60), s % 60, 0, 0);
      const end = new Date(start);
      end.setHours(Math.floor(e / 60), e % 60, 0, 0);
      if (e < s) end.setDate(end.getDate() + 1);
      if (now >= start && now < end && block.days.includes(dayIso(start))) {
        return { start: start.getTime(), end: end.getTime(), key: `${dayKey(start)} ${from}` };
      }
    }
  }
  return null;
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
  const ext = path.slice(dot + 1).toLowerCase();
  return AUDIO_EXTENSIONS.includes(ext) || VIDEO_EXTENSIONS.includes(ext);
}

/** Metadatos no vacios de una emision programada. */
function hasMeta(meta?: StreamMeta | null): meta is StreamMeta {
  return (
    !!meta &&
    [meta.title, meta.artist, meta.album, meta.year, meta.genre, meta.comment, meta.cover].some(
      (value) => !!value?.trim(),
    )
  );
}

/**
 * Mantiene alineados los metadatos de una lista al insertar, mover o quitar
 * pistas. Los metadatos nuevos se aplican con `overrides`.
 */
function alignPlaylistMeta(
  oldIds: string[],
  oldMeta: (StreamMeta | null | undefined)[] | undefined,
  newIds: string[],
  overrides?: (id: string, index: number) => StreamMeta | null,
): (StreamMeta | null)[] {
  const meta = oldMeta ?? [];
  const used = new Set<number>();
  return newIds.map((id, index) => {
    const override = overrides?.(id, index);
    if (override) return override;
    if (oldIds[index] === id && !used.has(index)) {
      used.add(index);
      return meta[index] ?? null;
    }
    const found = oldIds.findIndex((oldId, oldIndex) => !used.has(oldIndex) && oldId === id);
    if (found >= 0) {
      used.add(found);
      return meta[found] ?? null;
    }
    return null;
  });
}

/** Filas de una lista con los datos de la biblioteca (pistas que existen). */
function rowsOf(pl: Playlist | undefined, tracks: Track[]): PlaylistRow[] {
  if (!pl) return [];
  const byId = new Map(tracks.map((t) => [t.id, t]));
  return pl.trackIds.flatMap((id, index) => {
    const t = byId.get(id);
    if (!t) return [];
    const meta = pl.meta?.[index] ?? null;
    const value = (override: string | undefined, base: string) =>
      override?.trim() ? override : base;
    return [
      {
        id: t.id,
        title: value(meta?.title, t.title),
        artist: value(meta?.artist, t.artist),
        album: value(meta?.album, t.album),
        durationSecs: effectiveDuration(t),
        cover: value(meta?.cover, t.cover),
        blocks: t.blocks,
        video: isVideoFile(t.file),
        meta,
      },
    ];
  });
}

/** Con el motor nativo, la mesa web no toca los canales de musica. */
function webMixerSlice(s: Settings): Pick<Settings, "mixerChannels" | "mixerBuses" | "monitorBusId"> {
  return {
    // Los inserts los lleva el motor nativo (sus tarjetas se eligen por nombre
    // del sistema, no por el id del WebView), asi que aqui se quitan.
    mixerChannels: s.mixerChannels
      // Todo va por el motor nativo (la preescucha y las llamadas se le
      // mandan desde el WebView): la mesa web queda vacia y no suena nada doble.
      .filter(() => false)
      .map((ch) => ({ ...ch, insert: undefined })),
    mixerBuses: [],
    monitorBusId: s.monitorBusId,
  };
}

/** Pasa el antiguo RTMP unico a una salida de video de la lista nueva. */
function migrateLegacyRtmp(settings: Settings): Settings {
  const legacy = settings.streaming.rtmp;
  if (!legacy?.enabled) return settings;
  const url = legacy.url.trim();
  const streaming = {
    ...settings.streaming,
    rtmp: { ...legacy, enabled: false },
  };
  if (!url) return { ...settings, streaming };
  if (
    settings.video.outputs.some(
      (output) => output.kind === "rtmp" && output.source.trim() === url,
    )
  ) {
    return { ...settings, streaming };
  }
  const output: Settings["video"]["outputs"][number] = {
    id: `legacy-rtmp-${Date.now().toString(36)}`,
    name: "RTMP",
    kind: "rtmp",
    source: url,
    videoInputId: legacy.videoInputId || "program",
    fallbackVideoInputId: "",
    audioSource: legacy.audioSource ?? "mixer",
    audioSourceId: legacy.audioSourceId ?? "",
    enabled: true,
    width: legacy.width,
    height: legacy.height,
    fps: legacy.fps,
    bitrateKbps: legacy.bitrateKbps,
  };
  return {
    ...settings,
    streaming,
    video: { ...settings.video, outputs: [...settings.video.outputs, output] },
  };
}

/** Nombre de la emisora; los nombres de serie antiguos cuentan como vacío. */
function stationName(name: string | undefined): string {
  const n = (name ?? "").trim();
  return ["MiRadio", "Mi radio", "OmniCaster"].includes(n) ? "" : n;
}

export default function App() {
  const [tracks, setTracks] = useState<Track[]>([]);
  const [blocks, setBlocks] = useState<Block[]>([]);
  const blocksRef = useRef<Block[]>([]);
  blocksRef.current = blocks;
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
  const [, setDropHover] = useState(false);
  const [dropBlockId, setDropBlockId] = useState("");
  const [importing, setImporting] = useState(false);
  const [toast, setToast] = useState("");
  const [nowTick, setNowTick] = useState(() => Date.now());
  const [pendingInserts, setPendingInserts] = useState<PendingInsert[]>([]);
  // ---- emision de internet de un evento ----
  const [liveRun, setLiveRun] = useState<LiveRun | null>(null);
  const liveRunRef = useRef<LiveRun | null>(null);
  liveRunRef.current = liveRun;
  const liveTrack = useMemo<Track | null>(
    () =>
      liveRun
        ? {
            ...EMPTY_TRACK,
            id: `live:${liveRun.eventId}`,
            title: liveRun.meta.title,
            artist: liveRun.meta.artist,
            album: liveRun.meta.album,
            genre: liveRun.meta.genre,
            year: liveRun.meta.year,
            durationSecs: Math.max(0, (liveRun.endsAt - liveRun.startedAt) / 1000),
            cover: liveRun.meta.cover,
            file: "",
          }
        : null,
    [liveRun],
  );
  const [liveClock, setLiveClock] = useState(() => Date.now());
  useEffect(() => {
    if (!liveRun) return;
    const t = window.setInterval(() => setLiveClock(Date.now()), 500);
    return () => window.clearInterval(t);
  }, [liveRun]);
  const [manualAuto, setManualAuto] = useState<{ id: string; until: number } | null>(null);
  const [streamStatus, setStreamStatus] = useState<StreamStatus | null>(null);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [cutsTrackId, setCutsTrackId] = useState("");
  const [pendingEdit, setPendingEdit] = useState<{ id: string; n: number } | null>(null);
  const [streamBusy, setStreamBusy] = useState(false);
  // Menu de clic derecho para asignar bloques (desde el plato «al aire»).
  const [blockMenu, setBlockMenu] = useState<{ trackId: string; x: number; y: number } | null>(null);
  const [preview, setPreview] = useState<{
    track: Track;
    playing: boolean;
    pos: number;
    from: number;
    to: number;
  } | null>(null);
  const autopilotOn = settings.autopilotEnabled;
  const cutsTrack = tracks.find((track) => track.id === cutsTrackId) ?? null;
  const defaultBlockId = blocks.some((block) => block.id === settings.defaultBlockId)
    ? settings.defaultBlockId
    : "";
  const hasStreamOutputs = useMemo(
    () =>
      settings.streaming.icecast.some((stream) => stream.enabled) ||
      (settings.video.enabled && settings.video.outputs.some((output) => output.enabled && output.kind === "rtmp")),
    [settings.streaming.icecast, settings.video.enabled, settings.video.outputs],
  );
  const audioStreamRunning =
    streamStatus?.outputs.some((output) => output.running && output.kind === "icecast") ?? false;
  const videoStreamRunning =
    streamStatus?.outputs.some((output) => output.running && output.kind === "rtmp") ?? false;
  const audioStreamReady = settings.streaming.icecast.some((stream) => stream.enabled);
  const videoStreamReady =
    settings.video.enabled && settings.video.outputs.some((output) => output.enabled && output.kind === "rtmp");

  const playerRef = useRef<RadioPlayer | NativePlayer | null>(null);
  const [native, setNative] = useState<NativePlayer | null>(null);
  /** Posicion exacta (segundos) para la API de ngradio */
  const exactPosRef = useRef({ cur: 0, total: 0 });
  const mixerRef = useRef<SoundMixer | null>(null);
  const streamEncoderRef = useRef<StreamEncoder | null>(null);
  const userPausedRef = useRef(false);
  const autoPlayStartedRef = useRef(false);
  const pausedRef = useRef(true);
  /** Estado de pausa real (pausedRef no siempre se actualiza) */
  const pausedStateRef = useRef(true);
  const sessionRef = useRef<SessionState | null>(null);
  const sessionRestoredRef = useRef(false);
  const restoringRef = useRef(false);
  const [mixer, setMixer] = useState<SoundMixer | null>(null);
  const studioRef = useRef<StudioCalls | null>(null);
  const [studio, setStudio] = useState<StudioSnapshot>({ status: "off", error: "", calls: [] });
  const [callMuted, setCallMuted] = useState(false);
  const posRef = useRef(pos);
  const toastTimer = useRef(0);
  const topupBusy = useRef(false);
  const normalizerRef = useRef(false);
  const normApiRef = useRef<NormalizerApi | null>(null);
  const eventFiring = useRef<Set<string>>(new Set());
  const previewAudioRef = useRef<HTMLAudioElement | null>(null);
  const previewRef = useRef(preview);
  previewRef.current = preview;
  const previewFromRef = useRef(0);
  const previewToRef = useRef(0);
  const pendingInsertsRef = useRef(pendingInserts);
  pendingInsertsRef.current = pendingInserts;
  const playRowRef = useRef<(index: number) => void>(() => undefined);

  const showToast = useCallback((msg: string) => {
    if (/^(Error|No se pudo|Falló|Fallo)/.test(msg) && !msg.startsWith("Falló la prueba")) {
      void notifyFire("error", { message: msg }).catch(() => undefined);
    }
    setToast(msg);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(""), 3200);
  }, []);

  // Minireproductor de preescucha: suena por el canal «Preescucha» de la mesa
  // (auriculares), nunca por el programa. Se rehace si cambia la mesa.
  useEffect(() => {
    if (!mixer) return;
    const audio = new Audio();
    audio.preload = "auto";
    audio.crossOrigin = "anonymous";
    let node: MediaElementAudioSourceNode | null = null;
    try {
      node = mixer.ctx.createMediaElementSource(audio);
      node.connect(mixer.previewInput);
    } catch {
      /* sin Web Audio: sonara por la salida del sistema */
    }
    previewAudioRef.current = audio;
    const sync = () =>
      setPreview((prev) => {
        if (!prev) return prev;
        const to = previewToRef.current;
        if (to > 0 && audio.currentTime >= to) {
          audio.pause();
          return { ...prev, playing: false, pos: to };
        }
        return { ...prev, playing: !audio.paused, pos: audio.currentTime };
      });
    const onEnded = () =>
      setPreview((prev) => (prev ? { ...prev, playing: false, pos: prev.to } : prev));
    audio.addEventListener("timeupdate", sync);
    audio.addEventListener("play", sync);
    audio.addEventListener("pause", sync);
    audio.addEventListener("ended", onEnded);
    return () => {
      audio.pause();
      audio.removeAttribute("src");
      audio.removeEventListener("timeupdate", sync);
      audio.removeEventListener("play", sync);
      audio.removeEventListener("pause", sync);
      audio.removeEventListener("ended", onEnded);
      try {
        node?.disconnect();
      } catch {
        /* ya desconectado */
      }
      if (previewAudioRef.current === audio) previewAudioRef.current = null;
      setPreview(null);
    };
  }, [mixer]);

  const previewWarned = useRef(false);
  const startPreview = useCallback((track: Track) => {
    const audio = previewAudioRef.current;
    if (!audio) return;
    mixerRef.current?.stopPreview();
    void mixerRef.current?.resume();
    const hasCue = settingsRef.current.mixerChannels.some(
      (c) => c.input.kind === "app" && c.input.app === "preview",
    );
    if (!hasCue && !previewWarned.current) {
      previewWarned.current = true;
      showToast("La preescucha no tiene canal en la mesa: créalo (Sonido) para oírla en tus auriculares");
    }
    const from = Math.max(0, track.trimStart || 0);
    const to = Math.max(from + 0.05, track.trimEnd ?? track.durationSecs);
    previewFromRef.current = from;
    previewToRef.current = to;
    const play = () => {
      try {
        audio.currentTime = from;
      } catch {
        /* aun sin metadatos */
      }
      setPreview({ track, playing: true, pos: from, from, to });
      void audio.play().catch((error) => showToast(`No se pudo preescuchar: ${String(error)}`));
    };
    audio.src = trackUrl({ file: track.file });
    if (audio.readyState >= 1) play();
    else audio.addEventListener("loadedmetadata", play, { once: true });
  }, [showToast]);

  const togglePreview = useCallback(() => {
    const audio = previewAudioRef.current;
    const current = previewRef.current;
    if (!audio || !current) return;
    if (audio.paused) {
      if (audio.currentTime >= current.to - 0.05) audio.currentTime = current.from;
      void audio.play().catch((error) => showToast(`No se pudo preescuchar: ${String(error)}`));
    } else {
      audio.pause();
    }
  }, [showToast]);

  const seekPreview = useCallback((fraction: number) => {
    const audio = previewAudioRef.current;
    const cur = previewRef.current;
    if (!audio || !cur) return;
    try {
      audio.currentTime = cur.from + fraction * (cur.to - cur.from);
    } catch {
      /* sin metadatos aun */
    }
  }, []);
  const [autoPreview, setAutoPreviewState] = useState(() => {
    try {
      return localStorage.getItem("miradio.autoPreview") !== "0";
    } catch {
      return true;
    }
  });
  const setAutoPreview = useCallback((on: boolean) => {
    setAutoPreviewState(on);
    try {
      localStorage.setItem("miradio.autoPreview", on ? "1" : "0");
    } catch {
      /* sin almacenamiento */
    }
  }, []);

  const stopPreview = useCallback(() => {
    const audio = previewAudioRef.current;
    if (audio) {
      audio.pause();
      audio.src = "";
    }
    setPreview(null);
  }, []);

  // Los eventos cambian por minutos; no hace falta re-renderizar cada segundo.
  useEffect(() => {
    const t = window.setInterval(() => setNowTick(Date.now()), 10_000);
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
    const useNative = settingsRef.current.audioEngine === "native";
    // Motor nativo (beta): la musica la reproduce y mezcla Rust. La mesa web
    // sigue con microfonos, preescucha y llamadas.
    let appFeed: NativeAppFeed | null = null;
    const player = useNative ? new NativePlayer((msg) => showToast(msg)) : new RadioPlayer(mixer);
    if (useNative) {
      mixer.apply(webMixerSlice(settingsRef.current));
      const nat = player as NativePlayer;
      nat.applyMixer(settingsRef.current);
      nat.setVolume(settingsRef.current.masterVolume);
      appFeed = new NativeAppFeed(mixer);
      void mixer.resume();
      void appFeed.start();
      const s = settingsRef.current;
      nat.fadeSeconds = s.fadeSeconds;
      nat.loop = false;
      nat.silenceSkip = s.silenceDetection;
      nat.silenceThresholdDb = s.silenceThresholdDb ?? -55;
      const byId = new Map(tracksRef.current.map((t) => [t.id, t]));
      nat.setPlaylist(rowsRef.current.flatMap((r) => byId.get(r.id) ?? []));
      setNative(nat);
    }
    player.onIndexChange = (i) => onPlayerIndexRef.current(i);
    player.onDiag = (msg) => showToast(msg);
    player.onEnded = () => {
      setPlayingRow(-1);
      setPaused(true);
    };
    player.onTick = (cur, total) => {
      exactPosRef.current = { cur, total };
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
      player.onDiag = null;
      player.dispose();
      appFeed?.dispose();
      playerRef.current = null;
      setNative(null);
      mixer.dispose();
      mixerRef.current = null;
      setMixer(null);
    };
  }, [showToast, settings.audioEngine]);

  const active = useMemo(
    () => playlists.find((p) => p.id === activeId) ?? playlists[0],
    [playlists, activeId],
  );

  // Evento de franja AutoDJ activo. Si varios coinciden, manda el que
  // empezó más tarde (y a igualdad, el último de la lista).
  const activeAutoEvent = useMemo(() => {
    // Con el modo LIVE los eventos quedan en pausa.
    if (!settings.eventsEnabled || settings.liveMode) return null;
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
  }, [settings.events, settings.eventsEnabled, settings.liveMode, manualAuto, blocks, nowTick]);
  const autoScope = activeAutoEvent
    ? { kind: activeAutoEvent.sourceKind, id: activeAutoEvent.sourceId }
    : null;
  const autoScopeKey = autoScope ? `${autoScope.kind}|${autoScope.id}` : "";
  const autoScopeRef = useRef(autoScope);
  autoScopeRef.current = autoScope;

  // Filas resueltas con datos de la biblioteca (lista activa: la que suena)
  const rows: PlaylistRow[] = useMemo(() => rowsOf(active, tracks), [active, tracks]);

  // Lista que se ve en pantalla: se puede navegar sin cortar la que suena.
  const [viewId, setViewId] = useState("");
  const view = useMemo(
    () => playlists.find((p) => p.id === viewId) ?? active,
    [playlists, viewId, active],
  );
  const viewRows: PlaylistRow[] = useMemo(
    () => (view && active && view.id === active.id ? rows : rowsOf(view, tracks)),
    [view, active, rows, tracks],
  );
  // Siguiente elegida a mano (clic derecho): de esta lista o de otra.
  const [nextPick, setNextPick] = useState<{ listId: string; index: number } | null>(null);
  const pickRows: PlaylistRow[] | null = useMemo(() => {
    if (!nextPick) return null;
    if (active && nextPick.listId === active.id) return rows;
    return rowsOf(playlists.find((p) => p.id === nextPick.listId), tracks);
  }, [nextPick, active, rows, playlists, tracks]);


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
    if (liveTrack) return liveTrack;
    if (playingRow < 0) return null;
    const row = rows[playingRow];
    if (!row) return null;
    const track = tracks.find((item) => item.id === row.id);
    if (!track) return null;
    const meta = row.meta;
    if (!hasMeta(meta)) return track;
    return {
      ...track,
      title: meta.title?.trim() || track.title,
      artist: meta.artist?.trim() || track.artist,
      album: meta.album?.trim() || track.album,
      year: meta.year?.trim() || track.year,
      genre: meta.genre?.trim() || track.genre,
      cover: meta.cover?.trim() || track.cover,
    };
  }, [playingRow, rows, tracks, liveTrack]);

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
      album: liveProgram.album ?? "",
      year: liveProgram.year ?? "",
      genre: liveProgram.genre ?? "",
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
  pausedStateRef.current = paused;
  const tracksRef = useRef(tracks);
  tracksRef.current = tracks;
  const settingsRef = useRef(settings);
  const historyRef = useRef<HistoryEntry[]>([]);
  historyRef.current = history;
  settingsRef.current = settings;
  const activeIdRef = useRef("");
  activeIdRef.current = active?.id ?? "";
  const campaignFiring = useRef<Set<string>>(new Set());

  // El reproductor recibe la lista activa; si hay una "siguiente" elegida a
  // mano, tras la actual sigue esa pista (de esta u otra lista) y lo de debajo.
  const nextPickRef = useRef(nextPick);
  nextPickRef.current = nextPick;
  const virtMapRef = useRef<{ listId: string; row: number }[]>([]);
  const virtIdsRef = useRef<string[]>([]);
  // Intros: canciones desde el ultimo intro, plan por pista y ultimo audio usado.
  const introSinceRef = useRef(1000);
  const introPlanRef = useRef<Map<string, IntroOverlay>>(new Map());
  const lastIntroFileRef = useRef("");
  const lastStartedIdRef = useRef("");
  const pendingPlayRef = useRef<{ listId: string; row: number } | null>(null);
  useEffect(() => {
    if (!active) return;
    const byId = new Map(tracks.map((t) => [t.id, t]));
    const cur = playingRow;
    let entries = rows.map((r, row) => ({ listId: active.id, row, id: r.id }));
    if (nextPick && pickRows && cur >= 0 && nextPick.index < pickRows.length) {
      entries = entries.slice(0, cur + 1).concat(
        pickRows.slice(nextPick.index).map((r, k) => ({ listId: nextPick.listId, row: nextPick.index + k, id: r.id })),
      );
    }
    virtMapRef.current = entries.map(({ listId, row }) => ({ listId, row }));
    // Intros: se reparten por adelantado; la pista que ya suena conserva el suyo.
    const cfg = settingsRef.current.intros;
    const plan = new Map<string, IntroOverlay>();
    let since = introSinceRef.current;
    const ids = entries.map((e) => e.id);
    virtIdsRef.current = ids;
    const out = entries.flatMap((e, i) => {
      const t = byId.get(e.id);
      if (!t) return [];
      let ov: IntroOverlay | undefined;
      if (cur >= 0 && i <= cur) {
        ov = introPlanRef.current.get(e.id);
      } else {
        ov = cfg?.enabled ? pickIntro(t, cfg, since, tracks, lastIntroFileRef.current) : undefined;
        since = ov ? 0 : since + 1;
      }
      if (ov) plan.set(e.id, ov);
      return ov ? [{ ...t, introOverlay: ov }] : [t];
    });
    introPlanRef.current = plan;
    playerRef.current?.setPlaylist(out);
    const pending = pendingPlayRef.current;
    if (pending) {
      const idx = entries.findIndex((e) => e.listId === pending.listId && e.row === pending.row);
      if (idx >= 0) {
        pendingPlayRef.current = null;
        playRowRef.current(idx);
      }
    }
  }, [active, rows, tracks, nextPick, pickRows, playingRow, settings.intros]);

  // Indice del reproductor -> lista y fila. Al llegar a una siguiente de otra
  // lista, esa lista pasa a ser la activa.
  const onPlayerIndexRef = useRef<(i: number) => void>(() => undefined);
  onPlayerIndexRef.current = (i: number) => {
    const m = i >= 0 ? virtMapRef.current[i] : undefined;
    if (!m) {
      setPlayingRow(-1);
      return;
    }
    if (m.listId !== activeIdRef.current) setActiveId(m.listId);
    const startedId = virtIdsRef.current[i] ?? "";
    if (startedId && startedId !== lastStartedIdRef.current) {
      lastStartedIdRef.current = startedId;
      const ov = introPlanRef.current.get(startedId);
      if (ov) {
        introSinceRef.current = 0;
        lastIntroFileRef.current = ov.file;
      } else {
        introSinceRef.current += 1;
      }
    }
    setPlayingRow(m.row);
    const pick = nextPickRef.current;
    if (pick && pick.listId === m.listId && pick.index === m.row) setNextPick(null);
  };

  // Persistir la carga inicial de ajustes en el motor
  useEffect(() => {
    const p = playerRef.current;
    if (p) {
      p.fadeSeconds = settings.fadeSeconds;
      p.loop = false;
      p.silenceSkip = settings.silenceDetection;
      p.silenceThresholdDb = settings.silenceThresholdDb ?? -55;
      p.setVolume(settings.masterVolume);
      // Con el motor nativo, la mesa web (micros, preescucha) sigue el mismo volumen.
      if (p instanceof NativePlayer) mixerRef.current?.setMasterVolume(settings.masterVolume);
    }
  }, [
    settings.fadeSeconds,
    settings.masterVolume,
    settings.silenceDetection,
    settings.silenceThresholdDb,
  ]);

  // La mesa de sonido se reconfigura en caliente.
  useEffect(() => {
    const p = playerRef.current;
    if (p instanceof NativePlayer) {
      mixerRef.current?.apply(webMixerSlice(settings));
      p.applyMixer(settings);
    } else {
      mixerRef.current?.apply(settings);
    }
  }, [settings.mixerChannels, settings.mixerBuses, settings.monitorBusId, native]);

  // Llamadas al aire de NGRADIO: conexion con el worker y entrada a la mesa.
  useEffect(() => {
    if (!mixer) return;
    const calls = new StudioCalls(mixer);
    calls.onChange = setStudio;
    studioRef.current = calls;
    calls.configure(settingsRef.current.studioCalls);
    return () => {
      calls.dispose();
      studioRef.current = null;
      setStudio({ status: "off", error: "", calls: [] });
    };
  }, [mixer]);
  useEffect(() => {
    studioRef.current?.configure(settings.studioCalls);
  }, [settings.studioCalls.enabled, settings.studioCalls.serverUrl, settings.studioCalls.token]);
  // Confirmacion al cerrar la ventana, para no cortar la emision sin querer.
  const closeInfoRef = useRef({ playing: false, streaming: false, calls: 0 });
  closeInfoRef.current = {
    playing: playingRow >= 0 && !paused,
    streaming: !!streamStatus?.running,
    calls: studio.calls.length,
  };
  useEffect(() => {
    let off: (() => void) | null = null;
    let cancelled = false;
    void installQuitHandler((action) => {
      const verb = action === "reboot" ? "¿Reiniciar el equipo?" : action === "poweroff" ? "¿Apagar el equipo?" : "¿Cerrar OmniCaster?";
      const i = closeInfoRef.current;
      const extra = [
        i.calls > 0 ? "hay una llamada al aire" : "",
        i.streaming ? "se está emitiendo por streaming" : "",
        i.playing ? "está sonando la emisión" : "",
      ].filter(Boolean);
      return extra.length > 0
        ? `${verb} Ahora mismo ${extra.join(", ")} y se cortará.`
        : verb;
    }).then((fn) => {
      if (cancelled) fn();
      else off = fn;
    });
    return () => {
      cancelled = true;
      off?.();
    };
  }, []);
  const lastCallCount = useRef(0);
  useEffect(() => {
    if (studio.calls.length > lastCallCount.current) {
      showToast(`Llamada al aire: ${studio.calls[studio.calls.length - 1].name}`);
    } else if (studio.calls.length < lastCallCount.current && studio.calls.length === 0) {
      showToast("La llamada ha salido del aire");
    }
    lastCallCount.current = studio.calls.length;
  }, [studio.calls, showToast]);
  const muteCaller = useCallback((muted: boolean) => {
    setCallMuted(muted);
    studioRef.current?.setCallMuted(muted);
  }, []);

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
    // Si estaba sonando al cerrar, sigue sonando; si estaba en pausa, queda
    // preparada en ese punto (salvo que este activo "reproducir al iniciar").
    void player
      .restoreAt(index, session.positionSecs, session.playing || settings.autoPlayOnStart)
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
        const loaded = migrateLegacyRtmp(s);
        setTracks(t);
        setBlocks(bs);
        setPlaylists(ps);
        setActiveId(ps[0]?.id ?? "");
        setSettings(loaded);
        if (loaded !== s) void saveSettings(loaded).catch(() => undefined);
        setHistory(hist);
        sessionRef.current = session;
        if (session?.playlistId && ps.some((pl) => pl.id === session.playlistId)) {
          setActiveId(session.playlistId);
        }
        void backfillCovers()
          .then((n) => {
            if (n > 0) void listTracks().then(setTracks).catch(() => undefined);
          })
          .catch(() => undefined)
          .finally(() => {
            // Calidad (Hz, bits, kbps) de las canciones que aun no la tienen.
            void backfillQuality()
              .then((n) => {
                if (n > 0) void listTracks().then(setTracks).catch(() => undefined);
              })
              .catch(() => undefined);
          });
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
    // Ajustes en su propia ventana; si no se puede abrir, como panel.
    void openToolWindow("settings").then((ok) => {
      if (ok) return;
      setSettingsMounted(true);
      setSettingsOpen(true);
    });
  }, []);

  const openNormalizer = useCallback(() => {
    // La librería va en su propia ventana; si no se puede abrir, como panel.
    void openToolWindow("library").then((ok) => {
      if (ok) return;
      normalizerRef.current = true;
      setNormalizerMounted(true);
      setNormalizerOpen(true);
      if (!normStatus) void refreshTracksAndBlocks();
    });
  }, [normStatus, refreshTracksAndBlocks]);

  /** Pausar, reanudar o cancelar el análisis, esté en panel o en ventana. */
  const normControl = useCallback((what: "pause" | "resume" | "cancel") => {
    const api = normApiRef.current;
    if (api) api[what]();
    else void emitEvent("library://control", what);
  }, []);

  const hideNormalizer = useCallback(() => {
    normalizerRef.current = false;
    setNormalizerOpen(false);
    void refreshTracksAndBlocks();
  }, [refreshTracksAndBlocks]);

  // Guardar la sesion para poder continuar donde se quedo al reabrir.
  useEffect(() => {
    let last = "";
    const save = () => {
      const index = playingRowRef.current;
      const row = index >= 0 ? rowsRef.current[index] : null;
      const session: SessionState = {
        playlistId: activeIdRef.current,
        trackId: row?.id ?? "",
        positionSecs: posRef.current.cur,
        playing: index >= 0 && !pausedStateRef.current,
        updatedAt: Date.now(),
      };
      const key = `${session.playlistId}|${session.trackId}|${Math.round(session.positionSecs)}|${session.playing}`;
      if (key === last) return;
      last = key;
      void saveSession(session).catch(() => undefined);
    };
    // En pausa no cambia nada: no se reescribe el archivo sin necesidad.
    const timer = window.setInterval(save, 3000);
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
  const mutateViewRef = useRef<((fn: (ids: string[]) => string[]) => Promise<void>) | null>(null);
  const doImport = useCallback(
    async (paths: string[], library: "a" | "b" = "a", blockId?: string | null, playlistAt?: number, inPlace = false) => {
      const targetBlock =
        blockId && blocksRef.current.some((block) => block.id === blockId) ? blockId : null;
      let ok = paths.filter(extOk);
      if (ok.length === 0) {
        showToast("Formato no reconocido. Usa audio (mp3, wav, flac, m4a…) o vídeo (mp4, m4v, mov, avi, mkv…)");
        return;
      }
      setImporting(true);
      try {
        // Los videos que el reproductor no abre (avi, wmv, mkv…) se pasan a MP4.
        const toConvert = ok.filter(needsVideoConversion);
        // Los convertidos viven en una carpeta temporal: esos siempre se copian.
        let converted: string[] = [];
        if (toConvert.length > 0) {
          showToast(`Convirtiendo ${toConvert.length === 1 ? "1 vídeo" : `${toConvert.length} vídeos`} a MP4…`);
          const off = listen<{ index: number; total: number; name: string; fraction: number }>("video://convert", (e) => {
            const p = e.payload;
            showToast(`Convirtiendo vídeo ${p.index + 1}/${p.total}: ${p.name} ${Math.round(p.fraction * 100)}%`);
          });
          try {
            const res = await convertVideos(toConvert);
            const failed = res.filter((r) => !r.output);
            ok = ok.filter((p) => !needsVideoConversion(p));
            converted = res.flatMap((r) => (r.output ? [r.output] : []));
            if (!inPlace) {
              ok = ok.concat(converted);
              converted = [];
            }
            if (failed.length > 0) showToast(`No se pudo convertir ${failed[0].source.split(/[\\/]/).pop()}: ${failed[0].error ?? ""}`);
          } finally {
            void off.then((f) => f());
          }
        }
        if (ok.length === 0 && converted.length === 0) return;
        // Lo que ya estaba en el catalogo no se copia otra vez; si se suelta
        // sobre una lista, todo queda asignado a esa lista. Desde el Explorador
        // se catalogan en su sitio (sin copiarlos).
        const res =
          converted.length > 0
            ? await (async () => {
                const a = ok.length > 0 ? await importFilesDedup(ok, library, targetBlock, true) : { added: 0, existing: 0, ids: [] as string[] };
                const b = await importFilesDedup(converted, library, targetBlock, false);
                return { added: a.added + b.added, existing: a.existing + b.existing, ids: [...a.ids, ...b.ids] };
              })()
            : await importFilesDedup(ok, library, targetBlock, inPlace);
        setTracks(await listTracks());
        const blockName = targetBlock
          ? blocksRef.current.find((block) => block.id === targetBlock)?.name ?? ""
          : "";
        // Soltadas sobre la lista de emision: entran en ese punto (sin repetir).
        if (playlistAt !== undefined && res.ids.length > 0) {
          await mutateViewRef.current?.((cur) => {
            const fresh = res.ids.filter((id, i) => !cur.includes(id) && res.ids.indexOf(id) === i);
            const copy = [...cur];
            copy.splice(Math.max(0, Math.min(copy.length, playlistAt)), 0, ...fresh);
            return copy;
          });
        }
        const where = blockName
          ? ` en «${blockName}»`
          : playlistAt !== undefined
            ? " y añadidas a la lista"
            : library === "b"
              ? " a la biblioteca B"
              : "";
        const parts: string[] = [];
        if (res.added) parts.push(res.added === 1 ? "1 canción nueva" : `${res.added} canciones nuevas`);
        if (res.existing) parts.push(res.existing === 1 ? "1 que ya estaba" : `${res.existing} que ya estaban`);
        showToast(`${parts.join(" y ") || "Nada que importar"}${where}`);
      } catch (e) {
        showToast(`No se pudieron importar: ${String(e)}`);
      } finally {
        setImporting(false);
      }
    },
    [showToast],
  );

  // Destino de los archivos que se arrastran desde el Explorador: solo se
  // ilumina la zona donde caeran (una lista, la biblioteca o la lista).
  type FileTarget =
    | { kind: "block"; id: string; el: HTMLElement }
    | { kind: "library"; el: HTMLElement }
    | { kind: "playlist"; at: number; el: HTMLElement; after: boolean }
    | null;
  const fileOverRef = useRef<HTMLElement | null>(null);
  const fileTargetAt = useCallback((position?: { x: number; y: number }): FileTarget => {
    if (!position) return null;
    const dpr = window.devicePixelRatio || 1;
    const x = position.x / dpr;
    const y = position.y / dpr;
    const hit = document.elementFromPoint(x, y) as HTMLElement | null;
    if (!hit) return null;
    const block = hit.closest<HTMLElement>("[data-block-drop]");
    if (block?.dataset.blockDrop) return { kind: "block", id: block.dataset.blockDrop, el: block };
    const row = hit.closest<HTMLElement>("[data-drop-zone='playlist-row']");
    if (row) {
      const r = row.getBoundingClientRect();
      const after = y > r.top + r.height / 2;
      return { kind: "playlist", at: Number(row.dataset.index ?? 0) + (after ? 1 : 0), el: row, after };
    }
    const end = hit.closest<HTMLElement>("[data-drop-zone='playlist-end']");
    if (end) return { kind: "playlist", at: Number.MAX_SAFE_INTEGER, el: end, after: false };
    const lib = hit.closest<HTMLElement>("[data-file-drop='library']");
    if (lib) return { kind: "library", el: lib };
    return null;
  }, []);
  const markFileTarget = useCallback((t: FileTarget) => {
    const prev = fileOverRef.current;
    if (prev && prev !== t?.el) prev.classList.remove("file-over", "dnd-over", "dnd-over-after");
    fileOverRef.current = t?.el ?? null;
    if (t) {
      t.el.classList.add("file-over", "dnd-over");
      t.el.classList.toggle("dnd-over-after", t.kind === "playlist" && t.after);
    }
  }, []);

  useEffect(() => {
    let alive = true;
    let unlisten: (() => void) | undefined;
    void onWindowFileDrop({
      onDrop: (paths, position) => {
        if (!alive) return;
        const t = fileTargetAt(position);
        markFileTarget(null);
        setDropHover(false);
        setDropBlockId("");
        if (normalizerRef.current) {
          const dpr = window.devicePixelRatio || 1;
          const cssX = position ? position.x / dpr : window.innerWidth / 2;
          void doImport(paths, cssX < window.innerWidth / 2 ? "a" : "b", t?.kind === "block" ? t.id : null);
        } else if (!t) {
          showToast("Suelta los archivos sobre la biblioteca, una lista o la lista de emisión");
        } else if (t.kind === "block") {
          void doImport(paths, "a", t.id);
        } else if (t.kind === "playlist") {
          void doImport(paths, "a", null, t.at);
        } else {
          void doImport(paths);
        }
      },
      onEnter: (position) => {
        setDropHover(true);
        markFileTarget(fileTargetAt(position));
      },
      onOver: (position) => markFileTarget(fileTargetAt(position)),
      onLeave: () => {
        setDropHover(false);
        setDropBlockId("");
        markFileTarget(null);
      },
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

  const handleDeleteTrack = useCallback(
    (track: Track) => void removeTrack(track),
    [removeTrack],
  );
  const assignTrackBlock = useCallback(
    async (trackId: string, blockId: string) => {
      const track = tracksRef.current.find((item) => item.id === trackId);
      if (!track) return;
      if (track.blocks.includes(blockId)) return;
      try {
        await setTrackBlocks(trackId, [...track.blocks, blockId]);
        setTracks((prev) =>
          prev.map((item) =>
            item.id === trackId ? { ...item, blocks: [...item.blocks, blockId] } : item,
          ),
        );
        const name = blocksRef.current.find((block) => block.id === blockId)?.name ?? "lista";
        showToast(`«${track.title}» añadida a ${name}`);
      } catch (error) {
        showToast(`No se pudo asignar a la lista: ${String(error)}`);
      }
    },
    [showToast],
  );
  const handleEditCuts = useCallback((track: Track) => setCutsTrackId(track.id), []);
  const handlePendingEditDone = useCallback(() => setPendingEdit(null), []);


  // ---- listas ----
  const handleCreateBlock = useCallback(
    async (name: string) => {
      const b = await createBlock(name);
      setBlocks((prev) => [...prev, b]);
      showToast(`Lista «${b.name}» creada`);
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
      showToast("Lista eliminada");
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

  // ---- lista en pantalla (puede no ser la que suena) ----
  const playlistsRef = useRef(playlists);
  playlistsRef.current = playlists;
  const viewRowsRef = useRef(viewRows);
  viewRowsRef.current = viewRows;
  const viewIdRef = useRef("");
  viewIdRef.current = view?.id ?? "";

  const mutateById = useCallback(
    async (
      listId: string,
      fn: (ids: string[]) => string[],
      overrides?: (id: string, index: number) => StreamMeta | null,
    ) => {
      const pl = playlistsRef.current.find((p) => p.id === listId);
      if (!pl) return;
      const ids = fn(pl.trackIds);
      const updated: Playlist = {
        ...pl,
        trackIds: ids,
        meta: alignPlaylistMeta(pl.trackIds, pl.meta, ids, overrides),
      };
      // La referencia se actualiza ya: dos cambios seguidos (ordenar mientras
      // el AutoDJ añade) parten cada uno del anterior y no se pisan.
      playlistsRef.current = playlistsRef.current.map((p) => (p.id === updated.id ? updated : p));
      setPlaylists((prev) => prev.map((p) => (p.id === updated.id ? updated : p)));
      // La que suena sigue marcada en su sitio nuevo sin esperar al reproductor
      // (si no, durante un instante la lista y el AutoDJ ven la fila equivocada).
      if (listId === activeIdRef.current && playingRowRef.current >= 0) {
        const playingId = pl.trackIds[playingRowRef.current];
        const now = playingId ? ids.indexOf(playingId) : -1;
        if (now >= 0 && now !== playingRowRef.current) {
          playingRowRef.current = now;
          setPlayingRow(now);
        }
      }
      // Si la siguiente elegida esta en esta lista, su posicion puede cambiar.
      const pick = nextPickRef.current;
      if (pick && pick.listId === listId) {
        const id = rowsOf(pl, tracksRef.current)[pick.index]?.id;
        const idx = id ? rowsOf(updated, tracksRef.current).findIndex((r) => r.id === id) : -1;
        setNextPick(idx >= 0 ? { listId, index: idx } : null);
      }
      try {
        await savePlaylist(updated);
      } catch (e) {
        showToast(`No se pudo guardar la lista: ${String(e)}`);
      }
    },
    [showToast],
  );
  const mutateView = useCallback(
    (fn: (ids: string[]) => string[]) => mutateById(viewIdRef.current, fn),
    [mutateById],
  );
  // Editar la lista activa (la que suena)
  const mutateList = useCallback(
    (
      fn: (ids: string[]) => string[],
      overrides?: (id: string, index: number) => StreamMeta | null,
    ) => mutateById(activeIdRef.current, fn, overrides),
    [mutateById],
  );
  const mutateListRef = useRef(mutateList);
  mutateListRef.current = mutateList;

  /**
   * Mete `add` en la posicion `at` sin duplicados: si una ya estaba (y no es
   * la que suena) se mueve; la que suena se queda donde esta.
   */
  const placeIds = (cur: string[], add: string[], at: number, listId: string): string[] => {
    const playingId =
      listId === activeIdRef.current && playingRowRef.current >= 0 ? cur[playingRowRef.current] : undefined;
    const moving = new Set(add.filter((id) => id !== playingId));
    let to = Math.max(0, Math.min(cur.length, at));
    const kept: string[] = [];
    cur.forEach((id, k) => {
      if (moving.has(id)) {
        if (k < to) to -= 1;
      } else kept.push(id);
    });
    const unique = [...moving];
    kept.splice(Math.max(0, Math.min(kept.length, to)), 0, ...unique);
    return kept;
  };
  mutateViewRef.current = mutateView;

  /** Emitir desde una fila de la lista en pantalla (si es otra, pasa a ser la activa). */
  const playViewRow = useCallback((i: number) => {
    const listId = viewIdRef.current;
    if (!listId) return;
    if (listId === activeIdRef.current && !nextPickRef.current) {
      playRowRef.current(i);
      return;
    }
    pendingPlayRef.current = { listId, row: i };
    setNextPick(null);
    if (listId !== activeIdRef.current) {
      setPlayingRow(-1);
      setActiveId(listId);
    }
  }, []);

  /** Clic derecho -> "Siguiente": esta fila suena despues de la actual. */
  const setNextRow = useCallback((i: number) => {
    const listId = viewIdRef.current;
    if (!listId) return;
    if (listId === activeIdRef.current && i === playingRowRef.current + 1) {
      setNextPick(null); // ya era la siguiente natural
      return;
    }
    setNextPick({ listId, index: i });
  }, []);

  /** Rellena la lista en pantalla con el AutoDJ (sin tocar la que suena). */
  const generateView = useCallback(async () => {
    const listId = viewIdRef.current;
    const pl = playlistsRef.current.find((p) => p.id === listId);
    if (!pl) return;
    const scope = autoScopeRef.current;
    try {
      const picked = await autoPick(
        viewRowsRef.current.map((r) => r.id),
        Math.max(10, settingsRef.current.autopilotFillTo || 15),
        scope?.kind,
        scope?.id,
      );
      if (picked.length === 0) {
        showToast("El AutoDJ no encontró canciones para esta lista");
        return;
      }
      await mutateById(listId, (ids) => [...ids, ...picked]);
      showToast(`${picked.length} canciones añadidas a «${pl.name}»`);
    } catch (e) {
      showToast(`No se pudo generar la lista: ${String(e)}`);
    }
  }, [mutateById, showToast]);

  const addTrack = useCallback(
    (t: Track) => {
      void mutateView((ids) => [...ids, t.id]);
    },
    [mutateView],
  );

  const dropTrackAt = useCallback(
    (trackId: string, at: number) => {
      const listId = viewIdRef.current;
      void mutateView((ids) => placeIds(ids, [trackId], at, listId));
    },
    [mutateView],
  );

  /** Suelta una lista entero en la lista: sus canciones (las que no estan ya). */
  const dropBlockAt = useCallback(
    (blockId: string, at: number) => {
      const ids = tracksRef.current.filter((t) => t.blocks.includes(blockId) && !t.missing).map((t) => t.id);
      if (ids.length === 0) {
        showToast("Esa lista no tiene canciones");
        return;
      }
      let added = 0;
      const listId = viewIdRef.current;
      void mutateView((cur) => {
        added = ids.filter((id) => !cur.includes(id)).length;
        return placeIds(cur, ids, at, listId);
      }).then(() => {
        const name = blocksRef.current.find((b) => b.id === blockId)?.name ?? "lista";
        showToast(added ? `${added} canciones de «${name}» añadidas a la lista` : `Canciones de «${name}» colocadas en la lista`);
      });
    },
    [mutateView, showToast],
  );

  /** Preescucha de una pista de la lista por la salida de monitorizacion. */
  const previewRow = useCallback(
    (index: number) => {
      const row = viewRowsRef.current[index];
      if (!row) return;
      const track = tracksRef.current.find((t) => t.id === row.id);
      if (track) startPreview(track);
    },
    [startPreview],
  );

  const editRowCuts = useCallback(
    (index: number) => {
      const row = viewRowsRef.current[index];
      if (!row) return;
      setCutsTrackId(row.id);
    },
    [],
  );

  const editRowMeta = useCallback(
    (index: number) => {
      const row = viewRowsRef.current[index];
      if (!row) return;
      setPendingEdit({ id: row.id, n: Date.now() });
    },
    [],
  );

  /** Quita o pone una pista en un lista. */
  const toggleRowBlock = useCallback(
    async (trackId: string, blockId: string) => {
      const track = tracksRef.current.find((t) => t.id === trackId);
      if (!track) return;
      const next = track.blocks.includes(blockId)
        ? track.blocks.filter((b) => b !== blockId)
        : [...track.blocks, blockId];
      try {
        await setTrackBlocks(trackId, next);
        await refreshTracksAndBlocks();
      } catch (e) {
        showToast(`No se pudo cambiar la lista: ${String(e)}`);
      }
    },
    [refreshTracksAndBlocks, showToast],
  );

  // Quitar la que esta sonando: sigue sonando hasta el final, la siguiente
  // ya esta preparada y la fila desaparece en cuanto entra la siguiente.
  const [removeAfter, setRemoveAfter] = useState<{ listId: string; trackId: string } | null>(null);
  const removeRow = useCallback(
    (i: number) => {
      const listId = viewIdRef.current;
      if (listId === activeIdRef.current && i === playingRowRef.current) {
        const id = viewRowsRef.current[i]?.id;
        if (id) {
          setRemoveAfter({ listId, trackId: id });
          showToast("Se quitará de la lista cuando termine de sonar");
        }
        return;
      }
      void mutateView((ids) => ids.filter((_, idx) => idx !== i));
    },
    [mutateView, showToast],
  );
  useEffect(() => {
    if (!removeAfter) return;
    const currentId = playingRow >= 0 && active?.id === removeAfter.listId ? rows[playingRow]?.id : undefined;
    if (currentId === removeAfter.trackId) return; // aun suena
    const { listId, trackId } = removeAfter;
    setRemoveAfter(null);
    void mutateById(listId, (ids) => {
      // Quita la aparicion que ya no suena (la anterior a la actual si se repite).
      const cur = active?.id === listId && playingRow >= 0 ? playingRow : ids.length;
      let at = -1;
      for (let k = Math.min(cur, ids.length - 1); k >= 0; k -= 1) {
        if (ids[k] === trackId) {
          at = k;
          break;
        }
      }
      if (at < 0) at = ids.indexOf(trackId);
      return at < 0 ? ids : ids.filter((_, k) => k !== at);
    });
  }, [removeAfter, playingRow, rows, active, mutateById]);

  const reorderRow = useCallback(
    (from: number, to: number) => {
      void mutateView((ids) => {
        const copy = [...ids];
        const [moved] = copy.splice(from, 1);
        copy.splice(Math.max(0, Math.min(copy.length, to)), 0, moved);
        return copy;
      });
    },
    [mutateView],
  );

  const renamePlaylist = useCallback(
    (name: string) => {
      if (!view) return;
      void (async () => {
        const updated: Playlist = { ...view, name };
        setPlaylists((prev) => prev.map((p) => (p.id === updated.id ? updated : p)));
        await savePlaylist(updated);
      })();
    },
    [view],
  );

  const newPlaylist = useCallback(async () => {
    const pl: Playlist = {
      id: `pl-${Date.now()}`,
      name: `Lista ${playlists.length + 1}`,
      trackIds: [],
      meta: [],
    };
    try {
      await savePlaylist(pl);
      setPlaylists((prev) => [...prev, pl]);
      // Se abre en pantalla; la que suena sigue sonando.
      setViewId(pl.id);
    } catch (e) {
      showToast(`No se pudo crear la lista: ${String(e)}`);
    }
  }, [playlists, showToast]);

  const clearActivePlaylist = useCallback(async () => {
    if (!active) return;
    if (view && view.id !== active.id) {
      if (view.trackIds.length === 0) return showToast("La lista ya está vacía");
      if (!(await confirmAsk(`¿Vaciar la lista «${view.name}»? Se quitan todas sus pistas.`, "Vaciar"))) return;
      if (nextPickRef.current?.listId === view.id) setNextPick(null);
      await mutateById(view.id, () => []);
      showToast(`Lista «${view.name}» vaciada`);
      return;
    }
    if (active.trackIds.length === 0) {
      showToast("La lista ya está vacía");
      return;
    }
    const playing = playingRowRef.current;
    const keepId = playing >= 0 ? active.trackIds[playing] : undefined;
    const msg = keepId
      ? `¿Vaciar la lista «${active.name}»? Se quitan todas las pistas menos la que está sonando, que termina con normalidad.`
      : `¿Vaciar la lista «${active.name}»? Se quitan todas sus pistas.`;
    if (!(await confirmAsk(msg, "Vaciar"))) return;
    if (nextPickRef.current?.listId === active.id) setNextPick(null);
    if (keepId) {
      // La que suena sigue sonando: queda sola en la lista.
      await mutateList(() => [keepId]);
      showToast(`Lista «${active.name}» vaciada · sigue sonando la actual`);
      return;
    }
    await mutateList(() => []);
    showToast(`Lista «${active.name}» vaciada`);
  }, [active, view, mutateList, mutateById, showToast]);

  const removeActivePlaylist = useCallback(async () => {
    if (!active || playlists.length <= 1) return;
    if (view && view.id !== active.id) {
      if (!(await confirmAsk(`¿Eliminar la lista «${view.name}»?`, "Eliminar"))) return;
      try {
        await deletePlaylist(view.id);
        if (nextPickRef.current?.listId === view.id) setNextPick(null);
        setPlaylists((prev) => prev.filter((p) => p.id !== view.id));
        setViewId(active.id);
        showToast("Lista eliminada");
      } catch (e) {
        showToast(`No se pudo eliminar la lista: ${String(e)}`);
      }
      return;
    }
    if (!(await confirmAsk(`¿Eliminar la lista «${active.name}»? Es la que está sonando.`, "Eliminar"))) return;
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
  }, [active, view, playlists, showToast]);

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
    // Si hay una sesion que continuar, la restauracion ya arranca donde se quedo.
    const session = sessionRef.current;
    if (session?.trackId && rows.some((row) => row.id === session.trackId)) {
      autoPlayStartedRef.current = true;
      return;
    }
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
      void notifyFire("silence", { message: "silencio detectado" }).catch(() => undefined);
      void playRowRef.current(0);
    }, 3000);
    return () => window.clearTimeout(timer);
  }, [settings.silenceDetection, playingRow, active, rows.length]);

  const seek = useCallback((seconds: number) => {
    void playerRef.current?.seek(seconds);
  }, []);

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


  /** Detiene y vuelve a arrancar para aplicar salidas o ajustes nuevos. */
  const restartStreaming = useCallback(async () => {
    if (streamBusy) return;
    const mixer = mixerRef.current;
    if (!mixer) {
      showToast("La mesa de sonido todavía no está lista");
      return;
    }
    setStreamBusy(true);
    let failedStatus: StreamStatus | null = null;
    try {
      // Solo se rearranca lo que estaba en marcha (el vídeo no se enciende solo).
      const outs = streamStatusRef.current?.outputs ?? [];
      const audioOn = outs.some((o) => o.running && o.kind === "icecast");
      const videoOn = outs.some((o) => o.running && o.kind === "rtmp");
      const group = audioOn && videoOn ? "all" : videoOn ? "video" : "audio";
      await streamEncoderRef.current?.stop();
      streamEncoderRef.current = null;
      await stopStreaming().catch(() => undefined);
      const status = await startStreaming(settingsRef.current, group);
      if (!status.running) {
        failedStatus = status;
        setStreamStatus(status);
        throw new Error(status.lastError ?? "No se pudo iniciar la emisión");
      }
      setStreamStatus(status);
      if (status.needsAudio && !(playerRef.current instanceof NativePlayer)) {
        const encoder = new StreamEncoder(mixer, failStreaming);
        await encoder.start();
        streamEncoderRef.current = encoder;
      }
      showToast(status.lastError ?? "Emisión reiniciada con los cambios");
    } catch (error) {
      await streamEncoderRef.current?.stop();
      streamEncoderRef.current = null;
      if (failedStatus) setStreamStatus(failedStatus);
      else await stopStreaming().then(setStreamStatus).catch(() => setStreamStatus(null));
      showToast(error instanceof Error ? error.message : String(error));
    } finally {
      setStreamBusy(false);
    }
  }, [streamBusy, failStreaming, showToast]);

  /** Arranca o detiene solo el grupo de audio o el de video. */
  const setStreamGroup = useCallback(
    async (group: "audio" | "video", on: boolean) => {
      if (streamBusy) return;
      const mixer = mixerRef.current;
      if (!mixer) {
        showToast("La mesa de sonido todavía no está lista");
        return;
      }
      setStreamBusy(true);
      try {
        if (on) {
          const status = await startStreaming(settingsRef.current, group);
          setStreamStatus(status);
          if (!status.running) throw new Error(status.lastError ?? "No se pudo iniciar la emisión");
          if (status.needsAudio && !(playerRef.current instanceof NativePlayer) && !streamEncoderRef.current) {
            const encoder = new StreamEncoder(mixer, failStreaming);
            await encoder.start();
            streamEncoderRef.current = encoder;
          }
          showToast(status.lastError ?? (group === "audio" ? "Emisión de audio iniciada" : "Emisión de vídeo iniciada"));
        } else {
          const status = await stopStreaming(group);
          setStreamStatus(status);
          if (!status.needsAudio && streamEncoderRef.current) {
            await streamEncoderRef.current.stop();
            streamEncoderRef.current = null;
          }
          showToast(group === "audio" ? "Emisión de audio detenida" : "Emisión de vídeo detenida");
        }
      } catch (error) {
        showToast(error instanceof Error ? error.message : String(error));
      } finally {
        setStreamBusy(false);
      }
    },
    [streamBusy, failStreaming, showToast],
  );

  // Emitir al iniciar: una sola vez, cuando la mesa y el motor estan listos.
  const autoStreamDone = useRef(false);
  const setStreamGroupRef = useRef(setStreamGroup);
  setStreamGroupRef.current = setStreamGroup;
  useEffect(() => {
    if (autoStreamDone.current || !mixer || !settings.streaming?.autoStart || !hasStreamOutputs) return;
    autoStreamDone.current = true;
    // Sin limpiar el temporizador: si cambian los ajustes en esos segundos,
    // la emision tiene que arrancar igual (y solo una vez).
    window.setTimeout(() => {
      // Solo el audio: el vídeo nunca arranca solo (se lanza con EMITIR VÍDEO).
      if (!streamStatusRef.current?.running) void setStreamGroupRef.current("audio", true);
    }, 3000);
  }, [mixer, settings.streaming?.autoStart, hasStreamOutputs]);

  // Salidas del estudio (pantalla/HDMI, NDI, SDI): encendidas siempre que el
  // motor de vídeo esté activo, sin esperar a EMITIR. Se reinician solas al
  // cambiar sus ajustes.
  const localVideoKey = useMemo(() => {
    const v = settings.video;
    if (!v?.enabled) return "";
    const outs = v.outputs.filter((o) => o.enabled && (o.kind === "screen" || o.kind === "ndi" || o.kind === "decklink"));
    if (outs.length === 0) return "";
    return JSON.stringify({
      outs,
      inputs: v.inputs,
      maxHeight: v.maxHeight,
      ndiLow: v.ndiLowBandwidth,
      ndiFfmpeg: v.ndiFfmpegPath,
      screen: settings.videoScreen,
    });
  }, [settings.video, settings.videoScreen]);
  useEffect(() => {
    if (!mixer) return;
    let cancelled = false;
    const t = window.setTimeout(() => {
      void (async () => {
        try {
          if (!localVideoKey) {
            const status = await stopStreaming("local");
            if (!cancelled) setStreamStatus(status);
            return;
          }
          const status = await startStreaming(settingsRef.current, "local");
          if (cancelled) return;
          setStreamStatus(status);
          if (status.needsAudio && !(playerRef.current instanceof NativePlayer) && !streamEncoderRef.current && mixerRef.current) {
            const encoder = new StreamEncoder(mixerRef.current, failStreaming);
            await encoder.start();
            streamEncoderRef.current = encoder;
          }
          const failed = status.outputs.filter((o) => o.state === "error" && (o.kind === "screen" || o.kind === "ndi" || o.kind === "decklink"));
          if (failed.length > 0) showToast(`Salida de vídeo: ${failed[0].error ?? failed[0].name}`);
        } catch (error) {
          if (!cancelled) showToast(`Salidas de vídeo del estudio: ${error instanceof Error ? error.message : String(error)}`);
        }
      })();
    }, 1500);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mixer, localVideoKey]);

  useEffect(() => {
    if (!streamStatus?.running && !streamStatus?.localRunning) return;
    const wasRunning = !!streamStatus?.running;
    let alive = true;
    const timer = window.setInterval(() => {
      void getStreamStatus()
        .then((status) => {
          if (!alive) return;
          setStreamStatus(status);
          if (!status.running && wasRunning) {
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
  }, [streamStatus?.running, streamStatus?.localRunning, showToast]);

  /** Entra la emision de internet de un evento hasta `endsAt`. */
  const startLiveEvent = useCallback(
    (event: StationEvent, endsAt: number, key: string) => {
      const p = playerRef.current;
      if (!p) return;
      const fade = Math.max(0, event.fadeSecs ?? 3);
      const meta: StreamMeta = { title: "", artist: "", album: "", year: "", genre: "", comment: "", cover: "", ...(event.meta ?? {}) };
      p.onLive = (state, message) => {
        if (state === "error" && liveRunRef.current?.eventId === event.id) showToast(`Emisión «${event.name}»: ${message}`);
      };
      if (playingRowRef.current >= 0 && !pausedNowRef.current) p.fadePause(fade);
      void p.startLive((event.streamUrl ?? "").trim(), fade);
      setLiveRun({ eventId: event.id, name: event.name, url: event.streamUrl ?? "", startedAt: Date.now(), endsAt, fade, meta });
      setSettings((prev) => {
        const events = prev.events.map((e) => (e.id === event.id ? { ...e, lastFired: key } : e));
        const nextSettings = { ...prev, events };
        void saveSettings(nextSettings).catch(() => undefined);
        return nextSettings;
      });
      showToast(`En directo: «${event.name}» hasta las ${new Date(endsAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`);
    },
    [showToast],
  );

  /** Termina la emision de internet y la lista sigue con la siguiente canción. */
  const endLiveEvent = useCallback(
    (resume = true) => {
      const run = liveRunRef.current;
      const p = playerRef.current;
      if (!run) return;
      liveRunRef.current = null;
      setLiveRun(null);
      p?.stopLive(run.fade);
      if (resume && p && playingRowRef.current >= 0) void p.next();
    },
    [],
  );

  // Programacion de las emisiones de internet: entran y salen a su hora.
  useEffect(() => {
    const check = () => {
      const s = settingsRef.current;
      const run = liveRunRef.current;
      const now = new Date();
      if (run) {
        const ev = s.events.find((e) => e.id === run.eventId);
        // LIVE: la emision de internet se corta (el estudio toma la antena).
        if (s.liveMode) endLiveEvent(false);
        else if (Date.now() >= run.endsAt || (ev && !ev.enabled)) endLiveEvent(true);
        return;
      }
      if (!s.eventsEnabled || s.liveMode) return;
      for (const ev of s.events) {
        if (!ev.enabled || ev.kind !== "stream" || !(ev.streamUrl ?? "").trim()) continue;
        const w = streamWindow(ev, now);
        if (!w || ev.lastFired === w.key) continue;
        // Si la app se abre tarde, solo entra si queda al menos un minuto.
        if (w.end - now.getTime() < 60_000) continue;
        startLiveEvent(ev, w.end, w.key);
        return;
      }
    };
    check();
    const t = window.setInterval(check, 1000);
    return () => window.clearInterval(t);
  }, [startLiveEvent, endLiveEvent]);

  const launchEvent = useCallback(
    (event: StationEvent) => {
      if (!settingsRef.current.eventsEnabled) {
        showToast("Los eventos están desactivados globalmente");
        return;
      }
      if (settingsRef.current.liveMode) {
        showToast("Modo LIVE activo: los eventos están en pausa");
        return;
      }
      if (!event.enabled) {
        showToast(`El evento «${event.name}» está desactivado`);
        return;
      }
      if (event.kind === "stream") {
        if (liveRunRef.current) {
          showToast("Ya hay una emisión de internet en directo");
          return;
        }
        // Manual: hasta su hora de fin si cae dentro de la franja; si no, lo que dura la franja.
        const now = new Date();
        const w = streamWindow(event, now);
        const block = eventSchedules(event)[0];
        const s = parseHM(block.start ?? event.start) ?? 0;
        const e = parseHM(block.end ?? event.end ?? "") ?? s;
        const len = ((e - s + 1440) % 1440 || 60) * 60_000;
        startLiveEvent(event, w ? w.end : Date.now() + len, w ? w.key : `${dayKey(now)} manual`);
        return;
      }
      if (event.kind === "auto") {
        const until = nextAutoStartAfter(settingsRef.current.events, new Date());
        setManualAuto({ id: event.id, until });
        showToast(`Evento «${event.name}» activado manualmente`);
        return;
      }

      const playing = playingRowRef.current;
      const currentId = playing >= 0 ? rowsRef.current[playing]?.id ?? "" : "";
      let trackId = event.trackId;
      let pickNote = "";
      if (isRandom(event)) {
        const now = new Date();
        const slot = `${pad2(now.getHours())}:${pad2(now.getMinutes())}`;
        const pick = pickRandom(event, slot, tracksRef.current, historyRef.current, now.getTime(), new Set([currentId]));
        if (!pick.track) {
          showToast(`El evento «${event.name}» no tiene pistas en su fuente`);
          return;
        }
        trackId = pick.track.id;
        pickNote = relaxedText(pick);
        const entry = { slot, trackId, at: now.getTime() };
        setSettings((prev) => {
          const events = prev.events.map((e) => (e.id === event.id ? { ...e, pickLog: logPick(e.pickLog, entry) } : e));
          const nextSettings = { ...prev, events };
          void saveSettings(nextSettings).catch(() => undefined);
          return nextSettings;
        });
      }
      const track = tracksRef.current.find((item) => item.id === trackId);
      if (!track) {
        showToast(`El evento «${event.name}» no tiene una pista disponible`);
        return;
      }
      if (currentId === trackId) {
        showToast(`El evento «${event.name}» ya está sonando`);
        return;
      }
      const playlistId = activeIdRef.current;
      if (!playlistId) {
        showToast("No hay una lista activa para lanzar el evento");
        return;
      }

      let insertedAt = -1;
      void mutateListRef.current(
        (ids) => {
          const copy = ids.filter((id) => id !== trackId);
          const at = Math.max(0, Math.min(copy.length, playing >= 0 ? playing + 1 : 0));
          copy.splice(at, 0, trackId);
          insertedAt = at;
          return copy;
        },
        (_id, index) => (index === insertedAt && hasMeta(event.meta) ? event.meta! : null),
      );

      const item: PendingInsert = {
        eventId: event.id,
        eventName: event.name,
        playlistId,
        trackId,
        deadline: Date.now() + Math.max(0, event.maxWaitSecs) * 1000,
        onTimeout: event.onTimeout,
      };
      setPendingInserts((prev) => [...prev.filter((p) => p.eventId !== event.id), item]);
      showToast(`Evento «${event.name}»: ${isRandom(event) ? `${track.title} a continuación` : "a continuación"}${pickNote}`);
    },
    [showToast, startLiveEvent],
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
        let dueAt: { when: number; key: string } | null = null;
        for (const block of campaignSchedules(c)) {
          const occurrences = block.hourly
            ? [`${pad2(now.getHours())}:${pad2(block.minute ?? 0)}`]
            : block.times;
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
            if (!block.days.includes(dayIso(scheduled))) continue;
            const key = `${dayKey(scheduled)} ${pad2(h)}:${pad2(m)}`;
            if (c.lastFired === key) continue;
            if (campaignFiring.current.has(`${c.id}|${key}`)) continue;
            if (!dueAt || scheduled.getTime() > dueAt.when) {
              dueAt = { when: scheduled.getTime(), key };
            }
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
      const metaByIndex = new Map<number, StreamMeta>();
      void mutateListRef.current(
        (ids) => {
          const copy = [...ids];
          due.forEach((d, i) => {
            const at = Math.min(copy.length, base + i);
            copy.splice(at, 0, d.spotId);
            if (hasMeta(d.campaign.meta)) metaByIndex.set(at, d.campaign.meta!);
          });
          return copy;
        },
        (_id, index) => metaByIndex.get(index) ?? null,
      );
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

  // Al quitar el LIVE, lo que debia sonar durante el directo no se recupera.
  const liveOffAt = useRef(0);
  const wasLive = useRef(settings.liveMode);
  useEffect(() => {
    if (wasLive.current && !settings.liveMode) liveOffAt.current = Date.now();
    wasLive.current = settings.liveMode;
  }, [settings.liveMode]);

  // Eventos de inserción: a la hora exacta, el sonido queda como siguiente.
  useEffect(() => {
    if (!active) return;
    const check = () => {
      const s = settingsRef.current;
      if (!s.eventsEnabled || s.liveMode) return;
      const now = new Date();
      const rowsNow = rowsRef.current;
      const playing = playingRowRef.current;
      const byId = new Map(tracksRef.current.map((t) => [t.id, t]));
      const currentId = playing >= 0 ? rowsNow[playing]?.id ?? "" : "";
      const fires: { event: StationEvent; key: string; at: number; slot: string }[] = [];

      for (const event of s.events) {
        if (!event.enabled || event.kind !== "insert") continue;
        if (isRandom(event)) {
          if (randomPool(event, tracksRef.current).length === 0) continue;
        } else if (!event.trackId || !byId.has(event.trackId)) continue;
        let latest: { at: number; key: string; slot: string } | null = null;
        for (const block of eventSchedules(event)) {
          for (const value of block.times.length > 0 ? block.times : [block.start ?? event.start]) {
            const minute = parseHM(value);
            if (minute === null) continue;
            const scheduled = new Date(now);
            scheduled.setHours(Math.floor(minute / 60), minute % 60, 0, 0);
            let delta = now.getTime() - scheduled.getTime();
            if (delta < 0) {
              scheduled.setTime(scheduled.getTime() - DAY_MS);
              delta = now.getTime() - scheduled.getTime();
            }
            if (delta > EVENT_GRACE_MS) continue;
            if (scheduled.getTime() < liveOffAt.current) continue;
            if (!block.days.includes(dayIso(scheduled))) continue;
            const key = `${dayKey(scheduled)} ${pad2(Math.floor(minute / 60))}:${pad2(minute % 60)}`;
            if (!latest || scheduled.getTime() > latest.at) {
              latest = {
                at: scheduled.getTime(),
                key,
                slot: `${pad2(Math.floor(minute / 60))}:${pad2(minute % 60)}`,
              };
            }
          }
        }
        if (!latest) continue;
        if (event.lastFired === latest.key) continue;
        const lock = `${event.id}|${latest.key}`;
        if (eventFiring.current.has(lock)) continue;
        eventFiring.current.add(lock);
        fires.push({ event, key: latest.key, at: latest.at, slot: latest.slot });
      }

      if (fires.length === 0) return;
      fires.sort((a, b) => a.at - b.at);

      const firedKeys = new Map<string, string>();
      const already: StationEvent[] = [];
      const queue: { event: StationEvent; key: string; trackId: string }[] = [];
      const queuedTracks = new Set<string>();
      const picks = new Map<string, { slot: string; trackId: string; at: number }>();
      const relaxedNotes: string[] = [];
      const nowPick = Date.now();
      for (const fire of fires) {
        firedKeys.set(fire.event.id, fire.key);
        let trackId = fire.event.trackId;
        if (isRandom(fire.event)) {
          const pick = pickRandom(
            fire.event,
            fire.slot,
            tracksRef.current,
            historyRef.current,
            nowPick,
            new Set([currentId, ...queuedTracks]),
          );
          if (!pick.track) continue;
          trackId = pick.track.id;
          picks.set(fire.event.id, { slot: fire.slot, trackId, at: nowPick });
          if (pick.relaxed.length > 0) relaxedNotes.push(`«${fire.event.name}»${relaxedText(pick)}`);
        }
        if (trackId === currentId) {
          already.push(fire.event);
          continue;
        }
        if (queuedTracks.has(trackId)) continue;
        queuedTracks.add(trackId);
        queue.push({ event: fire.event, key: fire.key, trackId });
      }

      const inserted: PendingInsert[] = [];
      if (queue.length > 0) {
        let base = playing >= 0 ? playing + 1 : 0;
        const metaByIndex = new Map<number, StreamMeta>();
        void mutateListRef.current(
          (ids) => {
            let copy = [...ids];
            for (const item of queue) {
              copy = copy.filter((id) => id !== item.trackId);
              const at = Math.max(0, Math.min(copy.length, base));
              copy.splice(at, 0, item.trackId);
              if (hasMeta(item.event.meta)) metaByIndex.set(at, item.event.meta!);
              base = at + 1;
            }
            return copy;
          },
          (_id, index) => metaByIndex.get(index) ?? null,
        );
        const nowMs = Date.now();
        for (const item of queue) {
          inserted.push({
            eventId: item.event.id,
            eventName: item.event.name,
            playlistId: active.id,
            trackId: item.trackId,
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
          const events = prev.events.map((event) => {
            if (!firedKeys.has(event.id)) return event;
            const pick = picks.get(event.id);
            return {
              ...event,
              lastFired: firedKeys.get(event.id) ?? "",
              ...(pick ? { pickLog: logPick(event.pickLog, pick) } : {}),
            };
          });
          const nextSettings = { ...prev, events };
          void saveSettings(nextSettings).catch(() => undefined);
          return nextSettings;
        });
      }

      if (inserted.length === 1) {
        const wait = inserted[0];
        const limit = queue[0]?.event.maxWaitSecs ?? 0;
        const title = isRandom(queue[0].event) ? byId.get(wait.trackId)?.title : "";
        showToast(
          `Evento «${wait.eventName}»${title ? ` · ${title}` : ""}: a continuación${limit > 0 ? ` (máx. ${limit} s)` : ""}${relaxedNotes.length ? ` ${relaxedNotes[0].slice(relaxedNotes[0].indexOf("»") + 1)}` : ""}`,
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
      // Durante una emision de internet no se fuerza nada: espera a que termine.
      if (liveRunRef.current) return;
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
    // Mientras se arrastra no se añade nada: la lista no cambia bajo el puntero.
    if (isDragging()) return;
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

  // ---- API compatible con RadioBOSS (ngradio.es) ----
  // Configuracion: la URL de oyentes sale de la primera emision Icecast si no se indica.
  useEffect(() => {
    const api = settings.api;
    if (!api) return;
    const ice = settings.streaming.icecast.find((x) => x.enabled) ?? settings.streaming.icecast[0];
    const icecastStatusUrl =
      api.icecastStatusUrl.trim() ||
      (ice ? `${ice.tls ? "https" : "http"}://${ice.host}:${ice.port}/status-json.xsl` : "");
    void apiApply({ ...api, icecastStatusUrl }).catch(() => undefined);
  }, [settings.api, settings.streaming.icecast]);

  // Estado de la emision: en cada cambio y cada 2 s (la API extrapola la posicion).
  const streamStatusRef = useRef<StreamStatus | null>(null);
  const pausedNowRef = useRef(paused);
  pausedNowRef.current = paused;
  const publishApiState = useCallback(() => {
    if (!settingsRef.current.api?.enabled) return;
    const idx = playingRowRef.current;
    const list = rowsRef.current;
    const byId = new Map(tracksRef.current.map((t) => [t.id, t]));
    const toPub = (id: string | undefined) => {
      const t = id ? byId.get(id) : undefined;
      return t
        ? { id: t.id, artist: t.artist, title: t.title, album: t.album, file: t.file, durationSecs: t.durationSecs, cover: t.cover }
        : null;
    };
    const lr = liveRunRef.current;
    const liveNowMs = Date.now();
    const s = settingsRef.current;
    const program = s.liveMode
      ? (s.programs ?? []).find((p) => p.id === s.liveProgramId) ?? null
      : null;
    const programCurrent = program
      ? {
          id: `live:program:${program.id}`,
          artist: program.subtitle ?? "",
          title: program.name ?? "",
          album: program.album ?? "",
          file: "",
          durationSecs: 0,
          cover: program.cover ?? "",
        }
      : null;
    const current = lr
      ? {
          id: `live:${lr.eventId}`,
          artist: lr.meta.artist,
          title: lr.meta.title,
          album: lr.meta.album,
          file: "",
          durationSecs: (lr.endsAt - lr.startedAt) / 1000,
          cover: lr.meta.cover,
        }
      : programCurrent ?? (idx >= 0 ? toPub(list[idx]?.id) : null);
    const isProgram = !lr && programCurrent !== null;
    const pos = lr
      ? { cur: Math.max(0, (liveNowMs - lr.startedAt) / 1000), total: (lr.endsAt - lr.startedAt) / 1000 }
      : isProgram
        ? { cur: 0, total: 0 }
        : exactPosRef.current;
    void apiPublish({
      state: !current ? "stop" : lr || isProgram ? "play" : pausedNowRef.current ? "pause" : "play",
      posMs: current ? Math.max(0, pos.cur * 1000) : 0,
      lenMs: current ? Math.max(0, pos.total * 1000) : 0,
      current,
      next: (() => {
        const pick = nextPickRef.current;
        if (pick) {
          const pl = playlistsRef.current.find((p) => p.id === pick.listId);
          return toPub(rowsOf(pl, tracksRef.current)[pick.index]?.id);
        }
        return idx >= 0 ? toPub(list[idx + 1]?.id) : null;
      })(),
      queue: list.flatMap((r) => toPub(r.id) ?? []),
      currentIndex: isProgram ? -1 : idx,
      castTitle: isProgram ? liveTextRef.current ?? "" : nowPlayingTextRef.current ?? "",
      volume: settingsRef.current.masterVolume ?? 1,
      listName: playlistsRef.current.find((pl) => pl.id === activeIdRef.current)?.name ?? "",
      scheduler: settingsRef.current.eventsEnabled !== false && !settingsRef.current.liveMode,
      encoders: (() => {
        const st = streamStatusRef.current;
        return settingsRef.current.streaming.icecast.map((c) => {
          const out = st?.outputs.find((o) => o.id === `icecast:${c.id}`);
          const status = !c.enabled ? "off" : st?.running && out?.running ? "active" : "idle";
          return {
            name: c.name || `${c.host}:${c.port}${c.mount}`,
            status,
            error: c.enabled && st?.running && !out?.running ? (st?.lastError ?? "") : "",
            host: c.host,
            port: c.port,
            mount: c.mount,
            tls: c.tls,
            codec: c.codec,
            bitrateKbps: c.bitrateKbps,
            sampleRate: c.sampleRate,
            channels: c.channels,
            public: c.public,
            enabled: c.enabled,
          };
        });
      })(),
    }).catch(() => undefined);
  }, []);
  useEffect(() => {
    publishApiState();
  }, [
    playingRow,
    paused,
    rows,
    tracks,
    nextPick,
    publishApiState,
    liveRun,
    settings.liveMode,
    settings.liveProgramId,
    settings.programs,
    settings.liveTemplate,
    settings.nowPlayingTemplate,
  ]);
  useEffect(() => {
    const t = window.setInterval(publishApiState, 2000);
    return () => window.clearInterval(t);
  }, [publishApiState]);

  // Notificaciones: cambio de cancion (CURRENTSONG / LIVE).
  useEffect(() => {
    if (!nowPlayingText && !liveText) return;
    void notifyFire("track", {
      currentsong: nowPlayingText ?? "",
      live: liveText ?? "",
      live_mode: settingsRef.current.liveMode ? "1" : "0",
      state: settingsRef.current.liveMode ? "on" : "off",
      program: liveProgram?.name ?? "",
      artist: liveProgram?.subtitle ?? songFields?.artist ?? "",
      title: liveProgram?.name ?? songFields?.title ?? "",
      album: liveProgram?.album ?? songFields?.album ?? "",
      file: liveProgram ? "" : nowPlayingTrack?.file ?? "",
    }).catch(() => undefined);
  }, [nowPlayingText, liveText, songFields, nowPlayingTrack, liveProgram]);

  // Notificaciones del modo LIVE y del cambio de programa (pesan mas que la cancion).
  const liveNotifyRef = useRef<{ live: boolean; program: string } | null>(null);
  useEffect(() => {
    const prev = liveNotifyRef.current;
    const cur = { live: !!settings.liveMode, program: settings.liveProgramId ?? "" };
    liveNotifyRef.current = cur;
    if (!prev) return; // al abrir la app no se avisa
    const vars = {
      text: (cur.live ? liveText : nowPlayingText) ?? "",
      live: liveText ?? "",
      currentsong: nowPlayingText ?? "",
      state: cur.live ? "on" : "off",
      program: selectedProgram?.name ?? "",
      title: cur.live ? selectedProgram?.name ?? "" : songFields?.title ?? "",
      artist: cur.live ? selectedProgram?.subtitle ?? "" : songFields?.artist ?? "",
      message: cur.live ? `LIVE: ${selectedProgram?.name ?? ""}` : "LIVE desactivado",
    };
    if (prev.live !== cur.live) void notifyFire("live", vars).catch(() => undefined);
    else if (cur.live && prev.program !== cur.program)
      void notifyFire("program", { ...vars, message: `Programa: ${selectedProgram?.name ?? ""}` }).catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.liveMode, settings.liveProgramId]);

  // Estado de la emision (API y notificaciones): servidor conectado / caido.
  const streamWasRef = useRef<boolean | null>(null);
  const needsServerStatus =
    !!settings.api?.enabled ||
    !!settings.notifications?.some((n) => n.enabled && n.events.includes("server"));
  useEffect(() => {
    if (!needsServerStatus) return;
    const t = window.setInterval(() => {
      void getStreamStatus()
        .then((st) => {
          streamStatusRef.current = st;
          if (!settingsRef.current.notifications?.some((n) => n.enabled && n.events.includes("server"))) return;
          const prev = streamWasRef.current;
          streamWasRef.current = st.running;
          if (prev !== null && prev !== st.running) {
            void notifyFire("server", { message: st.running ? "conectado" : "desconectado" }).catch(() => undefined);
          }
        })
        .catch(() => undefined);
    }, 5000);
    return () => window.clearInterval(t);
  }, [needsServerStatus]);

  // ---- ventanas de herramientas (Ajustes...) ----
  const bridgeRef = useRef<Record<string, (...args: never[]) => unknown>>({});
  bridgeRef.current = {
    getState: () => ({ settings, studio, callMuted, streaming: !!streamStatus?.running, streamStatus, streamBusy }),
    restartStreaming: () => void restartStreaming(),
    streamGroup: (group: "audio" | "video", on: boolean) => void setStreamGroup(group, on),
    updateSettings: (s: Settings) => updateSettings(s),
    chooseMusicFolder: () => chooseMusicFolder(),
    chooseLogo: () => chooseLogo(),
    chooseNowPlayingFile: () => chooseNowPlayingFile(),
    chooseLiveFile: () => chooseLiveFile(),
    writeNowPlayingNow: () => writeNowPlayingNow(),
    removeLogo: () => removeLogo(),
    importForCampaign: () => importForCampaign(),
    launchEvent: (event: StationEvent) => launchEvent(event),
    muteCaller: (muted: boolean) => muteCaller(muted),
    refreshLibrary: () => refreshTracksAndBlocks(),
    pickFilesFor: (side: "a" | "b") => pickFilesFor(side),
    moveTracks: (ids: string[], to: "a" | "b") => moveTracks(ids, to),
    playPreview: async (file: string, start: number, end: number) => {
      const mixer = mixerRef.current;
      if (!mixer) throw new Error("La mesa de sonido todavía no está lista");
      await mixer.playPreview(
        file,
        start,
        end,
        (pos) => void emitEvent("preview://pos", pos),
        () => void emitEvent("preview://end"),
      );
    },
    stopPreview: () => mixerRef.current?.stopPreview(),
    liveVolume: (v: number) => {
      const p = playerRef.current;
      p?.setVolume(v);
      if (p instanceof NativePlayer) mixerRef.current?.setMasterVolume(v);
    },
    liveGain: (key: string, db: number) => {
      mixerRef.current?.setLiveGain(key, db);
      const p = playerRef.current;
      if (p instanceof NativePlayer) p.liveGain(key, db);
    },
    meters: (on: boolean) => {
      setMetersOn(on);
      const p = playerRef.current;
      if (p instanceof NativePlayer) p.setMeters(on);
    },
  };
  useEffect(() => {
    const off = serveMain(() => bridgeRef.current);
    return () => {
      void off.then((fn) => fn());
    };
  }, []);
  useEffect(() => {
    publishState({ settings, studio, callMuted, streaming: !!streamStatus?.running, streamStatus, streamBusy });
  }, [settings, studio, callMuted, streamStatus, streamBusy]);
  // ---- chat de NGRADIO: acoplado aqui o en su ventana ----
  const chatCfg = settings.chat ?? DEFAULT_SETTINGS.chat;
  useEffect(() => {
    if (chatCfg.enabled && chatCfg.floating) {
      void openToolWindow("chat");
    } else {
      void WebviewWindow.getByLabel("chat").then((w) => w?.destroy()).catch(() => undefined);
    }
  }, [chatCfg.enabled, chatCfg.floating]);
  const setChat = useCallback(
    (patch: Partial<typeof chatCfg>) =>
      updateSettings({ ...settingsRef.current, chat: { ...(settingsRef.current.chat ?? DEFAULT_SETTINGS.chat), ...patch } }),
    [updateSettings],
  );

  // ---- video: lo que suena, para la vista previa y la ventana de emision ----
  const videoSource = useCallback((): VideoState | null => {
    const s = settingsRef.current;
    const vs = s.videoScreen ?? DEFAULT_SETTINGS.videoScreen;
    let program: VideoState | null = null;
    const lr = liveRunRef.current;
    if (lr) {
      program = {
        trackId: `live:${lr.eventId}`,
        file: "",
        isVideo: false,
        pos: 0,
        playing: true,
        title: lr.meta.title,
        artist: lr.meta.artist,
        cover: lr.meta.cover,
        audioMode: vs.audioMode,
        logo: s.logoPath ?? "",
        stationName: s.radioName ?? "",
      };
    } else {
      const idx = playingRowRef.current;
      const row = idx >= 0 ? rowsRef.current[idx] : undefined;
      const t = row ? tracksRef.current.find((x) => x.id === row.id) : undefined;
      if (row && t) {
        program = {
          trackId: t.id,
          file: t.file,
          isVideo: isVideoFile(t.file),
          pos: Math.max(0, t.trimStart || 0) + exactPosRef.current.cur,
          playing: !pausedNowRef.current,
          title: row.title || t.title,
          artist: row.artist || t.artist,
          cover: row.cover || t.cover,
          audioMode: vs.audioMode,
          logo: s.logoPath ?? "",
          stationName: s.radioName ?? "",
        };
      }
    }
    if (vs.source === "capture") {
      const input = s.video.inputs.find(
        (item) =>
          item.id === vs.captureInputId &&
          (item.kind === "capture" || item.kind === "ndi") &&
          item.enabled &&
          item.source.trim() !== "",
      );
      if (input) {
        const base: VideoState =
          program ?? {
            trackId: `capture:${input.id}`,
            file: "",
            isVideo: false,
            pos: 0,
            playing: false,
            title: "",
            artist: "",
            cover: "",
            audioMode: vs.audioMode,
            logo: s.logoPath ?? "",
            stationName: s.radioName ?? "",
          };
        return {
          ...base,
          trackId: `capture:${input.id}`,
          programTrackId: program?.trackId ?? "",
          mirror: vs.mirror ?? false,
          captureFallback: vs.captureFallback === "none" ? "none" : "program",
          capture:
            input.kind === "ndi"
              ? { source: input.source, ndi: input.source }
              : { source: input.source, deviceId: input.deviceId },
        };
      }
    }
    return program;
  }, []);
  // Ventana de video: se abre/cierra con el ajuste y recibe el estado 5 veces por segundo.
  const videoScreen = settings.videoScreen ?? DEFAULT_SETTINGS.videoScreen;
  useEffect(() => {
    if (!videoScreen.enabled) {
      void closeVideoOut();
      return;
    }
    void openVideoOut(videoScreen.monitor).then((ok) => {
      if (ok === "hidden") showToast("La pantalla de emisión está en el monitor de OmniCaster: queda oculta (se emite igual). Elige otro monitor para verla.");
      else if (!ok) showToast("No se pudo abrir la ventana de vídeo");
    });
    const t = window.setInterval(() => {
      const st = videoSource();
      if (st) void emitEvent("video://state", st);
    }, 200);
    return () => window.clearInterval(t);
  }, [videoScreen.enabled, videoScreen.monitor, videoSource, showToast]);

  // Pared del ratón: queda en el monitor de OmniCaster y no se pierde en la pantalla de emisión.
  useEffect(() => {
    if (!videoScreen.enabled || !videoScreen.cursorWall) {
      void cursorWall(null).catch(() => undefined);
      return;
    }
    let last = "";
    const tick = async () => {
      try {
        const [ms, main] = await Promise.all([availableMonitors(), currentMonitor()]);
        const target = ms[videoScreen.monitor] ?? ms[0];
        const same = !!main && !!target && main.position.x === target.position.x && main.position.y === target.position.y;
        if (!main || ms.length < 2 || same) {
          if (last !== "off") void cursorWall(null).catch(() => undefined);
          last = "off";
          return;
        }
        const rect: [number, number, number, number] = [
          main.position.x,
          main.position.y,
          main.position.x + main.size.width,
          main.position.y + main.size.height,
        ];
        const key = rect.join(",");
        if (key !== last) void cursorWall(rect).catch(() => undefined);
        last = key;
      } catch {
        /* sin monitores: sin pared */
      }
    };
    void tick();
    const t = window.setInterval(() => void tick(), 2000);
    return () => {
      window.clearInterval(t);
      void cursorWall(null).catch(() => undefined);
    };
  }, [videoScreen.enabled, videoScreen.cursorWall, videoScreen.monitor]);

  // Ventana «Lo que suena» (fuera de pantalla) para las salidas que la emiten.
  const npSize = useMemo(() => {
    const outs = (settings.video?.enabled ? settings.video.outputs : []).filter(
      (o) => o.enabled && (o.videoInputId === "nowplaying" || o.fallbackVideoInputId === "nowplaying"),
    );
    if (outs.length === 0) return null;
    const big = outs.reduce((a, o) => (o.width * o.height > a.width * a.height ? o : a));
    return `${big.width}x${big.height}`;
  }, [settings.video]);
  useEffect(() => {
    if (!npSize) {
      void closeNowPlayingOut();
      return;
    }
    const [w, h] = npSize.split("x").map(Number);
    void openNowPlayingOut(w || 1280, h || 720);
    // Si la pantalla de emisión está abierta, su intervalo ya envía el estado.
    if (videoScreen.enabled) return;
    const t = window.setInterval(() => {
      const st = videoSource();
      if (st) void emitEvent("video://state", st);
    }, 200);
    return () => window.clearInterval(t);
  }, [npSize, videoScreen.enabled, videoSource]);

  // FFmpeg descargado/actualizado por OmniCaster: avisos al empezar y al terminar.
  useEffect(() => {
    let wasBusy = false;
    let announced = false;
    const off = listen<{ busy: boolean; phase: string; error: string | null; done: string | null }>(
      "ffmpeg://progress",
      (e) => {
        const p = e.payload;
        if (p.busy && p.phase === "descargando" && !announced) {
          announced = true;
          showToast("Descargando FFmpeg (emisiones y vídeo)…");
        }
        if (!p.busy && wasBusy) {
          announced = false;
          if (p.error) showToast(`FFmpeg: ${p.error}`);
          else if (p.done && !p.done.includes("al día")) showToast(p.done);
        }
        wasBusy = p.busy;
      },
    );
    return () => {
      void off.then((f) => f());
    };
  }, [showToast]);

  // Resultado de una importacion de copia de seguridad aplicada al arrancar.
  useEffect(() => {
    void backupLastImportLog()
      .then((log) => {
        if (log) showToast(log.includes("falló") ? log.trim() : "Copia de seguridad importada");
      })
      .catch(() => undefined);
  }, [showToast]);
  // Medidores de la mesa web para la ventana Mixer (el motor nativo manda los suyos).
  const [metersOn, setMetersOn] = useState(false);
  useEffect(() => {
    if (!metersOn) return;
    const timer = window.setInterval(() => {
      const mixer = mixerRef.current;
      if (!mixer) return;
      const list = mixer.getStripMeters();
      if (!(playerRef.current instanceof NativePlayer)) {
        const lv = mixer.getMonitorLevel();
        const peak = lv.db <= -60 ? 0 : 10 ** (lv.db / 20);
        list.push({ key: "master", l: peak, r: peak });
      }
      void emitEvent("mixer://meters", list);
    }, 40);
    return () => window.clearInterval(timer);
  }, [metersOn]);
  useEffect(() => {
    void emitEvent("library://changed");
  }, [tracks, blocks]);
  // Progreso del análisis de la librería cuando va en su propia ventana.
  useEffect(() => {
    const off = listen<NormalizerStatus | null>("library://status", (e) => setNormStatus(e.payload));
    return () => {
      void off.then((fn) => fn());
    };
  }, []);

  const deckRow = rows[playingRow] ?? null;
  // A continuacion: la elegida a mano (de cualquier lista) o la de debajo.
  const nextRow =
    nextPick && pickRows
      ? pickRows[nextPick.index] ?? null
      : playingRow >= 0 && playingRow + 1 < rows.length
        ? rows[playingRow + 1]
        : null;

  // ---- Control desde el móvil ----
  // El servidor (Rust) sirve la página; aquí se publica el estado y se
  // ejecutan las órdenes que llegan, con la misma lógica que la pantalla.
  const mobileCfg = settings.mobile;
  useEffect(() => {
    void invoke("mobile_apply", { config: mobileCfg ?? { enabled: false, port: 8080, pin: "" } }).catch(() => undefined);
  }, [mobileCfg?.enabled, mobileCfg?.port, mobileCfg?.pin]); // eslint-disable-line react-hooks/exhaustive-deps

  const videoSources = (settings.video?.inputs ?? []).filter(
    (input) => (input.kind === "capture" || input.kind === "ndi") && input.enabled && input.source.trim() !== "",
  );
  const vsNow = settings.videoScreen;
  const mobileSnapshot = useMemo(() => {
    if (!mobileCfg?.enabled) return null;
    const now = deckRow
      ? { title: deckRow.title, artist: deckRow.artist, cover: deckRow.cover || "", dur: pos.total || deckRow.durationSecs, playing: !paused && playingRow >= 0 }
      : { title: "", artist: "", cover: "", dur: 0, playing: false };
    const nextIndex = nextPick ? (nextPick.listId === active?.id ? nextPick.index : -1) : playingRow >= 0 ? playingRow + 1 : -1;
    return {
      station: settings.radioName || "OmniCaster",
      listName: active?.name ?? "",
      now,
      next: nextRow ? { title: nextRow.title, artist: nextRow.artist } : null,
      rows: rows.map((r, i) => ({ i, title: r.title, artist: r.artist, dur: r.durationSecs, auto: autoIds.has(r.id) })),
      playing: playingRow,
      nextRow: nextIndex,
      autopilot: autopilotOn,
      stream: { audioOn: audioStreamRunning, videoOn: videoStreamRunning, audioReady: audioStreamReady, videoReady: videoStreamReady, busy: streamBusy },
      video: {
        sources: [{ key: "program", label: "Programa" }, ...videoSources.map((i) => ({ key: `capture:${i.id}`, label: i.name.trim() || i.source }))],
        current: vsNow?.source === "capture" ? `capture:${vsNow.captureInputId ?? ""}` : "program",
        monitor: !!vsNow?.enabled,
      },
      mixer: (settings.mixerChannels ?? []).map((c) => ({ id: c.id, name: c.name, gainDb: c.gainDb, muted: c.muted })),
    };
    // pos.cur no entra: el móvil avanza la barra solo (se reenvía cada 10 s).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mobileCfg?.enabled, deckRow, nextRow, rows, playingRow, paused, pos.total, nextPick, active, autoIds, autopilotOn, audioStreamRunning, videoStreamRunning, audioStreamReady, videoStreamReady, streamBusy, settings.video, vsNow, settings.mixerChannels, settings.radioName]);
  const mobileSnapRef = useRef(mobileSnapshot);
  mobileSnapRef.current = mobileSnapshot;
  const mobilePosRef = useRef(pos);
  mobilePosRef.current = pos;
  useEffect(() => {
    if (!mobileCfg?.enabled) return;
    const publish = () => {
      const snap = mobileSnapRef.current;
      if (!snap) return;
      const full = { ...snap, now: { ...snap.now, pos: mobilePosRef.current.cur } };
      const covers = snap.now.cover ? [snap.now.cover] : [];
      void invoke("mobile_publish", { snapshot: JSON.stringify(full), covers }).catch(() => undefined);
    };
    publish();
    const t = window.setInterval(publish, 10_000);
    return () => window.clearInterval(t);
  }, [mobileCfg?.enabled, mobileSnapshot]);

  const mobileActions = useRef<(c: Record<string, unknown>) => void>(() => undefined);
  mobileActions.current = (c) => {
    const num = (k: string) => Number(c[k]);
    const s = settingsRef.current;
    switch (c.cmd) {
      case "toggle":
        void togglePlay();
        break;
      case "next":
        void next();
        break;
      case "prev":
        void prev();
        break;
      case "playRow": {
        const i = num("i");
        if (!Number.isInteger(i) || i < 0 || i >= rows.length || !active) return;
        if (nextPickRef.current) {
          pendingPlayRef.current = { listId: active.id, row: i };
          setNextPick(null);
        } else playRowRef.current(i);
        break;
      }
      case "setNext": {
        const i = num("i");
        if (!active || !Number.isInteger(i) || i < 0 || i >= rows.length || i === playingRowRef.current) return;
        setNextPick(i === playingRowRef.current + 1 ? null : { listId: active.id, index: i });
        break;
      }
      case "remove": {
        const i = num("i");
        if (!Number.isInteger(i) || i === playingRowRef.current) return;
        void mutateList((ids) => ids.filter((_, k) => k !== i));
        break;
      }
      case "move": {
        const from = num("from");
        const to = num("to");
        if (![from, to].every(Number.isInteger)) return;
        void mutateList((ids) => {
          if (from < 0 || from >= ids.length) return ids;
          const copy = [...ids];
          const [m] = copy.splice(from, 1);
          copy.splice(Math.max(0, Math.min(copy.length, to)), 0, m);
          return copy;
        });
        break;
      }
      case "autopilot":
        updateSettings({ ...s, autopilotEnabled: !!c.on });
        break;
      case "stream":
        if (c.group === "audio" || c.group === "video") void setStreamGroup(c.group, !!c.on);
        break;
      case "video": {
        const key = String(c.key ?? "");
        const vs = s.videoScreen ?? DEFAULT_SETTINGS.videoScreen;
        if (key === "program") updateSettings({ ...s, videoScreen: { ...vs, source: "program", captureInputId: "" } });
        else if (key.startsWith("capture:")) updateSettings({ ...s, videoScreen: { ...vs, source: "capture", captureInputId: key.slice(8) } });
        break;
      }
      case "monitor": {
        const vs = s.videoScreen ?? DEFAULT_SETTINGS.videoScreen;
        updateSettings({ ...s, videoScreen: { ...vs, enabled: !!c.on } });
        break;
      }
      case "fader":
      case "mute": {
        const id = String(c.id ?? "");
        const db = Math.max(-60, Math.min(12, num("db")));
        updateSettings({
          ...s,
          mixerChannels: s.mixerChannels.map((ch) =>
            ch.id !== id ? ch : c.cmd === "fader" ? (Number.isFinite(db) ? { ...ch, gainDb: db } : ch) : { ...ch, muted: !!c.on },
          ),
        });
        break;
      }
    }
  };
  useEffect(() => {
    const off = listen<Record<string, unknown>>("mobile://cmd", (e) => mobileActions.current(e.payload ?? {}));
    return () => {
      void off.then((f) => f());
    };
  }, []);

  return (
    <div className="app">
      <header className="topbar" data-tauri-drag-region>
        <div className="brand" data-tauri-drag-region>
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
          <div className="brand-txt" data-tauri-drag-region>
            <span className="brand-name" data-tauri-drag-region>{stationName(settings.radioName) || "OmniCaster Studio"}</span>
            <span className="brand-sub" data-tauri-drag-region>
              {settings.slogan.trim() || "Estudio de automatización"}
            </span>
          </div>
        </div>
        <div className="top-drag" data-tauri-drag-region />
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
            className={`top-switch ${settings.eventsEnabled && !settings.liveMode ? "switch-on" : ""}`}
            title={
              settings.liveMode
                ? "En pausa mientras el modo LIVE está activo; vuelven solos al quitarlo"
                : settings.eventsEnabled
                  ? "Desactivar temporalmente todos los eventos"
                  : "Activar los eventos programados"
            }
          >
            <span className="top-switch-label">{settings.liveMode && settings.eventsEnabled ? "EVENTOS (LIVE)" : "EVENTOS"}</span>
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
          <button
            type="button"
            className={`top-live ${audioStreamRunning ? "live" : ""} ${streamBusy ? "busy" : ""}`}
            onClick={() => void setStreamGroup("audio", !audioStreamRunning)}
            disabled={streamBusy || (!audioStreamRunning && !audioStreamReady)}
            aria-pressed={audioStreamRunning}
            title={
              audioStreamRunning
                ? "Detener la emisión de audio"
                : audioStreamReady
                  ? "Iniciar la emisión de audio"
                  : "Configura una salida Icecast en Streaming"
            }
          >
            <span className="top-live-dot" />
            <span>{audioStreamRunning ? "AUDIO · EN VIVO" : "EMITIR AUDIO"}</span>
          </button>
          <button
            type="button"
            className={`top-live ${videoStreamRunning ? "live" : ""} ${streamBusy ? "busy" : ""}`}
            onClick={() => void setStreamGroup("video", !videoStreamRunning)}
            disabled={streamBusy || (!videoStreamRunning && !videoStreamReady)}
            aria-pressed={videoStreamRunning}
            title={
              videoStreamRunning
                ? "Detener la emisión de vídeo"
                : videoStreamReady
                  ? "Iniciar la emisión de vídeo"
                  : "Configura una salida de vídeo en Streaming"
            }
          >
            <span className="top-live-dot" />
            <span>{videoStreamRunning ? "VÍDEO · EN VIVO" : "EMITIR VÍDEO"}</span>
          </button>
          <SysMonitor />
          <Clock />
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
        <WindowControls />
      </header>

      <WorkspaceLayout
        panels={[
          {
            id: "library",
            title: "Biblioteca",
            content: (
              <MusicBrowser
                tracks={tracks}
                blocks={blocks}
                history={history}
                autoBlocks={settings.autoBlocks}
                languages={settings.languages ?? DEFAULT_SETTINGS.languages}
                ai={settings.ai ?? DEFAULT_SETTINGS.ai}
                onToggleAutoBlock={toggleAutoBlock}
                onCreateBlock={handleCreateBlock}
                onRenameBlock={handleRenameBlock}
                onDeleteBlock={handleDeleteBlock}
                onScan={scanMusicFolder}
                onPickFiles={pickFiles}
                onAdd={addTrack}
                onDelete={handleDeleteTrack}
                onTrackSaved={refreshTracksAndBlocks}
                onEditCuts={handleEditCuts}
                pendingEdit={pendingEdit}
                onPendingEditDone={handlePendingEditDone}
                onAssignTrackBlock={assignTrackBlock}
                onPreviewTrack={autoPreview ? startPreview : undefined}
                dropBlockId={dropBlockId}
                onPreviewNow={startPreview}
                onImportPaths={(paths, opts) =>
                  void doImport(paths, "a", opts.blockId ?? null, opts.toPlaylist ? Number.MAX_SAFE_INTEGER : undefined, true)
                }
                showToast={showToast}
              />
            ),
          },
          {
            id: "vu",
            title: "Vúmetro",
            content: (
              <VuMeter
                mixer={native ?? mixer}
                source={settings.vuSource ?? "master"}
                buses={settings.mixerBuses.map((b) => ({ id: b.id, name: b.name }))}
                monitorBusId={settings.monitorBusId}
                onSelect={(vuSource, busId) =>
                  updateSettings({ ...settingsRef.current, vuSource, monitorBusId: busId })
                }
              />
            ),
          },
          {
            id: "center",
            title: "Reproductor y lista",
            content: (
              <div className="workspace-center">
                {liveRun && (
                  <div className="call-chip live-chip" role="status">
                    <span className="live-dot live-on" aria-hidden="true" />
                    EN DIRECTO · {liveRun.name} · hasta las{" "}
                    {new Date(liveRun.endsAt).toLocaleTimeString([], {
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={() => endLiveEvent(true)}
                      title="Terminar ya y seguir con la lista"
                    >
                      Terminar
                    </button>
                  </div>
                )}
                {studio.calls.length > 0 && (
                  <button
                    type="button"
                    className="call-chip"
                    onClick={() => muteCaller(!callMuted)}
                    title={callMuted ? "Dar voz al oyente" : "Silenciar al oyente"}
                  >
                    <span className="live-dot live-on" aria-hidden="true" />
                    {callMuted ? "OYENTE SILENCIADO" : "LLAMADA AL AIRE"} ·{" "}
                    {studio.calls[0].name}
                  </button>
                )}
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
                <VideoSwitcher
                  settings={settings}
                  onChange={(patch) =>
                    updateSettings({
                      ...settings,
                      videoScreen: { ...(settings.videoScreen ?? DEFAULT_SETTINGS.videoScreen), ...patch },
                    })
                  }
                />
                <div
                  className="deck-ctx-wrap"
                  onContextMenu={(e) => {
                    if (liveRun || !deckRow) return;
                    e.preventDefault();
                    setBlockMenu({ trackId: deckRow.id, x: e.clientX, y: e.clientY });
                  }}
                >
                <DeckZone
                  title={liveRun ? liveRun.meta.title : deckRow?.title ?? ""}
                  artist={liveRun ? liveRun.meta.artist : deckRow?.artist ?? ""}
                  album={liveRun ? liveRun.meta.album : deckRow?.album ?? ""}
                  cover={liveRun ? liveRun.meta.cover : deckRow?.cover ?? ""}
                  current={
                    liveRun ? Math.max(0, (liveClock - liveRun.startedAt) / 1000) : pos.cur
                  }
                  total={liveRun ? (liveRun.endsAt - liveRun.startedAt) / 1000 : pos.total}
                  spinning={liveRun ? true : !paused && playingRow >= 0}
                  next={nextRow ? nextRow.title : null}
                  nextArtist={nextRow?.artist ?? ""}
                  nextAlbum={nextRow?.album ?? ""}
                  nextCover={nextRow?.cover ?? ""}
                  nextDuration={nextRow?.durationSecs ?? 0}
                  onSeek={seek}
                  isVideo={
                    !liveRun &&
                    !!deckRow &&
                    isVideoFile(tracks.find((t) => t.id === deckRow.id)?.file ?? "")
                  }
                  videoSource={videoSource}
                />
                </div>
                <PlaylistZone
                  playlists={playlists}
                  activeId={view?.id ?? ""}
                  airId={active?.id ?? ""}
                  rows={viewRows}
                  playingRow={view && active && view.id === active.id ? playingRow : -1}
                  nextRow={
                    nextPick
                      ? nextPick.listId === view?.id
                        ? nextPick.index
                        : -1
                      : view && active && view.id === active.id && playingRow >= 0
                        ? playingRow + 1
                        : -1
                  }
                  nextElsewhere={
                    nextPick && nextPick.listId !== view?.id
                      ? `${pickRows?.[nextPick.index]?.title ?? ""} · ${playlists.find((p) => p.id === nextPick.listId)?.name ?? ""}`
                      : ""
                  }
                  autoIds={autoIds}
                  estStart={view && active && view.id === active.id ? estStart : []}
                  onSelect={setViewId}
                  onSetNext={setNextRow}
                  onClearNext={() => setNextPick(null)}
                  onGenerate={() => void generateView()}
                  pastVisible={settings.pastVisible ?? 5}
                  leavingRow={
                    removeAfter &&
                    view?.id === removeAfter.listId &&
                    view.id === active?.id &&
                    playingRow >= 0
                      ? playingRow
                      : -1
                  }
                  onNew={() => void newPlaylist()}
                  onRemovePlaylist={() => void removeActivePlaylist()}
                  onClearPlaylist={() => void clearActivePlaylist()}
                  onRename={renamePlaylist}
                  onPlayRow={playViewRow}
                  onReorder={reorderRow}
                  onRemove={removeRow}
                  onDropTrack={dropTrackAt}
            onDropBlock={dropBlockAt}
            onDropFiles={(paths, at) => void doImport(paths, "a", null, at, true)}
                  blocks={blocks}
                  onPreview={previewRow}
                  onEditMeta={editRowMeta}
                  onEditCuts={editRowCuts}
                  onToggleBlock={toggleRowBlock}
                />
                {chatCfg.enabled && !chatCfg.floating && (
                  <ChatPanel
                    config={{
                      serverUrl: settings.studioCalls.serverUrl,
                      token: settings.studioCalls.token,
                      name: chatCfg.name || settings.radioName || "Estudio",
                      enabled: chatCfg.enabled,
                    }}
                    floating={false}
                    onToggleFloating={() => setChat({ floating: true })}
                    collapsed={chatCfg.collapsed}
                    onToggleCollapsed={() => setChat({ collapsed: !chatCfg.collapsed })}
                  />
                )}
              </div>
            ),
          },
        ]}
      />

      <PlayerBar
        onOpenMixer={() => void openToolWindow("mixer")}
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
              ? `Lista guardada; ahora manda el evento «${eventSourceLabel(activeAutoEvent, blocks)}»`
              : name
                ? `AutoDJ: «${name}»`
                : "AutoDJ: automático (listas de Música)",
          );
        }}
        onFadeChange={(s) => updateSettings({ ...settings, fadeSeconds: s })}
        preview={
          preview
            ? {
                title: preview.track.title,
                artist: preview.track.artist,
                cover: preview.track.cover ? trackUrl({ file: preview.track.cover }) : "",
                playing: preview.playing,
                pos: preview.pos,
                from: preview.from,
                to: preview.to,
              }
            : null
        }
        onPreviewToggle={togglePreview}
        onPreviewStop={stopPreview}
        onPreviewSeek={seekPreview}
        autoPreview={autoPreview}
        onAutoPreview={setAutoPreview}
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
          studio={studio}
          callMuted={callMuted}
          onCallMute={muteCaller}
          streamStatus={streamStatus}
          streamBusy={streamBusy}
          onRestartStream={() => void restartStreaming()}
          onToggleStreamGroup={(group, on) => void setStreamGroup(group, on)}
        />
      )}

      {cutsTrackId && cutsTrack && (
        <TrackEditor
          track={cutsTrack}
          mixer={mixerRef.current}
          onClose={() => setCutsTrackId("")}
          onSaved={() => {
            void refreshTracksAndBlocks();
          }}
          showToast={showToast}
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
            onClick={() => normControl(normStatus.paused ? "resume" : "pause")}
          >
            {normStatus.paused ? "Reanudar" : "Pausar"}
          </button>
          <button
            type="button"
            className="ghost-btn norm-mini-cancel"
            onClick={() => normControl("cancel")}
          >
            Cancelar
          </button>
        </div>
      )}

      {blockMenu && (() => {
        const t = tracks.find((x) => x.id === blockMenu.trackId);
        if (!t) return null;
        return (
          <div
            className="ctx-backdrop"
            onClick={() => setBlockMenu(null)}
            onContextMenu={(e) => {
              e.preventDefault();
              setBlockMenu(null);
            }}
          >
            <div className="ctx-menu" style={{ left: blockMenu.x, top: blockMenu.y }} onClick={(e) => e.stopPropagation()} role="menu">
              <div className="ctx-title" title={t.title}>{t.title}</div>
              <div className="ctx-title">Añadir a una lista</div>
              <div className="ctx-blocks">
                {blocks.length === 0 && <span className="hint">No hay listas creadas.</span>}
                {blocks.map((block) => (
                  <button key={block.id} type="button" className="ctx-item" onClick={() => void toggleRowBlock(t.id, block.id)}>
                    <span className="plrow-block-check">{t.blocks.includes(block.id) ? "✓" : ""}</span>
                    {block.name}
                  </button>
                ))}
              </div>
            </div>
          </div>
        );
      })()}


      {toast && (
        <div className="toast" role="status">
          {toast}
        </div>
      )}
    </div>
  );
}
