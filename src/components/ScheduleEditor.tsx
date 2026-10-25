import { useState } from "react";
import type { ScheduleBlock } from "../types";
import { IconPlus, IconTrash } from "../icons";
import { TimeWizard } from "./TimeWizard";

const DAYS: { value: number; label: string; long: string }[] = [
  { value: 1, label: "L", long: "lunes" },
  { value: 2, label: "M", long: "martes" },
  { value: 3, label: "X", long: "miércoles" },
  { value: 4, label: "J", long: "jueves" },
  { value: 5, label: "V", long: "viernes" },
  { value: 6, label: "S", long: "sábado" },
  { value: 7, label: "D", long: "domingo" },
];

type Mode = "campaign" | "event" | "stream";

function uid(): string {
  return `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

export function newScheduleBlock(mode: Mode): ScheduleBlock {
  return {
    id: uid(),
    days: [1, 2, 3, 4, 5, 6, 7],
    times: mode === "stream" ? [] : [],
    hourly: false,
    minute: 0,
    start: "06:00",
    end: "07:00",
  };
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

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

function normalizeTimes(values: string[]): string[] {
  const valid = Array.from(new Set(values.map((v) => v.trim()).filter((v) => parseHM(v) !== null)));
  valid.sort((a, b) => (parseHM(a) ?? 0) - (parseHM(b) ?? 0));
  return [...valid, ...values.filter((v) => parseHM(v.trim()) === null)];
}

function addHour(value: string): string {
  const start = parseHM(value);
  if (start === null) return "07:00";
  const total = (start + 60) % (24 * 60);
  return `${pad2(Math.floor(total / 60))}:${pad2(total % 60)}`;
}

function DayPicker({ days, onChange }: { days: number[]; onChange: (days: number[]) => void }) {
  return (
    <div className="camp-days">
      {DAYS.map((day) => (
        <button
          key={day.value}
          type="button"
          className={`camp-day ${days.includes(day.value) ? "camp-day-on" : ""}`}
          title={day.long}
          onClick={() =>
            onChange(
              days.includes(day.value)
                ? days.filter((value) => value !== day.value)
                : [...days, day.value].sort(),
            )
          }
        >
          {day.label}
        </button>
      ))}
    </div>
  );
}

function CampaignTimes({
  block,
  onChange,
}: {
  block: ScheduleBlock;
  onChange: (patch: Partial<ScheduleBlock>) => void;
}) {
  const [slotMinute, setSlotMinute] = useState(0);
  const minute = Math.max(0, Math.min(59, Math.floor(slotMinute) || 0));
  const times = block.times ?? [];
  const toggleHour = (hour: number) => {
    const value = `${pad2(hour)}:${pad2(minute)}`;
    onChange({
      times: times.includes(value) ? times.filter((item) => item !== value) : [...times, value].sort(),
    });
  };
  return (
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
            onChange={(e) => setSlotMinute(Math.max(0, Math.min(59, Number(e.target.value) || 0)))}
          />
        </label>
      </div>
      <div className="camp-hours">
        {Array.from({ length: 24 }, (_, hour) => {
          const value = `${pad2(hour)}:${pad2(minute)}`;
          return (
            <button
              key={hour}
              type="button"
              className={`camp-hour ${times.includes(value) ? "camp-hour-on" : ""}`}
              title={times.includes(value) ? `Quitar ${value}` : `Añadir ${value}`}
              onClick={() => toggleHour(hour)}
            >
              {pad2(hour)}
            </button>
          );
        })}
      </div>
      <div className="camp-times">
        {times.length === 0 && <span className="hint">Sin horas todavía.</span>}
        {times.map((time) => (
          <span key={time} className="camp-time-chip">
            {time}
            <button
              type="button"
              onClick={() => onChange({ times: times.filter((item) => item !== time) })}
              title="Quitar hora"
            >
              ×
            </button>
          </span>
        ))}
      </div>
    </div>
  );
}

function EventTimes({
  block,
  onChange,
}: {
  block: ScheduleBlock;
  onChange: (patch: Partial<ScheduleBlock>) => void;
}) {
  const [wizard, setWizard] = useState(false);
  const times = normalizeTimes(block.times?.length ? block.times : [block.start ?? "06:00"]).filter(
    (value) => parseHM(value) !== null,
  );
  const setTimes = (next: string[]) => {
    const values = normalizeTimes(next);
    onChange({ times: values, start: values[0] ?? block.start ?? "06:00" });
  };
  return (
    <div className="event-times">
      {wizard && (
        <TimeWizard
          existing={times}
          onClose={() => setWizard(false)}
          onApply={(added, mode) => {
            const base = mode === "add" ? times : [];
            setTimes([...base, ...added]);
            setWizard(false);
          }}
        />
      )}
      <div className="event-times-head">
        <span className="field-label">Horarios de inicio</span>
        <span className="event-times-count">
          {times.length} {times.length === 1 ? "horario" : "horarios"}
        </span>
        <button
          type="button"
          className="btn btn-sm"
          onClick={() => setWizard(true)}
          title="Marca horas y minutos y se crean todas las combinaciones"
        >
          Asistente de horas
        </button>
      </div>
      <div className="event-time-list">
        {times.map((value, index) => (
          <span className="event-time-chip" key={index}>
            <input
              type="time"
              value={value}
              aria-label={`Horario ${index + 1}`}
              onChange={(e) => {
                const next = [...times];
                next[index] = e.target.value;
                onChange({ times: next, start: next[0] ?? value });
              }}
              onBlur={() => setTimes(times)}
            />
            <button
              type="button"
              className="event-time-x"
              title="Quitar horario"
              disabled={times.length <= 1}
              onClick={() => setTimes(times.filter((_, i) => i !== index))}
            >
              ×
            </button>
          </span>
        ))}
        <button
          type="button"
          className="btn btn-sm"
          onClick={() => setTimes([...times, addHour(times[times.length - 1] ?? block.start ?? "06:00")])}
        >
          <IconPlus size={13} /> Añadir
        </button>
      </div>
    </div>
  );
}

export function ScheduleEditor({
  blocks,
  onChange,
  mode,
}: {
  blocks: ScheduleBlock[];
  onChange: (blocks: ScheduleBlock[]) => void;
  mode: Mode;
}) {
  const update = (id: string, patch: Partial<ScheduleBlock>) =>
    onChange(blocks.map((block) => (block.id === id ? { ...block, ...patch } : block)));
  const remove = (id: string) => onChange(blocks.filter((block) => block.id !== id));

  return (
    <div className="schedule-blocks">
      {blocks.map((block, index) => (
        <div className="schedule-block" key={block.id}>
          <div className="schedule-block-head">
            <strong>Franja {index + 1}</strong>
            {blocks.length > 1 && (
              <button
                type="button"
                className="ghost-btn camp-del"
                title="Quitar esta franja"
                onClick={() => remove(block.id)}
              >
                <IconTrash size={13} />
              </button>
            )}
          </div>
          <DayPicker days={block.days} onChange={(days) => update(block.id, { days })} />
          {mode === "stream" ? (
            <div className="field-row">
              <label className="field">
                <span className="field-label">Empieza</span>
                <input
                  type="time"
                  value={block.start ?? "06:00"}
                  onChange={(e) => update(block.id, { start: e.target.value })}
                />
              </label>
              <label className="field">
                <span className="field-label">Termina</span>
                <input
                  type="time"
                  value={block.end ?? "07:00"}
                  onChange={(e) => update(block.id, { end: e.target.value })}
                />
              </label>
            </div>
          ) : (
            <>
              {mode === "campaign" && (
                <label className="check-field">
                  <input
                    type="checkbox"
                    checked={!!block.hourly}
                    onChange={(e) => update(block.id, { hourly: e.target.checked })}
                  />
                  Emitir cada hora al minuto
                  <input
                    className="camp-minute"
                    type="number"
                    min={0}
                    max={59}
                    value={block.minute ?? 0}
                    disabled={!block.hourly}
                    onChange={(e) =>
                      update(block.id, {
                        minute: Math.max(0, Math.min(59, Number(e.target.value) || 0)),
                      })
                    }
                  />
                </label>
              )}
              {mode === "campaign" && !block.hourly ? (
                <CampaignTimes block={block} onChange={(patch) => update(block.id, patch)} />
              ) : mode === "event" ? (
                <EventTimes block={block} onChange={(patch) => update(block.id, patch)} />
              ) : null}
            </>
          )}
          {block.days.length === 0 && <p className="form-error">Selecciona al menos un día.</p>}
        </div>
      ))}
      <button type="button" className="btn btn-sm" onClick={() => onChange([...blocks, newScheduleBlock(mode)])}>
        <IconPlus size={13} /> Añadir franja
      </button>
    </div>
  );
}
