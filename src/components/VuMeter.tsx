import { useEffect, useRef, useState } from "react";
import type { VUStereoLevel } from "../types";

interface VuMeterProps {
  mixer: {
    getMonitorLevel(): VUStereoLevel;
    getStreamLevel?(): VUStereoLevel;
  } | null;
  /** Que mide: la salida general o lo que va al streaming */
  source?: "master" | "streaming";
  /** Buses de la mesa (se puede medir cualquiera) */
  buses?: { id: string; name: string }[];
  /** Bus medido cuando la fuente es la salida general ("" = master) */
  monitorBusId?: string;
  onSelect?: (source: "master" | "streaming", busId: string) => void;
}

export function VuMeter({ mixer, source = "master", buses = [], monitorBusId = "", onSelect }: VuMeterProps) {
  const [menu, setMenu] = useState<{ left: number; top: number } | null>(null);
  const busName = buses.find((b) => b.id === monitorBusId)?.name;
  const label = source === "streaming" ? "Streaming" : busName ?? "Master";
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const key = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", key);
    };
  }, [menu]);
  const [left, setLeft] = useState(0);
  const [right, setRight] = useState(0);
  const [leftPeak, setLeftPeak] = useState(0);
  const [rightPeak, setRightPeak] = useState(0);
  const [dbL, setDbL] = useState(-60);
  const [dbR, setDbR] = useState(-60);
  const smooth = useRef({ l: 0, r: 0, hl: 0, hr: 0 });

  useEffect(() => {
    smooth.current = { l: 0, r: 0, hl: 0, hr: 0 };
    const reset = () => {
      setLeft(0);
      setRight(0);
      setLeftPeak(0);
      setRightPeak(0);
      setDbL(-60);
      setDbR(-60);
    };
    if (!mixer) {
      reset();
      return;
    }

    let raf = 0;
    let last = 0;
    const smoothStep = (current: number, raw: number) =>
      raw > current ? current + (raw - current) * 0.55 : Math.max(raw, current * 0.86);
    const tick = (time: number) => {
      raf = requestAnimationFrame(tick);
      if (time - last < 33) return;
      last = time;

      const next: VUStereoLevel =
        source === "streaming" && mixer.getStreamLevel
          ? mixer.getStreamLevel()
          : mixer.getMonitorLevel();
      const s = smooth.current;
      s.l = smoothStep(s.l, next.left?.level ?? next.level);
      s.r = smoothStep(s.r, next.right?.level ?? next.level);
      s.hl = Math.max(s.l, s.hl - 0.006);
      s.hr = Math.max(s.r, s.hr - 0.006);

      setLeft(s.l);
      setRight(s.r);
      setLeftPeak(s.hl);
      setRightPeak(s.hr);
      setDbL(next.left?.db ?? next.db);
      setDbR(next.right?.db ?? next.db);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [mixer, source]);

  const options: { key: string; text: string; source: "master" | "streaming"; busId: string }[] = [
    { key: "master", text: "Master (salida general)", source: "master", busId: "" },
    ...buses.map((b) => ({ key: `bus:${b.id}`, text: `Bus · ${b.name}`, source: "master" as const, busId: b.id })),
    { key: "streaming", text: "Streaming (lo que reciben los encoders)", source: "streaming", busId: monitorBusId },
  ];
  const current = source === "streaming" ? "streaming" : monitorBusId && busName ? `bus:${monitorBusId}` : "master";
  const sides = [
    { key: "l", name: "L", level: left, peak: leftPeak, db: dbL },
    { key: "r", name: "R", level: right, peak: rightPeak, db: dbR },
  ];
  const fmtDb = (db: number) => (db <= -59.5 ? "-∞" : db.toFixed(0));

  return (
    <aside
      className="vu-rail"
      aria-label={`${source === "streaming" ? "Nivel de la salida de streaming" : "Nivel de salida"} (estereo)`}
    >
      <button
        type="button"
        className={`vu-title vu-switch ${source === "streaming" ? "vu-switch-on" : ""}`}
        title={`Midiendo: ${label}. Clic para elegir qué medir`}
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          setMenu(menu ? null : { left: r.right + 6, top: r.top });
        }}
      >
        {source === "streaming" ? "STR" : busName ? "BUS" : "VU"}
      </button>
      <div className="vu-tracks">
        {sides.map((s) => (
          <div className="vu-channel" key={s.key}>
            <div className="vu-track" title={`Canal ${s.name}`}>
              <div className="vu-fill" style={{ height: `${Math.round(s.level * 100)}%` }} />
              <div className="vu-peak" style={{ bottom: `${Math.round(s.peak * 100)}%` }} />
              <span className="vu-tick vu-tick-75" />
              <span className="vu-tick vu-tick-50" />
              <span className="vu-tick vu-tick-25" />
            </div>
            <span className="vu-ch">{s.name}</span>
          </div>
        ))}
      </div>
      <div className="vu-db" title="Nivel de cada canal en dBFS">
        {sides.map((s) => (
          <span key={s.key}>{fmtDb(s.db)}</span>
        ))}
      </div>
      <span className="vu-src" title={`Midiendo: ${label}`}>
        {label}
      </span>
      {menu && (
        <div className="vu-menu" style={{ left: menu.left, top: menu.top }} onMouseDown={(e) => e.stopPropagation()}>
          <div className="vu-menu-title">El medidor mide…</div>
          {options.map((o) => (
            <button
              key={o.key}
              type="button"
              className={`vu-menu-item ${current === o.key ? "vu-menu-on" : ""}`}
              onClick={() => {
                onSelect?.(o.source, o.busId);
                setMenu(null);
              }}
            >
              {current === o.key ? "● " : "○ "}
              {o.text}
            </button>
          ))}
        </div>
      )}
    </aside>
  );
}
