import { useEffect, useMemo, useState } from "react";

const pad = (n: number) => String(n).padStart(2, "0");
const MAX_TIMES = 288;

/** Todas las combinaciones hora × minuto, ordenadas. */
export function combineTimes(hours: Iterable<number>, minutes: Iterable<number>): string[] {
  const hs = Array.from(hours).sort((a, b) => a - b);
  const ms = Array.from(minutes).sort((a, b) => a - b);
  return hs.flatMap((h) => ms.map((m) => `${pad(h)}:${pad(m)}`));
}

/**
 * Asistente de horas: se marcan las horas y los minutos y se generan todas las
 * combinaciones (horas 8 y 9 con minutos 15 y 45 = 8:15, 8:45, 9:15 y 9:45).
 */
export function TimeWizard({
  existing,
  onApply,
  onClose,
}: {
  existing: string[];
  onApply: (times: string[], mode: "add" | "replace") => void;
  onClose: () => void;
}) {
  const [hours, setHours] = useState<Set<number>>(new Set());
  const [minutes, setMinutes] = useState<Set<number>>(new Set([0]));

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const times = useMemo(() => combineTimes(hours, minutes), [hours, minutes]);
  const fresh = times.filter((t) => !existing.includes(t)).length;
  const tooMany = times.length > MAX_TIMES;

  const toggle = (set: Set<number>, value: number, apply: (next: Set<number>) => void) => {
    const next = new Set(set);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    apply(next);
  };
  const range = (n: number, step = 1) => Array.from({ length: Math.ceil(n / step) }, (_, i) => i * step);

  return (
    <div className="tw-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="tw-card" role="dialog" aria-label="Asistente de horas">
        <div className="tw-head">
          <strong>Asistente de horas</strong>
          <button type="button" className="ghost-btn" onClick={onClose} title="Cerrar">
            ✕
          </button>
        </div>
        <p className="hint tw-hint">
          Marca las horas y los minutos: se crean todas las combinaciones. Por ejemplo, las horas 8 y 9 con los
          minutos 15 y 45 dan 08:15, 08:45, 09:15 y 09:45.
        </p>

        <div className="tw-section">
          <div className="tw-title">
            <span>Horas</span>
            <span className="tw-quick">
              <button type="button" onClick={() => setHours(new Set(range(24)))}>Todas</button>
              <button type="button" onClick={() => setHours(new Set(range(24).filter((h) => h >= 6 && h < 12)))}>
                Mañana
              </button>
              <button type="button" onClick={() => setHours(new Set(range(24).filter((h) => h >= 12 && h < 20)))}>
                Tarde
              </button>
              <button type="button" onClick={() => setHours(new Set())}>Ninguna</button>
            </span>
          </div>
          <div className="tw-grid tw-hours">
            {range(24).map((h) => (
              <button
                key={h}
                type="button"
                className={`tw-cell ${hours.has(h) ? "tw-on" : ""}`}
                aria-pressed={hours.has(h)}
                onClick={() => toggle(hours, h, setHours)}
              >
                {pad(h)}
              </button>
            ))}
          </div>
        </div>

        <div className="tw-section">
          <div className="tw-title">
            <span>Minutos</span>
            <span className="tw-quick">
              <button type="button" onClick={() => setMinutes(new Set([0]))}>En punto</button>
              <button type="button" onClick={() => setMinutes(new Set([0, 30]))}>Medias</button>
              <button type="button" onClick={() => setMinutes(new Set([0, 15, 30, 45]))}>Cuartos</button>
              <button type="button" onClick={() => setMinutes(new Set(range(60, 10)))}>Cada 10</button>
              <button type="button" onClick={() => setMinutes(new Set(range(60, 5)))}>Cada 5</button>
              <button type="button" onClick={() => setMinutes(new Set())}>Ninguno</button>
            </span>
          </div>
          <div className="tw-grid tw-minutes">
            {range(60).map((m) => (
              <button
                key={m}
                type="button"
                className={`tw-cell ${minutes.has(m) ? "tw-on" : ""}`}
                aria-pressed={minutes.has(m)}
                onClick={() => toggle(minutes, m, setMinutes)}
              >
                {pad(m)}
              </button>
            ))}
          </div>
        </div>

        <div className="tw-preview">
          {times.length === 0 ? (
            <span className="hint">Marca al menos una hora y un minuto.</span>
          ) : (
            <>
              <strong>
                {times.length} {times.length === 1 ? "horario" : "horarios"}
              </strong>
              {existing.length > 0 && fresh < times.length && (
                <span className="hint"> · {times.length - fresh} ya existen</span>
              )}
              <div className="tw-chips">
                {times.slice(0, 48).map((t) => (
                  <span key={t} className={`tw-chip ${existing.includes(t) ? "tw-chip-dup" : ""}`}>
                    {t}
                  </span>
                ))}
                {times.length > 48 && <span className="tw-chip">+{times.length - 48}</span>}
              </div>
              {tooMany && <div className="form-error">Demasiados horarios (máximo {MAX_TIMES}).</div>}
            </>
          )}
        </div>

        <div className="edit-actions">
          <button type="button" className="ghost-btn" onClick={onClose}>
            Cancelar
          </button>
          <span className="spacer" />
          <button
            type="button"
            className="btn btn-sm"
            disabled={times.length === 0 || tooMany}
            onClick={() => onApply(times, "replace")}
            title="Quita los horarios actuales y deja solo estos"
          >
            Sustituir los actuales
          </button>
          <button
            type="button"
            className="btn btn-accent btn-sm"
            disabled={times.length === 0 || tooMany}
            onClick={() => onApply(times, "add")}
          >
            Añadir a los actuales
          </button>
        </div>
      </div>
    </div>
  );
}
