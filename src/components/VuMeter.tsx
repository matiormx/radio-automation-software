import { useEffect, useRef, useState } from "react";
type Level = { level: number; db: number };

interface VuMeterProps {
  mixer: { getMonitorLevel(): Level; getStreamLevel?(): Level } | null;
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
  const [level, setLevel] = useState(0);
  const [peak, setPeak] = useState(0);
  const [db, setDb] = useState(-60);
  const smooth = useRef(0);
  const hold = useRef(0);

  useEffect(() => {
    smooth.current = 0;
    hold.current = 0;
    if (!mixer) {
      setLevel(0);
      setPeak(0);
      setDb(-60);
      return;
    }

    let raf = 0;
    let last = 0;
    const tick = (time: number) => {
      raf = requestAnimationFrame(tick);
      if (time - last < 33) return;
      last = time;

      const next = source === "streaming" && mixer.getStreamLevel ? mixer.getStreamLevel() : mixer.getMonitorLevel();
      const raw = next.level;
      smooth.current =
        raw > smooth.current
          ? smooth.current + (raw - smooth.current) * 0.55
          : Math.max(raw, smooth.current * 0.86);
      hold.current = Math.max(smooth.current, hold.current - 0.006);

      setLevel(smooth.current);
      setPeak(hold.current);
      setDb(next.db);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [mixer, source]);

  const pct = Math.round(level * 100);
  const peakPct = Math.round(peak * 100);
  const options: { key: string; text: string; source: "master" | "streaming"; busId: string }[] = [
    { key: "master", text: "Master (salida general)", source: "master", busId: "" },
    ...buses.map((b) => ({ key: `bus:${b.id}`, text: `Bus · ${b.name}`, source: "master" as const, busId: b.id })),
    { key: "streaming", text: "Streaming (lo que reciben los encoders)", source: "streaming", busId: monitorBusId },
  ];
  const current = source === "streaming" ? "streaming" : monitorBusId && busName ? `bus:${monitorBusId}` : "master";

  return (
    <aside className="vu-rail" aria-label={source === "streaming" ? "Nivel de la salida de streaming" : "Nivel de salida"}>
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
      <div className="vu-track">
        <div className="vu-fill" style={{ height: `${pct}%` }} />
        <div className="vu-peak" style={{ bottom: `${peakPct}%` }} />
        <span className="vu-tick vu-tick-75" />
        <span className="vu-tick vu-tick-50" />
        <span className="vu-tick vu-tick-25" />
      </div>
      <span className="vu-db">{db <= -59.5 ? "-∞" : db.toFixed(0)}</span>
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
