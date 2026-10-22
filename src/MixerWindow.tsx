import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { listen } from "@tauri-apps/api/event";
import { WindowControls } from "./components/WindowControls";
import {
  ColorBar,
  InsertControls,
  LevelerControls,
  newId,
  nextColor,
  type Device,
} from "./components/MixerPanel";
import { callMain, onMainState } from "./bridge";
import { nativeDevices } from "./nativeEngine";
import { MAX_GAIN_DB, MIN_GAIN_DB } from "./mixer";
import type { MixerBus, MixerChannel, MixerSend, Settings } from "./types";
import type { SharedState } from "./SettingsWindow";

/**
 * Mesa de mezclas en su propia ventana, al estilo Pro Tools: una tira
 * vertical por canal y por bus con inserts, envios, entrada/salida,
 * panorama, solo/silencio, fader largo con medidor y nombre con color.
 */

// ------------------------------------------------------------ escala del fader

const TAPER: [number, number][] = [
  [0, MIN_GAIN_DB],
  [0.18, -40],
  [0.28, -30],
  [0.4, -20],
  [0.55, -10],
  [0.75, 0],
  [1, MAX_GAIN_DB],
];

function posToDb(pos: number): number {
  const p = Math.max(0, Math.min(1, pos));
  for (let i = 1; i < TAPER.length; i += 1) {
    const [p1, d1] = TAPER[i];
    const [p0, d0] = TAPER[i - 1];
    if (p <= p1) return d0 + ((p - p0) / (p1 - p0)) * (d1 - d0);
  }
  return MAX_GAIN_DB;
}

function dbToPos(db: number): number {
  const d = Math.max(MIN_GAIN_DB, Math.min(MAX_GAIN_DB, db));
  for (let i = 1; i < TAPER.length; i += 1) {
    const [p1, d1] = TAPER[i];
    const [p0, d0] = TAPER[i - 1];
    if (d <= d1) return p0 + ((d - d0) / (d1 - d0)) * (p1 - p0);
  }
  return 1;
}

function fmtDb(db: number): string {
  if (db <= MIN_GAIN_DB) return "−∞";
  const r = Math.round(db * 10) / 10;
  return `${r > 0 ? "+" : ""}${r.toFixed(1)}`;
}

function fmtPan(pan: number): string {
  const v = Math.round(pan * 100);
  if (v === 0) return "C";
  return v < 0 ? `<${-v}` : `${v}>`;
}

const SCALE_MARKS = [12, 6, 0, -5, -10, -20, -30, -40, -60];

// ------------------------------------------------------------ medidores

type MeterMap = Map<string, { l: number; r: number; at: number }>;

/** Medidor estereo que se pinta solo (sin re-render de React). */
function StereoMeter({ store, id }: { store: React.MutableRefObject<MeterMap>; id: string }) {
  const lRef = useRef<HTMLDivElement | null>(null);
  const rRef = useRef<HTMLDivElement | null>(null);
  const hlRef = useRef<HTMLDivElement | null>(null);
  const hrRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    let raf = 0;
    const shown = { l: 0, r: 0, hl: 0, hr: 0 };
    // Misma escala que el fader: las marcas de al lado valen para los dos.
    const frac = (v: number) => {
      if (v <= 0.000001) return 0;
      return dbToPos(20 * Math.log10(v));
    };
    const loop = () => {
      raf = requestAnimationFrame(loop);
      const m = store.current.get(id);
      const stale = !m || performance.now() - m.at > 400;
      const tl = stale ? 0 : frac(m.l);
      const tr = stale ? 0 : frac(m.r);
      // Subida inmediata, caida suave; pico retenido que cae despacio.
      shown.l = tl > shown.l ? tl : shown.l * 0.92 + tl * 0.08;
      shown.r = tr > shown.r ? tr : shown.r * 0.92 + tr * 0.08;
      shown.hl = Math.max(shown.l, shown.hl - 0.004);
      shown.hr = Math.max(shown.r, shown.hr - 0.004);
      if (lRef.current) lRef.current.style.transform = `scaleY(${shown.l})`;
      if (rRef.current) rRef.current.style.transform = `scaleY(${shown.r})`;
      if (hlRef.current) hlRef.current.style.bottom = `${shown.hl * 100}%`;
      if (hrRef.current) hrRef.current.style.bottom = `${shown.hr * 100}%`;
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [store, id]);
  return (
    <div className="mx-meter" aria-hidden="true">
      <div className="mx-meter-ch">
        <div className="mx-meter-fill" ref={lRef} />
        <div className="mx-meter-hold" ref={hlRef} />
      </div>
      <div className="mx-meter-ch">
        <div className="mx-meter-fill" ref={rRef} />
        <div className="mx-meter-hold" ref={hrRef} />
      </div>
    </div>
  );
}

