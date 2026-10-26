import { useEffect, useRef, useState } from "react";
import type { CompressorSettings, InsertSettings, LevelerSettings } from "../types";
import { pickVstFile, vstScan } from "../api";
import { levelerOf } from "../leveler";

/** Controles compartidos de la mesa (ventana Mixer y Ajustes → Sonido). */

const COMP_DEFAULT: CompressorSettings = { enabled: false, thresholdDb: -18, ratio: 3, attackMs: 10, releaseMs: 200, makeupDb: 0 };

/** Compresor de un canal o bus (antes del fader). */
export function CompressorControls({
  owner,
  label,
  onChange,
}: {
  owner: { compressor?: CompressorSettings };
  label: string;
  onChange: (compressor: CompressorSettings) => void;
}) {
  const c: CompressorSettings = { ...COMP_DEFAULT, ...(owner.compressor ?? {}) };
  const set = (patch: Partial<CompressorSettings>) => onChange({ ...c, ...patch });
  const num = (key: keyof Omit<CompressorSettings, "enabled">, text: string, min: number, max: number, step: number) => (
    <label>
      <span>{text}</span>
      <input
        type="number"
        min={min}
        max={max}
        step={step}
        value={c[key]}
        onChange={(e) => {
          const v = Number(e.target.value);
          if (Number.isFinite(v)) set({ [key]: Math.max(min, Math.min(max, v)) } as Partial<CompressorSettings>);
        }}
      />
    </label>
  );
  return (
    <div className="mixer-leveler">
      <label className="check-row">
        <input
          type="checkbox"
          checked={c.enabled}
          aria-label={`Compresor de ${label}`}
          onChange={(e) => set({ enabled: e.target.checked })}
        />
        <span>Compresor</span>
      </label>
      {c.enabled && (
        <div className="mixer-leveler-params">
          {num("thresholdDb", "Umbral (dB)", -60, 0, 1)}
          {num("ratio", "Ratio (:1)", 1, 20, 0.5)}
          {num("attackMs", "Ataque (ms)", 0.1, 200, 1)}
          {num("releaseMs", "Relajación (ms)", 10, 2000, 10)}
          {num("makeupDb", "Ganancia (dB)", 0, 24, 0.5)}
        </div>
      )}
    </div>
  );
}

export function LevelerControls({
  owner,
  label,
  onChange,
}: {
  owner: { leveler?: LevelerSettings };
  label: string;
  onChange: (leveler: LevelerSettings) => void;
}) {
  const lv = levelerOf(owner);
  const set = (patch: Partial<LevelerSettings>) =>
    onChange({ ...lv, ...patch });
  return (
    <div className="mixer-leveler">
      <label className="check-row">
        <input
          type="checkbox"
          checked={lv.enabled}
          aria-label={`Nivelador automático de ${label}`}
          onChange={(e) => set({ enabled: e.target.checked })}
        />
        <span>Nivelador automático</span>
      </label>
      {lv.enabled && (
        <div className="mixer-leveler-params">
          <label>
            <span>Objetivo (LUFS)</span>
            <input
              type="number"
              min={-30}
              max={-8}
              step={1}
              value={lv.targetLufs}
              onChange={(e) =>
                set({
                  targetLufs: Math.max(
                    -30,
                    Math.min(-8, Number(e.target.value) || -16),
                  ),
                })
              }
            />
          </label>
          <label>
            <span>Rango (± dB)</span>
            <input
              type="number"
              min={0}
              max={18}
              step={1}
              value={lv.maxGainDb}
              onChange={(e) =>
                set({
                  maxGainDb: Math.max(
                    0,
                    Math.min(18, Number(e.target.value) || 0),
                  ),
                })
              }
            />
          </label>
        </div>
      )}
    </div>
  );
}

/**
 * Para un canal mono: cada tarjeta se ofrece canal a canal (`nombre!K`), asi
 * el insert sale y vuelve por un solo canal (p. ej. un canal del VB-Matrix).
 */
