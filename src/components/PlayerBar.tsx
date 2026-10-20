import { IconPlay, IconPause, IconNext, IconPrev, IconBolt } from "../icons";

interface PlayerBarProps {
  paused: boolean;
  autopilot: boolean;
  fadeSeconds: number;
  hasPlaylist: boolean;
  onTogglePlay: () => void;
  onNext: () => void;
  onPrev: () => void;
  onAutopilot: (on: boolean) => void;
  onFadeChange: (secs: number) => void;
  onVolume: (vol: number) => void;
}

const FADE_OPTIONS = [3, 6, 10];

export function PlayerBar({
  paused,
  autopilot,
  fadeSeconds,
  hasPlaylist,
  onTogglePlay,
  onNext,
  onPrev,
  onAutopilot,
  onFadeChange,
  onVolume,
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

      <div className="pb-group-seg pb-vol">
        <span className="pb-label">VOLUMEN</span>
        <input
          type="range"
          min={0}
          max={100}
          defaultValue={100}
          onChange={(e) => onVolume(Number(e.target.value) / 100)}
          aria-label="Volumen"
        />
      </div>
    </footer>
  );
}
