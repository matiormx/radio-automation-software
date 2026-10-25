import { ApiTab } from "./ApiTab";
import { NotificationsTab } from "./NotificationsTab";
import { BackupTab } from "./BackupTab";
import { useMemo, useState } from "react";
import type {
  Block,
  Campaign,
  CampaignKind,
  Settings,
  StationEvent,
  StreamStatus,
  Track,
} from "../types";
import { DEFAULT_SETTINGS, effectiveDuration } from "../types";
import { trackUrl } from "../api";
import { LANGUAGE_CATALOG, languageFlag, languageName } from "../languages";
import { IconFolder, IconPlus, IconTrash, LogoRadio } from "../icons";
import { MixerEmbedded } from "../MixerWindow";
import { AiTab } from "./AiTab";
import { EventsTab } from "./EventsTab";
import { VideoTab } from "./VideoTab";
import { StreamingTab } from "./StreamingTab";
import { StudioCallsTab } from "./StudioCallsTab";
import type { StudioSnapshot } from "../studioCalls";
import { UpdateSection } from "./UpdateSection";
import { ProgramsTab } from "./ProgramsTab";
import {
  DEFAULT_NOW_PLAYING_TEMPLATE,
  NOW_PLAYING_PLACEHOLDERS,
  liveFilePath,
  liveImagePath,
  nowPlayingImagePath,
} from "../nowplaying";

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
  /** La emisión está en marcha; las salidas de vídeo se compactan. */
  streaming?: boolean;
  /** Estado real de cada salida para los testigos de Streaming. */
  streamStatus?: StreamStatus | null;
  streamBusy?: boolean;
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
  if (c.hourly) return `Cada hora a las :${String(c.minute).padStart(2, "0")}`;
  if (c.times.length === 0) return "Sin horas";
  return c.times.join(" · ");
}

