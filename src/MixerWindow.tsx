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
  CompressorControls,
  PluginPicker,
  setVstHidden,
} from "./components/MixerControls";
import { confirmAsk, vstEditor, vstLatencies } from "./api";
import { callMain, onMainState } from "./bridge";
import { nativeDeviceOptions, nativeDevices, nativeInputs } from "./nativeEngine";
import { MAX_GAIN_DB, MIN_GAIN_DB } from "./mixer";
import type { MixerAgc, MixerBus, MixerChannel, MixerSend, PluginSlot, Settings } from "./types";
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

/** Latencia de plugins de una tira (muestras): solo los activos y cargados. */
function pluginLatency(plugins: PluginSlot[] | undefined, lat: Record<string, number>): number {
  return (plugins ?? []).filter((p) => p.enabled && !p.off).reduce((a, p) => a + (lat[p.id] ?? 0), 0);
}

const ms = (samples: number) => `${(samples / 48).toFixed(samples < 4800 ? 1 : 0).replace(".", ",")} ms`;

/** Dos canales con la misma fuente (misma entrada y mismo canal de la tarjeta). */
function sameSource(a: MixerChannel, b: MixerChannel): boolean {
  if (a.input.kind !== b.input.kind) return false;
  if (a.input.kind === "app") return a.input.app === b.input.app;
  return a.input.deviceId !== "none" && a.input.deviceId === b.input.deviceId && (a.input.channel ?? 0) === (b.input.channel ?? 0);
}

/**
 * Latencia de un canal y si debe ir sincronizado con los demás:
 * - «debe»: comparte fuente con otro canal de distinta latencia (sonaría a eco o a fase).
 * - «conviene»: va más de 20 ms por detrás de otros canales (se nota con vídeo o con varios micros).
 * - «libre»: diferencia imperceptible.
 */
function latencyAdvice(ch: MixerChannel, all: MixerChannel[], lat: Record<string, number>) {
  const own = pluginLatency(ch.plugins, lat);
  const others = all.filter((o) => o.id !== ch.id);
  const maxOther = others.reduce((m, o) => Math.max(m, pluginLatency(o.plugins, lat)), 0);
  const syncMax = all.filter((o) => o.sync).reduce((m, o) => Math.max(m, pluginLatency(o.plugins, lat)), 0);
  const twin = others.find((o) => sameSource(ch, o) && pluginLatency(o.plugins, lat) !== own);
  const diff = Math.max(Math.abs(own - maxOther), own);
  let level: "debe" | "conviene" | "libre" = "libre";
  let why = `${ms(own)} de latencia: imperceptible, puede ir por libre.`;
  if (twin) {
    level = "debe";
    why = `Comparte fuente con «${twin.name}» y tienen distinta latencia: sin sincronizar sonará a eco o a fase.`;
  } else if (diff > 960) {
    level = "conviene";
    why = `Diferencia de ${ms(diff)} con otros canales: si se emiten juntos (vídeo, varios micros), sincronízalo.`;
  }
  const wait = ch.sync ? Math.max(0, syncMax - own) : 0;
  return { own, level, why, wait, show: own > 0 || !!ch.sync || all.some((o) => o.sync) || !!twin };
}

/**
 * Plugins VST3 de un canal o bus, uno por casilla. Doble clic: abre su
 * ventana. Clic derecho: bypass, desactivar, mover o quitar. La casilla
 * «+ FX» del final añade otro.
 */