// ------------------------------------------------------------ controles

function Fader({
  db,
  label,
  onLive,
  onCommit,
}: {
  db: number;
  label: string;
  onLive: (db: number) => void;
  onCommit: (db: number) => void;
}) {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const [drag, setDrag] = useState<number | null>(null);
  const value = drag ?? db;
  const fromEvent = (e: React.PointerEvent) => {
    const rect = trackRef.current!.getBoundingClientRect();
    return posToDb(1 - (e.clientY - rect.top) / rect.height);
  };
  const snap = (v: number) => (Math.abs(v) < 0.4 ? 0 : Math.round(v * 2) / 2);
  return (
    <div
      className="mx-fader"
      ref={trackRef}
      role="slider"
      tabIndex={0}
      aria-label={`Volumen de ${label}`}
      aria-valuemin={MIN_GAIN_DB}
      aria-valuemax={MAX_GAIN_DB}
      aria-valuenow={value}
      aria-valuetext={`${fmtDb(value)} dB`}
      title="Doble clic: 0 dB"
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        const v = snap(fromEvent(e));
        setDrag(v);
        onLive(v);
      }}
      onPointerMove={(e) => {
        if (drag === null) return;
        const v = snap(fromEvent(e));
        setDrag(v);
        onLive(v);
      }}
      onPointerUp={(e) => {
        if (drag === null) return;
        const v = snap(fromEvent(e));
        setDrag(null);
        onCommit(v);
      }}
      onPointerCancel={() => {
        if (drag !== null) onCommit(drag);
        setDrag(null);
      }}
      onDoubleClick={() => onCommit(0)}
      onKeyDown={(e) => {
        const step = e.shiftKey ? 3 : 0.5;
        if (e.key === "ArrowUp") onCommit(Math.min(MAX_GAIN_DB, value + step));
        else if (e.key === "ArrowDown") onCommit(Math.max(MIN_GAIN_DB, value - step));
        else return;
        e.preventDefault();
      }}
    >
      <div className="mx-fader-slot" />
      {SCALE_MARKS.map((m) => (
        <span key={m} className="mx-fader-mark" style={{ bottom: `${dbToPos(m) * 100}%` }}>
          {m > 0 ? `+${m}` : m}
        </span>
      ))}
      <div className="mx-fader-cap" style={{ bottom: `${dbToPos(value) * 100}%` }} />
    </div>
  );
}

function PanKnob({ pan, onCommit }: { pan: number; onCommit: (pan: number) => void }) {
  const [drag, setDrag] = useState<{ y: number; start: number; v: number } | null>(null);
  const value = drag?.v ?? pan;
  const angle = value * 135;
  return (
    <div className="mx-pan">
      <div
        className="mx-knob"
        role="slider"
        tabIndex={0}
        aria-label="Panorama"
        aria-valuemin={-100}
        aria-valuemax={100}
        aria-valuenow={Math.round(value * 100)}
        title="Arrastra arriba/abajo · doble clic: centro"
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          setDrag({ y: e.clientY, start: pan, v: pan });
        }}
        onPointerMove={(e) => {
          if (!drag) return;
          const v = Math.max(-1, Math.min(1, drag.start + (drag.y - e.clientY) / 120));
          setDrag({ ...drag, v: Math.abs(v) < 0.04 ? 0 : v });
        }}
        onPointerUp={() => {
          if (!drag) return;
          onCommit(drag.v);
          setDrag(null);
        }}
        onDoubleClick={() => onCommit(0)}
        onKeyDown={(e) => {
          if (e.key === "ArrowRight" || e.key === "ArrowUp") onCommit(Math.min(1, pan + 0.05));
          else if (e.key === "ArrowLeft" || e.key === "ArrowDown") onCommit(Math.max(-1, pan - 0.05));
        }}
      >
        <svg viewBox="0 0 32 32" width="30" height="30" aria-hidden="true">
          <circle cx="16" cy="16" r="12" className="mx-knob-body" />
          <line
            x1="16"
            y1="16"
            x2="16"
            y2="6"
            className="mx-knob-line"
            transform={`rotate(${angle} 16 16)`}
          />
        </svg>
      </div>
      <span className="mx-pan-val">{fmtPan(value)}</span>
    </div>
  );
}