function monoChannelOptions(devs: Device[]): Device[] {
  const pairs = new Map<string, number>();
  for (const d of devs) {
    const m = /^(.*)#(\d+)$/.exec(d.id);
    const base = m ? m[1] : d.id;
    pairs.set(base, Math.max(pairs.get(base) ?? 1, m ? Number(m[2]) : 1));
  }
  const out: Device[] = [];
  for (const [base, p] of pairs) {
    for (let c = 1; c <= p * 2; c += 1)
      out.push({ id: `${base}!${c}`, label: `${base} · canal ${c}`, kind: devs[0]?.kind ?? "audiooutput" });
  }
  return out;
}

export function InsertControls({
  owner,
  label,
  inputs: allInputs,
  outputs: allOutputs,
  mono = false,
  onChange,
}: {
  owner: { insert?: InsertSettings };
  label: string;
  inputs: Device[];
  outputs: Device[];
  /** Canal mono: el insert va por un solo canal de la tarjeta */
  mono?: boolean;
  onChange: (insert: InsertSettings) => void;
}) {
  const inputs = mono ? [...monoChannelOptions(allInputs), ...allInputs] : allInputs;
  const outputs = mono ? [...monoChannelOptions(allOutputs), ...allOutputs] : allOutputs;
  const ins: InsertSettings = {
    enabled: !!owner.insert?.enabled,
    sendDeviceId: owner.insert?.sendDeviceId ?? "",
    returnDeviceId: owner.insert?.returnDeviceId ?? "",
  };
  const set = (patch: Partial<InsertSettings>) =>
    onChange({ ...ins, ...patch });
  const incomplete = ins.enabled && (!ins.sendDeviceId || !ins.returnDeviceId);
  return (
    <div className="mixer-leveler">
      <label className="check-row">
        <input
          type="checkbox"
          checked={ins.enabled}
          aria-label={`Insert de ${label}`}
          onChange={(e) => set({ enabled: e.target.checked })}
        />
        <span>Insert (envío / retorno)</span>
      </label>
      {ins.enabled && (
        <div className="mixer-insert">
          <label className="mixer-field">
            <span>Envío</span>
            <select
              value={ins.sendDeviceId}
              onChange={(e) => set({ sendDeviceId: e.target.value })}
            >
              <option value="">Elige salida…</option>
              {outputs.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.label}
                </option>
              ))}
              {ins.sendDeviceId &&
                !outputs.some((d) => d.id === ins.sendDeviceId) && (
                  <option value={ins.sendDeviceId}>Salida no disponible</option>
                )}
            </select>
          </label>
          <label className="mixer-field">
            <span>Retorno</span>
            <select
              value={ins.returnDeviceId}
              onChange={(e) => set({ returnDeviceId: e.target.value })}
            >
              <option value="">Elige entrada…</option>
              {inputs.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.label}
                </option>
              ))}
              {ins.returnDeviceId &&
                !inputs.some((d) => d.id === ins.returnDeviceId) && (
                  <option value={ins.returnDeviceId}>
                    Entrada no disponible
                  </option>
                )}
            </select>
          </label>
          <p className="mixer-insert-hint">
            {incomplete
              ? "Elige envío y retorno; mientras tanto el canal suena directo."
              : mono
                ? "Canal mono: elige un solo canal de envío y de retorno (arriba de la lista) o un par estéreo."
                : "Usa un cable virtual hacia el procesador (p. ej. SuperRack) y otro de vuelta. Añade algo de latencia."}
          </p>
        </div>
      )}
    </div>
  );
}

export interface Device {
  id: string;
  label: string;
  kind: "audioinput" | "audiooutput";
  /** Canales que ofrece la tarjeta (si se conocen) */
  channels?: number;
}

/** Paleta fija de 15 colores (3 filas de 5): más fácil igualar canales. */
const COLORS = [
  "#4f8cff",
  "#59d98c",
  "#ffb84d",
  "#f87171",
  "#c084fc",
  "#22d3ee",
  "#f472b6",
  "#a3e635",
  "#f97316",
  "#94a3b8",
  "#2563eb",
  "#16a34a",
  "#dc2626",
  "#9333ea",
  "#0891b2",
];

