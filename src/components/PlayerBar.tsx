import { IconPlay, IconPause, IconNext, IconPrev, IconBolt, IconSliders, IconX } from "../icons";
import type { Block } from "../types";

interface PlayerBarProps {
  paused: boolean;
  autopilot: boolean;
  fadeSeconds: number;
  hasPlaylist: boolean;
  blocks: Block[];
  defaultBlockId: string;
  autoEventLabel: string | null;
  onTogglePlay: () => void;
  onNext: () => void;
  onPrev: () => void;
  onAutopilot: (on: boolean) => void;
  onDefaultBlockChange: (id: string) => void;
  onFadeChange: (secs: number) => void;
  preview: {
    title: string;
    artist: string;
    cover: string;
    playing: boolean;
    pos: number;
    from: number;
    to: number;
  } | null;
  onPreviewToggle: () => void;
  onPreviewStop: () => void;
  /** Salta a una posicion (0..1) de la preescucha */
  onPreviewSeek: (fraction: number) => void;
  /** Escuchar sola la canción al hacer clic en la biblioteca */
  autoPreview: boolean;
  onAutoPreview: (on: boolean) => void;
  onOpenMixer: () => void;
}

const FADE_OPTIONS = [3, 6, 10];

export function PlayerBar({
  paused,
  autopilot,
  fadeSeconds,
  hasPlaylist,
  blocks,
  defaultBlockId,
  autoEventLabel,
  onTogglePlay,
  onNext,
  onPrev,
  onAutopilot,
  onDefaultBlockChange,
  onFadeChange,
  preview,
  onPreviewToggle,
  onPreviewStop,
  onPreviewSeek,
  autoPreview,
  onAutoPreview,
  onOpenMixer,
}: PlayerBarProps) {
  return (
    <footer className="playerbar" aria-label="Controles de emisión">
      <div className="pb-group">
        <button type="button" className="round-btn" onClick={onPrev} aria-label="Pista anterior" title="Pista anterior">
          <IconPrev size={18} />
        </button>
        <button
          type="button"
          className={`big-play ${paused ? "state-play" : "state-pause"}`}
          onClick={onTogglePlay}
          disabled={!hasPlaylist && paused}
          aria-label={paused ? "Emitir" : "Pausa"}
          title={paused ? "Emitir" : "Pausa"}
        >
          {paused ? <IconPlay size={30} /> : <IconPause size={30} />}
        </button>
        <button type="button" className="round-btn" onClick={onNext} aria-label="Pista siguiente" title="Pista siguiente">
          <IconNext size={18} />
        </button>
      </div>

      <div className="pb-divider" />

      <label className={`pb-switch ${autopilot ? "switch-on" : ""}`} title="Rellena la lista solo, respetando las reglas de rotación">
        <IconBolt size={15} />
        <span className="pb-switch-label">PILOTO AUTOMÁTICO</span>
        <span className="switch-track"><span className="switch-knob" /></span>
        <input
          type="checkbox"
          checked={autopilot}
          onChange={(e) => onAutopilot(e.target.checked)}
          className="sr-only"
        />
      </label>

      <div className="pb-divider" />

      <div className="pb-group-seg pb-block">
        <span className="pb-label">LISTA AUTO</span>
        <select
          className="pb-select"
          value={defaultBlockId}
          onChange={(e) => onDefaultBlockChange(e.target.value)}
          aria-label="Lista que usa el AutoDJ"
          title={
            autoEventLabel
              ? `Ahora manda el evento: ${autoEventLabel}`
              : "Lista de la que el AutoDJ saca las próximas canciones"
          }
        >
          <option value="">Automático</option>
          {blocks.map((block) => (
            <option key={block.id} value={block.id}>
              {block.name}
            </option>
          ))}
        </select>
        {autoEventLabel && (
          <span className="pb-block-event" title="Evento activo: tiene prioridad sobre la lista">
            Evento: {autoEventLabel}
          </span>
        )}
      </div>

      <div className="pb-divider" />

      <div className="pb-group-seg" role="group" aria-label="Duración de la transición entre pistas">
        <span className="pb-label">TRANSICIÓN</span>
        <div className="seg">
          {FADE_OPTIONS.map((s) => (
            <button
              key={s}
              type="button"
              className={`seg-btn ${fadeSeconds === s ? "seg-on" : ""}`}
              onClick={() => onFadeChange(s)}
              aria-pressed={fadeSeconds === s}
            >
              {s}s
            </button>
          ))}
        </div>
      </div>

      <div className="pb-divider" />

      <div className="pb-group-seg pb-preview">
        {preview ? (
          <>
            <button
              type="button"
              className="pb-preview-play"
              onClick={onPreviewToggle}
              title={preview.playing ? "Pausar preescucha" : "Reanudar preescucha"}
              aria-label={preview.playing ? "Pausar preescucha" : "Reanudar preescucha"}
            >
              {preview.playing ? <IconPause size={14} /> : <IconPlay size={14} />}
            </button>
            {preview.cover && <img className="pb-preview-cover" src={preview.cover} alt="" />}
            <div className="pb-preview-info">
              <span className="pb-preview-title" title={preview.title}>{preview.title}</span>
              <span className="pb-preview-artist" title={preview.artist}>{preview.artist}</span>
              <span
                className="pb-preview-bar"
                role="slider"
                aria-label="Posición de la preescucha"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(((preview.pos - preview.from) / Math.max(0.05, preview.to - preview.from)) * 100)}
                onClick={(e) => {
                  const r = e.currentTarget.getBoundingClientRect();
                  onPreviewSeek(Math.max(0, Math.min(1, (e.clientX - r.left) / Math.max(1, r.width))));
                }}
              >
                <span
                  style={{
                    width: `${Math.max(
                      0,
                      Math.min(100, ((preview.pos - preview.from) / Math.max(0.05, preview.to - preview.from)) * 100),
                    )}%`,
                  }}
                />
              </span>
            </div>
            <button
              type="button"
              className="ghost-btn"
              onClick={onPreviewStop}
              title="Cerrar preescucha"
              aria-label="Cerrar preescucha"
            >
              <IconX size={13} />
            </button>
          </>
        ) : (
          <span className="pb-label pb-preview-empty" title="Haz clic en una canción de la biblioteca para escucharla">PREESCUCHA</span>
        )}
        <button
          type="button"
          className={`pb-preview-auto ${autoPreview ? "pb-preview-auto-on" : ""}`}
          aria-pressed={autoPreview}
          onClick={() => onAutoPreview(!autoPreview)}
          title={autoPreview ? "Autoescucha activada: al hacer clic en una canción de la biblioteca suena aquí" : "Autoescucha desactivada"}
        >
          AUTO
        </button>
      </div>

      <button
        type="button"
        className="pb-mixer"
        onClick={onOpenMixer}
        title="Abrir la mesa de mezclas (Mixer)"
        aria-label="Abrir el Mixer"
      >
        <IconSliders size={26} />
      </button>
    </footer>
  );
}
