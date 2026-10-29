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
  const [failed, setFailed] = useState(false);
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
  if (!active) return null;
  // Mientras el monitor produce la primera imagen (o si el FFmpeg de
  // miniatura falla) se ve el hueco negro: la miniatura aparece sola cuando
  // hay imagen y se reintenta cada segundo, sin dejar el hueco invisible.
  if (!base || failed) {
    return <span className={className} aria-hidden="true" />;
  }
  return (
    <img
      className={className}
      alt=""
      title={title}
      onError={() => setFailed(true)}
      onLoad={() => setFailed(false)}
      src={`${base}/m/monitor:${id}.jpg?${tick}`}
    />
  );
}