function daysText(c: Campaign): string {
  if (c.days.length === 7) return "Todos los días";
  return DAYS.filter((d) => c.days.includes(d.value))
    .map((d) => d.label)
    .join(" ");
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

export type SettingsTab =
  | "general"
  | "autodj"
  | "campaigns"
  | "events"
  | "programs"
  | "sound"
  | "ai"
  | "video"
  | "streaming"
  | "calls"
  | "api"
  | "notify"
  | "backup";

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
  streaming = false,
  streamStatus = null,
  streamBusy = false,
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
            <button
              type="button"
              className={`settings-nav-btn ${tab === "general" ? "settings-nav-on" : ""}`}
              onClick={() => onTabChange("general")}
              title="Identidad (nombre, eslogan y logo) y carpeta"
            >
              General
              <span>Identidad (nombre, eslogan y logo) y carpeta</span>
            </button>
            <button
              type="button"
              className={`settings-nav-btn ${tab === "sound" ? "settings-nav-on" : ""}`}
              onClick={() => onTabChange("sound")}
              title="Mesa de mezclas y salidas"
            >
              Sonido
              <span>Mesa de mezclas y salidas</span>
            </button>
            <button
              type="button"
              className={`settings-nav-btn ${tab === "ai" ? "settings-nav-on" : ""}`}
              onClick={() => onTabChange("ai")}
              title="Metadatos con Ollama local"
            >
              IA
              <span>Metadatos con Ollama local</span>
            </button>
            <button
              type="button"
              className={`settings-nav-btn ${tab === "video" ? "settings-nav-on" : ""}`}
              onClick={() => onTabChange("video")}
              title="Entradas, salidas y mezcla"
            >
              Vídeo
              <span>Entradas, salidas y mezcla</span>
            </button>
            <button
              type="button"
              className={`settings-nav-btn ${tab === "autodj" ? "settings-nav-on" : ""}`}
              onClick={() => onTabChange("autodj")}
              title="Rotación y cola automática"
            >
              AutoDJ
              <span>Rotación y cola automática</span>
            </button>
            <button
              type="button"
              className={`settings-nav-btn ${tab === "campaigns" ? "settings-nav-on" : ""}`}
              onClick={() => onTabChange("campaigns")}
              title="Anuncios y jingles"
            >
              Campañas
              <span>Anuncios y jingles</span>
            </button>
            <button
              type="button"
              className={`settings-nav-btn ${tab === "events" ? "settings-nav-on" : ""}`}
              onClick={() => onTabChange("events")}
              title="Franjas y sonidos programados"
            >
              Eventos
              <span>Franjas y sonidos programados</span>
            </button>
            <button
              type="button"
              className={`settings-nav-btn ${tab === "programs" ? "settings-nav-on" : ""}`}
              onClick={() => onTabChange("programs")}
              title="Títulos y portadas en directo"
            >
              Programas
              <span>Títulos y portadas en directo</span>
            </button>
            <button
              type="button"
              className={`settings-nav-btn ${tab === "streaming" ? "settings-nav-on" : ""}`}
              onClick={() => onTabChange("streaming")}
              title="Icecast, FLAC, AAC y RTMP"
            >
              Streaming
              <span>Icecast, FLAC, AAC y RTMP</span>
            </button>
            <button
              type="button"
              className={`settings-nav-btn ${tab === "calls" ? "settings-nav-on" : ""}`}
              onClick={() => onTabChange("calls")}
              title="Oyentes al aire desde NGRADIO"
            >
              Llamadas
              <span>Oyentes al aire desde NGRADIO</span>
            </button>
            <button
              type="button"
              className={`settings-nav-btn ${tab === "api" ? "settings-nav-on" : ""}`}
              onClick={() => onTabChange("api")}
              title="Datos para ngradio.es (como RadioBOSS)"
            >
              API
              <span>Datos para ngradio.es (como RadioBOSS)</span>
            </button>
            <button
              type="button"
              className={`settings-nav-btn ${tab === "notify" ? "settings-nav-on" : ""}`}
              onClick={() => onTabChange("notify")}
              title="Avisos GET/POST por eventos"
            >
              Notificaciones
              <span>Avisos GET/POST por eventos</span>
            </button>
            <button
              type="button"
              className={`settings-nav-btn ${tab === "backup" ? "settings-nav-on" : ""}`}
              onClick={() => onTabChange("backup")}
              title="Copias de seguridad y versiones nuevas"
            >
              Copia y actualizaciones
              <span>Copias de seguridad y versiones nuevas</span>
            </button>
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
            {tab === "sound" && <MixerEmbedded settings={s} onChange={onChange} />}
            {tab === "ai" && <AiTab settings={s} onChange={onChange} showToast={showToast} />}
            {tab === "video" && <VideoTab settings={s} onChange={onChange} streaming={streaming} />}
            {tab === "autodj" && <AutoDjTab settings={s} blocks={blocks} onChange={onChange} />}
            {tab === "campaigns" && (
              <CampaignsTab
                settings={s}
                tracks={tracks}
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
              <ProgramsTab settings={s} onChange={onChange} showToast={showToast} />
            )}
            {tab === "streaming" && (
              <StreamingTab
                settings={s}
                onChange={onChange}
                streamStatus={streamStatus}
                streamBusy={streamBusy}
              />
            )}
            {tab === "backup" && (
              <>
                <UpdateSection showToast={showToast} />
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
        <p className="hint">
          Estos datos sustituyen la marca por defecto de la esquina superior izquierda.
        </p>
        <div className="field-row">
          <label className="field">
            <span className="field-label">Nombre de la radio</span>
            <input
              type="text"
              value={s.radioName}
              maxLength={60}
              placeholder="MiRadio"
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
            <p className="hint">
              PNG, JPG, WebP o GIF. Se copia a los datos de la app; el original no se toca.
              Recomendado: cuadrado o horizontal con fondo transparente.
            </p>
          </div>
        </div>
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
          <span className="hint">
            Las que ya sonaron se ven en gris por encima de la actual; las más antiguas se ocultan.
          </span>
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
            <span className="hint">
              Por debajo de este nivel se considera silencio (3 s seguidos). Súbelo si salta
              con pasajes suaves; bájalo si no detecta silencios con ruido de fondo.
            </span>
          </label>
        )}
        <label className="field">
          <span className="field-label">Bloque musical por defecto del AutoDJ</span>
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
        <p className="hint">
          Si eliges un bloque, el AutoDJ saca las próximas canciones de ahí. En «Automático»
          usa los bloques marcados con el rayo en Música; si no hay ninguno, toda la biblioteca.
          Un evento activo tiene prioridad sobre esta selección.
        </p>
      </fieldset>

      <fieldset className="fieldset">
        <legend>Archivo nowplaying</legend>
        <p className="hint">
          Escribe un archivo de texto con la canción que está sonando, para que otros programas
          o pantallas lo lean. Se actualiza en cada cambio de canción.
        </p>
        <label className="field">
          <span className="field-label">Archivo</span>
          <span className="field-unit np-path">
            <input
              type="text"
              value={s.nowPlayingPath}
              spellCheck={false}
              placeholder="C:\\MiRadio\\nowplaying.txt"
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
        <p className="hint">
          Junto al archivo de texto se escribe la portada de la canción:{" "}
          <code>{nowPlayingImagePath(s.nowPlayingPath) || "nowplaying.jpg"}</code> (misma carpeta,
          600x600). Si la canción no tiene portada, se genera una imagen con el título.
        </p>
        <p className="hint">
          Hay dos archivos: <code>nowplaying.txt</code> lleva siempre la música que está sonando, y
          el archivo de directo lleva el programa seleccionado cuando el modo LIVE está activado. Si
          LIVE está apagado, los dos muestran la misma canción.
        </p>
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
        <p className="hint">
          Por defecto: <code>{DEFAULT_NOW_PLAYING_TEMPLATE}</code>. Puedes usar{" "}
          {NOW_PLAYING_PLACEHOLDERS.map((item, index) => (
            <span key={item.key}>
              {index > 0 && ", "}
              <code>{item.key}</code> ({item.label})
            </span>
          ))}
          .
        </p>
      </fieldset>



      <fieldset className="fieldset">
        <legend>Carpeta de música</legend>
        <p className="hint">
          Las canciones que importes se copian aquí, para que la biblioteca siempre tenga su
          propia copia. La canción es sus metadatos: si mueves el archivo, sigue viva y se puede
          relinkar.
        </p>
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
        <p className="hint">
          Audios de un bloque especial (presentaciones, identificadores…) que suenan encima del hueco entre el
          inicio de una canción y su punto de intro, sin pisar la voz. Solo se usan en canciones que tengan el
          intro marcado en el editor de cortes, y solo si el audio cabe en ese hueco.
        </p>
        <label className="check-field">
          <input type="checkbox" checked={intros.enabled} onChange={(e) => setIntros({ enabled: e.target.checked })} />
          Poner intros sobre las canciones
        </label>
        {intros.enabled && (
          <>
            <label className="field">
              <span className="field-label">Bloque de intros</span>
              <select value={intros.blockId} onChange={(e) => setIntros({ blockId: e.target.value })}>
                <option value="">— elige un bloque —</option>
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
              <span className="hint">
                Tras poner un intro, esas canciones suenan sin intro aunque lo tengan marcado; después se vuelve a
                intentar en la primera que lo tenga.
              </span>
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
            <p className="hint">
              El bloque de intros no entra en la rotación normal del AutoDJ. Los cambios valen para las canciones
              que aún no han empezado a sonar.
            </p>
          </>
        )}
      </fieldset>

      <fieldset className="fieldset">
        <legend>Idiomas</legend>
        <p className="hint">
          Idiomas que puedes asignar a cada canción (se ven con su bandera en los metadatos). Activa los que uses.
        </p>
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
        <p className="hint">
          Porcentaje de canciones de cada idioma que elige el AutoDJ. Con todos a 0 no filtra por idioma. Las
          canciones sin idioma solo entran si no hay porcentajes.
        </p>
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
        <p className="hint">
          El piloto automático respeta estas reglas cuando añade pistas a la lista. Si no hay
          ninguna que las cumpla, elige la que más tiempo lleve sin sonar.
        </p>
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

      <fieldset className="fieldset">
        <legend>Piloto automático</legend>
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
        <p className="hint">
          Los bloques musicales de los que saca canciones se eligen en el navegador «Música», con
          el rayo de cada bloque. Las campañas programadas se configuran en la pestaña Campañas.
        </p>
      </fieldset>
    </>
  );
}

