import { useEffect, useState } from "react";
import type { TrackDetails } from "../types";
import { getTrackDetails, trackUrl } from "../api";
import { IconEdit, IconNote } from "../icons";

interface TrackDetailsModalProps {
  trackId: string;
  onClose: () => void;
  onEdit?: (id: string) => void;
}

function fmtTime(secs: number): string {
  if (!secs || secs <= 0) return "--:--";
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

function fmtBytes(n: number): string {
  if (!n) return "—";
  const units = ["B", "KB", "MB", "GB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

export function TrackDetailsModal({ trackId, onClose, onEdit }: TrackDetailsModalProps) {
  const [details, setDetails] = useState<TrackDetails | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let alive = true;
    setDetails(null);
    setError("");
    void getTrackDetails(trackId)
      .then((d) => {
        if (alive) setDetails(d);
      })
      .catch((e) => {
        if (alive) setError(String(e));
      });
    return () => {
      alive = false;
    };
  }, [trackId]);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal props-modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Detalles de la canción"
      >
        <div className="modal-head">
          <h3>Detalles de la canción</h3>
          <button type="button" className="ghost-btn" onClick={onClose}>
            Cerrar
          </button>
        </div>
        <div className="modal-body">
          {error ? (
            <p className="form-error">{error}</p>
          ) : !details ? (
            <p className="hint">Leyendo el archivo…</p>
          ) : (
            <>
              <div className="props-hero">
                {details.cover ? (
                  <img
                    className="props-cover"
                    src={trackUrl({ file: details.cover })}
                    alt={`Carátula de ${details.album || details.title}`}
                  />
                ) : (
                  <div className="props-cover props-cover-ph">
                    <IconNote size={28} />
                  </div>
                )}
                <div className="props-title">
                  <strong>{details.title}</strong>
                  <span>{details.artist}</span>
                  {details.album && <span className="props-album">{details.album}</span>}
                  {details.missing && <span className="badge-missing">archivo no encontrado</span>}
                </div>
              </div>

              <div className="prop-grid">
                <span className="prop-k">Álbum</span>
                <span className="prop-v">{details.album || "—"}</span>
                <span className="prop-k">Estilo</span>
                <span className="prop-v">{details.genre || "—"}</span>
                <span className="prop-k">Año</span>
                <span className="prop-v">{details.year || "—"}</span>
                <span className="prop-k">Duración</span>
                <span className="prop-v">{fmtTime(details.durationSecs)}</span>
                <span className="prop-k">Biblioteca</span>
                <span className="prop-v">{details.library === "b" ? "B" : "A"}</span>
                <span className="prop-k">Normalización</span>
                <span className="prop-v">
                  {details.lufs != null
                    ? `${details.lufs.toFixed(1)} LUFS · ${details.gainDb != null ? `${details.gainDb >= 0 ? "+" : ""}${details.gainDb.toFixed(1)} dB` : "—"}`
                    : "Sin analizar"}
                </span>
                <span className="prop-k">Recorte</span>
                <span className="prop-v">
                  {details.trimStart > 0.05 || details.trimEnd != null
                    ? `${fmtTime(details.trimStart)} – ${fmtTime(details.trimEnd ?? details.durationSecs)}`
                    : "Sin recorte"}
                </span>
                <span className="prop-k">Intro</span>
                <span className="prop-v">
                  {details.introPoint > 0 ? fmtTime(details.introPoint) : "Sin marcar"}
                </span>
                <span className="prop-k">Mix</span>
                <span className="prop-v">
                  {details.mixPoint > 0 ? fmtTime(details.mixPoint) : "Sin marcar"}
                </span>
                <span className="prop-k">Fade out</span>
                <span className="prop-v">
                  {details.fadeOutStart > 0 ? fmtTime(details.fadeOutStart) : "Sin marcar"}
                </span>
                <span className="prop-k">Formato</span>
                <span className="prop-v">
                  {details.format}
                  {details.bitrateKbps ? ` · ${details.bitrateKbps} kbps` : ""}
                </span>
                <span className="prop-k">Calidad</span>
                <span className="prop-v">
                  {details.sampleRate ? `${(details.sampleRate / 1000).toFixed(1)} kHz` : "—"}
                  {details.bitDepth ? ` · ${details.bitDepth} bits` : ""}
                  {details.channels
                    ? ` · ${details.channels === 1 ? "mono" : details.channels === 2 ? "estéreo" : `${details.channels} canales`}`
                    : ""}
                </span>
                <span className="prop-k">Tamaño</span>
                <span className="prop-v">{fmtBytes(details.fileSize)}</span>
                <span className="prop-k">Listas</span>
                <span className="prop-v">
                  {details.blockNames.length > 0 ? (
                    <span className="props-chips">
                      {details.blockNames.map((b) => (
                        <span key={b} className="chip chip-block">
                          {b}
                        </span>
                      ))}
                    </span>
                  ) : (
                    "—"
                  )}
                </span>
                <span className="prop-k">Etiquetas</span>
                <span className="prop-v">
                  {details.tags.length > 0 ? (
                    <span className="props-chips">
                      {details.tags.map((tag) => (
                        <span key={tag} className="chip chip-tag">
                          {tag}
                        </span>
                      ))}
                    </span>
                  ) : (
                    "—"
                  )}
                </span>
                <span className="prop-k">Archivo</span>
                <span className="prop-v prop-path" title={details.file}>
                  {details.file || "—"}
                </span>
                <span className="prop-k">Nombre original</span>
                <span className="prop-v">{details.originalName || "—"}</span>
                <span className="prop-k">ID</span>
                <span className="prop-v prop-id">{details.id}</span>
              </div>

              <div className="edit-actions">
                {onEdit && (
                  <button type="button" className="btn btn-sm" onClick={() => onEdit(details.id)}>
                    <IconEdit size={13} /> Editar metadatos
                  </button>
                )}
                <span className="spacer" />
                <button type="button" className="btn btn-sm" onClick={onClose}>
                  Cerrar
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
