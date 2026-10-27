import { useCallback, useEffect, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";
import { VideoSurface, canvasUrl, type VideoState } from "./videoSurface";

/**
 * «Lo que suena»: dibuja en un lienzo lo mismo que se ve (el video o la
 * portada con titulo y artista) y lo manda a OmniCaster como JPEG: 25 veces por
 * segundo si es un video; si es una imagen fija (portada), solo cuando cambia
 * y una vez por segundo para mantenerla viva (antes se redibujaba y comprimía
 * 25 veces por segundo sin cambiar nada: mucho procesador para nada). Las salidas lo leen de ahi: no dependen de capturar esta ventana
 * escondida, que Windows dejaba de actualizar con una imagen fija.
 */
function useNowPlayingFeed(source: () => VideoState | null, enabled: boolean) {
  useEffect(() => {
    if (!enabled) return;
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const images = new Map<string, HTMLImageElement>();
    const img = (file: string): HTMLImageElement | null => {
      if (!file) return null;
      let el = images.get(file);
      if (!el) {
        el = new Image();
        el.crossOrigin = "anonymous";
        el.src = canvasUrl(file);
        images.set(file, el);
        if (images.size > 24) images.delete(images.keys().next().value as string);
      }
      return el.complete && el.naturalWidth > 0 ? el : null;
    };
    const fit = (iw: number, ih: number, w: number, h: number, cover: boolean) => {
      const k = cover ? Math.max(w / iw, h / ih) : Math.min(w / iw, h / ih);
      const dw = iw * k;
      const dh = ih * k;
      return [(w - dw) / 2, (h - dh) / 2, dw, dh] as const;
    };
    const text = (t: string, x: number, y: number, size: number, weight: number, color: string, maxW: number) => {
      ctx.font = `${weight} ${size}px "Segoe UI", system-ui, sans-serif`;
      ctx.fillStyle = color;
      let s = t;
      while (s.length > 1 && ctx.measureText(s).width > maxW) s = s.slice(0, -1);
      if (s !== t) s = `${s.slice(0, -1)}…`;
      ctx.fillText(s, x, y);
    };
    // Fondo difuminado de la portada: se calcula una vez por portada y tamaño
    // (el desenfoque de 40 px sobre toda la imagen es lo más caro de dibujar).
    let blurKey = "";
    const blurred = document.createElement("canvas");
    const blurredBg = (cover: HTMLImageElement, file: string, w: number, h: number) => {
      const key = `${file}|${w}x${h}`;
      if (key !== blurKey) {
        blurred.width = w;
        blurred.height = h;
        const b = blurred.getContext("2d");
        if (b) {
          b.fillStyle = "#0b0d12";
          b.fillRect(0, 0, w, h);
          b.filter = "blur(40px) brightness(0.35)";
          b.drawImage(cover, ...fit(cover.naturalWidth, cover.naturalHeight, w, h, true));
          b.filter = "none";
        }
        blurKey = key;
      }
      return blurred;
    };
    let busy = false;
    let lastKey = "";
    let lastSent = 0;
    const draw = () => {
      if (busy) return;
      // Como mucho 1280×720: es lo que sale (tope de resolución) y la
      // ventana escondida puede ser mucho más grande.
      const k = Math.min(1, 1280 / Math.max(1, window.innerWidth), 720 / Math.max(1, window.innerHeight));
      const w = Math.max(320, Math.round(window.innerWidth * k)) & ~1;
      const h = Math.max(180, Math.round(window.innerHeight * k)) & ~1;
      const s = source();
      const video = document.querySelector<HTMLVideoElement>("video.vs-video");
      // Imagen fija: solo se vuelve a dibujar si cambia algo (o cada segundo)
      if (!s?.isVideo) {
        const key = [
          w,
          h,
          s?.audioMode ?? "",
          s?.cover ?? "",
          img(s?.cover ?? "") ? 1 : 0,
          s?.logo ?? "",
          img(s?.logo ?? "") ? 1 : 0,
          s?.title ?? "",
          s?.artist ?? "",
          s?.stationName ?? "",
        ].join("|");
        if (key === lastKey && performance.now() - lastSent < 1000) return;
        lastKey = key;
      } else {
        lastKey = "";
      }
      lastSent = performance.now();
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
      ctx.filter = "none";
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, w, h);
      if (s?.isVideo) {
        if (video && video.readyState >= 2 && video.videoWidth > 0) {
          ctx.drawImage(video, ...fit(video.videoWidth, video.videoHeight, w, h, false));
        }
      } else if (s && s.audioMode === "logo") {
        const logo = img(s.logo);
        if (logo) {
          ctx.drawImage(logo, ...fit(logo.naturalWidth, logo.naturalHeight, w * 0.5, h * 0.5, false).map((v, i) => v + (i === 0 ? w * 0.25 : i === 1 ? h * 0.25 : 0)) as [number, number, number, number]);
        } else if (s.stationName) {
          ctx.textAlign = "center";
          text(s.stationName, w / 2, h / 2, Math.round(h * 0.08), 700, "#fff", w * 0.9);
          ctx.textAlign = "left";
        }
      } else if (s && s.audioMode !== "black") {
        // Portada, titulo y artista (como en la pantalla de emision)
        ctx.fillStyle = "#0b0d12";
        ctx.fillRect(0, 0, w, h);
        const cover = img(s.cover);
        if (cover) ctx.drawImage(blurredBg(cover, s.cover, w, h), 0, 0);
        const side = Math.round(h * 0.42);
        const x0 = Math.round(w * 0.12);
        const y0 = Math.round((h - side) / 2);
        if (cover) {
          ctx.drawImage(cover, ...fit(cover.naturalWidth, cover.naturalHeight, side, side, true).map((v, i) => v + (i === 0 ? x0 : i === 1 ? y0 : 0)) as [number, number, number, number]);
        } else {
          ctx.fillStyle = "#1c2030";
          ctx.fillRect(x0, y0, side, side);
        }
        const tx = x0 + side + Math.round(w * 0.04);
        const maxW = w - tx - Math.round(w * 0.05);
        text(s.title, tx, y0 + side * 0.42, Math.round(h * 0.075), 800, "#fff", maxW);
        text(s.artist, tx, y0 + side * 0.6, Math.round(h * 0.045), 500, "rgba(255,255,255,0.85)", maxW);
        text((s.stationName || "").toUpperCase(), tx, y0 + side * 0.78, Math.round(h * 0.03), 700, "rgba(255,255,255,0.7)", maxW);
      }
      busy = true;
      try {
      canvas.toBlob(
        (blob) => {
          if (!blob) {
            busy = false;
            return;
          }
          void blob
            .arrayBuffer()
            .then((buf) => invoke("np_frame", new Uint8Array(buf)))
            .catch(() => undefined)
            .finally(() => {
              busy = false;
            });
        },
        "image/jpeg",
        0.85,
      );
      } catch {
        // Lienzo «contaminado» por una imagen sin CORS: se olvidan las imagenes.
        images.clear();
        busy = false;
      }
    };
    const t = window.setInterval(draw, 40);
    return () => window.clearInterval(t);
  }, [source, enabled]);
}

