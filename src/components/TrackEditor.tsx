import { useEffect, useRef, useState } from "react";
import {
  autoTrackTrim,
  getTrackWaveform,
  saveTrackMarkers,
  saveTrackTrim,
} from "../api";
import { IconX, IconPlay, IconPause, IconTrash } from "../icons";
import type { Track, Waveform } from "../types";
import type { SoundMixer } from "../mixer";

type MarkerId = "start" | "end" | "mix" | "fade";

interface TrackEditorProps {
  track: Track;
  mixer: SoundMixer | null;
  onClose: () => void;
  onSaved: (track: Track) => void;
  showToast: (msg: string) => void;
}

const MARKER_COLORS: Record<MarkerId, string> = {
  start: "#59d98c",
  end: "#ffb84d",
  mix: "#4dd6ff",
  fade: "#c08bff",
};

function fmtTime(secs: number): string {
  if (!Number.isFinite(secs) || secs < 0) return "--:--";
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

function fmtPoint(secs: number): string {
  if (!Number.isFinite(secs)) return "--:--";
  return `${secs.toFixed(2)} s`;
}

/**
 * Editor de cortes y puntos: muestra la forma de onda con el corte inicial,
 * el corte final, el punto de mezcla (donde entra la siguiente canción) y el
 * punto de fade out (hasta el final). Se escucha por la preescucha.
 */
export function TrackEditor({ track, mixer, onClose, onSaved, showToast }: TrackEditorProps) {
  const [wave, setWave] = useState<Waveform | null>(null);
  const [error, setError] = useState("");
  const [start, setStart] = useState(track.trimStart || 0);
  const [end, setEnd] = useState(track.trimEnd ?? track.durationSecs);
  const [mix, setMix] = useState(track.mixPoint || 0);
  const [fade, setFade] = useState(track.fadeOutStart || 0);
  const [drag, setDrag] = useState<MarkerId | null>(null);
  const [playPos, setPlayPos] = useState(-1);
  const [previewing, setPreviewing] = useState(false);
  const [saving, setSaving] = useState(false);
  const previewingRef = useRef(false);
  const previewToken = useRef(0);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    let alive = true;
    setWave(null);
    setError("");
    void getTrackWaveform(track.id, 1200)
      .then((w) => {
        if (!alive) return;
        setWave(w);
        const s = Math.min(track.trimStart || 0, Math.max(0, w.durationSecs - 0.3));
        const e = Math.min(w.durationSecs, track.trimEnd ?? w.durationSecs);
        setStart(s);
        setEnd(Math.max(s + 0.3, e));
        setMix(track.mixPoint > 0 ? Math.min(w.durationSecs, track.mixPoint) : 0);
        setFade(track.fadeOutStart > 0 ? Math.min(w.durationSecs, track.fadeOutStart) : 0);
      })
      .catch((e) => {
        if (alive) setError(String(e));
      });
    return () => {
      alive = false;
    };
  }, [track.id]);

  useEffect(() => {
    return () => {
      mixer?.stopPreview();
    };
  }, [mixer]);

  const duration = wave?.durationSecs ?? track.durationSecs;

  // Dibujo de la forma de onda y de las marcas
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

    const mid = h / 2;
    const dur = wave.durationSecs || 1;
    const xOf = (secs: number) => (secs / dur) * w;
    const n = wave.peaks.length;
    for (let i = 0; i < n; i++) {
      const x = (i / n) * w;
      const p = Math.pow(Math.min(1, wave.peaks[i]), 0.6);
      const amp = Math.max(0.6, p * (h * 0.44));
      const inside = i / n >= start / dur && i / n <= end / dur;
      ctx.strokeStyle = inside ? "#5b9cff" : "#38445a";
      ctx.beginPath();
      ctx.moveTo(x + 0.5, mid - amp);
      ctx.lineTo(x + 0.5, mid + amp);
      ctx.stroke();
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
    ctx.fillRect(0, 0, xOf(start), h);
    ctx.fillRect(xOf(end), 0, w - xOf(end), h);

    const handle = (secs: number, color: string) => {
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
    if (mix > 0) handle(mix, MARKER_COLORS.mix);
    if (fade > 0) handle(fade, MARKER_COLORS.fade);

    if (playPos >= 0) {
      const x = xOf(playPos);
      ctx.strokeStyle = "#ffffffdd";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();
    }
  }, [wave, start, end, mix, fade, playPos]);

  const secsAt = (clientX: number): number => {
    const canvas = canvasRef.current;
    if (!canvas || !wave) return 0;
    const r = canvas.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (clientX - r.left) / r.width));
    return ratio * wave.durationSecs;
  };

  const pointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!wave) return;
    const secs = secsAt(e.clientX);
    const tol = Math.max(0.1, wave.durationSecs / 200);
    const near = (value: number) => value > 0 && Math.abs(secs - value) <= tol;
    if (near(start)) {
      setDrag("start");
    } else if (near(end)) {
      setDrag("end");
    } else if (near(mix)) {
      setDrag("mix");
    } else if (near(fade)) {
      setDrag("fade");
    } else {
      if (previewingRef.current) {
        previewToken.current += 1;
        previewingRef.current = false;
        setPreviewing(false);
        mixer?.stopPreview();
      }
      setPlayPos(secs);
      return;
    }
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const pointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drag || !wave) return;
    const secs = secsAt(e.clientX);
    if (drag === "start") setStart(Math.max(0, Math.min(end - 0.3, secs)));
    else if (drag === "end") setEnd(Math.min(wave.durationSecs, Math.max(start + 0.3, secs)));
    else if (drag === "mix") setMix(Math.max(start, Math.min(end, secs)));
    else if (drag === "fade") setFade(Math.max(start, Math.min(end, secs)));
  };

  const pointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (drag) {
      setDrag(null);
      try {
        e.currentTarget.releasePointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
    }
  };

  const stopPreview = () => {
    previewToken.current += 1;
    previewingRef.current = false;
    setPreviewing(false);
    setPlayPos(-1);
    mixer?.stopPreview();
  };

  const preview = async () => {
    if (!mixer) {
      showToast("La mesa de sonido todavía no está disponible");
      return;
    }
    if (previewingRef.current) {
      stopPreview();
      return;
    }
    const token = ++previewToken.current;
    previewingRef.current = true;
    setPreviewing(true);
    setPlayPos(start);
    try {
      await mixer.playPreview(
        track.file,
        start,
        end,
        (position) => {
          if (previewingRef.current) setPlayPos(position);
        },
        () => {
          if (token !== previewToken.current) return;
          previewingRef.current = false;
          setPreviewing(false);
          setPlayPos(-1);
        },
      );
    } catch (e) {
      if (token !== previewToken.current) return;
      previewingRef.current = false;
      setPreviewing(false);
      setPlayPos(-1);
      showToast(`No se pudo escuchar: ${String(e)}`);
    }
  };

  const save = async () => {
    setSaving(true);
    try {
      await saveTrackTrim(track.id, start, end);
      await saveTrackMarkers(track.id, mix, fade);
      onSaved({
        ...track,
        trimStart: start,
        trimEnd: end >= duration - 0.02 ? null : end,
        trimManual: true,
        mixPoint: mix,
        fadeOutStart: fade,
      });
      showToast("Cortes y puntos guardados");
      onClose();
    } catch (e) {
      showToast(`No se pudo guardar: ${String(e)}`);
      setSaving(false);
    }
  };

  const useAuto = async () => {
    try {
      await autoTrackTrim(track.id);
      const s = track.autoTrimStart;
      const e = track.autoTrimEnd ?? duration;
      setStart(s);
      setEnd(e);
      showToast("Recorte automático restablecido");
    } catch (e) {
      showToast(String(e));
    }
  };

  const setPoint = (which: MarkerId, value: number) => {
    if (which === "start") setStart(Math.max(0, Math.min(end - 0.3, value)));
    else if (which === "end") setEnd(Math.min(duration, Math.max(start + 0.3, value)));
    else if (which === "mix") setMix(Math.max(start, Math.min(end, value)));
    else setFade(Math.max(start, Math.min(end, value)));
  };

  const nudge = (which: MarkerId, delta: number) => {
    const current =
      which === "start" ? start : which === "end" ? end : which === "mix" ? mix : fade;
    setPoint(which, current + delta);
  };

  const head = playPos >= 0 ? playPos : start;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal modal-wide trim-modal" onClick={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <h3>Cortes y puntos</h3>
          <button type="button" className="ghost-btn" onClick={onClose} title="Cerrar">
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
          />

          <div className="mark-bar">
            <Marker
              id="start"
              label="Corte inicial"
              value={start}
              duration={duration}
              onChange={(v) => setPoint("start", v)}
              onNudge={(d) => nudge("start", d)}
            />
            <Marker
              id="end"
              label="Corte final"
              value={end}
              duration={duration}
              onChange={(v) => setPoint("end", v)}
              onNudge={(d) => nudge("end", d)}
            />
            <Marker
              id="mix"
              label="Punto mix (intro)"
              value={mix}
              duration={duration}
              onChange={(v) => setPoint("mix", v)}
              onNudge={(d) => nudge("mix", d)}
            />
            <Marker
              id="fade"
              label="Fade out"
              value={fade}
              duration={duration}
              onChange={(v) => setPoint("fade", v)}
              onNudge={(d) => nudge("fade", d)}
            />
          </div>

          <div className="mark-tools">
            <button type="button" className="btn btn-sm" onClick={() => void preview()}>
              {previewing ? <IconPause size={14} /> : <IconPlay size={14} />}
              {previewing ? "Parar" : "Escuchar (preescucha)"}
            </button>
            <button
              type="button"
              className="ghost-btn"
              onClick={() => {
                setPlayPos(head);
                setPoint("mix", head);
              }}
              title="Poner el punto de mezcla donde está el cursor"
            >
              Mix aquí
            </button>
            <button
              type="button"
              className="ghost-btn"
              onClick={() => {
                setPlayPos(head);
                setPoint("fade", head);
              }}
              title="Poner el fade out donde está el cursor"
            >
              Fade aquí
            </button>
            <button type="button" className="ghost-btn" onClick={() => void useAuto()}>
              Recorte automático
            </button>
            <button
              type="button"
              className="ghost-btn"
              onClick={() => {
                setMix(0);
                setFade(0);
              }}
              title="Quitar el punto de mezcla y el de fade out"
            >
              <IconTrash size={13} />
              Quitar puntos
            </button>
            <button
              type="button"
              className="btn btn-sm btn-accent"
              onClick={() => void save()}
              disabled={saving || !wave}
            >
              {saving ? "Guardando…" : "Guardar"}
            </button>
          </div>

          <p className="hint">
            Arrastra las marcas sobre la onda o usa los campos. El <strong>punto mix</strong> es
            donde termina la intro y entra la siguiente canción; el <strong>fade out</strong> es
            donde la pista baja hasta el final. La preescucha sale por la salida de monitorización
            de la mesa de sonido.
          </p>
        </div>
      </div>
    </div>
  );
}

