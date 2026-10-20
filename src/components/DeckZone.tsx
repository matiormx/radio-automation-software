import { useState } from "react";
import { IconVinyl } from "../icons";

interface DeckZoneProps {
  title: string;
  artist: string;
  current: number;
  total: number;
  spinning: boolean;
  onSeek: (seconds: number) => void;
}

function fmtTime(secs: number): string {
  if (!secs || secs <= 0) return "0:00";
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function DeckZone({ title, artist, current, total, spinning, onSeek }: DeckZoneProps) {
  const [scrub, setScrub] = useState<number | null>(null);
  const hasTrack = title !== "";

  const shown = scrub ?? current;

  return (
    <section className="panel deck" aria-label="Lo que suena ahora">
      <div className="deck-left">
        <span className={spinning ? "spin-wrap spinning" : "spin-wrap"}>
          <IconVinyl size={144} />
        </span>
      </div>
      <div className="deck-right">
        <span className="deck-label">{spinning ? "Suenan ahora" : "En la radio"}</span>
        <span className="deck-title" title={title}>
          {hasTrack ? title : "Toca una cancion de la lista para empezar"}
        </span>
        {hasTrack && <span className="deck-artist">{artist}</span>}
        {hasTrack && (
          <>
            <div className="meta-time">
              <span>{fmtTime(shown)}</span>
              <span>{fmtTime(total)}</span>
            </div>
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
              aria-label="Posicion de la cancion"
            />
          </>
        )}
      </div>
    </section>
  );
}
