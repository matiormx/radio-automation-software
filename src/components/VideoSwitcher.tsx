import type { Settings, VideoScreenSettings } from "../types";

interface Props {
  settings: Settings;
  onChange: (patch: Partial<VideoScreenSettings>) => void;
}

/**
 * Botonera de vídeo en directo: qué sale en la pantalla de emisión (y en las
 * salidas que emiten esa pantalla). Programa = lo que suena; cada capturadora
 * activa tiene su botón. La que está al aire va en rojo.
 */
export function VideoSwitcher({ settings, onChange }: Props) {
  const vs = settings.videoScreen;
  const sources = (settings.video?.inputs ?? []).filter(
    (input) => input.kind === "capture" && input.enabled && input.source.trim() !== "",
  );
  if (!vs?.enabled && sources.length === 0) return null;
  const current = vs?.source === "capture" ? `capture:${vs.captureInputId ?? ""}` : "program";
  const btn = (key: string, label: string, title: string, patch: Partial<VideoScreenSettings>) => (
    <button
      key={key}
      type="button"
      className={`vsw-btn ${current === key ? "vsw-on" : ""}`}
      aria-pressed={current === key}
      title={title}
      onClick={() => onChange(patch)}
    >
      {label}
    </button>
  );
  return (
    <div className="panel vsw" role="group" aria-label="Vídeo al aire">
      <span className="vsw-label">VÍDEO</span>
      {btn("program", "Programa", "Lo que está sonando (vídeos y portadas)", { source: "program", captureInputId: "" })}
      {sources.map((input) =>
        btn(`capture:${input.id}`, input.name.trim() || input.source, `Capturadora: ${input.source}`, {
          source: "capture",
          captureInputId: input.id,
        }),
      )}
      {!vs?.enabled && <span className="vsw-note">Ventana de vídeo apagada (Ajustes → Vídeo)</span>}
    </div>
  );
}