/** Ventanita anclada a la tira (inserts, envios, entrada/salida). */
function Pop({ open, onClose, children }: { open: boolean; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    const t = window.setTimeout(() => document.addEventListener("mousedown", onDoc), 0);
    document.addEventListener("keydown", onKey);
    return () => {
      window.clearTimeout(t);
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, onClose]);
  // Se coloca en la pantalla (position: fixed) hacia el lado con sitio:
  // a la derecha de su tira o, si no cabe, a la izquierda; y hacia arriba
  // si no cabe por debajo. Asi no lo recorta el borde de la ventana.
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    const place = () => {
      const el = ref.current;
      const anchor = el?.parentElement;
      if (!el || !anchor) return;
      const a = anchor.getBoundingClientRect();
      const w = el.offsetWidth;
      const h = el.offsetHeight;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      let left = a.left + 4;
      if (left + w > vw - 8) left = a.right - w - 4;
      left = Math.max(8, Math.min(left, vw - w - 8));
      let top = a.top + 30;
      if (top + h > vh - 8) top = a.top - h + 26;
      top = Math.max(8, Math.min(top, vh - h - 8));
      setPos({ left, top });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open]);
  if (!open) return null;
  return (
    <div
      className="mx-pop"
      ref={ref}
      style={pos ? { position: "fixed", left: pos.left, top: pos.top, right: "auto" } : { visibility: "hidden" }}
    >
      {children}
    </div>
  );
}

// ------------------------------------------------------------ dispositivos

function useDevices(isNative: boolean) {
  const [inputs, setInputs] = useState<Device[]>([]);
  const [outputs, setOutputs] = useState<Device[]>([]);
  const refresh = useCallback(async () => {
    try {
      const list = (await navigator.mediaDevices?.enumerateDevices?.()) ?? [];
      const ins: Device[] = [];
      const outs: Device[] = [];
      for (const d of list) {
        if (!d.deviceId) continue;
        if (d.kind === "audioinput") ins.push({ id: d.deviceId, label: d.label || `Entrada ${ins.length + 1}`, kind: "audioinput" });
        if (d.kind === "audiooutput" && d.deviceId !== "default")
          outs.push({ id: d.deviceId, label: d.label || `Salida ${outs.length + 1}`, kind: "audiooutput" });
      }
      setInputs(ins);
      if (isNative) {
        const names = await nativeDevices().catch(() => [] as string[]);
        setOutputs(names.map((n) => ({ id: n, label: n, kind: "audiooutput" as const })));
      } else {
        setOutputs(outs);
      }
    } catch {
      /* sin dispositivos */
    }
  }, [isNative]);
  useEffect(() => {
    void refresh();
    const media = navigator.mediaDevices;
    media?.addEventListener?.("devicechange", refresh);
    return () => media?.removeEventListener?.("devicechange", refresh);
  }, [refresh]);
  return { inputs, outputs };
}

// ------------------------------------------------------------ ventana

