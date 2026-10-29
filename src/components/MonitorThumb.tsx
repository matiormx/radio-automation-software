import { useEffect, useState } from "react";
import { monitorServer } from "../api";

/**
 * Miniatura de lo que sale por una emisión monitorizada (1 fps, barata):
 * el mismo monitor sirve a Ajustes > Streaming y al panel principal.
 */
export function MonitorThumb({
  id,
  active,
  className = "stream-thumb",
  title = "Miniatura de lo que sale (actualizada cada segundo)",
}: {
  id: string;
  active: boolean;
  /** Clase de tamaño/presentación (stream-thumb, deck-monitor…) */
  className?: string;
  title?: string;
}) {
  const [base, setBase] = useState("");
  const [tick, setTick] = useState(0);
  useEffect(() => {
    void monitorServer()
      .then((url) => setBase(url))
      .catch(() => undefined);
  }, []);
  useEffect(() => {
    if (!active || !base) return;
    const t = window.setInterval(() => setTick((v) => v + 1), 1000);
    return () => window.clearInterval(t);
  }, [active, base]);
  if (!active || !base) return null;
  return (
    <img
      className={className}
      alt=""
      title={title}
      onError={(e) => {
        e.currentTarget.style.visibility = "hidden";
      }}
      onLoad={(e) => {
        e.currentTarget.style.visibility = "visible";
      }}
      src={`${base}/m/monitor:${id}.jpg?${tick}`}
    />
  );
}
