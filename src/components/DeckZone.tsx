import { useState } from "react";
import { trackUrl } from "../api";
import { IconNote } from "../icons";

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
}: DeckZoneProps) {
  const [scrub, setScrub] = useState<number | null>(null);
  const hasTrack = title !== "";
  const shown = scrub ?? current;
  const remaining = total > 0 ? Math.max(0, total - shown) : 0;
  const nextSub = [nextAlbum, nextDuration > 0 ? fmtTime(nextDuration) : ""].filter(Boolean).join(" · ");

  return (
    <section className="panel deck" aria-label="Emisión">
      <div className="deck-now">
        <Cover src={cover} className="deck-cover" />
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
      </div>

      <div className="deck-next">
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
      </div>
    </section>
  );
}
