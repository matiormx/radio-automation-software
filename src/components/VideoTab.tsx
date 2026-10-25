import type {
  NdiProbe,
  Settings,
  VideoCaptureDevice,
  VideoInput,
  VideoInputKind,
} from "../types";
import { IconPlus, IconTrash } from "../icons";
import { useCallback, useEffect, useState } from "react";
import { listMonitors, type MonitorInfo } from "../bridge";
import { listVideoCaptureDevices, pickFfmpegFile, ndiNative, probeNdi } from "../api";
import { DEFAULT_SETTINGS } from "../types";

interface Props {
  settings: Settings;
  onChange: (s: Settings) => void;
}

const INPUT_KIND: Record<VideoInputKind, string> = {
  file: "Archivo",
  capture: "Captura de vídeo",
  rtmp: "RTMP",
  ndi: "NDI",
};

function uid(): string {
  return `v${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

function newInput(): VideoInput {
  return { id: uid(), name: "Entrada", kind: "file", source: "", enabled: true };
}

function inputPlaceholder(kind: VideoInputKind): string {
  if (kind === "capture") return "Cámara web o capturadora HDMI";
  if (kind === "rtmp") return "rtmp://servidor/live/clave";
  if (kind === "ndi") return "NOMBRE DE LA FUENTE NDI";
  return "Ruta del archivo de vídeo";
}

export function VideoTab({ settings, onChange }: Props) {
  const v = settings.video;
  const set = (patch: Partial<Settings["video"]>) =>
    onChange({ ...settings, video: { ...v, ...patch } });

  const updateInput = (id: string, patch: Partial<VideoInput>) =>
    set({ inputs: v.inputs.map((x) => (x.id === id ? { ...x, ...patch } : x)) });

  const vs = settings.videoScreen ?? DEFAULT_SETTINGS.videoScreen;
  const setVs = (patch: Partial<typeof vs>) => onChange({ ...settings, videoScreen: { ...vs, ...patch } });
  const [monitors, setMonitors] = useState<MonitorInfo[]>([]);
  const [ndi, setNdi] = useState<NdiProbe | null>(null);
  const [ndiBusy, setNdiBusy] = useState(false);

  const [captureDevices, setCaptureDevices] = useState<VideoCaptureDevice[]>([]);
  const [captureBusy, setCaptureBusy] = useState(false);
  const [captureError, setCaptureError] = useState("");

  useEffect(() => {
    void listMonitors().then(setMonitors);
  }, []);

  const refreshCapture = useCallback(async (grant = false) => {
    setCaptureBusy(true);
    setCaptureError("");
    try {
      if (grant && navigator.mediaDevices?.getUserMedia) {
        try {
          const stream = await navigator.mediaDevices.getUserMedia({ video: true });
          stream.getTracks().forEach((track) => track.stop());
        } catch {
          /* sin permiso de camara: se usa la lista de FFmpeg */
        }
      }
      const list = await listVideoCaptureDevices();
      const media = (await navigator.mediaDevices?.enumerateDevices?.()) ?? [];
      const cameras = media.filter((device) => device.kind === "videoinput" && !!device.deviceId);
      setCaptureDevices(
        list.map((device) => {
          const match = cameras.find(
            (camera) =>
              !!camera.label &&
              (camera.label === device.name ||
                camera.label === device.id ||
                device.name.startsWith(camera.label) ||
                camera.label.startsWith(device.name)),
          );
          return { ...device, deviceId: match?.deviceId };
        }),
      );
    } catch (error) {
      setCaptureDevices([]);
      setCaptureError(String(error));
    } finally {
      setCaptureBusy(false);
    }
  }, []);

  useEffect(() => {
    if (v.inputs.some((input) => input.kind === "capture")) void refreshCapture();
  }, []);

  const refreshNdi = useCallback(
    async (path = v.ndiFfmpegPath ?? "") => {
      setNdiBusy(true);
      try {
        // Primero NDI nativo (NDI Runtime); si no esta, el FFmpeg con NDI.
        const native = await ndiNative().catch(() => null);
        if (native?.available) {
          setNdi({ available: true, ffmpeg: "NDI Runtime (nativo)", device: null, runtime: true, sources: native.sources, error: null });
          return;
        }
        const probe = await probeNdi(path);
        setNdi(probe.available ? probe : { ...probe, error: native?.error ?? probe.error });
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
  const videoCaptureDevices = captureDevices.filter(
    (device) => !device.kind || device.kind === "video",
  );
  const audioCaptureDevices = captureDevices.filter((device) => device.kind === "audio");
  // Lo que puede verse en la pantalla de emision: capturadoras y fuentes NDI.
  const captureInputs = v.inputs.filter(
    (input) => (input.kind === "capture" || input.kind === "ndi") && input.enabled && input.source.trim() !== "",
  );
  const screenValue =
    vs.source === "capture" && captureInputs.some((input) => input.id === vs.captureInputId)
      ? `capture:${vs.captureInputId}`
      : "program";

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
            <span className="field-label">Qué se muestra</span>
            <select
              value={screenValue}
              onChange={(e) => {
                const value = e.target.value;
                if (value === "program") setVs({ source: "program", captureInputId: "" });
                else setVs({ source: "capture", captureInputId: value.slice("capture:".length) });
              }}
            >
              <option value="program">Programa (música, vídeos y portadas)</option>
              {captureInputs.map((input) => (
                <option key={input.id} value={`capture:${input.id}`}>
                  {input.kind === "ndi" ? "NDI" : "Capturadora"} · {input.name.trim() || input.source}
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
        <label className="check-field">
          <input
            type="checkbox"
            checked={!!vs.mirror}
            onChange={(e) => setVs({ mirror: e.target.checked })}
          />
          Espejo horizontal (solo en este monitor)
        </label>
        {vs.source === "capture" && (
          <label className="field">
            <span className="field-label">Respaldo si la capturadora no tiene señal</span>
            <select
              value={vs.captureFallback === "none" ? "none" : "program"}
              onChange={(e) => setVs({ captureFallback: e.target.value === "none" ? "none" : "program" })}
            >
              <option value="program">Lo que está sonando (vídeo o portada)</option>
              <option value="none">Negro</option>
            </select>
            <small className="hint">
              Si la capturadora se desconecta, deja de mandar imagen o da negro más de 3 s, se pasa solo a lo que suena y
              vuelve en cuanto llega imagen. Las salidas de Streaming que emiten «la pantalla de emisión» llevan este mismo
              respaldo.
            </small>
          </label>
        )}
        {captureInputs.length === 0 && (
          <p className="hint">
            Añade y activa una entrada de tipo «Captura de vídeo» para poder mostrarla en la pantalla externa.
          </p>
        )}
        <p className="hint">
          En otro monitor se abre a pantalla completa. Doble clic o tecla F: pantalla completa; Esc: salir de pantalla
          completa. La capturadora elegida aquí es la misma que emiten las salidas de vídeo de Streaming.
        </p>
      </fieldset>
      <div className="camp-head">
        <div>
          <h4>Entradas de vídeo y mezcla</h4>
          <p className="hint">
            Canales de entrada. La capturadora elegida para la pantalla externa también se emite por
            las salidas de vídeo de Streaming (pantalla, SDI, NDI o RTMP).
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
                  updateInput(ch.id, { kind, source: "", deviceId: "" });
                  if (kind === "ndi") void refreshNdi();
                  if (kind === "capture") void refreshCapture();
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
                  <select value={ch.source} onChange={(e) => updateInput(ch.id, { source: e.target.value })}>
                    <option value="">{ndiBusy ? "Buscando fuentes…" : ndiSources.length ? "Elige una fuente…" : "Sin fuentes: pulsa Buscar"}</option>
                    {ndiSources.map((source) => (
                      <option key={source} value={source}>
                        {source}
                      </option>
                    ))}
                    {ch.source && !ndiSources.includes(ch.source) && <option value={ch.source}>{ch.source} (no encontrada ahora)</option>}
                  </select>
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
            ) : ch.kind === "capture" ? (
              <>
                <div className="ndi-source-row">
                  <label className="field">
                    <span className="field-label">Capturadora</span>
                    <select
                      value={ch.source}
                      onChange={(e) => {
                        const device = videoCaptureDevices.find((item) => item.id === e.target.value);
                        updateInput(ch.id, { source: e.target.value, deviceId: device?.deviceId ?? "" });
                      }}
                    >
                      <option value="">
                        {captureBusy ? "Buscando capturadoras…" : videoCaptureDevices.length ? "Elige una capturadora…" : "Sin capturadoras: pulsa Buscar"}
                      </option>
                      {videoCaptureDevices.map((device) => (
                        <option key={device.id} value={device.id}>
                          {device.name}
                        </option>
                      ))}
                      {ch.source && !videoCaptureDevices.some((d) => d.id === ch.source) && (
                        <option value={ch.source}>{ch.source} (no encontrada ahora)</option>
                      )}
                    </select>
                  </label>
                  <button
                    type="button"
                    className="btn btn-sm"
                    disabled={captureBusy}
                    onClick={() => void refreshCapture()}
                  >
                    {captureBusy ? "Buscando…" : "Buscar"}
                  </button>
                  <button
                    type="button"
                    className="btn btn-sm"
                    disabled={captureBusy}
                    title="Pide permiso de cámara para poder mostrarla en la pantalla externa"
                    onClick={() => void refreshCapture(true)}
                  >
                    Detectar
                  </button>
                </div>

                <p className="hint">
                  {captureError
                    ? `No se pudieron listar las capturadoras: ${captureError}`
                    : videoCaptureDevices.length > 0
                      ? `Encontradas ${videoCaptureDevices.length} capturadora(s) y ${audioCaptureDevices.length} entrada(s) de audio. «Detectar» pide permiso de cámara para verla en la pantalla de emisión. Se cambia en directo con la botonera VÍDEO de la ventana principal.`
                      : captureBusy
                        ? "Buscando dispositivos…"
                        : "No se encontraron capturadoras. Comprueba que FFmpeg esté instalado y pulsa «Buscar». También puedes escribir el nombre exacto."}
                </p>
              </>
            ) : (
              <label className="field">
                <span className="field-label">Fuente</span>
                <input
                  value={ch.source}
                  placeholder={inputPlaceholder(ch.kind)}
                  onChange={(e) => updateInput(ch.id, { source: e.target.value })}
                />
              </label>
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
        <legend>NDI</legend>
        <p className="hint">
          Con el NDI Runtime instalado (gratis, «NDI Tools» en ndi.video), MiRadio recibe NDI por sí mismo: las
          fuentes se ven en la pantalla de emisión y en la botonera VÍDEO, y salen por las salidas que emiten la
          pantalla de emisión. Las salidas NDI (Streaming) también usan el Runtime. El FFmpeg con NDI ya solo
          haría falta para emitir una fuente NDI directamente a RTMP sin pasar por la pantalla de emisión.
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
