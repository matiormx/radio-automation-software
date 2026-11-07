import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MusicBrowser } from "../components/MusicBrowser";
import { TrackEditor } from "../components/TrackEditor";
import { EventsTab } from "../components/EventsTab";
import { ProgramsTab } from "../components/ProgramsTab";
import { createBlock, deleteBlock, deletePlaylist, deleteTrack, getSettings, listBlocks, listPlaylists, renameBlock, savePlaylist, saveSettings } from "../api";
import { DEFAULT_SETTINGS, type Block, type Playlist, type Settings, type Track } from "../types";
import type { SoundMixer } from "../mixer";
import { connect, logout, mediaUrl, setToken, subscribe, takeToken, tracksNow, uploadFiles, whoAmI, type UploadProgress } from "./store";
import { PlaylistEditor } from "./PlaylistEditor";

type Tab = "music" | "playlists" | "events" | "programs";
const TABS: { id: Tab; label: string }[] = [
  { id: "music", label: "Música" },
  { id: "playlists", label: "Playlists" },
  { id: "events", label: "Eventos" },
  { id: "programs", label: "Programas" },
];

/** Escucha previa en el navegador (lo que en OmniCaster suena por la mesa). */
function makePreview() {
  const audio = new Audio();
  audio.preload = "auto";
  let timer = 0;
  let ended: (() => void) | null = null;
  const stop = () => {
    window.clearInterval(timer);
    audio.pause();
    const e = ended;
    ended = null;
    e?.();
  };
  return {
    async playPreview(file: string, start: number, end: number, onTick: (p: number) => void, onEnded: () => void) {
      stop();
      const url = mediaUrl(file);
      if (!url) throw new Error("Esta canción aún no tiene su archivo en la nube");
      if (audio.src !== new URL(url, location.href).href) audio.src = url;
      ended = onEnded;
      await new Promise<void>((res, rej) => {
        if (audio.readyState >= 1) return res();
        audio.onloadedmetadata = () => res();
        audio.onerror = () => rej(new Error("No se pudo cargar el audio"));
      });
      audio.currentTime = Math.max(0, start);
      await audio.play();
      timer = window.setInterval(() => {
        onTick(audio.currentTime);
        if (end > 0 && audio.currentTime >= end) stop();
      }, 50);
      audio.onended = () => stop();
    },
    stopPreview() {
      stop();
    },
  };
}

/** Elegir archivos con el selector del navegador. */
function pickFiles(accept = "audio/*,video/*,.flac,.m4a,.aac,.ogg,.opus,.wav,.mp3"): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    input.accept = accept;
    // En la página (algunos navegadores, como Safari, no avisan si no está).
    input.style.display = "none";
    document.body.appendChild(input);
    let settled = false;
    const done = (files: File[]) => {
      if (settled) return;
      settled = true;
      input.remove();
      resolve(files);
    };
    input.onchange = () => done([...(input.files ?? [])]);
    // Hay navegadores que avisan «cancelado» justo antes de los archivos.
    input.oncancel = () => window.setTimeout(() => done([...(input.files ?? [])]), 800);
    input.click();
  });
}

