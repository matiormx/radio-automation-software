import { CloudTab } from "./CloudTab";
import { ApiTab } from "./ApiTab";
import { NotificationsTab } from "./NotificationsTab";
import { BackupTab } from "./BackupTab";
import { useEffect, useMemo, useRef, useState } from "react";
import type {
  Block,
  Campaign,
  CampaignKind,
  Settings,
  StationEvent,
  StreamStatus,
  Track,
} from "../types";
import { DEFAULT_ENERGY_CURVE, DEFAULT_SETTINGS, campaignSchedules, effectiveDuration } from "../types";
import { IS_LINUX, confirmAsk, logsOpen, logsTail, requestQuit, trackUrl } from "../api";
import { RemoteTab } from "./RemoteTab";
import { MobileTab } from "./MobileTab";
import { NetworkTab } from "./NetworkTab";
import { LANGUAGE_CATALOG, languageFlag, languageName } from "../languages";
import { IconFolder, IconPlus, IconTrash, LogoRadio } from "../icons";
import { MixerEmbedded } from "../MixerWindow";
import { VstSettings } from "./VstSettings";
import { AiTab } from "./AiTab";
import { EventsTab } from "./EventsTab";
import { VideoTab } from "./VideoTab";
import { StreamingTab } from "./StreamingTab";
import { StudioCallsTab } from "./StudioCallsTab";
import type { StudioSnapshot } from "../studioCalls";
import { UpdateSection } from "./UpdateSection";
import { FfmpegSection } from "./FfmpegSection";
import { ProgramsTab } from "./ProgramsTab";
import { ScheduleEditor, newScheduleBlock } from "./ScheduleEditor";
import { EMPTY_STREAM_META, MetaFields } from "./MetaFields";
import { MediaTypesTab } from "./MediaTypesTab";
import {
  DEFAULT_NOW_PLAYING_TEMPLATE,
  NOW_PLAYING_PLACEHOLDERS,
  liveFilePath,
  liveImagePath,
  nowPlayingImagePath,
} from "../nowplaying";
import { Help } from "./Help";

interface SettingsPanelProps {
  settings: Settings;
  tracks: Track[];
  blocks: Block[];
  hidden: boolean;
  onChange: (s: Settings) => void;
  onClose: () => void;
  onPickMusicFolder: () => Promise<void>;
  onPickNowPlaying: () => void;
  onPickLiveFile: () => void;
  onWriteNowPlaying: () => void;
  onPickLogo: () => Promise<void>;
  onClearLogo: () => Promise<void>;
  onImportAudio: () => Promise<Track[]>;
  onLaunchEvent: (event: StationEvent) => void;
  showToast: (msg: string) => void;
  tab: SettingsTab;
  onTabChange: (tab: SettingsTab) => void;
  studio: StudioSnapshot;
  callMuted: boolean;
  onCallMute: (muted: boolean) => void;
  /** Estado real de cada salida para los testigos de Streaming. */
  streamStatus?: StreamStatus | null;
  streamBusy?: boolean;
  onRestartStream?: () => void;
  onToggleStreamGroup?: (group: "audio" | "video", on: boolean) => void;
  /** En su propia ventana: sin fondo modal ni cabecera de dialogo */
  windowed?: boolean;
}

const DAYS: { value: number; label: string; long: string }[] = [
  { value: 1, label: "L", long: "lunes" },
  { value: 2, label: "M", long: "martes" },
  { value: 3, label: "X", long: "miércoles" },
  { value: 4, label: "J", long: "jueves" },
  { value: 5, label: "V", long: "viernes" },
  { value: 6, label: "S", long: "sábado" },
  { value: 7, label: "D", long: "domingo" },
];

const KIND_LABEL: Record<CampaignKind, string> = { ads: "Anuncio", jingle: "Jingle" };

