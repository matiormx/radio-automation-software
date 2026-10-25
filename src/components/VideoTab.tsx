import type {
  NdiProbe,
  Settings,
  VideoInput,
  VideoInputKind,
  VideoOutput,
  VideoOutputKind,
} from "../types";
import { IconEdit, IconPlus, IconTrash } from "../icons";
import { useCallback, useEffect, useState } from "react";
import { listMonitors, type MonitorInfo } from "../bridge";
import { pickFfmpegFile, probeNdi } from "../api";
import { DEFAULT_SETTINGS } from "../types";

interface Props {
  settings: Settings;
  onChange: (s: Settings) => void;
  /** La emisión está en marcha: las salidas se muestran compactas. */
  streaming?: boolean;
}

const INPUT_KIND: Record<VideoInputKind, string> = {
  file: "Archivo",
  capture: "Captura de vídeo",
  rtmp: "RTMP",
  ndi: "NDI",
};

const OUTPUT_KIND: Record<VideoOutputKind, string> = {
  screen: "Pantalla / HDMI",
  decklink: "Tarjeta SDI",
  ndi: "NDI",
  rtmp: "RTMP",
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
  if (kind === "capture") return "Cámara web o capturadora HDMI";
  if (kind === "rtmp") return "rtmp://servidor/live/clave";
  if (kind === "ndi") return "NOMBRE DE LA FUENTE NDI";
  return "Ruta del archivo de vídeo";
}

function outputPlaceholder(kind: VideoOutputKind): string {
  if (kind === "screen") return "0 = monitor principal";
  if (kind === "decklink") return "0, 1…";
  if (kind === "ndi") return "MiRadio Programa";
  return "rtmp://live.restream.io/live/clave";
}

function outputSummary(output: VideoOutput): string {
  const format = `${output.width}×${output.height} · ${output.fps} fps`;
  if (output.kind === "rtmp") {
    const destination = output.source.trim() || "Sin destino";
    return `${destination} · ${format}${output.bitrateKbps ? ` · ${output.bitrateKbps} kbps` : ""}`;
  }
  if (output.kind === "ndi") {
    return `${output.source.trim() || output.name || "MiRadio"} · ${format}`;
  }
  if (output.kind === "screen") {
    return `Pantalla ${output.source.trim() || "0"} · ${format}`;
  }
  return `Dispositivo ${output.source.trim() || "0"} · ${format}`;
}

