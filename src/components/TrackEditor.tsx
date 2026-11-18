import { useCallback, useEffect, useRef, useState } from "react";
import { closeOnBackdrop } from "../backdrop";
import { autoTrackTrim, getTrackWaveform, saveTrackMarkers, saveTrackTrim } from "../api";
import { IconX, IconPlay, IconPause, IconTrash, IconPrev, IconNext } from "../icons";
import type { Track, Waveform } from "../types";
import type { SoundMixer } from "../mixer";

/** Lo que el editor necesita para la preescucha. */
type PreviewLike = Pick<SoundMixer, "playPreview" | "stopPreview">;

type MarkerId = "start" | "end" | "intro" | "mix" | "fade";

interface TrackEditorProps {
  track: Track;
  mixer: PreviewLike | null;
  onClose: () => void;
  onSaved: (track: Track) => void;
  showToast: (msg: string) => void;
}

const MARKER_COLORS: Record<MarkerId, string> = {
  start: "#59d98c",
  end: "#ffb84d",
  intro: "#4dd6ff",
  mix: "#ff7ab6",
  fade: "#c08bff",
};

/** Lo más cerca que se puede acercar: 1 s en todo el ancho. */
const MIN_SPAN = 1;

function fmtClock(secs: number): string {
  if (!Number.isFinite(secs) || secs < 0) return "--:--";
  const m = Math.floor(secs / 60);
  const s = secs - m * 60;
  return `${m}:${s.toFixed(2).padStart(5, "0")}`;
}