function CampaignsTab({
  settings: s,
  tracks,
  onChange,
  onImportAudio,
}: {
  settings: Settings;
  tracks: Track[];
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
    setDraft({ ...c, days: [...c.days], times: [...c.times], trackIds: [...c.trackIds] });
  };

  const save = () => {
    if (!draft) return;
    const name = draft.name.trim();
    if (!name) {
      setError("Ponle un nombre a la campaña.");
      return;
    }
    if (!draft.hourly && draft.times.length === 0) {
      setError("Añade al menos una hora o activa «cada hora».");
      return;
    }
    if (draft.days.length === 0) {
      setError("Selecciona al menos un día.");
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
    const clean: Campaign = { ...draft, name };
    const exists = s.campaigns.some((c) => c.id === clean.id);
    const campaigns = exists
      ? s.campaigns.map((c) => (c.id === clean.id ? clean : c))
      : [...s.campaigns, clean];
    onChange({ ...s, campaigns });
    setDraft(null);
    setError("");
  };

  const remove = (c: Campaign) => {
    if (!window.confirm(`¿Eliminar la campaña «${c.name}»?`)) return;
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
          <p className="hint">
            Cada campaña se inserta en la lista del AutoDJ a las horas indicadas. El spot suena
            después del tema que esté sonando cuando llega la hora, sin cortarlo.
          </p>
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
  onSave: () => void;
  onCancel: () => void;
  importing: boolean;
  onImport: () => Promise<void>;
}) {
  const q = search.trim().toLowerCase();
  const options = useMemo(
    () =>
      Array.from(byId.values())
        .filter((t) => !draft.trackIds.includes(t.id))
        .filter(
          (t) =>
            !q ||
            [t.title, t.artist, t.album].join(" ").toLowerCase().includes(q),
        )
        .slice(0, 80),
    [byId, draft.trackIds, q],
  );

  const set = (patch: Partial<Campaign>) => setDraft({ ...draft, ...patch });
  const [slotMinute, setSlotMinute] = useState(0);
  const minuteSafe = Math.max(0, Math.min(59, Math.floor(slotMinute) || 0));

  const toggleHour = (hour: number) => {
    const value = `${pad2(hour)}:${pad2(minuteSafe)}`;
    set({
      times: draft.times.includes(value)
        ? draft.times.filter((x) => x !== value)
        : [...draft.times, value].sort(),
    });
  };

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
        <div className="camp-days">
          {DAYS.map((d) => (
            <button
              key={d.value}
              type="button"
              className={`camp-day ${draft.days.includes(d.value) ? "camp-day-on" : ""}`}
              title={d.long}
              onClick={() =>
                set({
                  days: draft.days.includes(d.value)
                    ? draft.days.filter((x) => x !== d.value)
                    : [...draft.days, d.value].sort(),
                })
              }
            >
              {d.label}
            </button>
          ))}
        </div>

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

        <label className="check-field">
          <input
            type="checkbox"
            checked={draft.hourly}
            onChange={(e) => set({ hourly: e.target.checked })}
          />
          Emitir cada hora al minuto
          <input
            className="camp-minute"
            type="number"
            min={0}
            max={59}
            value={draft.minute}
            disabled={!draft.hourly}
            onChange={(e) =>
              set({ minute: Math.max(0, Math.min(59, Number(e.target.value) || 0)) })
            }
          />
        </label>

        {!draft.hourly && (
          <div className="camp-hour-picker">
            <div className="camp-hour-head">
              <span className="field-label">Seleccionar horas</span>
              <label className="camp-slot-minute">
                <span>Minuto</span>
                <input
                  type="number"
                  min={0}
                  max={59}
                  value={slotMinute}
                  onChange={(e) =>
                    setSlotMinute(Math.max(0, Math.min(59, Number(e.target.value) || 0)))
                  }
                />
              </label>
            </div>
            <div className="camp-hours">
              {Array.from({ length: 24 }, (_, hour) => hour).map((hour) => {
                const value = `${pad2(hour)}:${pad2(minuteSafe)}`;
                const on = draft.times.includes(value);
                return (
                  <button
                    key={hour}
                    type="button"
                    className={`camp-hour ${on ? "camp-hour-on" : ""}`}
                    title={on ? `Quitar ${value}` : `Añadir ${value}`}
                    onClick={() => toggleHour(hour)}
                  >
                    {pad2(hour)}
                  </button>
                );
              })}
            </div>
            <div className="camp-times">
              {draft.times.length === 0 && <span className="hint">Sin horas todavía.</span>}
              {draft.times.map((t) => (
                <span key={t} className="camp-time-chip">
                  {t}
                  <button
                    type="button"
                    onClick={() => set({ times: draft.times.filter((x) => x !== t) })}
                    title="Quitar hora"
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
            <p className="hint">
              Haz clic en una hora para añadirla con el minuto elegido. Vuelve a pulsarla para
              quitarla.
            </p>
          </div>
        )}
        <p className="hint">
          La campaña solo emite entre las fechas indicadas. Si la app está cerrada a esa hora no se
          emite; al abrirla solo se recupera la emisión si han pasado menos de 15 minutos.
        </p>
      </fieldset>

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