function FxSlots({
  plugins,
  isNative,
  onChange,
}: {
  plugins: PluginSlot[];
  isNative: boolean;
  onChange: (plugins: PluginSlot[]) => void;
}) {
  const [menu, setMenu] = useState<string | null>(null);
  const [err, setErr] = useState("");
  const closeMenu = useCallback(() => setMenu(null), []);
  const patch = (id: string, change: Partial<PluginSlot>) =>
    onChange(plugins.map((x) => (x.id === id ? { ...x, ...change } : x)));
  const move = (i: number, d: -1 | 1) => {
    const j = i + d;
    if (j < 0 || j >= plugins.length) return;
    const next = plugins.slice();
    [next[i], next[j]] = [next[j], next[i]];
    onChange(next);
  };
  const open = (p: PluginSlot) => {
    setErr("");
    if (p.off) {
      setErr("Está desactivado: actívalo para abrirlo.");
      setMenu(p.id);
      return;
    }
    void vstEditor(p).catch((e) => {
      setErr(String(e));
      setMenu(p.id);
    });
  };
  return (
    <>
      {plugins.map((p, i) => {
        const state = p.off ? "desactivado" : !p.enabled ? "bypass" : "activo";
        return (
          <div key={p.id} className="mx-fx-cell">
            <button
              type="button"
              className={`mx-slot ${p.off ? "mx-fx-off" : !p.enabled ? "mx-fx-bypass" : "mx-slot-on"}`}
              title={`${p.name} (${state})\nDoble clic: abrir · Clic derecho: opciones`}
              onDoubleClick={() => open(p)}
              onContextMenu={(e) => {
                e.preventDefault();
                setErr("");
                setMenu(menu === p.id ? null : p.id);
              }}
            >
              <span className="mx-slot-name">{p.name || "Plugin"}</span>
              {!p.off && !p.enabled && <span className="mx-slot-val">BYP</span>}
            </button>
            <Pop open={menu === p.id} onClose={closeMenu}>
              <div className="mx-menu">
                <div className="mx-pop-title">{p.name}</div>
                <button type="button" disabled={p.off} onClick={() => { setMenu(null); open(p); }}>
                  Abrir ventana
                </button>
                <button type="button" disabled={p.off} onClick={() => { patch(p.id, { enabled: !p.enabled }); setMenu(null); }}>
                  {p.enabled ? "Bypass (dejar pasar sin procesar)" : "Quitar bypass"}
                </button>
                <button type="button" onClick={() => { patch(p.id, { off: !p.off }); setMenu(null); }}>
                  {p.off ? "Activar" : "Desactivar (no se carga)"}
                </button>
                <button type="button" disabled={i === 0} onClick={() => { move(i, -1); setMenu(null); }}>
                  Subir
                </button>
                <button type="button" disabled={i === plugins.length - 1} onClick={() => { move(i, 1); setMenu(null); }}>
                  Bajar
                </button>
                <button type="button" className="mx-menu-danger" onClick={() => { onChange(plugins.filter((x) => x.id !== p.id)); setMenu(null); }}>
                  Quitar
                </button>
                {err && <p className="mixer-insert-hint">{err}</p>}
              </div>
            </Pop>
          </div>
        );
      })}
      <div className="mx-fx-cell">
        <button
          type="button"
          className="mx-slot mx-fx-add"
          title="Añadir un plugin VST3"
          onClick={() => setMenu(menu === "add" ? null : "add")}
        >
          + FX
        </button>
        <Pop open={menu === "add"} onClose={closeMenu}>
          <PluginPicker
            isNative={isNative}
            onPick={(path, name) => {
              const id = `vst${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
              onChange([...plugins, { id, path, name, enabled: true }]);
              setMenu(null);
            }}
          />
        </Pop>
      </div>
    </>
  );
}

type MonoMode = "off" | "sum" | "left" | "right";
const MONO_NEXT: Record<MonoMode, MonoMode> = { off: "sum", sum: "left", left: "right", right: "off" };
const MONO_LABEL: Record<MonoMode, string> = { off: "ST", sum: "L+R", left: "L", right: "R" };
const MONO_TIPS: Record<MonoMode, string> = {
  off: "Estéreo",
  sum: "Mono: suma L+R por los dos lados",
  left: "Mono: solo el lado izquierdo por los dos lados",
  right: "Mono: solo el lado derecho por los dos lados",
};

function fmtPan(pan: number): string {
  const v = Math.round(pan * 100);
  if (v === 0) return "centro";
  return v < 0 ? `${-v}% izquierda` : `${v}% derecha`;
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
        title={`Panorama ${fmtPan(value)} · arrastra arriba/abajo · doble clic: centro`}
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
  const [insertInputs, setInsertInputs] = useState<Device[]>([]);
  const [webInputs, setWebInputs] = useState<Device[]>([]);
  const [chanMap, setChanMap] = useState<Record<string, number>>(() => {
    try {
      return JSON.parse(localStorage.getItem("mx-in-channels") || "{}") as Record<string, number>;
    } catch {
      return {};
    }
  });
  const chanRef = useRef(chanMap);
  chanRef.current = chanMap;
  const refresh = useCallback(async () => {
    try {
      const list = (await navigator.mediaDevices?.enumerateDevices?.()) ?? [];
      const ins: Device[] = [];
      const outs: Device[] = [];
      for (const d of list) {
        if (!d.deviceId) continue;
        if (d.kind === "audioinput")
          ins.push({
            id: d.deviceId,
            label: d.label || `Entrada ${ins.length + 1}`,
            kind: "audioinput",
            channels: chanRef.current[d.deviceId],
          });
        if (d.kind === "audiooutput" && d.deviceId !== "default")
          outs.push({ id: d.deviceId, label: d.label || `Salida ${outs.length + 1}`, kind: "audiooutput" });
      }
      setWebInputs(ins);
      if (isNative) {
        const names = await nativeInputs().catch(() => [] as string[]);
        setInsertInputs(nativeDeviceOptions(names, "audioinput"));
        // Con el motor nativo, los canales capturan las tarjetas por su nombre
        // del sistema; el par/canal se elige aparte en el canal.
        const pairs = new Map<string, number>();
        for (const n of names) {
          const m = /^(.*)#(\d+)$/.exec(n);
          const base = m ? m[1] : n;
          pairs.set(base, Math.max(pairs.get(base) ?? 1, m ? Number(m[2]) : 1));
        }
        setInputs(Array.from(pairs, ([id, p]) => ({ id, label: id, kind: "audioinput" as const, channels: p * 2 })));
      } else {
        setInputs(ins);
        setInsertInputs(ins);
      }
      if (isNative) {
        const names = await nativeDevices().catch(() => [] as string[]);
        setOutputs(nativeDeviceOptions(names, "audiooutput"));
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
  const detect = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices?.getUserMedia?.({ audio: true });
      stream?.getTracks().forEach((t) => t.stop());
    } catch {
      /* sin permiso */
    }
    // Canales de cada entrada: se abre un instante pidiendo muchos y se lee lo que da.
    try {
      const list = (await navigator.mediaDevices?.enumerateDevices?.()) ?? [];
      const found: Record<string, number> = { ...chanRef.current };
      for (const d of list) {
        if (d.kind !== "audioinput" || !d.deviceId || d.deviceId === "default") continue;
        try {
          const st = await navigator.mediaDevices.getUserMedia({
            audio: {
              deviceId: { exact: d.deviceId },
              channelCount: { ideal: 64 },
              echoCancellation: false,
              noiseSuppression: false,
              autoGainControl: false,
            },
          });
          const n = st.getAudioTracks()[0]?.getSettings().channelCount;
          st.getTracks().forEach((t) => t.stop());
          if (n && n > 0) found[d.deviceId] = n;
        } catch {
          /* entrada ocupada o sin permiso */
        }
      }
      chanRef.current = found;
      setChanMap(found);
      try {
        localStorage.setItem("mx-in-channels", JSON.stringify(found));
      } catch {
        /* sin almacenamiento */
      }
    } catch {
      /* sin dispositivos */
    }
    await refresh();
  }, [refresh]);
  return { inputs, webInputs, insertInputs, outputs, detect };
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
  const { inputs, webInputs, insertInputs, outputs, detect } = useDevices(!!isNative);

  if (!s) {
    return (
      <div className="tool-window">
        <MixerTitle />
        <div className="tool-loading">Conectando con MiRadio…</div>
      </div>
    );
  }

  return (
    <div className="tool-window mx-window">
      <MixerTitle />
      <MixerBoard
        s={s}
        commit={commit}
        meters={meters}
        isNative={!!isNative}
        inputs={inputs}
        webInputs={webInputs}
        insertInputs={insertInputs}
        outputs={outputs}
        onDetect={detect}
      />
    </div>
  );
}

/** La misma mesa, dentro de Ajustes → Sonido. */
export function MixerEmbedded({ settings, onChange }: { settings: Settings; onChange: (next: Settings) => void }) {
  const meters = useRef<MeterMap>(new Map());
  const isNative = settings.audioEngine === "native";
  const { inputs, webInputs, insertInputs, outputs, detect } = useDevices(isNative);
  useEffect(() => {
    const offs: Array<Promise<() => void>> = [];
    type M = { key: string; l: number; r: number }[];
    const take = (list: M) => {
      const now = performance.now();
      for (const m of list) meters.current.set(m.key, { l: m.l, r: m.r, at: now });
    };
    offs.push(listen<M>("engine://meters", (e) => take(e.payload)));
    offs.push(listen<M>("mixer://meters", (e) => take(e.payload)));
    void callMain("meters", true).catch(() => undefined);
    return () => {
      void callMain("meters", false).catch(() => undefined);
      for (const o of offs) void o.then((fn) => fn());
    };
  }, []);
  return (
    <div className="mx-embedded mx-window">
      <MixerBoard
        s={settings}
        commit={onChange}
        meters={meters}
        isNative={isNative}
        inputs={inputs}
        webInputs={webInputs}
        insertInputs={insertInputs}
        outputs={outputs}
        onDetect={detect}
      />
    </div>
  );
}

const APP_NAMES = { music: "Música", preview: "Preescucha", call: "Llamadas" } as const;

function MixerBoard({
  s,
  commit,
  meters,
  isNative,
  inputs,
  webInputs,
  insertInputs,
  outputs,
  onDetect,
}: {
  s: Settings;
  commit: (next: Settings) => void;
  meters: React.MutableRefObject<MeterMap>;
  isNative: boolean;
  inputs: Device[];
  webInputs: Device[];
  insertInputs: Device[];
  outputs: Device[];
  onDetect: () => void;
}) {
  const channels = s.mixerChannels ?? [];
  const buses = s.mixerBuses ?? [];
  setVstHidden(s.vst?.hidden);
  // Latencia de los plugins (motor nativo): se mira cada 2 s.
  const [lat, setLat] = useState<Record<string, number>>({});
  const anyPlugins = channels.some((c) => (c.plugins ?? []).length > 0) || buses.some((b) => (b.plugins ?? []).length > 0);
  useEffect(() => {
    if (!isNative || !anyPlugins) {
      setLat({});
      return;
    }
    const tick = () => void vstLatencies().then(setLat).catch(() => undefined);
    tick();
    const t = window.setInterval(tick, 2000);
    return () => window.clearInterval(t);
  }, [isNative, anyPlugins]);
  // Todas las tiras con la cabecera igual de alta: los faders quedan alineados
  // aunque una tira tenga mas envios, plugins o ranuras que otra.
  const stripsRef = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    const root = stripsRef.current;
    if (!root) return;
    const tops = Array.from(root.querySelectorAll<HTMLElement>(".mx-top"));
    for (const t of tops) t.style.minHeight = "";
    const max = Math.max(0, ...tops.map((t) => t.offsetHeight));
    for (const t of tops) t.style.minHeight = `${max}px`;
  });
  // Motor nativo: las entradas guardadas con el id del WebView se pasan al
  // nombre de la tarjeta en el sistema (mismo nombre que ve Windows).
  useEffect(() => {
    if (!isNative || inputs.length === 0 || webInputs.length === 0) return;
    const names = new Set(inputs.map((d) => d.id));
    const clean = (l: string) => l.replace(/^(Predeterminado|Default|Comunicaciones|Communications)\s*-\s*/i, "").trim();
    let changed = false;
    const next = channels.map((c) => {
      if (c.input.kind !== "device") return c;
      const id = c.input.deviceId;
      if (!id || id === "none" || id === "default" || names.has(id)) return c;
      const web = webInputs.find((d) => d.id === id);
      const label = web ? clean(web.label) : "";
      if (!label || !names.has(label)) return c;
      changed = true;
      return { ...c, input: { ...c.input, deviceId: label } };
    });
    if (changed) commit({ ...s, mixerChannels: next });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isNative, inputs, webInputs]);
  const patchChannel = (id: string, patch: Partial<MixerChannel>) =>
    commit({ ...s, mixerChannels: channels.map((c) => (c.id === id ? { ...c, ...patch } : c)) });
  const patchBus = (id: string, patch: Partial<MixerBus>) =>
    commit({ ...s, mixerBuses: buses.map((b) => (b.id === id ? { ...b, ...patch } : b)) });

  const addChannel = (app: "music" | "preview" | "call" = "music", named = false) =>
    commit({
      ...s,
      mixerChannels: [
        ...channels,
        {
          id: newId(),
          name: named ? APP_NAMES[app] : `Canal ${channels.length + 1}`,
          color: nextColor(channels.length),
          // Un canal nuevo no tiene entrada ni salida hasta que se elijan;
          // los de aplicacion (musica, preescucha, llamadas) salen ya conectados.
          input: named ? { kind: "app", app, deviceId: "" } : { kind: "device", app: "", deviceId: "none" },
          output: !named
            ? { kind: "device", id: "none" }
            : buses[0]
              ? { kind: "bus", id: buses[0].id }
              : { kind: "device", id: "default" },
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

  const usedApps = new Set(
    channels.filter((c) => c.input.kind === "app").map((c) => (c.input.app || "music") as string),
  );
  const missingApps = (["music", "preview", "call"] as const).filter((a) => !usedApps.has(a));
  const toStream = (id: string) => (id || "").trim().toLowerCase() === "streaming";
  const streamFeeds = [
    ...channels.filter((c) => c.output.kind === "device" && toStream(c.output.id)).map((c) => `canal ${c.name}`),
    ...buses.filter((b) => toStream(b.outputDeviceId)).map((b) => `bus ${b.name}`),
  ];
  const masterDb = s.masterVolume <= 0.001 ? MIN_GAIN_DB : 20 * Math.log10(s.masterVolume);

  return (
    <div className="mx-board">
      <div className="mx-bar">
        <button type="button" className="btn btn-sm" onClick={() => addChannel()}>
          + Canal
        </button>
        <button type="button" className="btn btn-sm" onClick={addBus}>
          + Bus
        </button>
        <button
          type="button"
          className="btn btn-sm"
          title="Pide permiso para ver los nombres de las entradas y vuelve a buscar tarjetas"
          onClick={onDetect}
        >
          Detectar entradas
        </button>
        <label className="mx-engine" title="Nativo: todo el audio (música, entradas, preescucha, llamadas) se mezcla en MiRadio y va a las tarjetas por su nombre del sistema. Web: el motor de la ventana (solo estéreo por tarjeta).">
          Motor{" "}
          <select
            value={isNative ? "native" : "web"}
            aria-label="Motor de audio"
            onChange={(e) => {
              const next = e.target.value === "native" ? "native" : "web";
              void confirmAsk("Cambiar de motor detiene la reproducción. ¿Continuar? (No lo cambies en pleno directo.)", "Cambiar").then((ok) => {
                if (ok) commit({ ...s, audioEngine: next });
              });
            }}
          >
            <option value="native">Nativo</option>
            <option value="web">Web</option>
          </select>
        </label>
      </div>
      <div className="mx-notes">
        {missingApps.map((app) => (
          <div key={app} className={`mx-note ${app === "music" ? "mx-note-warn" : ""}`}>
            <span>
              {app === "music"
                ? "La música no tiene canal: no suena por ninguna salida y el detector de silencio no actúa."
                : app === "preview"
                  ? "La preescucha no tiene canal: no se oirá."
                  : "Las llamadas no tienen canal: no se oirá a los oyentes."}
            </span>
            <button type="button" className="btn btn-sm" onClick={() => addChannel(app, true)}>
              Crear canal «{APP_NAMES[app]}»
            </button>
          </div>
        ))}
        <div className="mx-note">
          <span>
            <strong>Streaming recibe:</strong>{" "}
            {streamFeeds.length > 0
              ? streamFeeds.join(", ")
              : "nada enrutado; los encoders reciben una copia de la salida predeterminada"}
            . El detector de silencio mide esta señal.
          </span>
        </div>
      </div>
      <div className="mx-strips" ref={stripsRef}>
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
            insertInputs={insertInputs}
            outputs={outputs}
            meters={meters}
            isNative={isNative}
            latency={latencyAdvice(ch, channels, lat)}
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
            inputs={insertInputs}
            meters={meters}
            isMonitor={s.monitorBusId === bus.id}
            isNative={isNative}
            latency={pluginLatency(bus.plugins, lat)}
            onPatch={(patch) => patchBus(bus.id, patch)}
            onRemove={() => removeBus(bus.id)}
          />
        ))}
        <div className="mx-sep" />
        <section className="mx-strip mx-master" aria-label="Master">
          <div className="mx-top">
          <div className="mx-section mx-grow-top">
            <span className="mx-label">MASTER · SALIDAS</span>
            <span className="mx-hint">Volumen de las salidas de tarjeta. No afecta al streaming.</span>
          </div>
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
        void confirmAsk(`¿Eliminar «${name}»?`, "Eliminar").then((ok) => ok && onRemove());
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
  insertInputs,
  outputs,
  meters,
  isNative,
  latency,
  onPatch,
  onRemove,
}: {
  latency: ReturnType<typeof latencyAdvice>;
  ch: MixerChannel;
  buses: MixerBus[];
  inputs: Device[];
  insertInputs: Device[];
  outputs: Device[];
  meters: React.MutableRefObject<MeterMap>;
  isNative: boolean;
  onPatch: (patch: Partial<MixerChannel>) => void;
  onRemove: () => void;
}) {
  const [pop, setPop] = useState<"" | "insert" | "leveler" | "comp" | "vst" | "in" | "gain" | "out" | `send:${number}`>("");
  const close = useCallback(() => setPop(""), []);
  const sends = ch.sends ?? [];
  const busName = (id: string) => buses.find((b) => b.id === id)?.name ?? "—";
  const monoMode: MonoMode = ch.monoMode === "sum" || ch.monoMode === "left" || ch.monoMode === "right" ? ch.monoMode : "off";
  const monoOn = monoMode !== "off";
  const agcMode: MixerAgc = ch.agc === "slow" || ch.agc === "fast" ? ch.agc : "off";
  const inChannels = inputs.find((d) => d.id === ch.input.deviceId)?.channels ?? 2;
  const inputLabel =
    ch.input.kind === "app"
      ? ch.input.app === "preview"
        ? "Preescucha"
        : ch.input.app === "call"
          ? "Llamadas"
          : "Música"
      : ch.input.deviceId === "none"
        ? "Ninguna"
        : (inputs.find((d) => d.id === ch.input.deviceId)?.label ?? "Entrada") +
          ((ch.input.channel ?? 0) > 0
            ? monoOn
              ? ` · c${ch.input.channel}`
              : ` · ${(ch.input.channel as number) * 2 - 1}-${(ch.input.channel as number) * 2}`
            : "");
  const outputLabel =
    ch.output.kind === "bus"
      ? busName(ch.output.id)
      : ch.output.id === "none"
        ? "Ninguna"
        : ch.output.id === "streaming"
        ? "Streaming"
        : ch.output.id === "default" || !ch.output.id
          ? "Predeterminada"
          : outputs.find((d) => d.id === ch.output.id)?.label ?? "Salida";
  const ownBus = ch.output.kind === "bus" ? ch.output.id : "";
  const freeBus = buses.find((b) => b.id !== ownBus && !sends.some((x) => x.busId === b.id));
  const setSend = (i: number, patch: Partial<MixerSend> | null) => {
    const next = sends.slice();
    if (patch === null) next.splice(i, 1);
    else next[i] = { ...next[i], ...patch };
    onPatch({ sends: next });
  };
  const key = `ch:${ch.id}`;

  return (
    <section className="mx-strip" aria-label={ch.name}>
      <div className="mx-top">
      <div className="mx-section">
        <span className="mx-label">ENTRADA</span>
        <button type="button" className="mx-slot" title={inputLabel} onClick={() => setPop(pop === "in" ? "" : "in")}>
          {inputLabel}
        </button>
        <Pop open={pop === "in"} onClose={close}>
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
                <option value="device:none">Ninguna</option>
                <option value="device:default">Entrada predeterminada</option>
                {inputs.map((d) => (
                  <option key={d.id} value={`device:${d.id}`}>
                    {d.label}
                  </option>
                ))}
              </optgroup>
            </select>
          </label>
          {ch.input.kind === "device" && ch.input.deviceId !== "none" && (
            <label className="mixer-field">
              <span>{monoOn ? "Canal (mono)" : "Canales (estéreo)"}</span>
              <select
                value={ch.input.channel ?? 0}
                onChange={(e) => onPatch({ input: { ...ch.input, channel: Number(e.target.value) } })}
              >
                {monoOn ? (
                  <>
                    <option value={0}>Mezcla de los dos lados</option>
                    {Array.from({ length: Math.max(inChannels, ch.input.channel ?? 0) }, (_, k) => (
                      <option key={k} value={k + 1}>
                        Canal {k + 1}
                      </option>
                    ))}
                  </>
                ) : (
                  Array.from({ length: Math.max(1, Math.ceil(inChannels / 2), ch.input.channel ?? 1) }, (_, k) => (
                    <option key={k} value={k + 1}>
                      Canales {k * 2 + 1}-{k * 2 + 2}
                    </option>
                  ))
                )}
              </select>
              <small className="mx-hint">
                {inputs.find((d) => d.id === ch.input.deviceId)?.channels !== undefined
                  ? `La tarjeta ofrece ${inChannels} canales.`
                  : "Pulsa «Detectar entradas» para ver cuántos canales tiene la tarjeta."}
              </small>
            </label>
          )}
        </Pop>
        <button
          type="button"
          className={`mx-slot ${agcMode !== "off" ? "mx-slot-on" : ""}`}
          title="Ganancia de entrada / control automático de ganancia"
          onClick={() => setPop(pop === "gain" ? "" : "gain")}
        >
          {agcMode === "slow" ? "AGC lento" : agcMode === "fast" ? "AGC rápido" : `Gain ${fmtDb(ch.inputGainDb ?? 0)}`}
        </button>
        <Pop open={pop === "gain"} onClose={close}>
          <div className="mx-pop-title">Ganancia de entrada</div>
          <label className="mixer-field">
            <span>Control automático (AGC)</span>
            <select value={agcMode} onChange={(e) => onPatch({ agc: e.target.value as MixerAgc })}>
              <option value="off">Apagado (ganancia manual)</option>
              <option value="slow">Lento (voz, programa)</option>
              <option value="fast">Rápido</option>
            </select>
          </label>
          <label className="mixer-field">
            <span>Ganancia {fmtDb(ch.inputGainDb ?? 0)} dB</span>
            <input
              type="range"
              min={-24}
              max={24}
              step={0.5}
              disabled={agcMode !== "off"}
              value={ch.inputGainDb ?? 0}
              onDoubleClick={() => onPatch({ inputGainDb: 0 })}
              onChange={(e) => onPatch({ inputGainDb: Number(e.target.value) })}
            />
          </label>
          <small className="mx-hint">
            Antes de inserts y fader. El AGC lleva la señal a unos −18 dB (sube hasta +18 dB) y solo funciona con el motor nativo.
          </small>
        </Pop>
      </div>

      <div className="mx-section">
        <span className="mx-label">INSERT</span>
        <button
          type="button"
          className={`mx-slot ${ch.insert?.enabled ? "mx-slot-on" : ""}`}
          onClick={() => setPop(pop === "insert" ? "" : "insert")}
        >
          {ch.insert?.enabled ? "Envío/Ret." : "—"}
        </button>
      </div>
      <div className="mx-section">
        <span className="mx-label">FX</span>
        <button
          type="button"
          className={`mx-slot ${ch.leveler?.enabled ? "mx-slot-on" : "mx-fx-idle"}`}
          title="Nivelador automático (clic para ajustar)"
          onClick={() => setPop(pop === "leveler" ? "" : "leveler")}
        >
          Nivelador
        </button>
        <button
          type="button"
          className={`mx-slot ${ch.compressor?.enabled ? "mx-slot-on" : "mx-fx-idle"}`}
          title="Compresor (clic para ajustar)"
          onClick={() => setPop(pop === "comp" ? "" : "comp")}
        >
          {ch.compressor?.enabled ? `Comp ${ch.compressor.ratio}:1` : "Compresor"}
        </button>
        <Pop open={pop === "comp"} onClose={close}>
          <CompressorControls owner={ch} label={ch.name} onChange={(compressor) => onPatch({ compressor })} />
        </Pop>
        <FxSlots plugins={ch.plugins ?? []} isNative={isNative} onChange={(plugins) => onPatch({ plugins })} />
        {isNative && latency.show && (
          <div className={`mx-lat mx-lat-${latency.level}`} title={`${latency.why}${latency.wait > 0 ? `\nSincronizado: espera ${ms(latency.wait)} para ir a la par del más lento.` : ""}`}>
            <span className="mx-lat-val">
              {ms(latency.own)}
              {latency.wait > 0 && <small> +{ms(latency.wait)}</small>}
            </span>
            <button
              type="button"
              className={`mx-lat-sync ${ch.sync ? "mx-lat-sync-on" : ""}`}
              onClick={() => onPatch({ sync: !ch.sync })}
              title={ch.sync ? "En el grupo sincronizado (clic para sacarlo)" : "Meter en el grupo que se sincroniza"}
            >
              SYNC
            </button>
          </div>
        )}
        <Pop open={pop === "insert"} onClose={close}>
          <InsertControls
            owner={ch}
            label={ch.name}
            inputs={insertInputs}
            outputs={outputs}
            mono={monoOn}
            onChange={(insert) => onPatch({ insert })}
          />
        </Pop>
        <Pop open={pop === "leveler"} onClose={close}>
          <LevelerControls owner={ch} label={ch.name} onChange={(leveler) => onPatch({ leveler })} />
        </Pop>
      </div>

      <div className="mx-section">
        <span className="mx-label">SENDS</span>
        {Array.from({ length: sends.length + (freeBus ? 1 : 0) }, (_, i) => i).map((i) => {
          const sd = sends[i];
          return (
            <button
              key={i}
              type="button"
              className={`mx-slot ${sd ? (sd.muted ? "mx-slot-muted" : "mx-slot-send") : ""}`}
              title={sd ? undefined : "Añadir un envío a otro bus"}
              onClick={() => {
                if (!sd) {
                  if (!freeBus) return;
                  onPatch({ sends: [...sends, { busId: freeBus.id, gainDb: 0, pre: false, muted: false }] });
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
        {buses.length === 0 && <span className="mx-hint">Crea un bus para poder enviar</span>}
        {sends.map((sd, i) => (
          <Pop key={i} open={pop === `send:${i}`} onClose={close}>
            <div className="mx-pop-title">Envío {i + 1}</div>
            <label className="mixer-field">
              <span>Bus</span>
              <select value={sd.busId} onChange={(e) => setSend(i, { busId: e.target.value })}>
                {buses
                  .filter((b) => b.id === sd.busId || (b.id !== ownBus && !sends.some((x) => x.busId === b.id)))
                  .map((b) => (
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
        <span className="mx-label">SALIDA</span>
        <button type="button" className="mx-slot" title={outputLabel} onClick={() => setPop(pop === "out" ? "" : "out")}>
          {outputLabel}
        </button>
        <Pop open={pop === "out"} onClose={close}>
          <label className="mixer-field">
            <span>Salida</span>
            <select
              value={ch.output.kind === "bus" ? `bus:${ch.output.id}` : `device:${ch.output.id || "default"}`}
              onChange={(e) => {
                const [kind, ...rest] = e.target.value.split(":");
                const v = rest.join(":");
                onPatch({
                  output: kind === "bus" ? { kind: "bus", id: v } : { kind: "device", id: v || "default" },
                  // Un envio al mismo bus de salida se sumaria dos veces: se quita.
                  ...(kind === "bus" ? { sends: sends.filter((x) => x.busId !== v) } : {}),
                });
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
                <option value="device:none">Ninguna (solo envíos)</option>
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
          className={`mx-btn mx-mono ${monoMode !== "off" ? "mx-on" : ""}`}
          aria-label="Modo de entrada"
          title={`${MONO_TIPS[monoMode]} · clic: cambiar (estéreo → L+R → L → R)`}
          onClick={() => onPatch({ monoMode: MONO_NEXT[monoMode] })}
        >
          {MONO_LABEL[monoMode]}
        </button>
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
  isNative,
  latency,
  isMonitor,
  onPatch,
  onRemove,
}: {
  bus: MixerBus;
  inputs: Device[];
  outputs: Device[];
  meters: React.MutableRefObject<MeterMap>;
  isNative: boolean;
  /** Latencia de sus plugins (muestras) */
  latency: number;
  isMonitor: boolean;
  onPatch: (patch: Partial<MixerBus>) => void;
  onRemove: () => void;
}) {
  const [pop, setPop] = useState<"" | "insert" | "leveler" | "comp" | "vst" | "io">("");
  const close = useCallback(() => setPop(""), []);
  const out = bus.outputDeviceId || "default";
  const outputLabel =
    out === "none" ? "Ninguna" : out === "streaming" ? "Streaming" : out === "default" ? "Predeterminada" : outputs.find((d) => d.id === out)?.label ?? "Salida";
  const key = `bus:${bus.id}`;
  return (
    <section className="mx-strip mx-bus" aria-label={bus.name}>
      <div className="mx-top">
      <div className="mx-section">
        <span className="mx-label">ENTRADA{isMonitor ? " · VU" : ""}</span>
        <span className="mx-slot mx-slot-bus" title={`Lo que envían los canales al bus «${bus.name}»`}>
          Bus {bus.name}
        </span>
      </div>
      <div className="mx-section">
        <span className="mx-label">INSERT</span>
        <button
          type="button"
          className={`mx-slot ${bus.insert?.enabled ? "mx-slot-on" : ""}`}
          onClick={() => setPop(pop === "insert" ? "" : "insert")}
        >
          {bus.insert?.enabled ? "Envío/Ret." : "—"}
        </button>
      </div>
      <div className="mx-section">
        <span className="mx-label">FX</span>
        <button
          type="button"
          className={`mx-slot ${bus.leveler?.enabled ? "mx-slot-on" : "mx-fx-idle"}`}
          title="Nivelador automático (clic para ajustar)"
          onClick={() => setPop(pop === "leveler" ? "" : "leveler")}
        >
          Nivelador
        </button>
        <button
          type="button"
          className={`mx-slot ${bus.compressor?.enabled ? "mx-slot-on" : "mx-fx-idle"}`}
          title="Compresor (clic para ajustar)"
          onClick={() => setPop(pop === "comp" ? "" : "comp")}
        >
          {bus.compressor?.enabled ? `Comp ${bus.compressor.ratio}:1` : "Compresor"}
        </button>
        <Pop open={pop === "comp"} onClose={close}>
          <CompressorControls owner={bus} label={bus.name} onChange={(compressor) => onPatch({ compressor })} />
        </Pop>
        <FxSlots plugins={bus.plugins ?? []} isNative={isNative} onChange={(plugins) => onPatch({ plugins })} />
        {isNative && latency > 0 && (
          <div className="mx-lat mx-lat-libre" title="Latencia de los plugins de este bus: retrasa por igual todo lo que pasa por él.">
            <span className="mx-lat-val">{ms(latency)}</span>
          </div>
        )}
        <Pop open={pop === "insert"} onClose={close}>
          <InsertControls owner={bus} label={bus.name} inputs={inputs} outputs={outputs} onChange={(insert) => onPatch({ insert })} />
        </Pop>
        <Pop open={pop === "leveler"} onClose={close}>
          <LevelerControls owner={bus} label={bus.name} onChange={(leveler) => onPatch({ leveler })} />
        </Pop>
      </div>
      <div className="mx-section mx-grow-top">
        <span className="mx-label">SALIDA</span>
        <button type="button" className="mx-slot" title={outputLabel} onClick={() => setPop(pop === "io" ? "" : "io")}>
          {outputLabel}
        </button>
        <Pop open={pop === "io"} onClose={close}>
          <label className="mixer-field">
            <span>Salida</span>
            <select value={out} onChange={(e) => onPatch({ outputDeviceId: e.target.value })}>
              <option value="streaming">Streaming (encoders)</option>
              <option value="none">Ninguna (solo envíos)</option>
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
