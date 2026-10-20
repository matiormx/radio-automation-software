import { useState } from "react";

interface DeckZoneProps {
  title: string;
  artist: string;
  current: number;
  total: number;
  spinning: boolean;
  next: string | null;
  onSeek: (seconds: number) => void;
}

function fmtTime(secs: number): string {
  if (!secs || secs <= 0) return "0:00";
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function DeckZone({ title, artist, current, total, spinning, next, onSeek }: DeckZoneProps) {
  const [scrub, setScrub] = useState<number | null>(null);
  const hasTrack = title !== "";
  const shown = scrub ?? current;
  const remaining = total > 0 ? Math.max(0, total - shown) : 0;

  return (
    <section className="panel deck" aria-label="Emisión">
      <div className="deck-main">
        <div className="deck-label-row">
          <span className={`live-dot ${spinning ? "live-on" : ""}`} aria-hidden="true" />
          <span className="deck-label">{spinning ? "EN EMISIÓN" : "EN PAUSA"}</span>
        </div>
        <span className="deck-title" title={hasTrack ? title : ""}>
          {hasTrack ? title : "Sin emisión"}
        </span>
        {hasTrack && <span className="deck-artist">{artist}</span>}
        {hasTrack && (
          <div className="progress-block">
            <input
              className="pbar"
              type="range"
              min={0}
              max={Math.max(1, Math.floor(total - 2))}
              step={1}
              value={Math.max(0, Math.floor(shown))}
              onChange={(e) => setScrub(Number(e.target.value))}
              onPointerUp={() => {
                if (scrub !== null) onSeek(scrub);
                setScrub(null);
              }}
              onKeyUp={() => {
                if (scrub !== null) onSeek(scrub);
                setScrub(null);
              }}
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
      <div className="deck-side">
        <div className={`eq ${spinning ? "eq-on" : ""}`} aria-hidden="true">
          <span /><span /><span /><span /><span />
        </div>
        <div className="deck-next">
          <span className="deck-next-label">A CONTINUACIÓN</span>
          <span className="deck-next-val" title={next ?? ""}>{next ?? "—"}</span>
        </div>
      </div>
    </section>
  );
}
