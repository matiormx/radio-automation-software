import { VideoSurface, type VideoState } from "../videoSurface";
import { useEffect, useRef, useState } from "react";
import { trackUrl } from "../api";
import { IconNote } from "../icons";
import { MonitorThumb } from "./MonitorThumb";

interface DeckZoneProps {
  title: string;
  artist: string;
  album: string;
  cover: string;
  current: number;
  total: number;
  spinning: boolean;
  next: string | null;
  nextArtist: string;
  nextAlbum: string;
  nextCover: string;
  nextDuration: number;
  onSeek: (seconds: number) => void;
  /** La pista que suena es un video: se ve en lugar de la portada */
  isVideo?: boolean;
  videoSource?: () => VideoState | null;
  /** Miniatura de lo que sale por streaming (salida monitorizada y en vivo) */
  monitorId?: string | null;
  /** Diagnóstico del FFmpeg de miniatura para poder mostrar por qué va negra */
  diag?: { attempts: number; frames: number; lastError: string | null } | null;
}

function fmtTime(secs: number): string {
  if (!secs || secs <= 0) return "0:00";
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

function Cover({ src, className }: { src: string; className: string }) {
  return (
    <div className={`${className} ${src ? "" : "cover-empty"}`}>
      <IconNote size={className === "deck-cover" ? 28 : 18} />
      {src && (
        <img
          src={trackUrl({ file: src })}
          alt=""
          loading="lazy"
          onError={(e) => {
            e.currentTarget.style.display = "none";
          }}
        />
      )}
    </div>
  );
}

export function DeckZone({
  title,
  artist,
  album,
  cover,
  current,
  total,
  spinning,
  next,
  nextArtist,
  nextAlbum,
  nextCover,
  nextDuration,
  onSeek,
  isVideo,
  videoSource,
  monitorId,
  diag,
}: DeckZoneProps) {
  // Posicion que el operador esta arrastrando (aun sin soltar).
  const [scrub, setScrub] = useState<number | null>(null);
  // Destino ya pedido al motor: se sigue mostrando hasta que el motor llega
  // para que la barra no rebote a la posicion vieja al soltar.
  const [target, setTarget] = useState<number | null>(null);
  const scrubRef = useRef<number | null>(null);
  const onSeekRef = useRef(onSeek);
  onSeekRef.current = onSeek;
  const hasTrack = title !== "";
  const shown = scrub ?? target ?? current;

  // Aplica el salto una sola vez, venga de soltar el raton o de una tecla.
  const commitScrub = () => {
    const value = scrubRef.current;
    scrubRef.current = null;
    setScrub(null);
    if (value === null) return;
    setTarget(value);
    onSeekRef.current(value);
  };

  // El destino se oculta cuando el motor ya esta ahi, o pasados 2 s por si el
  // salto no llegara a aplicarse.
  useEffect(() => {
    if (target !== null && Math.abs(current - target) <= 2) setTarget(null);
  }, [current, target]);
  useEffect(() => {
    if (target === null) return;
    const timer = window.setTimeout(() => setTarget(null), 2000);
    return () => window.clearTimeout(timer);
  }, [target]);
  const remaining = total > 0 ? Math.max(0, total - shown) : 0;
  const nextSub = [nextAlbum, nextDuration > 0 ? fmtTime(nextDuration) : ""].filter(Boolean).join(" · ");

  return (
    <section className="panel deck" aria-label="Emisión">
      <div className="deck-now">
        {isVideo && videoSource ? (
          <div className="deck-cover deck-video" title="Vídeo en el aire">
            <VideoSurface source={videoSource} output={false} />
          </div>
        ) : (
          <Cover src={cover} className="deck-cover" />
        )}
        <div className="deck-main">
          <div className="deck-label-row">
            <span className={`live-dot ${spinning ? "live-on" : ""}`} aria-hidden="true" />
            <span className="deck-label">{spinning ? "EN EMISIÓN" : "EN PAUSA"}</span>
          </div>
          <span className="deck-title" title={hasTrack ? title : ""}>
            {hasTrack ? title : "Sin emisión"}
          </span>
          {hasTrack && <span className="deck-artist">{artist || "Artista desconocido"}</span>}
          {hasTrack && album && <span className="deck-album">{album}</span>}
          {hasTrack && (
            <div className="progress-block">
              <input
                className="pbar"
                type="range"
                min={0}
                max={Math.max(1, Math.floor(total - 2))}
                step={1}
                value={Math.max(0, Math.floor(shown))}
                onChange={(e) => {
                  const value = Number(e.target.value);
                  scrubRef.current = value;
                  setScrub(value);
                }}
                onPointerUp={commitScrub}
                onKeyUp={commitScrub}
                aria-label="Posición de la pista"
              />
              <div className="progress-times">
                <span>{fmtTime(shown)}</span>
                <span className="remaining">-{fmtTime(remaining)}</span>
                <span>{fmtTime(total)}</span>
              </div>
            </div>
          )}
        </div>
      </div>

      <div className={`deck-next ${monitorId ? "has-monitor" : ""}`}>
        {monitorId ? (
          <div className="deck-monitor-only">
            <span className="deck-next-label">LO QUE SALE · STREAMING</span>
            <MonitorThumb
              id={monitorId}
              active
              className="deck-monitor-big"
              title="Miniatura de lo que sale por streaming (1 imagen por segundo)"
              diag={diag}
            />
          </div>
        ) : (
          <>
            <span className="deck-next-label">A CONTINUACIÓN</span>
            {next ? (
              <div className="deck-next-body">
                <Cover src={nextCover} className="deck-next-cover" />
                <div className="deck-next-meta">
                  <span className="deck-next-val" title={next}>{next}</span>
                  <span className="deck-next-artist">{nextArtist || "Artista desconocido"}</span>
                  {nextSub && <span className="deck-next-sub">{nextSub}</span>}
                </div>
              </div>
            ) : (
              <span className="deck-next-empty">—</span>
            )}
          </>
        )}
      </div>
    </section>
  );
}
