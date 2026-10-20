import {
  IconPlay,
  IconPause,
  IconNext,
  IconPrev,
  IconLoop,
} from "../icons";

interface PlayerBarProps {
  paused: boolean;
  loop: boolean;
  fadeSeconds: number;
  hasPlaylist: boolean;
  onTogglePlay: () => void;
  onNext: () => void;
  onPrev: () => void;
  onLoopChange: (loop: boolean) => void;
  onFadeChange: (secs: number) => void;
  onVolume: (vol: number) => void;
}

const FADE_OPTIONS = [3, 6, 10];

export function PlayerBar({
  paused,
  loop,
  fadeSeconds,
  hasPlaylist,
  onTogglePlay,
  onNext,
  onPrev,
  onLoopChange,
  onFadeChange,
  onVolume,
}: PlayerBarProps) {
  return (
    <footer className="playerbar" aria-label="Controles de la radio">
      <div className="pb-side">
        <button type="button" className="round-btn small" onClick={onPrev} aria-label="Cancion anterior">
          <IconPrev />
        </button>
      </div>

      <button
        type="button"
        className={`big-play ${paused ? "state-play" : "state-pause"}`}
        onClick={onTogglePlay}
        disabled={!hasPlaylist && paused}
        aria-label={paused ? "Sonar" : "Pausa"}
      >
        {paused ? <IconPlay size={40} /> : <IconPause size={40} />}
      </button>

      <div className="pb-side">
        <button type="button" className="round-btn small" onClick={onNext} aria-label="Cancion siguiente">
          <IconNext />
        </button>
      </div>

      <div className="pb-opts">
        <div className="pb-row">
          <button
            type="button"
            className={`chip-btn ${loop ? "chip-on" : ""}`}
            onClick={() => onLoopChange(!loop)}
            aria-pressed={loop}
            title="Repetir toda la lista"
          >
            <IconLoop size={18} />
            Repetir
          </button>
        </div>

        <div className="pb-row pb-fades" role="group" aria-label="Duracion de la transicion entre canciones">
          <span className="pb-label">Transicion suave:</span>
          {FADE_OPTIONS.map((s) => (
            <button
              key={s}
              type="button"
              className={`chip-btn ${fadeSeconds === s ? "chip-on" : ""}`}
              onClick={() => onFadeChange(s)}
              aria-pressed={fadeSeconds === s}
            >
              {s} seg
            </button>
          ))}
        </div>

        <div className="pb-row pb-vol">
          <span className="pb-label">Volumen</span>
          <input
            type="range"
            min={0}
            max={100}
            defaultValue={100}
            onChange={(e) => onVolume(Number(e.target.value) / 100)}
            aria-label="Volumen"
          />
        </div>
      </div>
    </footer>
  );
}