function Marker({
  id,
  label,
  value,
  duration,
  onChange,
  onNudge,
}: {
  id: MarkerId;
  label: string;
  value: number;
  duration: number;
  onChange: (v: number) => void;
  onNudge: (d: number) => void;
}) {
  const [text, setText] = useState(value > 0 ? value.toFixed(2) : "");
  useEffect(() => {
    setText(value > 0 ? value.toFixed(2) : "");
  }, [value]);
  return (
    <div className="mark-item">
      <span className="mark-label">
        <i className="mark-dot" style={{ background: MARKER_COLORS[id] }} />
        {label}
      </span>
      <span className="mark-controls">
        {value > 0 ? (
          <>
            <input
              type="number"
              step="0.05"
              min={0}
              max={duration}
              value={text}
              onChange={(e) => {
                setText(e.target.value);
                const num = Number(e.target.value);
                if (Number.isFinite(num)) onChange(num);
              }}
            />
            <span className="mark-time">{fmtPoint(value)}</span>
            <button type="button" className="act-btn" onClick={() => onNudge(-0.1)} title="Quitar 0,1 s">
              −
            </button>
            <button type="button" className="act-btn" onClick={() => onNudge(0.1)} title="Añadir 0,1 s">
              +
            </button>
            <button
              type="button"
              className="act-btn"
              onClick={() => onChange(0)}
              title="Quitar este punto"
            >
              <IconTrash size={12} />
            </button>
          </>
        ) : (
          <span className="hint">Sin marcar</span>
        )}
      </span>
    </div>
  );
}
