import type { Settings } from "../types";

interface SettingsPanelProps {
  settings: Settings;
  onChange: (s: Settings) => void;
  onClose: () => void;
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

export function SettingsPanel({ settings, onChange, onClose }: SettingsPanelProps) {
  const s = settings;
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="Ajustes de rotación">
        <div className="modal-head">
          <h3>Ajustes</h3>
          <button type="button" className="ghost-btn" onClick={onClose}>Cerrar</button>
        </div>

        <div className="modal-body">
          <fieldset className="fieldset">
            <legend>Reglas de rotación</legend>
            <p className="hint">
              El piloto automático respeta estas reglas cuando añade pistas a la
              lista. Si no hay ninguna que las cumpla, elige la que más tiempo
              lleve sin sonar.
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
          </fieldset>
        </div>
      </div>
    </div>
  );
}