export function MixerWindow() {
  const [shared, setShared] = useState<SharedState | null>(null);
  const lastLocalEdit = useRef(0);
  const meters = useRef<MeterMap>(new Map());
  const settingsRef = useRef<Settings | null>(null);
  settingsRef.current = shared?.settings ?? null;

  useEffect(() => {
    const offs: Array<Promise<() => void>> = [];
    offs.push(
      onMainState<SharedState>((s) =>
        setShared((prev) =>
          prev && Date.now() - lastLocalEdit.current < 800 ? { ...s, settings: prev.settings } : s,
        ),
      ),
    );
    type M = { key: string; l: number; r: number }[];
    const take = (list: M) => {
      const now = performance.now();
      for (const m of list) meters.current.set(m.key, { l: m.l, r: m.r, at: now });
    };
    offs.push(listen<M>("engine://meters", (e) => take(e.payload)));
    offs.push(listen<M>("mixer://meters", (e) => take(e.payload)));
    void callMain<SharedState>("getState").then(setShared).catch(() => undefined);
    void callMain("meters", true).catch(() => undefined);
    const off = () => void callMain("meters", false).catch(() => undefined);
    window.addEventListener("beforeunload", off);
    return () => {
      off();
      window.removeEventListener("beforeunload", off);
      for (const o of offs) void o.then((fn) => fn());
    };
  }, []);

  const commit = useCallback((next: Settings) => {
    lastLocalEdit.current = Date.now();
    setShared((prev) => (prev ? { ...prev, settings: next } : prev));
    void callMain("updateSettings", next).catch(() => undefined);
  }, []);

  const s = shared?.settings;
  const isNative = s?.audioEngine === "native";
  const { inputs, outputs } = useDevices(!!isNative);

  if (!s) {
    return (
      <div className="tool-window">
        <MixerTitle />
        <div className="tool-loading">Conectando con MiRadio…</div>
      </div>
    );
  }

  const channels = s.mixerChannels ?? [];
  const buses = s.mixerBuses ?? [];
  const patchChannel = (id: string, patch: Partial<MixerChannel>) =>
    commit({ ...s, mixerChannels: channels.map((c) => (c.id === id ? { ...c, ...patch } : c)) });
  const patchBus = (id: string, patch: Partial<MixerBus>) =>
    commit({ ...s, mixerBuses: buses.map((b) => (b.id === id ? { ...b, ...patch } : b)) });

  const addChannel = () =>
    commit({
      ...s,
      mixerChannels: [
        ...channels,
        {
          id: newId(),
          name: `Canal ${channels.length + 1}`,
          color: nextColor(channels.length),
          input: { kind: "app", app: "music", deviceId: "" },
          output: buses[0] ? { kind: "bus", id: buses[0].id } : { kind: "device", id: "default" },
          gainDb: 0,
          muted: false,
        },
      ],
    });
  const addBus = () =>
    commit({
      ...s,
      mixerBuses: [
        ...buses,
        {
          id: newId(),
          name: `Bus ${buses.length + 1}`,
          color: nextColor(channels.length + buses.length + 1),
          outputDeviceId: "default",
          gainDb: 0,
          muted: false,
        },
      ],
    });
  const removeChannel = (id: string) => commit({ ...s, mixerChannels: channels.filter((c) => c.id !== id) });
  const removeBus = (id: string) =>
    commit({
      ...s,
      mixerBuses: buses.filter((b) => b.id !== id),
      mixerChannels: channels.map((c) => ({
        ...c,
        output: c.output.kind === "bus" && c.output.id === id ? { kind: "device", id: "default" } : c.output,
        sends: (c.sends ?? []).filter((x) => x.busId !== id),
      })),
      monitorBusId: s.monitorBusId === id ? "" : s.monitorBusId,
    });

  const masterDb = s.masterVolume <= 0.001 ? MIN_GAIN_DB : 20 * Math.log10(s.masterVolume);

  return (
    <div className="tool-window mx-window">
      <MixerTitle>
        <button type="button" className="btn btn-sm" onClick={addChannel}>
          + Canal
        </button>
        <button type="button" className="btn btn-sm" onClick={addBus}>
          + Bus
        </button>
        <span className="mx-engine">{isNative ? "Motor nativo" : "Motor web"}</span>
      </MixerTitle>
      <div className="mx-strips">
        {channels.length === 0 && buses.length === 0 && (
          <div className="mx-empty">
            Sin canales. La música sale por la salida predeterminada. Crea un canal para empezar.
          </div>
        )}
        {channels.map((ch) => (
          <ChannelStrip
            key={ch.id}
            ch={ch}
            buses={buses}
            inputs={inputs}
            outputs={outputs}
            meters={meters}
            onPatch={(patch) => patchChannel(ch.id, patch)}
            onRemove={() => removeChannel(ch.id)}
          />
        ))}
        {buses.length > 0 && <div className="mx-sep" />}
        {buses.map((bus) => (
          <BusStrip
            key={bus.id}
            bus={bus}
            outputs={outputs}
            inputs={inputs}
            meters={meters}
            isMonitor={s.monitorBusId === bus.id}
            onPatch={(patch) => patchBus(bus.id, patch)}
            onRemove={() => removeBus(bus.id)}
          />
        ))}
        <div className="mx-sep" />
        <section className="mx-strip mx-master" aria-label="Master">
          <div className="mx-section mx-grow-top">
            <span className="mx-label">MASTER</span>
            <span className="mx-hint">Volumen general de las salidas (no afecta al streaming)</span>
          </div>
          <div className="mx-fader-row">
            <Fader
              db={masterDb}
              label="Master"
              onLive={(db) => void callMain("liveVolume", db <= MIN_GAIN_DB ? 0 : Math.min(1, 10 ** (db / 20)))}
              onCommit={(db) => commit({ ...s, masterVolume: db <= MIN_GAIN_DB ? 0 : Math.min(1, 10 ** (Math.min(0, db) / 20)) })}
            />
            <StereoMeter store={meters} id="master" />
          </div>
          <div className="mx-db">{fmtDb(Math.min(0, masterDb))}</div>
          <div className="mx-name mx-name-master">Master</div>
        </section>
      </div>
    </div>
  );
}