function fmtTime(secs: number): string {
  if (!Number.isFinite(secs) || secs < 0) return "--:--";
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

/**
 * Editor de cortes y puntos: onda con zoom (rueda) y desplazamiento (botón
 * central), cursor, controles de reproducción desde el cursor y un botón
 * «Asignar» en cada punto para ponerlo donde está el cursor.
 */
export function TrackEditor({ track, mixer, onClose, onSaved, showToast }: TrackEditorProps) {
  const [wave, setWave] = useState<Waveform | null>(null);
  const [error, setError] = useState("");
  const [start, setStart] = useState(track.trimStart || 0);
  const [end, setEnd] = useState(track.trimEnd ?? track.durationSecs);
  const [intro, setIntro] = useState(track.introPoint || 0);
  const [mix, setMix] = useState(track.mixPoint || 0);
  const [fade, setFade] = useState(track.fadeOutStart || 0);
  const [drag, setDrag] = useState<MarkerId | null>(null);
  /** Posición elegida por el usuario (desde donde suena) */
  const [cursor, setCursor] = useState(track.trimStart || 0);
  /** Posición de lo que está sonando (-1 = parado) */
  const [playPos, setPlayPos] = useState(-1);
  const [playing, setPlaying] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedFlash, setSavedFlash] = useState(0);
  const [saved, setSaved] = useState("");
  const [askClose, setAskClose] = useState(false);
  /** Parte visible de la onda (segundos) */
  const [view, setView] = useState<[number, number]>([0, track.durationSecs || 1]);
  const playingRef = useRef(false);
  const playFrom = useRef(0);
  const lastPos = useRef(-1);
  const previewToken = useRef(0);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const pan = useRef<{ x: number; view: [number, number] } | null>(null);

  const snapshot = (s = start, e = end, i = intro, m = mix, f = fade) =>
    JSON.stringify([s, e, i, m, f].map((v) => Math.round(v * 1000)));

  useEffect(() => {
    let alive = true;
    setWave(null);
    setError("");
    // Toda la resolución que haya (una muestra cada 50 ms) para poder acercar.
    const buckets = Math.min(20000, Math.max(1200, Math.round((track.durationSecs || 240) * 20)));
    void getTrackWaveform(track.id, buckets)
      .then((w) => {
        if (!alive) return;
        setWave(w);
        const s = Math.min(track.trimStart || 0, Math.max(0, w.durationSecs - 0.3));
        const e = Math.max(s + 0.3, Math.min(w.durationSecs, track.trimEnd ?? w.durationSecs));
        const i = track.introPoint > 0 ? Math.min(w.durationSecs, track.introPoint) : 0;
        const m = track.mixPoint > 0 ? Math.min(w.durationSecs, track.mixPoint) : 0;
        const f = track.fadeOutStart > 0 ? Math.min(w.durationSecs, track.fadeOutStart) : 0;
        setStart(s);
        setEnd(e);
        setIntro(i);
        setMix(m);
        setFade(f);
        setCursor(s);
        setView([0, w.durationSecs || 1]);
        setSaved(snapshot(s, e, i, m, f));
      })
      .catch((e) => {
        if (alive) setError(String(e));
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [track.id]);

  useEffect(() => {
    return () => {
      previewToken.current += 1;
      mixer?.stopPreview();
    };
  }, [mixer]);

  const duration = wave?.durationSecs ?? track.durationSecs;
  const dirty = !!wave && saved !== "" && snapshot() !== saved;
  /** Donde se asignan los puntos: lo que suena o, parado, el cursor */
  const head = playing && playPos >= 0 ? playPos : cursor;

  const clampView = useCallback(
    (a: number, b: number): [number, number] => {
      const dur = duration || 1;
      let span = Math.min(dur, Math.max(Math.min(MIN_SPAN, dur), b - a));
      let s = a;
      if (s < 0) s = 0;
      if (s + span > dur) s = Math.max(0, dur - span);
      span = Math.min(span, dur - s);
      return [s, s + span];
    },
    [duration],
  );

  // Dibujo de la forma de onda (solo la parte visible) y de las marcas
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !wave) return;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    canvas.width = Math.max(1, Math.round(w * dpr));
    canvas.height = Math.max(1, Math.round(h * dpr));
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const [v0, v1] = view;
    const span = v1 - v0 || 1;
    const dur = wave.durationSecs || 1;
    const n = wave.peaks.length;
    const xOf = (secs: number) => ((secs - v0) / span) * w;
    const mid = h / 2;

    // Una barra por píxel con el pico de lo que cae en él.
    ctx.lineWidth = 1;
    for (let x = 0; x < w; x++) {
      const t0 = v0 + (x / w) * span;
      const t1 = v0 + ((x + 1) / w) * span;
      const i0 = Math.floor((t0 / dur) * n);
      const i1 = Math.max(i0 + 1, Math.ceil((t1 / dur) * n));
      let p = 0;
      for (let i = Math.max(0, i0); i < Math.min(n, i1); i++) p = Math.max(p, wave.peaks[i]);
      const amp = Math.max(0.6, Math.pow(Math.min(1, p), 0.6) * (h * 0.44));
      const tm = (t0 + t1) / 2;
      ctx.strokeStyle = tm >= start && tm <= end ? "#5b9cff" : "#38445a";
      ctx.beginPath();
      ctx.moveTo(x + 0.5, mid - amp);
      ctx.lineTo(x + 0.5, mid + amp);
      ctx.stroke();
    }

    // Rejilla de tiempo
    const steps = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60];
    const step = steps.find((s) => (s / span) * w >= 70) ?? 60;
    ctx.fillStyle = "rgba(255,255,255,0.45)";
    ctx.font = "10px ui-monospace, monospace";
    for (let t = Math.ceil(v0 / step) * step; t <= v1; t += step) {
      const x = xOf(t);
      ctx.fillRect(x, h - 5, 1, 5);
      ctx.fillText(step < 1 ? t.toFixed(2) : fmtTime(t), x + 3, h - 3);
    }

    // zona de fade out
    if (fade > 0 && fade < end) {
      const x0 = xOf(fade);
      const x1 = xOf(end);
      const grad = ctx.createLinearGradient(x0, 0, x1, 0);
      grad.addColorStop(0, "rgba(192,139,255,0)");
      grad.addColorStop(1, "rgba(192,139,255,0.35)");
      ctx.fillStyle = grad;
      ctx.fillRect(x0, 0, x1 - x0, h);
    }

    // fuera del recorte
    ctx.fillStyle = "rgba(4, 7, 12, 0.58)";
    if (start > v0) ctx.fillRect(0, 0, xOf(start), h);
    if (end < v1) ctx.fillRect(xOf(end), 0, w - xOf(end), h);

    const handle = (secs: number, color: string) => {
      if (secs < v0 || secs > v1) return;
      const x = xOf(secs);
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x + 7, 0);
      ctx.lineTo(x, 9);
      ctx.closePath();
      ctx.fill();
    };
    handle(start, MARKER_COLORS.start);
    handle(end, MARKER_COLORS.end);
    if (intro > 0) handle(intro, MARKER_COLORS.intro);
    if (mix > 0) handle(mix, MARKER_COLORS.mix);
    if (fade > 0) handle(fade, MARKER_COLORS.fade);

    // Cursor (elegido) y lo que suena
    const line = (secs: number, color: string, dash: number[]) => {
      if (secs < v0 || secs > v1) return;
      const x = Math.round(xOf(secs)) + 0.5;
      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      ctx.setLineDash(dash);
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();
      ctx.setLineDash([]);
    };
    line(cursor, "#ffffff99", [4, 3]);
    if (playing && playPos >= 0) line(playPos, "#ffffff", []);
  }, [wave, view, start, end, intro, mix, fade, cursor, playPos, playing]);

  // Al sonar, la vista sigue a la reproducción si se sale.
  useEffect(() => {
    if (!playing || playPos < 0) return;
    const [v0, v1] = view;
    if (playPos > v1 || playPos < v0) {
      const span = v1 - v0;
      setView(clampView(playPos - span * 0.1, playPos + span * 0.9));
    }
  }, [playPos, playing, view, clampView]);

  // Rueda: zoom alrededor del ratón (necesita un oyente no pasivo).
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = canvas.getBoundingClientRect();
      const ratio = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
      setView(([v0, v1]) => {
        const span = v1 - v0;
        // Rueda horizontal (o Mayús + rueda): desplazar
        if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
          const d = (e.shiftKey ? e.deltaY : e.deltaX) / r.width;
          return clampView(v0 + d * span, v1 + d * span);
        }
        const factor = Math.pow(1.0015, e.deltaY);
        const t = v0 + ratio * span;
        const ns = span * factor;
        return clampView(t - ratio * ns, t - ratio * ns + ns);
      });
    };
    canvas.addEventListener("wheel", onWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", onWheel);
  }, [clampView, wave]);

  const secsAt = (clientX: number): number => {
    const canvas = canvasRef.current;
    if (!canvas || !wave) return 0;
    const r = canvas.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (clientX - r.left) / r.width));
    return Math.max(0, Math.min(wave.durationSecs, view[0] + ratio * (view[1] - view[0])));
  };

  const stopAudio = () => {
    previewToken.current += 1;
    playingRef.current = false;
    setPlaying(false);
    mixer?.stopPreview();
  };

  const play = async (from: number) => {
    if (!mixer) {
      showToast("La mesa de sonido todavía no está disponible");
      return;
    }
    stopAudio();
    const s = Math.max(0, Math.min(from, end - 0.05));
    const token = ++previewToken.current;
    playingRef.current = true;
    playFrom.current = s;
    lastPos.current = s;
    setPlaying(true);
    setPlayPos(s);
    try {
      await mixer.playPreview(
        track.file,
        s,
        end,
        (position) => {
          if (token !== previewToken.current) return;
          lastPos.current = position;
          setPlayPos(position);
        },
        () => {
          if (token !== previewToken.current) return;
          playingRef.current = false;
          setPlaying(false);
          setPlayPos(-1);
        },
      );
    } catch (e) {
      if (token !== previewToken.current) return;
      playingRef.current = false;
      setPlaying(false);
      setPlayPos(-1);
      showToast(`No se pudo escuchar: ${String(e)}`);
    }
  };

  /** Pausa: se para y el cursor se queda donde iba. */
  const pause = () => {
    const at = lastPos.current;
    stopAudio();
    if (at >= 0) setCursor(at);
    setPlayPos(-1);
  };

  /** Parar: vuelve el cursor a donde empezó a sonar. */
  const stop = () => {
    stopAudio();
    setCursor(playFrom.current);
    setPlayPos(-1);
  };

  const togglePlay = () => {
    if (playingRef.current) pause();
    else void play(cursor);
  };

  /** Mueve el cursor (y, si suena, sigue sonando desde ahí). */
  const seek = (secs: number) => {
    const t = Math.max(0, Math.min(duration, secs));
    setCursor(t);
    if (playingRef.current) void play(t);
    const [v0, v1] = view;
    if (t < v0 || t > v1) {
      const span = v1 - v0;
      setView(clampView(t - span / 2, t + span / 2));
    }
  };

  const pointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!wave) return;
    // Botón central: arrastrar la vista
    if (e.button === 1) {
      e.preventDefault();
      pan.current = { x: e.clientX, view };
      e.currentTarget.setPointerCapture(e.pointerId);
      return;
    }
    if (e.button !== 0) return;
    const secs = secsAt(e.clientX);
    const r = e.currentTarget.getBoundingClientRect();
    const tol = ((view[1] - view[0]) / r.width) * 6; // 6 px
    const near = (value: number) => value > 0 && Math.abs(secs - value) <= tol;
    const nearCut = (value: number) => Math.abs(secs - value) <= tol;
    if (nearCut(start)) setDrag("start");
    else if (nearCut(end)) setDrag("end");
    else if (near(intro)) setDrag("intro");
    else if (near(mix)) setDrag("mix");
    else if (near(fade)) setDrag("fade");
    else {
      seek(secs);
      return;
    }
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const pointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (pan.current) {
      const r = e.currentTarget.getBoundingClientRect();
      const [v0, v1] = pan.current.view;
      const d = ((pan.current.x - e.clientX) / r.width) * (v1 - v0);
      setView(clampView(v0 + d, v1 + d));
      return;
    }
    if (!drag || !wave) return;
    setPoint(drag, secsAt(e.clientX));
  };

  const pointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (pan.current || drag) {
      pan.current = null;
      setDrag(null);
      try {
        e.currentTarget.releasePointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
    }
  };

  const zoom = (factor: number) => {
    const [v0, v1] = view;
    const c = cursor >= v0 && cursor <= v1 ? cursor : (v0 + v1) / 2;
    const ratio = (c - v0) / (v1 - v0 || 1);
    const ns = (v1 - v0) * factor;
    setView(clampView(c - ratio * ns, c - ratio * ns + ns));
  };

  const save = async (): Promise<boolean> => {
    if (mix > 0 && mix <= start + (end - start) / 2) {
      showToast(
        "El punto Mix va al final de la pista (segunda mitad). " + "Si querías marcar dónde empieza a cantar, usa Intro.",
      );
      return false;
    }
    setSaving(true);
    try {
      await saveTrackTrim(track.id, start, end);
      await saveTrackMarkers(track.id, intro, mix, fade);
      onSaved({
        ...track,
        trimStart: start,
        trimEnd: end >= duration - 0.02 ? null : end,
        trimManual: true,
        introPoint: intro,
        mixPoint: mix,
        fadeOutStart: fade,
      });
      setSaved(snapshot());
      setSavedFlash((n) => n + 1);
      return true;
    } catch (e) {
      showToast(`No se pudo guardar: ${String(e)}`);
      return false;
    } finally {
      setSaving(false);
    }
  };

  const requestClose = () => {
    if (dirty) setAskClose(true);
    else onClose();
  };

  // Atajos: espacio = reproducir/pausa; Esc = cerrar
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = document.activeElement as HTMLElement | null;
      const typing = el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);
      if (e.key === "Escape") {
        e.preventDefault();
        if (askClose) setAskClose(false);
        else requestClose();
      } else if (e.code === "Space" && !typing && !askClose) {
        e.preventDefault();
        togglePlay();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // El aviso de «Guardado» se va solo.
  useEffect(() => {
    if (!savedFlash) return;
    const t = window.setTimeout(() => setSavedFlash(0), 1600);
    return () => window.clearTimeout(t);
  }, [savedFlash]);

  const useAuto = async () => {
    try {
      await autoTrackTrim(track.id);
      setStart(track.autoTrimStart);
      setEnd(track.autoTrimEnd ?? duration);
      showToast("Recorte automático restablecido");
    } catch (e) {
      showToast(String(e));
    }
  };

  function setPoint(which: MarkerId, value: number) {
    if (which === "start") setStart(Math.max(0, Math.min(end - 0.3, value)));
    else if (which === "end") setEnd(Math.min(duration, Math.max(start + 0.3, value)));
    else if (which === "intro") setIntro(Math.max(start, Math.min(end, value)));
    else if (which === "mix") setMix(Math.max(start, Math.min(end, value)));
    else setFade(Math.max(start, Math.min(end, value)));
  }

  const valueOf = (which: MarkerId): number =>
    which === "start" ? start : which === "end" ? end : which === "intro" ? intro : which === "mix" ? mix : fade;

  const markerProps = (id: MarkerId) => ({
    id,
    value: valueOf(id),
    duration,
    onChange: (v: number) => setPoint(id, v),
    onNudge: (d: number) => setPoint(id, valueOf(id) + d),
    onAssign: () => setPoint(id, head),
    onGo: () => seek(valueOf(id)),
  });

  const zoomed = view[1] - view[0] < duration - 0.01;

  return (
    <div className="modal-backdrop" {...closeOnBackdrop(requestClose)}>
      <div className="modal modal-wide trim-modal" onClick={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <h3>Cortes y puntos</h3>
          <button type="button" className="ghost-btn" onClick={requestClose} title="Cerrar">
            <IconX size={16} />
          </button>
        </header>

        <div className="modal-body">
          <div className="trim-title">
            <strong>{track.title}</strong>
            <span>{track.artist || "Artista desconocido"}</span>
            <span className="trim-meta">{fmtTime(duration)}</span>
          </div>

          {error && <div className="form-error">{error}</div>}
          {!wave && !error && <div className="trim-loading">Calculando la onda…</div>}

          <canvas
            ref={canvasRef}
            className="wave-canvas"
            onPointerDown={pointerDown}
            onPointerMove={pointerMove}
            onPointerUp={pointerUp}
            onPointerCancel={pointerUp}
            onMouseDown={(e) => {
              if (e.button === 1) e.preventDefault(); // sin el desplazamiento automático
            }}
            onAuxClick={(e) => e.preventDefault()}
            title="Clic: poner el cursor · Rueda: zoom · Botón central: arrastrar la vista · Arrastra las marcas para moverlas"
          />

          {/* Vista general: qué parte se está viendo */}
          <div
            className={`wave-overview ${zoomed ? "" : "wave-overview-all"}`}
            onPointerDown={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              const t = ((e.clientX - r.left) / r.width) * duration;
              const span = view[1] - view[0];
              setView(clampView(t - span / 2, t + span / 2));
            }}
          >
            <span
              className="wave-overview-win"
              style={{ left: `${(view[0] / (duration || 1)) * 100}%`, width: `${((view[1] - view[0]) / (duration || 1)) * 100}%` }}
            />
            <span className="wave-overview-cur" style={{ left: `${(head / (duration || 1)) * 100}%` }} />
          </div>

          <div className="transport">
            <button type="button" className="act-btn" onClick={() => seek(start)} title="Ir al corte inicial">
              <IconPrev size={14} />
            </button>
            <button type="button" className="act-btn" onClick={() => seek(head - 5)} title="Atrás 5 s">
              −5 s
            </button>
            <button type="button" className="act-btn" onClick={() => seek(head - 1)} title="Atrás 1 s">
              −1 s
            </button>
            <button
              type="button"
              className="transport-play"
              onClick={togglePlay}
              disabled={!wave}
              title={playing ? "Pausa (espacio)" : "Reproducir desde el cursor (espacio)"}
            >
              {playing ? <IconPause size={16} /> : <IconPlay size={16} />}
            </button>
            <button type="button" className="act-btn" onClick={stop} disabled={!playing} title="Parar (vuelve a donde empezó)">
              ■
            </button>
            <button type="button" className="act-btn" onClick={() => seek(head + 1)} title="Adelante 1 s">
              +1 s
            </button>
            <button type="button" className="act-btn" onClick={() => seek(head + 5)} title="Adelante 5 s">
              +5 s
            </button>
            <button type="button" className="act-btn" onClick={() => seek(Math.max(start, end - 10))} title="Ir a 10 s del final">
              <IconNext size={14} />
            </button>
            <span className="transport-time" title="Posición del cursor">
              {fmtClock(head)} <span>/ {fmtClock(duration)}</span>
            </span>
            <span className="spacer" />
            <button type="button" className="act-btn" onClick={() => zoom(1.6)} title="Alejar (rueda hacia abajo)">
              −
            </button>
            <button type="button" className="act-btn" onClick={() => zoom(1 / 1.6)} title="Acercar (rueda hacia arriba)">
              +
            </button>
            <button type="button" className="act-btn" onClick={() => setView([0, duration || 1])} disabled={!zoomed} title="Ver toda la canción">
              Todo
            </button>
          </div>

          <div className="mark-bar">
            <Marker label="Corte inicial" fixed {...markerProps("start")} />
            <Marker label="Corte final" fixed {...markerProps("end")} />
            <Marker label="Intro (empieza a cantar)" {...markerProps("intro")} />
            <Marker label="Mix (entra la siguiente)" {...markerProps("mix")} />
            <Marker label="Fade out" {...markerProps("fade")} />
          </div>

          <div className="mark-tools">
            <button type="button" className="ghost-btn" onClick={() => void useAuto()}>
              Recorte automático
            </button>
            <button
              type="button"
              className="ghost-btn"
              onClick={() => {
                setIntro(0);
                setMix(0);
                setFade(0);
              }}
              title="Quitar los puntos de intro, mezcla y fade out"
            >
              <IconTrash size={13} />
              Quitar puntos
            </button>
            <span className="spacer" />
            {dirty && <span className="trim-dirty">Cambios sin guardar</span>}
            <button
              type="button"
              className={`btn btn-sm btn-accent save-btn ${savedFlash ? "save-btn-ok" : ""}`}
              onClick={() => void save()}
              disabled={saving || !wave}
            >
              {saving ? "Guardando…" : savedFlash ? "✓ Guardado" : "Guardar"}
            </button>
            <button type="button" className="btn btn-sm" onClick={requestClose}>
              Cerrar
            </button>
          </div>

          <p className="hint">
            Clic en la onda para poner el cursor; <strong>rueda</strong> para acercar o alejar y{" "}
            <strong>botón central</strong> para arrastrar la vista. Con el cursor en su sitio, pulsa{" "}
            <strong>Asignar</strong> en el punto que quieras. La <strong>intro</strong> es donde empieza a cantar; el{" "}
            <strong>mix</strong>, donde entra la siguiente canción; el <strong>fade out</strong>, donde baja hasta el
            final. Se escucha por la preescucha.
          </p>
        </div>

        {askClose && (
          <div className="trim-ask" role="alertdialog" aria-label="Cambios sin guardar">
            <div className="trim-ask-box">
              <strong>Hay cambios sin guardar</strong>
              <p>¿Quieres guardarlos antes de cerrar?</p>
              <div className="trim-ask-actions">
                <button type="button" className="btn btn-sm" onClick={() => setAskClose(false)}>
                  Cancelar
                </button>
                <button type="button" className="btn btn-sm btn-danger" onClick={onClose}>
                  No guardar
                </button>
                <button
                  type="button"
                  className="btn btn-sm btn-accent"
                  autoFocus
                  disabled={saving}
                  onClick={async () => {
                    if (await save()) onClose();
                    else setAskClose(false);
                  }}
                >
                  Guardar y cerrar
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function Marker({
  id,
  label,
  fixed = false,
  value,
  duration,
  onChange,
  onNudge,
  onAssign,
  onGo,
}: {
  id: MarkerId;
  label: string;
  /** Los cortes inicial y final siempre estan; los demas puntos se pueden quitar */
  fixed?: boolean;
  value: number;
  duration: number;
  onChange: (v: number) => void;
  onNudge: (d: number) => void;
  onAssign: () => void;
  onGo: () => void;
}) {
  const set = value > 0 || fixed;
  const [text, setText] = useState(set ? value.toFixed(2) : "");
  const [editing, setEditing] = useState(false);
  // Mientras se escribe no se pisa el texto con el valor ya recortado.
  useEffect(() => {
    if (!editing) setText(set ? value.toFixed(2) : "");
  }, [value, editing, set]);
  const commit = () => {
    setEditing(false);
    const num = Number(text.replace(",", "."));
    if (text.trim() !== "" && Number.isFinite(num)) onChange(num);
    else setText(set ? value.toFixed(2) : "");
  };
  return (
    <div className="mark-item">
      <span className="mark-label">
        <i className="mark-dot" style={{ background: MARKER_COLORS[id] }} />
        {label}
      </span>
      <span className="mark-controls">
        {set ? (
          <>
            <input
              type="number"
              step="0.05"
              min={0}
              max={duration}
              value={text}
              onFocus={() => setEditing(true)}
              onChange={(e) => setText(e.target.value)}
              onBlur={commit}
              onKeyDown={(e) => {
                if (e.key === "Enter") e.currentTarget.blur();
              }}
            />
            <button type="button" className="mark-time mark-go" onClick={onGo} title="Llevar el cursor a este punto">
              {fmtClock(value)}
            </button>
            <button type="button" className="act-btn" onClick={() => onNudge(-0.1)} title="Quitar 0,1 s">
              −
            </button>
            <button type="button" className="act-btn" onClick={() => onNudge(0.1)} title="Añadir 0,1 s">
              +
            </button>
            {!fixed && (
              <button type="button" className="act-btn" onClick={() => onChange(0)} title="Quitar este punto">
                <IconTrash size={12} />
              </button>
            )}
          </>
        ) : (
          <span className="hint">Sin marcar</span>
        )}
        <button
          type="button"
          className="btn btn-sm mark-assign"
          style={{ borderColor: MARKER_COLORS[id] }}
          onClick={onAssign}
          title="Poner este punto donde está el cursor"
        >
          Asignar
        </button>
      </span>
    </div>
  );
}
