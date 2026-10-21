import { useEffect, useRef, useState } from "react";
import type { SoundMixer } from "../mixer";

interface VuMeterProps {
  mixer: SoundMixer | null;
}

export function VuMeter({ mixer }: VuMeterProps) {
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

      const next = mixer.getMonitorLevel();
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
  }, [mixer]);

  const pct = Math.round(level * 100);
  const peakPct = Math.round(peak * 100);

  return (
    <aside className="vu-rail" aria-label="Nivel de salida">
      <span className="vu-title">VU</span>
      <div className="vu-track">
        <div className="vu-fill" style={{ height: `${pct}%` }} />
        <div className="vu-peak" style={{ bottom: `${peakPct}%` }} />
        <span className="vu-tick vu-tick-75" />
        <span className="vu-tick vu-tick-50" />
        <span className="vu-tick vu-tick-25" />
      </div>
      <span className="vu-db">{db <= -59.5 ? "-∞" : db.toFixed(0)}</span>
    </aside>
  );
}