/**
 * Ventana de video de la emision: pantalla completa en el monitor elegido.
 * Recibe de la ventana principal lo que suena y su posicion.
 */
export function VideoOutWindow({ programOnly = false }: { programOnly?: boolean }) {
  const state = useRef<{ s: VideoState; at: number } | null>(null);

  useEffect(() => {
    const off = listen<VideoState>("video://state", (e) => {
      state.current = { s: e.payload, at: performance.now() };
    });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") void getCurrentWindow().setFullscreen(false);
      if (e.key === "f" || e.key === "F" || e.key === "F11") {
        void getCurrentWindow()
          .isFullscreen()
          .then((f) => getCurrentWindow().setFullscreen(!f));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      void off.then((f) => f());
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  // La posicion avanza entre mensajes si esta sonando.
  const source = useCallback((): VideoState | null => {
    const cur = state.current;
    if (!cur) return null;
    const pos = cur.s.playing ? cur.s.pos + (performance.now() - cur.at) / 1000 : cur.s.pos;
    if (programOnly && cur.s.capture) {
      // Solo lo que suena: sin capturadora ni NDI aunque la botonera los tenga.
      return { ...cur.s, trackId: cur.s.programTrackId || "none", capture: undefined, pos };
    }
    return { ...cur.s, pos };
  }, [programOnly]);
  useNowPlayingFeed(source, programOnly);

  return (
    <div
      className="vs-window"
      data-tauri-drag-region
      onDoubleClick={() =>
        void getCurrentWindow()
          .isFullscreen()
          .then((f) => getCurrentWindow().setFullscreen(!f))
      }
    >
      <VideoSurface source={source} output canvasSafe={programOnly} />
      {/* Latido: un punto casi invisible que cambia siempre, para que la
          ventana pinte fotogramas nuevos aunque la imagen sea fija (portada). */}
      <div className="vs-heartbeat" aria-hidden="true" />
    </div>
  );
}