function Login({ error, onEnter }: { error: string; onEnter: (t: string) => void }) {
  const [v, setV] = useState("");
  return (
    <div className="web-login">
      <div className="web-card">
        <h1>Gestión de la emisora</h1>
        <p className="hint">
          Entra con el enlace que te ha mandado quien gestiona la emisora. Si tienes la llave a mano, pégala aquí.
        </p>
        {error && <p className="hint update-error">{error}</p>}
        <input
          type="password"
          placeholder="och_… u ocs_…"
          autoComplete="off"
          spellCheck={false}
          value={v}
          onChange={(e) => setV(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && v.trim() && onEnter(v.trim())}
        />
        <button type="button" className="btn btn-accent" disabled={!v.trim()} onClick={() => onEnter(v.trim())}>
          Entrar
        </button>
      </div>
    </div>
  );
}

export function WebApp() {
  const [state, setState] = useState<"connecting" | "login" | "ready">(() => (takeToken() ? "connecting" : "login"));
  const [error, setError] = useState("");
  const [tab, setTab] = useState<Tab>("music");
  const [tracks, setTracks] = useState<Track[]>([]);
  const [blocks, setBlocks] = useState<Block[]>([]);
  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [selPl, setSelPl] = useState("");
  const [cutsId, setCutsId] = useState("");
  const [upload, setUpload] = useState<UploadProgress | null>(null);
  const [toast, setToast] = useState("");
  const toastTimer = useRef(0);
  const preview = useMemo(() => makePreview(), []);

  const showToast = useCallback((m: string) => {
    setToast(m);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(""), 3500);
  }, []);

  const refresh = useCallback(async () => {
    setTracks(tracksNow());
    const [b, p, s] = await Promise.all([listBlocks(), listPlaylists(), getSettings()]);
    setBlocks(b);
    setPlaylists(p);
    setSettings(s);
  }, []);

  useEffect(() => {
    if (state !== "connecting") return;
    let alive = true;
    connect()
      .then(async () => {
        if (!alive) return;
        await refresh();
        setState("ready");
      })
      .catch((e) => {
        if (!alive) return;
        setError(String(e instanceof Error ? e.message : e));
        setState("login");
      });
    return () => {
      alive = false;
    };
  }, [state, refresh]);

  useEffect(() => subscribe(() => void refresh()), [refresh]);
  useEffect(() => {
    if (!selPl && playlists.length) setSelPl(playlists[0].id);
  }, [playlists, selPl]);

  const doUpload = useCallback(
    async (blockId?: string): Promise<Track[]> => {
      const files = await pickFiles();
      if (!files.length) return [];
      try {
        const made = await uploadFiles(files, { blockId }, setUpload);
        showToast(made.length === 1 ? `«${made[0].title}» subida` : `${made.length} archivos subidos`);
        return made;
      } catch (e) {
        showToast(`No se pudo subir: ${String(e instanceof Error ? e.message : e)}`);
        return [];
      } finally {
        setUpload(null);
      }
    },
    [showToast],
  );

  const changeSettings = useCallback(
    (s: Settings) => {
      setSettings(s);
      void saveSettings(s).catch((e) => showToast(String(e)));
    },
    [showToast],
  );

  const addToPlaylist = useCallback(
    (t: Track) => {
      const pl = playlists.find((p) => p.id === selPl);
      if (!pl) {
        showToast("Crea antes una playlist");
        return;
      }
      void savePlaylist({ ...pl, trackIds: [...pl.trackIds, t.id], meta: [...(pl.meta ?? []), null] })
        .then(() => showToast(`${t.title} añadida a «${pl.name}»`))
        .catch((e) => showToast(String(e)));
    },
    [playlists, selPl, showToast],
  );

  if (state === "login")
    return (
      <Login
        error={error}
        onEnter={(t) => {
          setToken(t);
          setError("");
          setState("connecting");
        }}
      />
    );
  if (state === "connecting")
    return (
      <div className="web-login">
        <p className="hint">Conectando con la emisora…</p>
      </div>
    );

  const me = whoAmI();
  const cutsTrack = tracks.find((t) => t.id === cutsId);
  return (
    <div className="web-app">
      <header className="web-top">
        <b className="web-station">{me?.station.name ?? "Emisora"}</b>
        <nav className="web-tabs">
          {TABS.map((t) => (
            <button key={t.id} type="button" className={`btn btn-sm ${tab === t.id ? "btn-accent" : ""}`} onClick={() => setTab(t.id)}>
              {t.label}
            </button>
          ))}
        </nav>
        <span className="web-who">
          {me?.caller.kind === "helper" ? me.caller.name : "Propietario"}
          <button type="button" className="btn btn-sm" onClick={() => window.confirm("¿Salir de la gestión en este navegador?") && logout()}>
            Salir
          </button>
        </span>
      </header>
      {upload && (
        <div className="web-upload">
          {upload.phase === "hash" ? "Preparando" : "Subiendo"} {upload.index + 1} de {upload.total}: {upload.name}
          {upload.phase === "upload" ? ` · ${Math.round(upload.fraction * 100)} %` : ""}
          <div className="web-bar">
            <div style={{ width: `${Math.round(((upload.index + (upload.phase === "upload" ? upload.fraction : 0)) / upload.total) * 100)}%` }} />
          </div>
        </div>
      )}
      <main className="web-main">
        {tab === "music" && (
          <div className="web-music">
            {playlists.length > 0 && (
              <div className="web-target hint">
                El botón «+» de cada canción la añade a la playlist{" "}
                <select value={selPl} onChange={(e) => setSelPl(e.target.value)}>
                  {playlists.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </div>
            )}
            <MusicBrowser
              tracks={tracks}
              blocks={blocks}
              history={[]}
              autoBlocks={[]}
              languages={settings.languages ?? DEFAULT_SETTINGS.languages}
              ai={settings.ai ?? DEFAULT_SETTINGS.ai}
              onToggleAutoBlock={() => showToast("Las listas del AutoDJ se eligen en cada equipo")}
              onCreateBlock={async (name) => {
                await createBlock(name);
              }}
              onRenameBlock={renameBlock}
              onDeleteBlock={deleteBlock}
              onScan={async () => 0}
              onPickFiles={() => void doUpload()}
              onAdd={addToPlaylist}
              onDelete={(t) => {
                if (window.confirm(`¿Borrar «${t.title}» de la biblioteca de la emisora? Se borra en todos los equipos.`)) {
                  void deleteTrack(t.id).catch((e) => showToast(String(e)));
                }
              }}
              onTrackSaved={refresh}
              onEditCuts={(t) => setCutsId(t.id)}
              pendingEdit={null}
              onPendingEditDone={() => undefined}
              onPreviewNow={(t) =>
                void preview.playPreview(t.file, t.trimStart || 0, t.trimEnd ?? t.durationSecs, () => undefined, () => undefined).catch((e) => showToast(String(e)))
              }
              showToast={showToast}
            />
          </div>
        )}
        {tab === "playlists" && (
          <PlaylistEditor
            playlists={playlists}
            tracks={tracks}
            selected={selPl}
            onSelect={setSelPl}
            onSave={(p) => void savePlaylist(p).catch((e) => showToast(String(e)))}
            onDelete={(id) => void deletePlaylist(id).catch((e) => showToast(String(e)))}
            onPreview={(t) =>
              void preview.playPreview(t.file, t.trimStart || 0, t.trimEnd ?? t.durationSecs, () => undefined, () => undefined).catch((e) => showToast(String(e)))
            }
            onStop={() => preview.stopPreview()}
            onEditCuts={(t) => setCutsId(t.id)}
          />
        )}
        {tab === "events" && (
          <div className="settings-section web-pad">
            <EventsTab
              settings={settings}
              tracks={tracks}
              blocks={blocks}
              onChange={changeSettings}
              onImportAudio={() => doUpload()}
              onLaunchEvent={() => showToast("Lanzar un evento ahora solo se puede desde el estudio")}
            />
          </div>
        )}
        {tab === "programs" && (
          <div className="settings-section web-pad">
            <ProgramsTab settings={settings} blocks={blocks} onChange={changeSettings} showToast={showToast} />
          </div>
        )}
      </main>
      {cutsTrack && (
        <TrackEditor
          track={cutsTrack}
          mixer={preview as unknown as SoundMixer}
          onClose={() => {
            preview.stopPreview();
            setCutsId("");
          }}
          onSaved={() => void refresh()}
          showToast={showToast}
        />
      )}
      {toast && (
        <div className="toast" role="status">
          {toast}
        </div>
      )}
    </div>
  );
}
