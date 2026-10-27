import type { Settings, VideoScreenSettings } from "../types";

interface Props {
  settings: Settings;
  onChange: (patch: Partial<VideoScreenSettings>) => void;
}

/**
 * Botonera de vídeo en directo: qué sale en la pantalla de emisión (y en las
 * salidas que emiten esa pantalla). Programa = lo que suena; cada capturadora
 * activa tiene su botón. La que está al aire va en rojo. A la derecha,
 * encender o apagar la ventana (el monitor de los presentadores).
 */
export function VideoSwitcher({ settings, onChange }: Props) {
  const vs = settings.videoScreen;
  const sources = (settings.video?.inputs ?? []).filter(
    (input) => (input.kind === "capture" || input.kind === "ndi") && input.enabled && input.source.trim() !== "",
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
        btn(`capture:${input.id}`, input.name.trim() || input.source, `${input.kind === "ndi" ? "NDI" : "Capturadora"}: ${input.source}`, {
          source: "capture",
          captureInputId: input.id,
        }),
      )}
      <button
        type="button"
        className={`vsw-power ${vs?.enabled ? "vsw-power-on" : ""}`}
        aria-pressed={!!vs?.enabled}
        title={
          vs?.enabled
            ? "Apagar el monitor de los presentadores: libera CPU y red (deja de recibir el NDI si nadie más lo usa)"
            : "Encender el monitor de los presentadores en su pantalla"
        }
        onClick={() => onChange({ enabled: !vs?.enabled })}
      >
        <span className="vsw-power-dot" aria-hidden="true" />
        {vs?.enabled ? "Monitor encendido" : "Monitor apagado"}
      </button>
    </div>
  );
}
