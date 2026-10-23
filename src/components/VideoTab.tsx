import type { Settings, VideoInput, VideoInputKind, VideoOutput, VideoOutputKind } from "../types";
import { IconPlus, IconTrash } from "../icons";
import { useEffect, useState } from "react";
import { listMonitors, type MonitorInfo } from "../bridge";
import { DEFAULT_SETTINGS } from "../types";

interface Props {
  settings: Settings;
  onChange: (s: Settings) => void;
}

const INPUT_KIND: Record<VideoInputKind, string> = {
  file: "Archivo",
  rtsp: "RTSP",
  ndi: "NDI",
};

const OUTPUT_KIND: Record<VideoOutputKind, string> = {
  screen: "Pantalla / HDMI",
  decklink: "Tarjeta SDI",
  ndi: "NDI",
  rtsp: "RTSP",
};

function uid(): string {
  return `v${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

function newInput(): VideoInput {
  return { id: uid(), name: "Entrada", kind: "file", source: "", enabled: true };
}

function newOutput(): VideoOutput {
  return {
    id: uid(),
    name: "Salida",
    kind: "screen",
    source: "0",
    enabled: true,
    width: 1920,
    height: 1080,
    fps: 25,
    bitrateKbps: 6000,
  };
}

function inputPlaceholder(kind: VideoInputKind): string {
  if (kind === "rtsp") return "rtsp://servidor/canal";
  if (kind === "ndi") return "NOMBRE DE LA FUENTE NDI";
  return "Ruta del archivo de vídeo";
}

function outputPlaceholder(kind: VideoOutputKind): string {
  if (kind === "screen") return "0 = monitor principal";
  if (kind === "decklink") return "0, 1…";
  if (kind === "ndi") return "NOMBRE DE SALIDA NDI";
  return "rtsp://servidor/salida";
}

export function VideoTab({ settings, onChange }: Props) {
  const v = settings.video;
  const set = (patch: Partial<Settings["video"]>) =>
    onChange({ ...settings, video: { ...v, ...patch } });

  const updateInput = (id: string, patch: Partial<VideoInput>) =>
    set({ inputs: v.inputs.map((x) => (x.id === id ? { ...x, ...patch } : x)) });

  const updateOutput = (id: string, patch: Partial<VideoOutput>) =>
    set({ outputs: v.outputs.map((x) => (x.id === id ? { ...x, ...patch } : x)) });

  const vs = settings.videoScreen ?? DEFAULT_SETTINGS.videoScreen;
  const setVs = (patch: Partial<typeof vs>) => onChange({ ...settings, videoScreen: { ...vs, ...patch } });
  const [monitors, setMonitors] = useState<MonitorInfo[]>([]);
  useEffect(() => {
    void listMonitors().then(setMonitors);
  }, []);

  return (
    <>
      <div className="camp-head">
        <div>
          <h4>Vídeos de la lista</h4>
          <p className="hint">
            Los vídeos de la biblioteca (mp4, m4v, mov, avi, mkv…) suenan en la lista como cualquier canción: su audio
            pasa por la mesa. La imagen se ve en la zona «En el aire» y, si la activas, en una ventana de vídeo a
            pantalla completa en el monitor que elijas (HDMI, proyector o captura de OBS).
          </p>
        </div>
      </div>
      <fieldset className="fieldset">
        <legend>Ventana de vídeo de la emisión</legend>
        <label className="check-field">
          <input type="checkbox" checked={vs.enabled} onChange={(e) => setVs({ enabled: e.target.checked })} />
          Mostrar la ventana de vídeo
        </label>
        <div className="field-row">
          <label className="field">
            <span className="field-label">Monitor</span>
            <select value={vs.monitor} onChange={(e) => setVs({ monitor: Number(e.target.value) })}>
              {monitors.length === 0 && <option value={vs.monitor}>Pantalla {vs.monitor + 1}</option>}
              {monitors.map((m) => (
                <option key={m.index} value={m.index}>
                  {m.index + 1}: {m.name} ({m.width}×{m.height})
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span className="field-label">Mientras suena audio</span>
            <select value={vs.audioMode} onChange={(e) => setVs({ audioMode: e.target.value as typeof vs.audioMode })}>
              <option value="cover">Portada, título y artista</option>
              <option value="logo">Logo de la emisora</option>
              <option value="black">Negro</option>
            </select>
          </label>
        </div>
        <p className="hint">
          En otro monitor se abre a pantalla completa. Doble clic o tecla F: pantalla completa; Esc: salir de pantalla
          completa.
        </p>
      </fieldset>
      <div className="camp-head">
        <div>
          <h4>Vídeo y mezcla</h4>
          <p className="hint">
            Canales de entrada y de salida. La mezcla inicial hace cortes entre fuentes; la salida
            puede ir a una pantalla, una tarjeta SDI o por red.
          </p>
        </div>
        <label className="check-field">
          <input
            type="checkbox"
            checked={v.enabled}
            onChange={(e) => set({ enabled: e.target.checked })}
          />
          Motor de vídeo activo
        </label>
      </div>

      <fieldset className="fieldset">
        <legend>Canales de entrada</legend>
        {v.inputs.length === 0 && (
          <p className="hint">Añade un archivo, una fuente RTSP o una fuente NDI.</p>
        )}
        {v.inputs.map((ch) => (
          <div className="io-card" key={ch.id}>
            <div className="io-card-head">
              <input
                className="io-name"
                value={ch.name}
                placeholder="Nombre del canal"
                onChange={(e) => updateInput(ch.id, { name: e.target.value })}
              />
              <select
                value={ch.kind}
                onChange={(e) => updateInput(ch.id, { kind: e.target.value as VideoInputKind })}
              >
                {(Object.keys(INPUT_KIND) as VideoInputKind[]).map((k) => (
                  <option key={k} value={k}>
                    {INPUT_KIND[k]}
                  </option>
                ))}
              </select>
              <label className="check-field io-on">
                <input
                  type="checkbox"
                  checked={ch.enabled}
                  onChange={(e) => updateInput(ch.id, { enabled: e.target.checked })}
                />
                Activa
              </label>
              <button
                type="button"
                className="ghost-btn io-del"
                title="Quitar entrada"
                onClick={() => set({ inputs: v.inputs.filter((x) => x.id !== ch.id) })}
              >
                <IconTrash size={14} />
              </button>
            </div>
            <label className="field">
              <span className="field-label">Fuente</span>
              <input
                value={ch.source}
                placeholder={inputPlaceholder(ch.kind)}
                onChange={(e) => updateInput(ch.id, { source: e.target.value })}
              />
            </label>
          </div>
        ))}
        <button
          type="button"
          className="btn btn-sm io-add"
          onClick={() => set({ inputs: [...v.inputs, newInput()] })}
        >
          <IconPlus size={14} /> Añadir entrada
        </button>
      </fieldset>

      <fieldset className="fieldset">
        <legend>Canales de salida</legend>
        {v.outputs.length === 0 && (
          <p className="hint">Añade una pantalla, una tarjeta SDI o una salida de red.</p>
        )}
        {v.outputs.map((ch) => (
          <div className="io-card" key={ch.id}>
            <div className="io-card-head">
              <input
                className="io-name"
                value={ch.name}
                placeholder="Nombre del canal"
                onChange={(e) => updateOutput(ch.id, { name: e.target.value })}
              />
              <select
                value={ch.kind}
                onChange={(e) =>
                  updateOutput(ch.id, { kind: e.target.value as VideoOutputKind })
                }
              >
                {(Object.keys(OUTPUT_KIND) as VideoOutputKind[]).map((k) => (
                  <option key={k} value={k}>
                    {OUTPUT_KIND[k]}
                  </option>
                ))}
              </select>
              <label className="check-field io-on">
                <input
                  type="checkbox"
                  checked={ch.enabled}
                  onChange={(e) => updateOutput(ch.id, { enabled: e.target.checked })}
                />
                Activa
              </label>
              <button
                type="button"
                className="ghost-btn io-del"
                title="Quitar salida"
                onClick={() => set({ outputs: v.outputs.filter((x) => x.id !== ch.id) })}
              >
                <IconTrash size={14} />
              </button>
            </div>
            <label className="field">
              <span className="field-label">Destino</span>
              <input
                value={ch.source}
                placeholder={outputPlaceholder(ch.kind)}
                onChange={(e) => updateOutput(ch.id, { source: e.target.value })}
              />
            </label>
            <div className="io-format">
              <label className="field">
                <span className="field-label">Ancho</span>
                <input
                  type="number"
                  min={320}
                  max={7680}
                  value={ch.width}
                  onChange={(e) =>
                    updateOutput(ch.id, { width: Math.max(0, Number(e.target.value) || 0) })
                  }
                />
              </label>
              <label className="field">
                <span className="field-label">Alto</span>
                <input
                  type="number"
                  min={240}
                  max={4320}
                  value={ch.height}
                  onChange={(e) =>
                    updateOutput(ch.id, { height: Math.max(0, Number(e.target.value) || 0) })
                  }
                />
              </label>
              <label className="field">
                <span className="field-label">FPS</span>
                <input
                  type="number"
                  min={1}
                  max={120}
                  value={ch.fps}
                  onChange={(e) =>
                    updateOutput(ch.id, { fps: Math.max(1, Number(e.target.value) || 25) })
                  }
                />
              </label>
              <label className="field">
                <span className="field-label">Bitrate</span>
                <span className="field-unit">
                  <input
                    type="number"
                    min={0}
                    max={100000}
                    value={ch.bitrateKbps}
                    onChange={(e) =>
                      updateOutput(ch.id, {
                        bitrateKbps: Math.max(0, Number(e.target.value) || 0),
                      })
                    }
                  />
                  kbps
                </span>
              </label>
            </div>
          </div>
        ))}
        <button
          type="button"
          className="btn btn-sm io-add"
          onClick={() => set({ outputs: [...v.outputs, newOutput()] })}
        >
          <IconPlus size={14} /> Añadir salida
        </button>
      </fieldset>

      <p className="hint">
        NDI y la salida SDI necesitan el SDK correspondiente. En esta fase NDI queda preparado en
        los canales y la tarjeta SDI requiere el SDK DeckLink instalado en el equipo.
      </p>
    </>
  );
}
