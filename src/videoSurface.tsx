import { useEffect, useRef, useState } from "react";
import { trackUrl } from "./api";

/** Lo que suena, para pintar su video (o su portada) sincronizado con el audio. */
export interface VideoState {
  trackId: string;
  file: string;
  isVideo: boolean;
  /** Segundo del archivo que suena ahora */
  pos: number;
  playing: boolean;
  title: string;
  artist: string;
  cover: string;
  /** Con audio: "cover" (portada y titulo), "logo" o "black" */
  audioMode: "cover" | "logo" | "black";
  logo: string;
  stationName: string;
}

interface Props {
  /** Se consulta varias veces por segundo (sin re-renderizar la app). */
  source: () => VideoState | null;
  /** Ventana de emision (pantalla completa) o vista previa pequeña */
  output: boolean;
}

/**
 * Video sincronizado con el motor de audio: el <video> va siempre en
 * silencio (el sonido sale por la mesa) y se corrige si se desvia.
 */
export function VideoSurface({ source, output }: Props) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [shown, setShown] = useState<VideoState | null>(null);
  const shownKey = useRef("");
  const lastSeek = useRef(0);
  const [failed, setFailed] = useState("");

  useEffect(() => {
    let alive = true;
    const tick = () => {
      if (!alive) return;
      const s = source();
      const key = s ? `${s.trackId}|${s.file}|${s.isVideo}|${s.audioMode}|${s.title}|${s.cover}|${s.logo}` : "";
      if (key !== shownKey.current) {
        shownKey.current = key;
        setShown(s);
      }
      const v = videoRef.current;
      if (s?.isVideo && v && v.readyState >= 1) {
        const drift = Math.abs(v.currentTime - s.pos);
        const now = performance.now();
        if (drift > (s.playing ? 0.3 : 0.08) && now - lastSeek.current > 600) {
          lastSeek.current = now;
          try {
            v.currentTime = Math.max(0, s.pos);
          } catch {
            /* aun no se puede buscar */
          }
        }
        if (s.playing && v.paused) void v.play().catch(() => undefined);
        if (!s.playing && !v.paused) v.pause();
      }
    };
    const t = window.setInterval(tick, 150);
    tick();
    return () => {
      alive = false;
      window.clearInterval(t);
    };
  }, [source]);

  if (!shown) return output ? <div className="vs-root vs-black" /> : null;

  if (shown.isVideo) {
    return (
      <div className={`vs-root ${output ? "vs-output" : "vs-preview"}`}>
        <video
          key={shown.file}
          ref={videoRef}
          className="vs-video"
          src={trackUrl({ file: shown.file })}
          muted
          playsInline
          preload="auto"
          disablePictureInPicture
          onLoadedMetadata={(e) => {
            setFailed("");
            const s = source();
            if (s) e.currentTarget.currentTime = Math.max(0, s.pos);
          }}
          onError={() => setFailed(shown.file)}
        />
        {failed === shown.file && <div className="vs-error">No se puede mostrar la imagen de este vídeo (el audio sigue sonando)</div>}
      </div>
    );
  }

  if (!output) return null;
  if (shown.audioMode === "black") return <div className="vs-root vs-black" />;
  if (shown.audioMode === "logo") {
    return (
      <div className="vs-root vs-black vs-center">
        {shown.logo ? <img className="vs-logo" src={trackUrl({ file: shown.logo })} alt="" /> : <div className="vs-station">{shown.stationName}</div>}
      </div>
    );
  }
  return (
    <div className="vs-root vs-audio">
      {shown.cover && <img className="vs-bg" src={trackUrl({ file: shown.cover })} alt="" />}
      <div className="vs-card">
        {shown.cover ? <img className="vs-cover" src={trackUrl({ file: shown.cover })} alt="" /> : <div className="vs-cover vs-cover-empty" />}
        <div className="vs-text">
          <div className="vs-title">{shown.title}</div>
          <div className="vs-artist">{shown.artist}</div>
          <div className="vs-station-small">{shown.stationName}</div>
        </div>
      </div>
    </div>
  );
}
