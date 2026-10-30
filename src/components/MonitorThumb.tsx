import { useEffect, useState } from "react";
import { monitorThumbnail } from "../api";

/**
 * Miniatura de lo que sale por una emisión monitorizada (1 fps, barata).
 * Se pide por comando Tauri (base64), igual que la lee el móvil: un solo
 * camino, sin servidores HTTP de por medio. Mientras no hay imagen muestra
 * el motivo en el hueco, para no quedarse a ciegas.
 */
export function MonitorThumb({
  id,
  active,
  className = "stream-thumb",
  title = "Miniatura de lo que sale (actualizada cada segundo)",
}: {
  id: string;
  active: boolean;
  /** Clase de tamaño/presentación (stream-thumb, deck-monitor-big…) */
  className?: string;
  title?: string;
}) {
  const [src, setSrc] = useState<string | null>(null);
  const [state, setState] = useState<{ since: number; err: string | null }>({ since: Date.now(), err: null });
  useEffect(() => {
    if (!active) return;
    setSrc(null);
    setState({ since: Date.now(), err: null });
    let alive = true;
    const pull = async () => {
      try {
        const b64 = await monitorThumbnail(id);
        if (!alive) return;
        if (b64) {
          setSrc(`data:image/jpeg;base64,${b64}`);
          setState((p) => ({ since: p.since, err: null }));
        } else {
          setState((p) => ({
            since: p.since,
            err: `sin imagen (${Math.round((Date.now() - p.since) / 1000)} s)`,
          }));
        }
      } catch (e) {
        if (alive) setState((p) => ({ since: p.since, err: String(e instanceof Error ? e.message : e) }));
      }
    };
    void pull();
    const t = window.setInterval(() => void pull(), 1000);
    return () => {
      alive = false;
      window.clearInterval(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, id]);
  if (!active) return null;
  return src ? (
    <img className={className} alt="" title={title} src={src} />
  ) : (
    <span className={`${className} mwait`}>{state.err ?? "esperando…"}</span>
  );
}