function fmtDur(secs: number): string {
  const m = Math.floor(secs / 60);
  const s = Math.round(secs % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

function scheduleText(c: Campaign): string {
  return campaignSchedules(c)
    .map((block) => {
      if (block.hourly) return `Cada hora a las :${String(block.minute ?? 0).padStart(2, "0")}`;
      return block.times.length === 0 ? "Sin horas" : block.times.join(" · ");
    })
    .join(" | ");
}

function daysText(c: Campaign): string {
  return campaignSchedules(c)
    .map((block) => {
      if (block.days.length === 7) return "Todos los días";
      return DAYS.filter((d) => block.days.includes(d.value))
        .map((d) => d.label)
        .join(" ");
    })
    .join(" | ");
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function toLocalInput(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(
    d.getHours(),
  )}:${pad2(d.getMinutes())}`;
}

function todayStartInput(): string {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return toLocalInput(d);
}

function campaignDate(value: string): number | null {
  if (!value) return null;
  const t = new Date(value).getTime();
  return Number.isNaN(t) ? null : t;
}

function fmtCampaignDate(value: string): string {
  const t = campaignDate(value);
  if (t == null) return "";
  return new Date(t).toLocaleString("es-ES", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function defaultEndAt(startAt: string): string {
  const start = campaignDate(startAt);
  const d = start == null ? new Date() : new Date(start);
  d.setDate(d.getDate() + 7);
  return toLocalInput(d);
}

function campaignWindowText(c: Campaign): string {
  const start = c.startAt ? fmtCampaignDate(c.startAt) : "";
  const end = c.endAt ? fmtCampaignDate(c.endAt) : "";
  if (start && end) return `Del ${start} al ${end}`;
  if (start) return `Desde ${start} · permanente`;
  if (end) return `Hasta ${end}`;
  return "Sin límites de fecha";
}

function MinField({
  label,
  value,
  onCommit,
}: {
  label: string;
  value: number;
  onCommit: (v: number) => void;
}) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      <span className="field-unit">
        <input
          type="number"
          min={0}
          max={10080}
          value={value}
          onChange={(e) => onCommit(Math.max(0, Number(e.target.value) || 0))}
        />
        min
      </span>
    </label>
  );
}

/** Menú lateral de Ajustes, por áreas de trabajo de la emisora. */
const NAV_GROUPS: { title: string; items: { id: SettingsTab; label: string; sub: string; linux?: boolean }[] }[] = [
  {
    title: "Emisora",
    items: [
      { id: "general", label: "General", sub: "Identidad, apariencia y arranque" },
      { id: "programs", label: "Programas", sub: "Títulos y portadas en directo" },
    ],
  },
  {
    title: "Programación",
    items: [
      { id: "autodj", label: "AutoDJ", sub: "Rotación, curva de energía e intros" },
      { id: "mediatypes", label: "Tipos de medio", sub: "Música, jingles, programas, cuñas" },
      { id: "events", label: "Eventos", sub: "Franjas y emisiones programadas" },
      { id: "campaigns", label: "Campañas", sub: "Cuñas y jingles por pases" },
    ],
  },
  {
    title: "Audio y vídeo",
    items: [
      { id: "sound", label: "Consola", sub: "Canales, buses y salidas" },
      { id: "plugins", label: "Plugins VST", sub: "Carpetas y plugins visibles" },
      { id: "video", label: "Vídeo", sub: "Entradas, salidas y mezcla" },
    ],
  },
  {
    title: "Emisión",
    items: [
      { id: "streaming", label: "Streaming", sub: "Icecast, FLAC, AAC, RTMP y NDI" },
      { id: "calls", label: "Llamadas", sub: "Oyentes al aire desde NGRADIO" },
    ],
  },
  {
    title: "Conexiones",
    items: [
      { id: "cloud", label: "Nube (maestro)", sub: "Equipos de la emisora y panel web" },
      { id: "mobile", label: "Control remoto", sub: "Directo, lista y consola desde el móvil" },
      { id: "ai", label: "Inteligencia artificial", sub: "Metadatos IA, asistente y transcripción" },
      { id: "api", label: "API", sub: "Datos para la web de la emisora" },
      { id: "notify", label: "Notificaciones", sub: "Avisos GET/POST por eventos" },
    ],
  },
  {
    title: "Sistema",
    items: [
      { id: "backup", label: "Copia y actualizaciones", sub: "Copias de seguridad y versiones" },
      { id: "remote", label: "Acceso remoto", sub: "VNC, WireGuard y carpeta compartida", linux: true },
      { id: "network", label: "Red", sub: "IP, DNS, Wi-Fi y nombre del equipo", linux: true },
    ],
  },
];

export type SettingsTab =
  | "general"
  | "autodj"
  | "mediatypes"
  | "campaigns"
  | "events"
  | "programs"
  | "sound"
  | "plugins"
  | "ai"
  | "video"
  | "streaming"
  | "calls"
  | "api"
  | "notify"
  | "backup"
  | "remote"
  | "mobile"
  | "cloud"
  | "network";

export function SettingsPanel({
  settings,
  tracks,
  blocks,
  hidden,
  onChange,
  onClose,
  onPickMusicFolder,
  onPickNowPlaying,
  onPickLiveFile,
  onWriteNowPlaying,
  onPickLogo,
  onClearLogo,
  onImportAudio,
  onLaunchEvent,
  showToast,
  tab,
  onTabChange,
  studio,
  callMuted,
  onCallMute,
  streamStatus = null,
  streamBusy = false,
  onRestartStream,
  onToggleStreamGroup,
  windowed = false,
}: SettingsPanelProps) {
  const s = settings;
  return (
    <div
      className={windowed ? "settings-windowed" : `modal-backdrop ${hidden ? "modal-hidden" : ""}`}
      onClick={windowed ? undefined : onClose}
      aria-hidden={hidden}
    >
      <div
        className={
          windowed
            ? "settings-window-body"
            : `modal settings-modal ${
                tab === "sound" || tab === "video" || tab === "streaming" ? "settings-modal-wide" : ""
              }`
        }
        onClick={(e) => e.stopPropagation()}
        role={windowed ? undefined : "dialog"}
        aria-modal={windowed ? undefined : true}
        aria-label="Ajustes"
      >
        {!windowed && (
        <div className="modal-head">
          <h3>Ajustes</h3>
          <button
            type="button"
            className="ghost-btn"
            onClick={onClose}
            title="Ocultar los ajustes; se conserva la pestaña y lo que estés editando"
          >
            Ocultar
          </button>
        </div>
        )}

        <div className="settings-body">
          <nav className="settings-nav">
            {NAV_GROUPS.map((g) => (
              <div key={g.title} className="settings-nav-group">
                <div className="settings-nav-title">{g.title}</div>
                {g.items
                  .filter((it) => !it.linux || IS_LINUX)
                  .map((it) => (
                    <button
                      key={it.id}
                      type="button"
                      className={`settings-nav-btn ${tab === it.id ? "settings-nav-on" : ""}`}
                      onClick={() => onTabChange(it.id)}
                      title={it.sub}
                    >
                      {it.label}
                      <span>{it.sub}</span>
                    </button>
                  ))}
              </div>
            ))}
            <div className="settings-nav-power">
              {IS_LINUX ? (
                <>
                  <button type="button" className="btn btn-sm" onClick={() => void requestQuit("reboot")}>
                    Reiniciar equipo…
                  </button>
                  <button type="button" className="btn btn-sm btn-danger" onClick={() => void requestQuit("poweroff")}>
                    Apagar equipo…
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  className="btn btn-sm btn-danger"
                  title="La X de la ventana solo la oculta en la barra de tareas"
                  onClick={() => void requestQuit()}
                >
                  Cerrar OmniCaster…
                </button>
              )}
            </div>
          </nav>

          <div className="settings-content">
            {tab === "general" && (
              <GeneralTab
                settings={s}
                blocks={blocks}
                showToast={showToast}
                onChange={onChange}
                onPickMusicFolder={onPickMusicFolder}
                onPickNowPlaying={onPickNowPlaying}
                onPickLiveFile={onPickLiveFile}
                onWriteNowPlaying={onWriteNowPlaying}
                onPickLogo={onPickLogo}
                onClearLogo={onClearLogo}
              />
            )}
            {tab === "sound" && (
              <>
                <AudioBufferField settings={s} onChange={onChange} />
                <MixerEmbedded settings={s} onChange={onChange} />
              </>
            )}
            {tab === "plugins" && <VstSettings settings={s} onChange={onChange} />}
            {tab === "ai" && <AiTab settings={s} onChange={onChange} showToast={showToast} />}
            {tab === "video" && <VideoTab settings={s} onChange={onChange} streamStatus={streamStatus} />}
            {tab === "autodj" && <AutoDjTab settings={s} blocks={blocks} onChange={onChange} />}
            {tab === "mediatypes" && <MediaTypesTab settings={s} onChange={onChange} />}
            {tab === "campaigns" && (
              <CampaignsTab
                settings={s}
                tracks={tracks}
                blocks={blocks}
                onChange={onChange}
                onImportAudio={onImportAudio}
              />
            )}
            {tab === "events" && (
              <EventsTab
                settings={s}
                tracks={tracks}
                blocks={blocks}
                onChange={onChange}
                onImportAudio={onImportAudio}
                onLaunchEvent={onLaunchEvent}
              />
            )}
            {tab === "programs" && (
              <ProgramsTab settings={s} blocks={blocks} onChange={onChange} showToast={showToast} />
            )}
            {tab === "streaming" && (
              <StreamingTab
                settings={s}
                onChange={onChange}
                streamStatus={streamStatus}
                streamBusy={streamBusy}
                onRestartStream={onRestartStream}
                onToggleStreamGroup={onToggleStreamGroup}
              />
            )}
            {tab === "mobile" && <MobileTab settings={s} onChange={onChange} />}
            {tab === "cloud" && <CloudTab showToast={showToast} settings={s} onChange={onChange} />}
            {tab === "remote" && <RemoteTab settings={s} onChange={onChange} showToast={showToast} />}
            {tab === "network" && <NetworkTab showToast={showToast} />}
            {tab === "backup" && (
              <>
                <UpdateSection showToast={showToast} />
                <FfmpegSection showToast={showToast} />
                <BackupTab showToast={showToast} />
              </>
            )}
            {tab === "notify" && <NotificationsTab settings={s} onChange={onChange} showToast={showToast} />}
            {tab === "api" && <ApiTab settings={s} onChange={onChange} showToast={showToast} />}
            {tab === "calls" && (
              <StudioCallsTab
                settings={s}
                onChange={onChange}
                studio={studio}
                callMuted={callMuted}
                onCallMute={onCallMute}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function GeneralTab({
  settings: s,
  blocks,
  showToast: _showToast,
  onChange,
  onPickMusicFolder,
  onPickNowPlaying,
  onPickLiveFile,
  onWriteNowPlaying,
  onPickLogo,
  onClearLogo,
}: {
  settings: Settings;
  blocks: Block[];
  showToast: (msg: string) => void;
  onChange: (s: Settings) => void;
  onPickMusicFolder: () => Promise<void>;
  onPickNowPlaying: () => void;
  onPickLiveFile: () => void;
  onWriteNowPlaying: () => void;
  onPickLogo: () => Promise<void>;
  onClearLogo: () => Promise<void>;
}) {
  const defaultBlock = blocks.some((block) => block.id === s.defaultBlockId)
    ? s.defaultBlockId
    : "";
  return (
    <>
      <fieldset className="fieldset">
        <legend>Identidad de la emisora</legend>
        <Help>
          Estos datos sustituyen la marca por defecto de la esquina superior izquierda.
        </Help>
        <div className="field-row">
          <label className="field">
            <span className="field-label">Nombre de la radio</span>
            <input
              type="text"
              value={s.radioName}
              maxLength={60}
              placeholder="OmniCaster"
              onChange={(e) => onChange({ ...s, radioName: e.target.value })}
            />
          </label>
          <label className="field">
            <span className="field-label">Eslogan</span>
            <input
              type="text"
              value={s.slogan}
              maxLength={90}
              placeholder="Estudio de automatización"
              onChange={(e) => onChange({ ...s, slogan: e.target.value })}
            />
          </label>
        </div>
        <span className="field-label">Logo</span>
        <div className="branding-row">
          <div className="branding-preview">
            {s.logoPath ? (
              <img src={trackUrl({ file: s.logoPath })} alt="Logo de la emisora" />
            ) : (
              <LogoRadio size={42} />
            )}
          </div>
          <div className="branding-actions">
            <div className="branding-btns">
              <button type="button" className="btn btn-sm" onClick={() => void onPickLogo()}>
                Elegir imagen
              </button>
              {s.logoPath && (
                <button type="button" className="ghost-btn" onClick={() => void onClearLogo()}>
                  Quitar logo
                </button>
              )}
            </div>
            <Help>
              PNG, JPG, WebP o GIF. Se copia a los datos de la app; el original no se toca.
              Recomendado: cuadrado o horizontal con fondo transparente.
            </Help>
          </div>
        </div>
            </fieldset>

      <fieldset className="fieldset">
        <legend>Diagnóstico</legend>
        <Help>
          OmniCaster apunta en <strong>rendimiento.log</strong> qué gasta el procesador (por partes y por hilos) y qué
          órdenes se repiten, cada vez que pasa del 30 % y un resumen cada 10 minutos; los fallos van en errores.log.
          Si algo va lento, copia el registro y mándalo.
        </Help>
        <p>
          <button
            type="button"
            className="btn btn-sm btn-accent"
            onClick={() =>
              void logsTail()
                .then((t) => navigator.clipboard.writeText(t))
                .then(() => alert("Registro copiado: pégalo en el chat o en un correo."))
                .catch((e) => alert(String(e)))
            }
          >
            Copiar el registro
          </button>{" "}
          <button type="button" className="btn btn-sm" onClick={() => void logsOpen().catch((e) => alert(String(e)))}>
            Abrir la carpeta
          </button>
        </p>
      </fieldset>

      <fieldset className="fieldset">
        <legend>Apariencia</legend>
        <label className="field">
          <span className="field-label">Tamaño de la interfaz</span>
          <select value={s.uiScale ?? 100} onChange={(e) => onChange({ ...s, uiScale: Number(e.target.value) })}>
            {[
              [90, "Pequeño (90 %)"],
              [100, "Normal"],
              [110, "Grande (110 %)"],
              [125, "Más grande (125 %)"],
              [140, "Muy grande (140 %)"],
            ].map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span className="field-label">Contraste del texto</span>
          <select value={s.uiContrast ?? "normal"} onChange={(e) => onChange({ ...s, uiContrast: e.target.value as Settings["uiContrast"] })}>
            <option value="normal">Normal (suave)</option>
            <option value="alto">Alto: textos secundarios más claros</option>
            <option value="maximo">Máximo: todo blanco y colores vivos</option>
          </select>
        </label>
        <Help>Se aplica al momento. Útil en pantallas lejanas, por VNC o con poca luz.</Help>
      </fieldset>

      <fieldset className="fieldset">
        <legend>Inicio y automatización</legend>
        <label className="check-field">
          <input
            type="checkbox"
            checked={s.autoPlayOnStart}
            onChange={(e) => onChange({ ...s, autoPlayOnStart: e.target.checked })}
          />
          Reproducir automáticamente al iniciar el programa
        </label>
        <label className="check-field">
          <input
            type="checkbox"
            checked={s.renameFiles !== false}
            onChange={(e) => onChange({ ...s, renameFiles: e.target.checked })}
          />
          Renombrar el archivo al editar título o artista
          <Help>El archivo pasa a llamarse «Artista - Título» cada vez que cambias esos datos en el editor.</Help>
        </label>
        <label className="check-field">
          <input
            type="checkbox"
            checked={s.fadeInNext === true}
            onChange={(e) => onChange({ ...s, fadeInNext: e.target.checked })}
          />
          Fade in en el crossfade
          <Help>
            Activado, la siguiente canción entra con fundido de entrada. Desactivado (recomendado), entra a volumen
            completo y solo baja la que sale: así no se pierde el arranque de las canciones enérgicas.
          </Help>
        </label>
        <label className="check-field">
          <input
            type="checkbox"
            checked={s.silenceDetection}
            onChange={(e) => onChange({ ...s, silenceDetection: e.target.checked })}
          />
          Detección de silencio (pasa a la siguiente canción o activa la reproducción)
        </label>
        <label className="field">
          <span className="field-label">
            Canciones emitidas visibles en la lista: {s.pastVisible ?? 5}
          </span>
          <input
            type="range"
            min={0}
            max={30}
            step={1}
            value={s.pastVisible ?? 5}
            onChange={(e) => onChange({ ...s, pastVisible: Number(e.target.value) })}
          />
          <Help>
            Las que ya sonaron se ven en gris por encima de la actual; las más antiguas se ocultan.
          </Help>
        </label>
        <label className="field">
          <span className="field-label">Canciones emitidas que se guardan en la lista</span>
          <select
            value={s.keepPlayed ?? 0}
            onChange={(e) => onChange({ ...s, keepPlayed: Number(e.target.value) })}
          >
            <option value={0}>Todas (no borrar)</option>
            {[1, 5, 10, 20, 50, 100].map((n) => (
              <option key={n} value={n}>
                Las últimas {n}
              </option>
            ))}
          </select>
          <Help>
            Las más antiguas se quitan de la lista que suena (siguen en la biblioteca). Así la lista no crece sin fin.
          </Help>
        </label>
        {s.silenceDetection && (
          <label className="field">
            <span className="field-label">
              Umbral de silencio: {s.silenceThresholdDb ?? -55} dBFS
            </span>
            <input
              type="range"
              min={-80}
              max={-20}
              step={1}
              value={s.silenceThresholdDb ?? -55}
              onChange={(e) => onChange({ ...s, silenceThresholdDb: Number(e.target.value) })}
            />
            <Help>
              Por debajo de este nivel se considera silencio (3 s seguidos). Súbelo si salta
              con pasajes suaves; bájalo si no detecta silencios con ruido de fondo.
            </Help>
          </label>
        )}
        <label className="field">
          <span className="field-label">Lista por defecto del AutoDJ</span>
          <select
            value={defaultBlock}
            onChange={(e) => onChange({ ...s, defaultBlockId: e.target.value })}
          >
            <option value="">Automático (según Música)</option>
            {blocks.map((block) => (
              <option key={block.id} value={block.id}>
                {block.name}
              </option>
            ))}
          </select>
        </label>
        <Help>
          Si eliges una lista, el AutoDJ saca las próximas canciones de ahí. En «Automático»
          usa las listas marcados con el rayo en Música; si no hay ninguno, toda la biblioteca.
          Un evento activo tiene prioridad sobre esta selección.
        </Help>
      </fieldset>

      <fieldset className="fieldset">
        <legend>Archivo nowplaying</legend>
        <Help>
          Escribe un archivo de texto con la canción que está sonando, para que otros programas
          o pantallas lo lean. Se actualiza en cada cambio de canción.
        </Help>
        <label className="field">
          <span className="field-label">Archivo</span>
          <span className="field-unit np-path">
            <input
              type="text"
              value={s.nowPlayingPath}
              spellCheck={false}
              placeholder="C:\\OmniCaster\\nowplaying.txt"
              onChange={(e) => onChange({ ...s, nowPlayingPath: e.target.value })}
            />
            <button type="button" className="btn btn-sm" onClick={() => void onPickNowPlaying()}>
              <IconFolder size={14} />
              Elegir archivo
            </button>
            <button
              type="button"
              className="ghost-btn"
              onClick={onWriteNowPlaying}
              title="Escribir ahora la canción que suena"
            >
              Escribir ahora
            </button>
          </span>
        </label>
        <Help>
          Junto al archivo de texto se escribe la portada de la canción:{" "}
          <code>{nowPlayingImagePath(s.nowPlayingPath) || "nowplaying.jpg"}</code> (misma carpeta,
          600x600). Si la canción no tiene portada, se genera una imagen con el título.
        </Help>
        <Help>
          Hay dos archivos: <code>nowplaying.txt</code> lleva siempre la música que está sonando, y
          el archivo de directo lleva el programa seleccionado cuando el modo LIVE está activado. Si
          LIVE está apagado, los dos muestran la misma canción.
        </Help>
        <label className="field">
          <span className="field-label">Contenido</span>
          <span className="field-unit np-path">
            <input
              type="text"
              value={s.nowPlayingTemplate}
              spellCheck={false}
              placeholder={DEFAULT_NOW_PLAYING_TEMPLATE}
              onChange={(e) => onChange({ ...s, nowPlayingTemplate: e.target.value })}
            />
          </span>
        </label>
        <label className="field">
          <span className="field-label">Archivo directo</span>
          <span className="field-unit np-path">
            <input
              type="text"
              value={s.liveFilePath}
              spellCheck={false}
              placeholder={liveFilePath(s.nowPlayingPath, "") || "live.txt"}
              onChange={(e) => onChange({ ...s, liveFilePath: e.target.value })}
            />
            <button type="button" className="btn btn-sm" onClick={() => void onPickLiveFile()}>
              <IconFolder size={14} />
              Elegir archivo
            </button>
          </span>
        </label>
        <p className="hint">
          Se escribirá en <code>{liveFilePath(s.nowPlayingPath, s.liveFilePath) || "live.txt"}</code>{" "}
          con su portada <code>{liveImagePath(liveFilePath(s.nowPlayingPath, s.liveFilePath)) || "live.jpg"}</code>.
        </p>
        <label className="field">
          <span className="field-label">Contenido directo</span>
          <span className="field-unit np-path">
            <input
              type="text"
              value={s.liveTemplate}
              spellCheck={false}
              placeholder={DEFAULT_NOW_PLAYING_TEMPLATE}
              onChange={(e) => onChange({ ...s, liveTemplate: e.target.value })}
            />
          </span>
        </label>
        <Help>
          Por defecto: <code>{DEFAULT_NOW_PLAYING_TEMPLATE}</code>. Puedes usar{" "}
          {NOW_PLAYING_PLACEHOLDERS.map((item, index) => (
            <span key={item.key}>
              {index > 0 && ", "}
              <code>{item.key}</code> ({item.label})
            </span>
          ))}
          .
        </Help>
      </fieldset>



      <fieldset className="fieldset">
        <legend>Carpeta de música</legend>
        <Help>
          Las canciones que importes se copian aquí, para que la biblioteca siempre tenga su
          propia copia. La canción es sus metadatos: si mueves el archivo, sigue viva y se puede
          reubicar.
        </Help>
        <div className="music-path-row">
          <span className="music-path" title={s.musicPath || "Carpeta interna de la app"}>
            {s.musicPath || "Carpeta interna de la app"}
          </span>
          <button type="button" className="btn btn-sm" onClick={() => void onPickMusicFolder()}>
            <IconFolder size={14} />
            Elegir carpeta
          </button>
          {s.musicPath !== "" && (
            <button
              type="button"
              className="ghost-btn"
              onClick={() => onChange({ ...s, musicPath: "" })}
            >
              Usar la interna
            </button>
          )}
        </div>
      </fieldset>
    </>
  );
}

function AutoDjTab({
  settings: s,
  blocks,
  onChange,
}: {
  settings: Settings;
  blocks: Block[];
  onChange: (s: Settings) => void;
}) {
  const intros = s.intros ?? DEFAULT_SETTINGS.intros;
  const setIntros = (patch: Partial<typeof intros>) => onChange({ ...s, intros: { ...intros, ...patch } });
  const langs = s.languages ?? [];
  const weights = s.languageWeights ?? {};
  const toggleLang = (code: string) => {
    const on = langs.includes(code);
    const next = on ? langs.filter((c) => c !== code) : [...langs, code];
    const w = { ...weights };
    if (on) delete w[code];
    onChange({ ...s, languages: next, languageWeights: w });
  };
  const setWeight = (code: string, v: number) =>
    onChange({ ...s, languageWeights: { ...weights, [code]: Math.max(0, Math.min(100, v)) } });
  const anyWeight = Object.values(weights).some((v) => v > 0);
  const sumW = langs.reduce((a, c) => a + (weights[c] ?? 0), 0);
  return (
    <>
      <fieldset className="fieldset">
        <legend>Intros</legend>
        <Help>
          Audios de una lista especial (presentaciones, identificadores…) que suenan encima del hueco entre el
          inicio de una canción y su punto de intro, sin pisar la voz. Solo se usan en canciones que tengan el
          intro marcado en Marcadores, y solo si el audio cabe en ese hueco.
        </Help>
        <label className="check-field">
          <input type="checkbox" checked={intros.enabled} onChange={(e) => setIntros({ enabled: e.target.checked })} />
          Poner intros sobre las canciones
        </label>
        {intros.enabled && (
          <>
            <label className="field">
              <span className="field-label">Lista de intros</span>
              <select value={intros.blockId} onChange={(e) => setIntros({ blockId: e.target.value })}>
                <option value="">— elige una lista —</option>
                {blocks.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span className="field-label">Dónde cae en el hueco</span>
              <select value={intros.align} onChange={(e) => setIntros({ align: e.target.value as "start" | "end" })}>
                <option value="start">Al principio (empieza con la canción)</option>
                <option value="end">Al final (termina justo cuando empieza la voz)</option>
              </select>
            </label>
            <label className="field">
              <span className="field-label">Canciones de espera entre intros</span>
              <input
                type="number"
                min={0}
                max={50}
                value={intros.gapSongs}
                onChange={(e) => setIntros({ gapSongs: Math.max(0, Math.min(50, Math.round(Number(e.target.value) || 0))) })}
              />
              <Help>
                Tras poner un intro, esas canciones suenan sin intro aunque lo tengan marcado; después se vuelve a
                intentar en la primera que lo tenga.
              </Help>
            </label>
            <label className="field">
              <span className="field-label">Volumen del intro: {intros.gainDb > 0 ? "+" : ""}{intros.gainDb} dB</span>
              <input
                type="range"
                min={-18}
                max={6}
                step={1}
                value={intros.gainDb}
                onChange={(e) => setIntros({ gainDb: Number(e.target.value) })}
              />
            </label>
            <Help>
              La lista de intros no entra en la rotación normal del AutoDJ. Los cambios valen para las canciones
              que aún no han empezado a sonar.
            </Help>
          </>
        )}
      </fieldset>

      <fieldset className="fieldset">
        <legend>Idiomas</legend>
        <Help>
          Idiomas que puedes asignar a cada canción (se ven con su bandera en los metadatos). Activa los que uses.
        </Help>
        <div className="edit-blocks">
          {LANGUAGE_CATALOG.map((l) => (
            <button
              key={l.code}
              type="button"
              className={`chip chip-toggle ${langs.includes(l.code) ? "chip-on" : ""}`}
              onClick={() => toggleLang(l.code)}
            >
              {l.flag} {l.name}
            </button>
          ))}
        </div>
        <h4 style={{ marginTop: 12 }}>Probabilidad en el AutoDJ</h4>
        <Help>
          Porcentaje de canciones de cada idioma que elige el AutoDJ. Con todos a 0 no filtra por idioma. Las
          canciones sin idioma solo entran si no hay porcentajes.
        </Help>
        {langs.map((c) => (
          <label key={c} className="field field-inline">
            <span className="field-label">
              {languageFlag(c)} {languageName(c)}
            </span>
            <input
              type="range"
              min={0}
              max={100}
              step={5}
              value={weights[c] ?? 0}
              onChange={(e) => setWeight(c, Number(e.target.value))}
            />
            <span className="hint" style={{ minWidth: 70 }}>
              {weights[c] ?? 0}%
              {anyWeight && sumW > 0 ? ` (${Math.round(((weights[c] ?? 0) / sumW) * 100)}% real)` : ""}
            </span>
          </label>
        ))}
      </fieldset>

      <fieldset className="fieldset">
        <legend>Reglas de rotación</legend>
        <Help>
          El AutoDJ respeta estas reglas cuando añade pistas a la lista. Si no hay
          ninguna que las cumpla, elige la que más tiempo lleve sin sonar.
        </Help>
        <MinField
          label="Sin repetir mismo tema"
          value={s.repeatTrackMinutes}
          onCommit={(v) => onChange({ ...s, repeatTrackMinutes: v })}
        />
        <MinField
          label="Sin repetir mismo título"
          value={s.repeatTitleMinutes}
          onCommit={(v) => onChange({ ...s, repeatTitleMinutes: v })}
        />
        <MinField
          label="Sin repetir mismo artista"
          value={s.repeatArtistMinutes}
          onCommit={(v) => onChange({ ...s, repeatArtistMinutes: v })}
        />
        <label className="check-field">
          <input
            type="checkbox"
            checked={s.avoidConsecutiveArtist}
            onChange={(e) => onChange({ ...s, avoidConsecutiveArtist: e.target.checked })}
          />
          No emparejar dos temas del mismo artista seguidos
        </label>
      </fieldset>

      <EnergyCurveField s={s} onChange={onChange} />

      <fieldset className="fieldset">
        <legend>AutoDJ</legend>
        <MinField
          label="Añadir pistas cuando queden menos de"
          value={s.autopilotMinUpcoming}
          onCommit={(v) => onChange({ ...s, autopilotMinUpcoming: v })}
        />
        <MinField
          label="Dejar la lista con al menos"
          value={s.autopilotFillTo}
          onCommit={(v) => onChange({ ...s, autopilotFillTo: v })}
        />
        <Help>
          Los listas de los que saca canciones se eligen en el navegador «Música», con
          el rayo de cada lista. Las campañas programadas se configuran en la pestaña Campañas.
        </Help>
      </fieldset>
    </>
  );
}

function CampaignsTab({
  settings: s,
  tracks,
  blocks,
  onChange,
  onImportAudio,
}: {
  settings: Settings;
  tracks: Track[];
  blocks: Block[];
  onChange: (s: Settings) => void;
  onImportAudio: () => Promise<Track[]>;
}) {
  const [draft, setDraft] = useState<Campaign | null>(null);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [importing, setImporting] = useState(false);

  const byId = useMemo(() => new Map(tracks.map((t) => [t.id, t])), [tracks]);

  const newCampaign = () => {
    setError("");
    setSearch("");
    setDraft({
      id: `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`,
      name: "",
      kind: "ads",
      enabled: true,
      days: [1, 2, 3, 4, 5, 6, 7],
      times: [],
      hourly: false,
      minute: 0,
      schedules: [newScheduleBlock("campaign")],
      meta: { ...EMPTY_STREAM_META },
      startAt: todayStartInput(),
      endAt: "",
      trackIds: [],
      cursor: 0,
      lastFired: "",
    });
  };

  const edit = (c: Campaign) => {
    setError("");
    setSearch("");
    setDraft({
      ...c,
      days: [...c.days],
      times: [...c.times],
      schedules: campaignSchedules(c).map((block) => ({
        ...block,
        days: [...block.days],
        times: [...block.times],
      })),
      meta: { ...EMPTY_STREAM_META, ...(c.meta ?? {}) },
      trackIds: [...c.trackIds],
    });
  };

  const save = () => {
    if (!draft) return;
    const name = draft.name.trim();
    if (!name) {
      setError("Ponle un nombre a la campaña.");
      return;
    }
    const schedules = campaignSchedules(draft).map((block) => ({
      ...block,
      days: [...block.days].sort(),
      times: [...block.times],
    }));
    if (schedules.some((block) => block.days.length === 0)) {
      setError("Cada franja debe tener al menos un día.");
      return;
    }
    if (schedules.some((block) => !block.hourly && block.times.length === 0)) {
      setError("Añade al menos una hora a cada franja o activa «cada hora».");
      return;
    }
    const start = campaignDate(draft.startAt);
    const end = campaignDate(draft.endAt);
    if (draft.startAt && start == null) {
      setError("La fecha de inicio no es válida.");
      return;
    }
    if (draft.endAt && end == null) {
      setError("La fecha de fin no es válida.");
      return;
    }
    if (start != null && end != null && end <= start) {
      setError("La fecha de fin debe ser posterior a la de inicio.");
      return;
    }
    if (draft.trackIds.length === 0) {
      setError("Añade al menos un anuncio o jingle.");
      return;
    }
    const first = schedules[0];
    const clean: Campaign = {
      ...draft,
      name,
      schedules,
      days: first.days,
      times: first.times,
      hourly: !!first.hourly,
      minute: first.minute ?? 0,
      meta: { ...EMPTY_STREAM_META, ...(draft.meta ?? {}) },
    };
    const exists = s.campaigns.some((c) => c.id === clean.id);
    const campaigns = exists
      ? s.campaigns.map((c) => (c.id === clean.id ? clean : c))
      : [...s.campaigns, clean];
    onChange({ ...s, campaigns });
    setDraft(null);
    setError("");
  };

  const remove = async (c: Campaign) => {
    if (!(await confirmAsk(`¿Eliminar la campaña «${c.name}»?`, "Eliminar"))) return;
    onChange({ ...s, campaigns: s.campaigns.filter((x) => x.id !== c.id) });
    if (draft?.id === c.id) setDraft(null);
  };

  const toggle = (c: Campaign) => {
    onChange({
      ...s,
      campaigns: s.campaigns.map((x) => (x.id === c.id ? { ...x, enabled: !x.enabled } : x)),
    });
  };

  if (draft) {
    return (
      <CampaignEditor
        draft={draft}
        setDraft={setDraft}
        error={error}
        search={search}
        setSearch={setSearch}
        byId={byId}
        blocks={blocks}
        onSave={save}
        onCancel={() => {
          setDraft(null);
          setError("");
        }}
        importing={importing}
        onImport={async () => {
          setImporting(true);
          try {
            const added = await onImportAudio();
            if (added.length > 0) {
              setDraft((prev) =>
                prev
                  ? {
                      ...prev,
                      trackIds: [
                        ...prev.trackIds,
                        ...added.map((t) => t.id).filter((id) => !prev.trackIds.includes(id)),
                      ],
                    }
                  : prev,
              );
            }
          } finally {
            setImporting(false);
          }
        }}
      />
    );
  }

  return (
    <>
      <div className="camp-head">
        <div>
          <h4>Campañas de anuncios y jingles</h4>
          <Help>
            Cada campaña se inserta en la lista del AutoDJ a las horas indicadas. El spot suena
            después del tema que esté sonando cuando llega la hora, sin cortarlo.
          </Help>
        </div>
        <button type="button" className="btn btn-accent btn-sm" onClick={newCampaign}>
          <IconPlus size={14} /> Nueva campaña
        </button>
      </div>

      {s.campaigns.length === 0 ? (
        <div className="camp-empty">
          Todavía no hay campañas. Crea una para programar anuncios o jingles.
        </div>
      ) : (
        <div className="camp-list">
          {s.campaigns.map((c) => {
            const spots = c.trackIds.map((id) => byId.get(id)).filter((t): t is Track => !!t);
            const total = spots.reduce((acc, t) => acc + effectiveDuration(t), 0);
            return (
              <div key={c.id} className={`camp-card ${c.enabled ? "" : "camp-off"}`}>
                <label className="camp-toggle" title="Activar o desactivar la campaña">
                  <input type="checkbox" checked={c.enabled} onChange={() => toggle(c)} />
                </label>
                <div className="camp-card-main">
                  <div className="camp-card-title">
                    <strong>{c.name}</strong>
                    <span className={`camp-kind camp-kind-${c.kind}`}>{KIND_LABEL[c.kind]}</span>
                  </div>
                  <div className="camp-card-meta">
                    <span>{scheduleText(c)}</span>
                    <span>{daysText(c)}</span>
                    <span>{campaignWindowText(c)}</span>
                    <span>
                      {spots.length} {spots.length === 1 ? "spot" : "spots"} · {fmtDur(total)}
                    </span>
                  </div>
                  {c.lastFired && (
                    <div className="camp-card-last">Última emisión: {c.lastFired}</div>
                  )}
                </div>
                <div className="camp-card-actions">
                  <button type="button" className="btn btn-sm" onClick={() => edit(c)}>
                    Editar
                  </button>
                  <button
                    type="button"
                    className="ghost-btn camp-del"
                    onClick={() => remove(c)}
                    title="Eliminar campaña"
                  >
                    <IconTrash size={14} />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}

function CampaignEditor({
  draft,
  setDraft,
  error,
  search,
  setSearch,
  byId,
  blocks,
  onSave,
  onCancel,
  importing,
  onImport,
}: {
  draft: Campaign;
  setDraft: (c: Campaign | null) => void;
  error: string;
  search: string;
  setSearch: (v: string) => void;
  byId: Map<string, Track>;
  blocks: Block[];
  onSave: () => void;
  onCancel: () => void;
  importing: boolean;
  onImport: () => Promise<void>;
}) {
  const q = search.trim().toLowerCase();
  const [spotBlock, setSpotBlock] = useState("");
  const options = useMemo(
    () =>
      Array.from(byId.values())
        .filter((t) => !draft.trackIds.includes(t.id))
        .filter((t) => !spotBlock || t.blocks.includes(spotBlock))
        .filter(
          (t) =>
            !q ||
            [t.title, t.artist, t.album].join(" ").toLowerCase().includes(q),
        )
        .slice(0, 80),
    [byId, draft.trackIds, q, spotBlock],
  );

  const set = (patch: Partial<Campaign>) => setDraft({ ...draft, ...patch });

  const moveSpot = (index: number, dir: -1 | 1) => {
    const to = index + dir;
    if (to < 0 || to >= draft.trackIds.length) return;
    const ids = [...draft.trackIds];
    const [x] = ids.splice(index, 1);
    ids.splice(to, 0, x);
    set({ trackIds: ids });
  };

  return (
    <div className="camp-editor">
      <div className="camp-editor-head">
        <button type="button" className="ghost-btn" onClick={onCancel}>
          ← Volver
        </button>
        <h4>{draft.name ? "Editar campaña" : "Nueva campaña"}</h4>
      </div>

      <fieldset className="fieldset">
        <legend>Datos</legend>
        <div className="field-row">
          <label className="field">
            <span className="field-label">Nombre</span>
            <input
              type="text"
              value={draft.name}
              maxLength={70}
              placeholder="Ej.: Anuncios mañana"
              onChange={(e) => set({ name: e.target.value })}
            />
          </label>
          <label className="field camp-kind-field">
            <span className="field-label">Tipo</span>
            <select
              value={draft.kind}
              onChange={(e) => set({ kind: e.target.value as CampaignKind })}
            >
              <option value="ads">Anuncio</option>
              <option value="jingle">Jingle</option>
            </select>
          </label>
        </div>
        <label className="check-field">
          <input
            type="checkbox"
            checked={draft.enabled}
            onChange={(e) => set({ enabled: e.target.checked })}
          />
          Campaña activa
        </label>
      </fieldset>

      <fieldset className="fieldset">
        <legend>Programación</legend>
        <ScheduleEditor
          blocks={campaignSchedules(draft)}
          onChange={(schedules) => set({ schedules })}
          mode="campaign"
        />

        <div className="camp-dates">
          <label className="field">
            <span className="field-label">Inicio</span>
            <input
              type="datetime-local"
              value={draft.startAt}
              onChange={(e) => set({ startAt: e.target.value })}
            />
          </label>
          <label className="field">
            <span className="field-label">Fin</span>
            <input
              type="datetime-local"
              value={draft.endAt}
              min={draft.startAt || undefined}
              disabled={!draft.endAt}
              onChange={(e) => set({ endAt: e.target.value })}
            />
          </label>
        </div>
        <label className="check-field">
          <input
            type="checkbox"
            checked={!draft.endAt}
            onChange={(e) =>
              set({ endAt: e.target.checked ? "" : defaultEndAt(draft.startAt) })
            }
          />
          Sin fecha de fin (continuidad permanente)
        </label>

        <Help>
          La campaña solo emite entre las fechas indicadas. Si la app está cerrada a esa hora no se
          emite; al abrirla solo se recupera la emisión si han pasado menos de 15 minutos.
        </Help>
      </fieldset>

      <MetaFields
        meta={{ ...EMPTY_STREAM_META, ...(draft.meta ?? {}) }}
        onChange={(meta) => set({ meta })}
        legend="Metadatos al emitirse"
      />

      <fieldset className="fieldset">
        <legend>Spots de la campaña</legend>
        <div className="camp-spots">
          {draft.trackIds.length === 0 && (
            <span className="hint">Añade anuncios o jingles desde la lista de abajo.</span>
          )}
          {draft.trackIds.map((id, i) => {
            const t = byId.get(id);
            return (
              <div key={id} className="camp-spot">
                <span className="camp-spot-n">{i + 1}</span>
                <span className="camp-spot-title">
                  {t ? t.title : "Pista no disponible"}
                  <em>{t ? t.artist : ""}</em>
                </span>
                <span className="camp-spot-dur">{t ? fmtDur(effectiveDuration(t)) : "—"}</span>
                <button
                  type="button"
                  className="ghost-btn"
                  disabled={i === 0}
                  onClick={() => moveSpot(i, -1)}
                  title="Subir"
                >
                  ↑
                </button>
                <button
                  type="button"
                  className="ghost-btn"
                  disabled={i === draft.trackIds.length - 1}
                  onClick={() => moveSpot(i, 1)}
                  title="Bajar"
                >
                  ↓
                </button>
                <button
                  type="button"
                  className="ghost-btn camp-del"
                  onClick={() => set({ trackIds: draft.trackIds.filter((x) => x !== id) })}
                  title="Quitar"
                >
                  <IconTrash size={13} />
                </button>
              </div>
            );
          })}
        </div>

        <div className="camp-add-head">
          <select
            value={spotBlock}
            onChange={(e) => setSpotBlock(e.target.value)}
            title="Filtrar los spots por lista"
            aria-label="Lista"
          >
            <option value="">Toda la biblioteca</option>
            {blocks.map((block) => (
              <option key={block.id} value={block.id}>
                {block.name}
              </option>
            ))}
          </select>
          <input
            className="nsearch"
            type="search"
            placeholder="Buscar en la biblioteca…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <button
            type="button"
            className="btn btn-sm"
            disabled={importing}
            onClick={() => void onImport()}
          >
            {importing ? "Importando…" : "Importar audio"}
          </button>
        </div>
        <div className="camp-options">
          {options.map((t) => (
            <button
              key={t.id}
              type="button"
              className="camp-option"
              onClick={() => set({ trackIds: [...draft.trackIds, t.id] })}
            >
              <span className="camp-option-title">{t.title}</span>
              <span className="camp-option-artist">{t.artist}</span>
              <span className="camp-option-plus">+</span>
            </button>
          ))}
          {options.length === 0 && (
            <span className="hint">No hay más canciones que coincidan.</span>
          )}
        </div>
      </fieldset>

      {error && <div className="form-error">{error}</div>}

      <div className="edit-actions">
        <button type="button" className="ghost-btn" onClick={onCancel}>
          Cancelar
        </button>
        <span className="spacer" />
        <button type="button" className="btn btn-accent btn-sm" onClick={onSave}>
          Guardar campaña
        </button>
      </div>
    </div>
  );
}

/** Margen de las tarjetas de sonido contra cortes (Ajustes › Sonido). */
function AudioBufferField({ settings: s, onChange }: { settings: Settings; onChange: (s: Settings) => void }) {
  return (
    <fieldset className="fieldset">
      <legend>Tarjetas de sonido</legend>
      <label className="field">
        <span className="field-label">Margen contra cortes</span>
        <select
          value={String(s.audioBufferMs ?? 40)}
          onChange={(e) => onChange({ ...s, audioBufferMs: Number(e.target.value) })}
        >
          <option value="0">Mínimo (10 ms, el de Windows)</option>
          <option value="20">20 ms</option>
          <option value="40">40 ms (recomendado)</option>
          <option value="80">80 ms (equipo muy cargado)</option>
          <option value="150">150 ms (máximo)</option>
        </select>
        <Help>
          Sonido que la tarjeta tiene guardado por adelantado. Si el audio se entrecorta cuando el equipo va
          cargado (vídeo, NDI, plugins), sube el margen. A cambio, lo que pasa por la consola sale un poco más tarde.
          Se aplica al reiniciar OmniCaster.
        </Help>
      </label>
    </fieldset>
  );
}


const ENERGY_SHORT = ["", "Muy tranquila", "Suave", "Media", "Animada", "Muy enérgica"];

/**
 * Rango de energía de una franja: cinco niveles; se pulsa uno y luego otro
 * (o se arrastra de uno a otro) para elegir desde dónde hasta dónde.
 */
function EnergyRangePicker({ lo, hi, onChange }: { lo: number; hi: number; onChange: (lo: number, hi: number) => void }) {
  const anchor = useRef<number | null>(null);
  const set = (a: number, b: number) => onChange(Math.min(a, b), Math.max(a, b));
  useEffect(() => {
    const up = () => (anchor.current = null);
    window.addEventListener("pointerup", up);
    return () => window.removeEventListener("pointerup", up);
  }, []);
  return (
    <span className="erange" title="Pulsa un nivel y luego otro (o arrastra) para elegir el rango">
      {[1, 2, 3, 4, 5].map((n) => (
        <button
          key={n}
          type="button"
          className={`erange-lvl ${n >= lo && n <= hi ? "erange-on" : ""}`}
          onPointerDown={(e) => {
            e.preventDefault();
            if (lo === hi && n !== lo) {
              // Ya había uno solo: se amplía hasta este
              set(lo, n);
              anchor.current = lo;
            } else {
              set(n, n);
              anchor.current = n;
            }
          }}
          onPointerEnter={() => {
            if (anchor.current != null) set(anchor.current, n);
          }}
          aria-pressed={n >= lo && n <= hi}
          aria-label={`Energía ${n}: ${ENERGY_SHORT[n]}`}
        >
          {n}
        </button>
      ))}
      <span className="erange-txt">{lo === hi ? ENERGY_SHORT[lo] : `${ENERGY_SHORT[lo]} → ${ENERGY_SHORT[hi]}`}</span>
    </span>
  );
}

/** Curva de energía del día (AutoDJ): franjas con su energía. */
function EnergyCurveField({ s, onChange }: { s: Settings; onChange: (s: Settings) => void }) {
  const curve = s.energyCurve ?? DEFAULT_ENERGY_CURVE;
  const set = (c: Partial<typeof curve>) => onChange({ ...s, energyCurve: { ...curve, ...c } });
  const setPoint = (i: number, p: Partial<(typeof curve.points)[number]>) =>
    set({ points: curve.points.map((x, k) => (k === i ? { ...x, ...p } : x)) });
  const sorted = [...curve.points].map((p, i) => ({ p, i })).sort((a, b) => a.p.start.localeCompare(b.p.start));
  return (
    <fieldset className="fieldset">
      <legend>Energía del día</legend>
      <label className="check-field">
        <input type="checkbox" checked={curve.enabled} onChange={(e) => set({ enabled: e.target.checked })} />
        El AutoDJ sigue una curva de energía según la hora
      </label>
      <Help>
        Cada franja va desde su hora hasta la siguiente (la última sigue de madrugada). Usa la
        energía de la metadatos IA de cada canción (Ajustes › IA › Metadatos IA de la biblioteca). Dentro del
        rango de la franja todas valen igual y se reparten al azar; las de fuera solo suenan si no
        queda ninguna dentro. Las que aún no tienen metadatos IA van detrás de las del rango.
      </Help>
      {curve.enabled && (
        <>
          <label className="check-field">
            <input type="checkbox" checked={curve.smooth} onChange={(e) => set({ smooth: e.target.checked })} />
            Transiciones de energía suaves
            <Help>
              No salta más de un nivel de energía entre una canción y la siguiente. Con un rango (por ejemplo, de 3 a
              5) va de uno en uno como una ola: se queda unas canciones en un nivel, sube o baja uno y rebota en los
              bordes.
            </Help>
          </label>
          <div className="energy-curve">
            {sorted.map(({ p, i }) => (
              <div key={i} className="energy-row">
                <input className="input" type="time" value={p.start} onChange={(e) => setPoint(i, { start: e.target.value })} />
                <input className="input" placeholder="Nombre" value={p.label} onChange={(e) => setPoint(i, { label: e.target.value })} />
                <EnergyRangePicker
                  lo={p.energy}
                  hi={p.energyMax || p.energy}
                  onChange={(lo, hi) => setPoint(i, { energy: lo, energyMax: hi })}
                />
                <button type="button" className="btn btn-sm" onClick={() => set({ points: curve.points.filter((_, k) => k !== i) })} title="Quitar franja">
                  ✕
                </button>
              </div>
            ))}
          </div>
          <p>
            <button type="button" className="btn btn-sm" onClick={() => set({ points: [...curve.points, { start: "12:00", energy: 3, energyMax: 3, label: "" }] })}>
              Añadir franja
            </button>{" "}
            <button type="button" className="btn btn-sm" onClick={() => set({ points: DEFAULT_ENERGY_CURVE.points })}>
              Volver a la propuesta
            </button>
          </p>
        </>
      )}
    </fieldset>
  );
}
