import { useCallback, useEffect, useRef, useState } from "react";
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
  /** Capturadora que se muestra en la ventana externa */
  capture?: { source: string; deviceId?: string } | null;
  /** Espejo horizontal solo en la ventana de los locutores */
  mirror?: boolean;
  /** Si la capturadora no tiene señal: "program" (lo que suena) o "none" (negro) */
  captureFallback?: "program" | "none";
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
  const captureRef = useRef<HTMLVideoElement | null>(null);
  const [shown, setShown] = useState<VideoState | null>(null);
  const shownKey = useRef("");
  const lastSeek = useRef(0);
  const [failed, setFailed] = useState("");
  const [captureDown, setCaptureDown] = useState(false);
  const [noSignal, setNoSignal] = useState(false);
  const streamRef = useRef<MediaStream | null>(null);
  const frames = useRef(0);
  // Engancha la capturadora al <video> cada vez que se monta (cambia de sitio
  // al pasar al respaldo) y cuenta los fotogramas que llegan.
  const attachCapture = useCallback((el: HTMLVideoElement | null) => {
    captureRef.current = el;
    if (!el) return;
    if (streamRef.current && el.srcObject !== streamRef.current) {
      el.srcObject = streamRef.current;
      void el.play().catch(() => undefined);
    }
    const anyEl = el as HTMLVideoElement & { requestVideoFrameCallback?: (cb: () => void) => number };
    if (anyEl.requestVideoFrameCallback) {
      const loop = () => {
        frames.current += 1;
        if (captureRef.current === el) anyEl.requestVideoFrameCallback?.(loop);
      };
      anyEl.requestVideoFrameCallback(loop);
    }
  }, []);

  useEffect(() => {
    let alive = true;
    const tick = () => {
      if (!alive) return;
      const s = source();
      const key = s
        ? `${s.trackId}|${s.file}|${s.isVideo}|${s.audioMode}|${s.title}|${s.cover}|${s.logo}|${s.capture?.source ?? ""}|${s.capture?.deviceId ?? ""}`
        : "";
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

  // Capturadora en la ventana externa (se abre con permiso del WebView).
  const capture = shown?.capture ?? null;
  const captureSource = capture?.source ?? "";
  const captureDevice = capture?.deviceId ?? "";
  useEffect(() => {
    if (!capture || !output) return;
    let cancelled = false;
    let stream: MediaStream | null = null;
    setFailed("");
    setCaptureDown(false);
    const onCaptureLost = () => {
      if (!cancelled) setCaptureDown(true);
    };
    const open = async () => {
      const constraints: MediaStreamConstraints = {
        audio: false,
        video: captureDevice
          ? { deviceId: { exact: captureDevice } }
          : captureSource
            ? { deviceId: { exact: captureSource } }
            : true,
      };
      try {
        stream = await navigator.mediaDevices.getUserMedia(constraints);
      } catch {
        try {
          const devices = await navigator.mediaDevices.enumerateDevices();
          const match = devices.find(
            (device) =>
              device.kind === "videoinput" &&
              (device.deviceId === captureSource ||
                device.label === captureSource ||
                device.label.startsWith(captureSource)),
          );
          stream = await navigator.mediaDevices.getUserMedia({
            audio: false,
            video: match ? { deviceId: { exact: match.deviceId } } : true,
          });
        } catch {
          if (!cancelled) setCaptureDown(true);
          return;
        }
      }
      if (!stream) return;
      if (cancelled) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      const track = stream.getVideoTracks()[0];
      if (track) track.addEventListener("ended", onCaptureLost);
      streamRef.current = stream;
      if (captureRef.current) attachCapture(captureRef.current);
    };
    void open();
    return () => {
      cancelled = true;
      const track = stream?.getVideoTracks()[0];
      if (track) track.removeEventListener("ended", onCaptureLost);
      stream?.getTracks().forEach((item) => item.stop());
      streamRef.current = null;
      if (captureRef.current) captureRef.current.srcObject = null;
    };
  }, [capture, captureSource, captureDevice, output]);

  // Sin señal: una capturadora sin imagen suele dar negro o la ultima imagen
  // congelada. Se mira la imagen dos veces por segundo; si no hay señal se
  // pasa al respaldo (lo que suena) y se vuelve sola cuando llega imagen.
  const fallbackOn = shown?.captureFallback !== "none";
  useEffect(() => {
    if (!capture || !output || !fallbackOn) return;
    const canvas = document.createElement("canvas");
    canvas.width = 32;
    canvas.height = 18;
    const g = canvas.getContext("2d", { willReadFrequently: true });
    let lastFrames = -1;
    const hasRvfc = "requestVideoFrameCallback" in HTMLVideoElement.prototype;
    let badSince = 0;
    let goodSince = 0;
    const t = window.setInterval(() => {
      const v = captureRef.current;
      if (!g || !v || v.readyState < 2 || !v.videoWidth) return;
      try {
        g.drawImage(v, 0, 0, 32, 18);
      } catch {
        return;
      }
      const px = g.getImageData(0, 0, 32, 18).data;
      let luma = 0;
      for (let i = 0; i < px.length; i += 4) luma += 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
      luma /= px.length / 4;
      // Sin fotogramas nuevos (la capturadora dejo de mandar) o imagen negra.
      const stalled = frames.current === lastFrames;
      lastFrames = frames.current;
      const now = performance.now();
      const bad = luma < 6 || (stalled && hasRvfc);
      if (bad) {
        goodSince = 0;
        if (!badSince) badSince = now;
        if (now - badSince > 3000) setNoSignal(true);
      } else {
        badSince = 0;
        if (!goodSince) goodSince = now;
        if (now - goodSince > 1000) setNoSignal(false);
      }
    }, 500);
    return () => {
      window.clearInterval(t);
      setNoSignal(false);
    };
  }, [capture, output, fallbackOn]);

  if (!shown) return output ? <div className="vs-root vs-black" /> : null;

  // La capturadora sigue abierta (oculta) mientras suena el respaldo, para
  // detectar cuando vuelve la señal.
  const captureEl =
    shown.capture && output && !captureDown ? (
      <video
        ref={attachCapture}
        className="vs-video"
        style={{
          transform: shown.mirror ? "scaleX(-1)" : undefined,
          ...(noSignal ? { position: "absolute", width: 2, height: 2, opacity: 0, pointerEvents: "none" } : {}),
        }}
        muted
        playsInline
        autoPlay
        disablePictureInPicture
      />
    ) : null;
  if (shown.capture && output && !captureDown && !noSignal) {
    return <div className="vs-root vs-output">{captureEl}</div>;
  }
  if (shown.capture && output && (captureDown || noSignal) && shown.captureFallback === "none") {
    return <div className="vs-root vs-black">{captureEl}</div>;
  }

  if (shown.isVideo) {
    return (
      <div className={`vs-root ${output ? "vs-output" : "vs-preview"}`}>
        {captureEl}
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
  if (shown.audioMode === "black") return <div className="vs-root vs-black">{captureEl}</div>;
  if (shown.audioMode === "logo") {
    return (
      <div className="vs-root vs-black vs-center">
        {captureEl}
        {shown.logo ? <img className="vs-logo" src={trackUrl({ file: shown.logo })} alt="" /> : <div className="vs-station">{shown.stationName}</div>}
      </div>
    );
  }
  return (
    <div className="vs-root vs-audio">
      {captureEl}
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
