import { useEffect, useState } from "react";
import { monitorThumbnail } from "../api";

/**
 * Miniatura de lo que sale por una emisión monitorizada (1 fps, barata).
 * Se pide por comando Tauri (base64), igual que la lee el móvil: un solo
 * camino, sin servidores HTTP de por medio.
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
  useEffect(() => {
    if (!active) return;
    let alive = true;
    const pull = async () => {
      try {
        const b64 = await monitorThumbnail(id);
        if (alive && b64) setSrc(`data:image/jpeg;base64,${b64}`);
      } catch {
        /* sin miniatura a estas alturas: sigue el marcador */
      }
    };
    void pull();
    const t = window.setInterval(() => void pull(), 1000);
    return () => {
      alive = false;
      window.clearInterval(t);
    };
  }, [active, id]);
  if (!active) return null;
  return src ? (
    <img className={className} alt="" title={title} src={src} />
  ) : (
    <span className={className} aria-hidden="true" />
  );
}