/**
 * Barra de color de la tira: al pulsarla se abre una paleta de 15 colores.
 */
export function ColorBar({
  value,
  label,
  onChange,
}: {
  value: string;
  label: string;
  onChange: (color: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  return (
    <div className="mixer-colorbar-wrap" ref={ref}>
      <button
        type="button"
        className="mixer-colorbar"
        title="Cambiar color"
        aria-label={`Color de ${label}`}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span style={{ background: value }} />
      </button>
      {open && (
        <div className="mixer-palette" role="radiogroup" aria-label={`Color de ${label}`}>
          {COLORS.map((c) => {
            const on = c.toLowerCase() === value.toLowerCase();
            return (
              <button
                key={c}
                type="button"
                role="radio"
                aria-checked={on}
                className={`mixer-swatch ${on ? "mixer-swatch-on" : ""}`}
                style={{ background: c }}
                onClick={() => {
                  onChange(c);
                  setOpen(false);
                }}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}

export function nextColor(count: number): string {
  return COLORS[count % COLORS.length];
}

export function newId(): string {
  if (
    typeof crypto !== "undefined" &&
    typeof crypto.randomUUID === "function"
  ) {
    return crypto.randomUUID();
  }
  return `mixer-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** Plugins ocultos en Ajustes (lo actualiza la mesa al pintarse). */
let vstHiddenNow: string[] = [];
export function setVstHidden(list: string[] | undefined) {
  vstHiddenNow = list ?? [];
}

/**
 * Selector para añadir un plugin VST3: busca los del equipo (sin los ocultos
 * en Ajustes > Plugins VST) o deja elegir el archivo .vst3.
 */
export function PluginPicker({
  isNative,
  onPick,
}: {
  isNative: boolean;
  onPick: (path: string, name: string) => void;
}) {
  const [found, setFound] = useState<{ name: string; vendor: string; path: string }[] | null>(null);
  const [filter, setFilter] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    let alive = true;
    void vstScan()
      .then((r) => {
        if (!alive) return;
        const hide = new Set(vstHiddenNow.map((h) => h.toLowerCase()));
        setFound(r.plugins.filter((p) => !hide.has(p.path.toLowerCase())));
      })
      .catch((e) => alive && setError(String(e)));
    return () => {
      alive = false;
    };
  }, []);
  const list = (found ?? []).filter((p) => `${p.name} ${p.vendor}`.toLowerCase().includes(filter.toLowerCase()));
  return (
    <div className="mixer-leveler vst-slots">
      <div className="mx-pop-title">Añadir plugin VST3</div>
      {!isNative && <p className="mixer-insert-hint">Los plugins solo suenan con el motor nativo.</p>}
      <div className="vst-pick">
        <input
          autoFocus
          placeholder={found ? `Buscar entre ${found.length} plugins…` : "Buscando plugins…"}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <div className="vst-list">
          {found && list.length === 0 && (
            <span className="mixer-insert-hint">
              No hay plugins VST3 (o están ocultos). Revisa las carpetas en Ajustes &gt; Plugins VST.
            </span>
          )}
          {list.map((p) => (
            <button key={p.path} type="button" className="vst-item" title={p.path} onClick={() => onPick(p.path, p.name)}>
              <strong>{p.name}</strong> <span>{p.vendor}</span>
            </button>
          ))}
        </div>
        <button
          type="button"
          className="ghost-btn"
          onClick={() =>
            void pickVstFile().then((path) => {
              if (path) onPick(path, path.split(/[\\/]/).pop()?.replace(/\.vst3$/i, "") ?? "Plugin");
            })
          }
        >
          Elegir archivo .vst3…
        </button>
      </div>
      {error && <p className="mixer-insert-hint">{error}</p>}
    </div>
  );
}