export function VideoTab({ settings, onChange, streaming = false }: Props) {
  const v = settings.video;
  const set = (patch: Partial<Settings["video"]>) =>
    onChange({ ...settings, video: { ...v, ...patch } });

  const updateInput = (id: string, patch: Partial<VideoInput>) =>
    set({ inputs: v.inputs.map((x) => (x.id === id ? { ...x, ...patch } : x)) });

  const updateOutput = (id: string, patch: Partial<VideoOutput>) =>
    set({ outputs: v.outputs.map((x) => (x.id === id ? { ...x, ...patch } : x)) });

  // Solo se edita una salida a la vez; el resto se ve como lista compacta.
  const [editingOutput, setEditingOutput] = useState<string | null>(null);

  useEffect(() => {
    if (streaming) setEditingOutput(null);
  }, [streaming]);

  const addOutput = () => {
    const created = newOutput();
    set({ outputs: [...v.outputs, created] });
    setEditingOutput(created.id);
  };

  const removeOutput = (id: string) => {
    set({ outputs: v.outputs.filter((x) => x.id !== id) });
    setEditingOutput((current) => (current === id ? null : current));
  };

  const vs = settings.videoScreen ?? DEFAULT_SETTINGS.videoScreen;
  const setVs = (patch: Partial<typeof vs>) => onChange({ ...settings, videoScreen: { ...vs, ...patch } });
  const [monitors, setMonitors] = useState<MonitorInfo[]>([]);
  const [ndi, setNdi] = useState<NdiProbe | null>(null);
  const [ndiBusy, setNdiBusy] = useState(false);

  useEffect(() => {
    void listMonitors().then(setMonitors);
  }, []);

  const refreshNdi = useCallback(
    async (path = v.ndiFfmpegPath ?? "") => {
      setNdiBusy(true);
      try {
        setNdi(await probeNdi(path));
      } catch (error) {
        setNdi({
          available: false,
          ffmpeg: null,
          device: null,
          runtime: false,
          sources: [],
          error: String(error),
        });
      } finally {
        setNdiBusy(false);
      }
    },
    [v.ndiFfmpegPath],
  );

  useEffect(() => {
    const hasNdi =
      v.inputs.some((input) => input.kind === "ndi") ||
      v.outputs.some((output) => output.kind === "ndi") ||
      (v.ndiFfmpegPath ?? "").trim() !== "";
    if (hasNdi) void refreshNdi();
  }, []);

  const pickNdiFfmpeg = async () => {
    const path = await pickFfmpegFile();
    if (path) {
      set({ ndiFfmpegPath: path });
      void refreshNdi(path);
    }
  };

  const ndiSources = ndi?.sources ?? [];

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
          <p className="hint">Añade un archivo, una captura de vídeo, una fuente RTMP o una fuente NDI.</p>
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
                onChange={(e) => {
                  const kind = e.target.value as VideoInputKind;
                  updateInput(ch.id, { kind, source: "" });
                  if (kind === "ndi") void refreshNdi();
                }}
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
            {ch.kind === "ndi" ? (
              <div className="ndi-source-row">
                <label className="field">
                  <span className="field-label">Fuente NDI</span>
                  <input
                    list={`ndi-sources-${ch.id}`}
                    value={ch.source}
                    placeholder={
                      ndiBusy
                        ? "Buscando fuentes…"
                        : ndiSources.length > 0
                          ? "Elige o escribe una fuente…"
                          : "Nombre de la fuente NDI"
                    }
                    onChange={(e) => updateInput(ch.id, { source: e.target.value })}
                  />
                  <datalist id={`ndi-sources-${ch.id}`}>
                    {ndiSources.map((source) => (
                      <option key={source} value={source} />
                    ))}
                  </datalist>
                </label>
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={ndiBusy}
                  onClick={() => void refreshNdi()}
                >
                  {ndiBusy ? "Buscando…" : "Buscar"}
                </button>
              </div>
            ) : (
              <>
                <label className="field">
                  <span className="field-label">Fuente</span>
                  <input
                    value={ch.source}
                    placeholder={inputPlaceholder(ch.kind)}
                    onChange={(e) => updateInput(ch.id, { source: e.target.value })}
                  />
                </label>
                {ch.kind === "capture" && (
                  <p className="hint">
                    En Windows escribe el nombre exacto del dispositivo que
                    muestra{" "}
                    <code>ffmpeg -list_devices true -f dshow -i dummy</code>.
                    En Linux puedes usar <code>/dev/video0</code>.
                  </p>
                )}
              </>
            )}
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
        {v.outputs.map((ch) => {
          const isOpen = editingOutput === ch.id;
          return (
            <div
              className={`io-card ${isOpen ? "io-card-open" : "io-row"}`}
              key={ch.id}
            >
              {isOpen ? (
                <div className="io-card-head">
                  <input
                    className="io-name"
                    value={ch.name}
                    placeholder="Nombre del canal"
                    onChange={(e) => updateOutput(ch.id, { name: e.target.value })}
                  />
                  <select
                    value={ch.kind}
                    onChange={(e) => {
                      const kind = e.target.value as VideoOutputKind;
                      updateOutput(ch.id, {
                        kind,
                        source:
                          kind === "ndi"
                            ? ch.name && ch.name !== "Salida"
                              ? ch.name
                              : "MiRadio Programa"
                            : kind === "screen"
                              ? "0"
                              : "",
                      });
                      if (kind === "ndi") void refreshNdi();
                    }}
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
                    className="btn btn-sm"
                    onClick={() => setEditingOutput(null)}
                  >
                    Guardar
                  </button>
                  <button
                    type="button"
                    className="ghost-btn io-del"
                    title="Quitar salida"
                    onClick={() => removeOutput(ch.id)}
                  >
                    <IconTrash size={14} />
                  </button>
                </div>
              ) : (
                <div className="stream-line">
                  <input
                    type="checkbox"
                    checked={ch.enabled}
                    title={ch.enabled ? "Activa" : "Inactiva"}
                    aria-label={`Activar ${ch.name || OUTPUT_KIND[ch.kind]}`}
                    onChange={(e) => updateOutput(ch.id, { enabled: e.target.checked })}
                  />
                  <strong className="stream-line-name">{ch.name || "Sin nombre"}</strong>
                  <span className="stream-line-codec">{OUTPUT_KIND[ch.kind]}</span>
                  <span className="stream-line-url" title={outputSummary(ch)}>
                    {outputSummary(ch)}
                  </span>
                  <button
                    type="button"
                    className="ghost-btn"
                    title="Editar salida"
                    aria-label={`Editar ${ch.name || OUTPUT_KIND[ch.kind]}`}
                    onClick={() => setEditingOutput(ch.id)}
                  >
                    <IconEdit size={14} />
                  </button>
                  <button
                    type="button"
                    className="ghost-btn io-del"
                    title="Quitar salida"
                    onClick={() => removeOutput(ch.id)}
                  >
                    <IconTrash size={14} />
                  </button>
                </div>
              )}

              {isOpen && (
                <>
                  <label className="field">
                    <span className="field-label">
                      {ch.kind === "ndi" ? "Nombre de la fuente NDI" : "Destino"}
                    </span>
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
                    {ch.kind !== "ndi" && (
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
                    )}
                  </div>
                  {ch.kind === "ndi" && (
                    <p className="hint">
                      El audio de esta salida NDI es la mezcla que va a la salida «Streaming» de la mesa.
                    </p>
                  )}
                </>
              )}
            </div>
          );
        })}
        <button
          type="button"
          className="btn btn-sm io-add"
          onClick={addOutput}
        >
          <IconPlus size={14} /> Añadir salida
        </button>
      </fieldset>

      <fieldset className="fieldset">
        <legend>NDI</legend>
        <p className="hint">
          NDI necesita un FFmpeg compilado con NDI y el NDI Runtime instalado. Si el FFmpeg de la
          app no lo incluye, indica aquí uno que sí lo tenga. Para emitir, activa el motor de vídeo.
        </p>
        <div className="ndi-source-row">
          <label className="field">
            <span className="field-label">FFmpeg con NDI</span>
            <input
              value={v.ndiFfmpegPath ?? ""}
              placeholder="ffmpeg-ndi.exe (opcional)"
              onChange={(e) => set({ ndiFfmpegPath: e.target.value })}
            />
          </label>
          <button type="button" className="btn btn-sm" onClick={() => void pickNdiFfmpeg()}>
            Elegir…
          </button>
          <button
            type="button"
            className="btn btn-sm"
            disabled={ndiBusy}
            onClick={() => void refreshNdi()}
          >
            {ndiBusy ? "Buscando…" : "Buscar fuentes"}
          </button>
        </div>
        <p className="hint">
          {ndiBusy
            ? "Comprobando NDI…"
            : ndi
              ? ndi.available
                ? ndi.error
                  ? `NDI con ${ndi.ffmpeg}, pero no se pudieron listar fuentes: ${ndi.error}`
                  : `NDI listo con ${ndi.ffmpeg}. ${ndi.sources.length} fuente(s) encontrada(s).`
                : `NDI no disponible: ${ndi.error ?? "no se encontró un FFmpeg con NDI."}`
              : "Pulsa «Buscar fuentes» para detectar NDI."}
        </p>
        {ndi?.available && ndi.sources.length > 0 && (
          <ul className="ndi-sources">
            {ndi.sources.map((source) => (
              <li key={source}>{source}</li>
            ))}
          </ul>
        )}
      </fieldset>

      <p className="hint">
        La tarjeta SDI requiere el SDK DeckLink instalado en el equipo. NDI usa FFmpeg con soporte
        NDI; el audio de NDI sale de la salida «Streaming» de la mesa.
      </p>
    </>
  );
}