function MixerTitle({ children }: { children?: ReactNode }) {
  return (
    <header className="tool-titlebar" data-tauri-drag-region>
      <span className="tool-title" data-tauri-drag-region>
        Mixer
      </span>
      <div className="mx-tools">{children}</div>
      <div className="top-drag" data-tauri-drag-region />
      <WindowControls />
    </header>
  );
}

function NameField({ name, onRename, onRemove }: { name: string; onRename: (n: string) => void; onRemove: () => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  if (editing) {
    return (
      <input
        className="mx-name-input"
        value={draft}
        autoFocus
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          setEditing(false);
          if (draft.trim()) onRename(draft.trim());
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          if (e.key === "Escape") {
            setDraft(name);
            setEditing(false);
          }
        }}
      />
    );
  }
  return (
    <div
      className="mx-name"
      title={`${name} · doble clic: renombrar · clic derecho: eliminar`}
      onDoubleClick={() => {
        setDraft(name);
        setEditing(true);
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        if (window.confirm(`¿Eliminar «${name}»?`)) onRemove();
      }}
    >
      {name}
    </div>
  );
}

function ChannelStrip({
  ch,
  buses,
  inputs,
  outputs,
  meters,
  onPatch,
  onRemove,
}: {
  ch: MixerChannel;
  buses: MixerBus[];
  inputs: Device[];
  outputs: Device[];
  meters: React.MutableRefObject<MeterMap>;
  onPatch: (patch: Partial<MixerChannel>) => void;
  onRemove: () => void;
}) {
  const [pop, setPop] = useState<"" | "insert" | "leveler" | "io" | `send:${number}`>("");
  const close = useCallback(() => setPop(""), []);
  const sends = ch.sends ?? [];
  const busName = (id: string) => buses.find((b) => b.id === id)?.name ?? "—";
  const inputLabel =
    ch.input.kind === "app"
      ? ch.input.app === "preview"
        ? "Preescucha"
        : ch.input.app === "call"
          ? "Llamadas"
          : "Música"
      : inputs.find((d) => d.id === ch.input.deviceId)?.label ?? "Entrada";
  const outputLabel =
    ch.output.kind === "bus"
      ? busName(ch.output.id)
      : ch.output.id === "streaming"
        ? "Streaming"
        : ch.output.id === "default" || !ch.output.id
          ? "Predeterminada"
          : outputs.find((d) => d.id === ch.output.id)?.label ?? "Salida";
  const setSend = (i: number, patch: Partial<MixerSend> | null) => {
    const next = sends.slice();
    if (patch === null) next.splice(i, 1);
    else next[i] = { ...next[i], ...patch };
    onPatch({ sends: next });
  };
  const key = `ch:${ch.id}`;

  return (
    <section className="mx-strip" aria-label={ch.name}>
      <div className="mx-section">
        <span className="mx-label">INSERTS</span>
        <button
          type="button"
          className={`mx-slot ${ch.insert?.enabled ? "mx-slot-on" : ""}`}
          onClick={() => setPop(pop === "insert" ? "" : "insert")}
        >
          {ch.insert?.enabled ? "Envío/Ret." : "—"}
        </button>
        <button
          type="button"
          className={`mx-slot ${ch.leveler?.enabled ? "mx-slot-on" : ""}`}
          onClick={() => setPop(pop === "leveler" ? "" : "leveler")}
        >
          {ch.leveler?.enabled ? "Nivelador" : "—"}
        </button>
        <Pop open={pop === "insert"} onClose={close}>
          <InsertControls
            owner={ch}
            label={ch.name}
            inputs={inputs}
            outputs={outputs}
            onChange={(insert) => onPatch({ insert })}
          />
        </Pop>
        <Pop open={pop === "leveler"} onClose={close}>
          <LevelerControls owner={ch} label={ch.name} onChange={(leveler) => onPatch({ leveler })} />
        </Pop>
      </div>

      <div className="mx-section">
        <span className="mx-label">SENDS</span>
        {[0, 1, 2].map((i) => {
          const sd = sends[i];
          return (
            <button
              key={i}
              type="button"
              className={`mx-slot ${sd ? (sd.muted ? "mx-slot-muted" : "mx-slot-send") : ""}`}
              disabled={!sd && (buses.length === 0 || i > sends.length)}
              title={buses.length === 0 ? "Crea un bus para poder enviar" : undefined}
              onClick={() => {
                if (!sd) {
                  const free = buses.find(
                    (b) => !sends.some((x) => x.busId === b.id) && !(ch.output.kind === "bus" && ch.output.id === b.id),
                  );
                  if (!free) return;
                  onPatch({ sends: [...sends, { busId: free.id, gainDb: 0, pre: false, muted: false }] });
                }
                setPop(`send:${i}`);
              }}
            >
              {sd ? (
                <>
                  <span className="mx-slot-name">{busName(sd.busId)}</span>
                  <span className="mx-slot-val">{sd.pre ? "pre" : fmtDb(sd.gainDb)}</span>
                </>
              ) : (
                "+"
              )}
            </button>
          );
        })}
        {sends.map((sd, i) => (
          <Pop key={i} open={pop === `send:${i}`} onClose={close}>
            <div className="mx-pop-title">Envío {i + 1}</div>
            <label className="mixer-field">
              <span>Bus</span>
              <select value={sd.busId} onChange={(e) => setSend(i, { busId: e.target.value })}>
                {buses.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="mixer-field">
              <span>Nivel {fmtDb(sd.gainDb)} dB</span>
              <input
                type="range"
                min={MIN_GAIN_DB}
                max={MAX_GAIN_DB}
                step={0.5}
                value={sd.gainDb}
                onDoubleClick={() => setSend(i, { gainDb: 0 })}
                onChange={(e) => setSend(i, { gainDb: Number(e.target.value) })}
              />
            </label>
            <label className="check-row">
              <input type="checkbox" checked={sd.pre} onChange={(e) => setSend(i, { pre: e.target.checked })} />
              <span>Pre-fader (no le afecta el fader)</span>
            </label>
            <label className="check-row">
              <input type="checkbox" checked={sd.muted} onChange={(e) => setSend(i, { muted: e.target.checked })} />
              <span>Silenciado</span>
            </label>
            <button
              type="button"
              className="ghost-btn ghost-danger"
              onClick={() => {
                setSend(i, null);
                close();
              }}
            >
              Quitar envío
            </button>
          </Pop>
        ))}
      </div>

      <div className="mx-section">
        <span className="mx-label">I/O</span>
        <button type="button" className="mx-slot" title={inputLabel} onClick={() => setPop(pop === "io" ? "" : "io")}>
          {inputLabel}
        </button>
        <button type="button" className="mx-slot" title={outputLabel} onClick={() => setPop(pop === "io" ? "" : "io")}>
          {outputLabel}
        </button>
        <Pop open={pop === "io"} onClose={close}>
          <label className="mixer-field">
            <span>Entrada</span>
            <select
              value={ch.input.kind === "app" ? `app:${ch.input.app || "music"}` : `device:${ch.input.deviceId || "default"}`}
              onChange={(e) => {
                const [kind, ...rest] = e.target.value.split(":");
                const v = rest.join(":");
                onPatch({
                  input:
                    kind === "app"
                      ? { kind: "app", app: v === "preview" ? "preview" : v === "call" ? "call" : "music", deviceId: "" }
                      : { kind: "device", app: "", deviceId: v },
                });
              }}
            >
              <optgroup label="Aplicación">
                <option value="app:music">Reproducción de música</option>
                <option value="app:preview">Preescucha</option>
                <option value="app:call">Llamadas de oyentes</option>
              </optgroup>
              <optgroup label="Entradas">
                <option value="device:default">Entrada predeterminada</option>
                {inputs.map((d) => (
                  <option key={d.id} value={`device:${d.id}`}>
                    {d.label}
                  </option>
                ))}
              </optgroup>
            </select>
          </label>
          <label className="mixer-field">
            <span>Salida</span>
            <select
              value={ch.output.kind === "bus" ? `bus:${ch.output.id}` : `device:${ch.output.id || "default"}`}
              onChange={(e) => {
                const [kind, ...rest] = e.target.value.split(":");
                const v = rest.join(":");
                onPatch({ output: kind === "bus" ? { kind: "bus", id: v } : { kind: "device", id: v || "default" } });
              }}
            >
              {buses.length > 0 && (
                <optgroup label="Buses">
                  {buses.map((b) => (
                    <option key={b.id} value={`bus:${b.id}`}>
                      {b.name}
                    </option>
                  ))}
                </optgroup>
              )}
              <optgroup label="Emisión">
                <option value="device:streaming">Streaming (encoders)</option>
              </optgroup>
              <optgroup label="Tarjetas">
                <option value="device:default">Salida predeterminada</option>
                {outputs.map((d) => (
                  <option key={d.id} value={`device:${d.id}`}>
                    {d.label}
                  </option>
                ))}
              </optgroup>
            </select>
          </label>
        </Pop>
      </div>

      <PanKnob pan={ch.pan ?? 0} onCommit={(pan) => onPatch({ pan })} />

      <div className="mx-buttons">
        <button
          type="button"
          className={`mx-btn mx-solo ${ch.solo ? "mx-on" : ""}`}
          aria-pressed={!!ch.solo}
          title="Solo"
          onClick={() => onPatch({ solo: !ch.solo })}
        >
          S
        </button>
        <button
          type="button"
          className={`mx-btn mx-mute ${ch.muted ? "mx-on" : ""}`}
          aria-pressed={ch.muted}
          title="Silencio"
          onClick={() => onPatch({ muted: !ch.muted })}
        >
          M
        </button>
      </div>

      <div className="mx-fader-row">
        <Fader
          db={ch.gainDb}
          label={ch.name}
          onLive={(db) => void callMain("liveGain", key, db)}
          onCommit={(db) => onPatch({ gainDb: db })}
        />
        <StereoMeter store={meters} id={key} />
      </div>
      <div className="mx-db">{fmtDb(ch.gainDb)}</div>
      <NameField name={ch.name} onRename={(name) => onPatch({ name })} onRemove={onRemove} />
      <div className="mx-color">
        <ColorBar value={ch.color} label={ch.name} onChange={(color) => onPatch({ color })} />
      </div>
    </section>
  );
}

function BusStrip({
  bus,
  inputs,
  outputs,
  meters,
  isMonitor,
  onPatch,
  onRemove,
}: {
  bus: MixerBus;
  inputs: Device[];
  outputs: Device[];
  meters: React.MutableRefObject<MeterMap>;
  isMonitor: boolean;
  onPatch: (patch: Partial<MixerBus>) => void;
  onRemove: () => void;
}) {
  const [pop, setPop] = useState<"" | "insert" | "leveler" | "io">("");
  const close = useCallback(() => setPop(""), []);
  const out = bus.outputDeviceId || "default";
  const outputLabel =
    out === "streaming" ? "Streaming" : out === "default" ? "Predeterminada" : outputs.find((d) => d.id === out)?.label ?? "Salida";
  const key = `bus:${bus.id}`;
  return (
    <section className="mx-strip mx-bus" aria-label={bus.name}>
      <div className="mx-section">
        <span className="mx-label">INSERTS</span>
        <button
          type="button"
          className={`mx-slot ${bus.insert?.enabled ? "mx-slot-on" : ""}`}
          onClick={() => setPop(pop === "insert" ? "" : "insert")}
        >
          {bus.insert?.enabled ? "Envío/Ret." : "—"}
        </button>
        <button
          type="button"
          className={`mx-slot ${bus.leveler?.enabled ? "mx-slot-on" : ""}`}
          onClick={() => setPop(pop === "leveler" ? "" : "leveler")}
        >
          {bus.leveler?.enabled ? "Nivelador" : "—"}
        </button>
        <Pop open={pop === "insert"} onClose={close}>
          <InsertControls owner={bus} label={bus.name} inputs={inputs} outputs={outputs} onChange={(insert) => onPatch({ insert })} />
        </Pop>
        <Pop open={pop === "leveler"} onClose={close}>
          <LevelerControls owner={bus} label={bus.name} onChange={(leveler) => onPatch({ leveler })} />
        </Pop>
      </div>
      <div className="mx-section mx-grow-top">
        <span className="mx-label">BUS{isMonitor ? " · VU" : ""}</span>
      </div>
      <div className="mx-section">
        <span className="mx-label">I/O</span>
        <button type="button" className="mx-slot" title={outputLabel} onClick={() => setPop(pop === "io" ? "" : "io")}>
          {outputLabel}
        </button>
        <Pop open={pop === "io"} onClose={close}>
          <label className="mixer-field">
            <span>Salida</span>
            <select value={out} onChange={(e) => onPatch({ outputDeviceId: e.target.value })}>
              <option value="streaming">Streaming (encoders)</option>
              <option value="default">Salida predeterminada</option>
              {outputs.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.label}
                </option>
              ))}
            </select>
          </label>
        </Pop>
      </div>
      <PanKnob pan={bus.pan ?? 0} onCommit={(pan) => onPatch({ pan })} />
      <div className="mx-buttons">
        <button
          type="button"
          className={`mx-btn mx-mute ${bus.muted ? "mx-on" : ""}`}
          aria-pressed={bus.muted}
          title="Silencio"
          onClick={() => onPatch({ muted: !bus.muted })}
        >
          M
        </button>
      </div>
      <div className="mx-fader-row">
        <Fader
          db={bus.gainDb}
          label={bus.name}
          onLive={(db) => void callMain("liveGain", key, db)}
          onCommit={(db) => onPatch({ gainDb: db })}
        />
        <StereoMeter store={meters} id={key} />
      </div>
      <div className="mx-db">{fmtDb(bus.gainDb)}</div>
      <NameField name={bus.name} onRename={(name) => onPatch({ name })} onRemove={onRemove} />
      <div className="mx-color">
        <ColorBar value={bus.color} label={bus.name} onChange={(color) => onPatch({ color })} />
      </div>
    </section>
  );
}
