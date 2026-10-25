import { useCallback, useEffect, useState } from "react";
import type {
  IcecastCodec,
  IcecastStream,
  Settings,
  StreamStatus,
  StreamingSettings,
  VideoCaptureDevice,
  VideoOutput,
  VideoOutputKind,
} from "../types";
import { IconEdit, IconPlus, IconTrash } from "../icons";
import { listVideoCaptureDevices } from "../api";

interface Props {
  settings: Settings;
  onChange: (s: Settings) => void;
  streamStatus?: StreamStatus | null;
  streamBusy?: boolean;
}

function uid(): string {
  return `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

function newStream(codec: IcecastCodec, settings: Settings): IcecastStream {
  return {
    id: uid(),
    name: codec === "flac" ? "Icecast FLAC" : "Icecast AAC",
    enabled: false,
    host: "localhost",
    port: 8000,
    mount: codec === "flac" ? "/miradio.flac" : "/miradio.aac",
    username: "source",
    password: "",
    tls: false,
    codec,
    bitrateKbps: codec === "flac" ? 0 : 128,
    sampleRate: 48000,
    channels: 2,
    public: false,
    stationName: settings.radioName,
    description: settings.slogan,
    genre: "",
  };
}

type EmissionTone = "live" | "error" | "pending" | "idle";

function icecastConfigError(s: IcecastStream): string | null {
  if (!s.host.trim()) return "Falta el servidor.";
  if (!s.port) return "El puerto no es válido.";
  const mount = s.mount.trim();
  if (!mount || mount === "/") return "Falta el montaje.";
  return null;
}

function rtmpUrlError(url: string): string | null {
  const target = url.trim().toLowerCase();
  if (!target) return "Falta la URL RTMP.";
  if (!target.startsWith("rtmp://") && !target.startsWith("rtmps://")) {
    return "La URL debe empezar por rtmp:// o rtmps://.";
  }
  return null;
}

function videoRoutingError(
  settings: Settings,
  videoInputId: string | undefined,
  audioSource: string | undefined,
  audioSourceId: string | undefined,
): string | null {
  if (videoInputId) {
    const input = settings.video.inputs.find((item) => item.id === videoInputId);
    if (!input || !input.enabled || !input.source.trim()) {
      return "La entrada de vídeo elegida no está activa.";
    }
  }
  if (audioSource === "device" && !(audioSourceId ?? "").trim()) {
    return "Elige el dispositivo de audio de la capturadora.";
  }
  return null;
}

const VIDEO_OUTPUT_KIND: Record<VideoOutputKind, string> = {
  screen: "Pantalla / HDMI",
  decklink: "Tarjeta SDI",
  ndi: "NDI",
  rtmp: "RTMP",
};

function newVideoOutput(): VideoOutput {
  return {
    id: `v${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`,
    name: "Salida",
    kind: "screen",
    source: "0",
    videoInputId: "",
    audioSource: "mixer",
    audioSourceId: "",
    enabled: true,
    width: 1920,
    height: 1080,
    fps: 25,
    bitrateKbps: 6000,
  };
}

function videoOutputPlaceholder(kind: VideoOutputKind): string {
  if (kind === "screen") return "0 = monitor principal";
  if (kind === "decklink") return "0, 1…";
  if (kind === "ndi") return "MiRadio Programa";
  return "rtmp://live.restream.io/live/clave";
}

function videoOutputSummary(output: VideoOutput): string {
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

function videoOutputConfigError(settings: Settings, output: VideoOutput): string | null {
  if (!settings.video.enabled) return "Activa el motor de vídeo en Ajustes > Vídeo.";
  if (!settings.video.inputs.some((i) => i.enabled && i.source.trim())) {
    return "Añade una entrada de vídeo activa en Ajustes > Vídeo.";
  }
  const routing = videoRoutingError(
    settings,
    output.videoInputId,
    output.audioSource,
    output.audioSourceId,
  );
  if (routing) return routing;
  if (output.kind === "rtmp") return rtmpUrlError(output.source);
  if ((output.kind === "screen" || output.kind === "decklink") && !output.source.trim()) {
    return "Indica el dispositivo de salida.";
  }
  return null;
}

function emissionState(
  status: StreamStatus | null | undefined,
  id: string,
  enabled: boolean,
  busy: boolean,
  configError: string | null,
) {
  if (!enabled) return { tone: "idle" as EmissionTone, label: "Inactiva", error: null };
  const out = status?.outputs.find((o) => o.id === id);
  if (out?.running) {
    return { tone: "live" as EmissionTone, label: "En vivo", error: out.error ?? null };
  }
  if (out?.state === "error") {
    return {
      tone: "error" as EmissionTone,
      label: "Error",
      error: out.error ?? status?.lastError ?? null,
    };
  }
  if (configError) {
    return { tone: "error" as EmissionTone, label: "Configuración", error: configError };
  }
  if (busy) return { tone: "pending" as EmissionTone, label: "Conectando", error: null };
  if (out) return { tone: "idle" as EmissionTone, label: "Detenida", error: out.error ?? null };
  if (status?.running) {
    return { tone: "idle" as EmissionTone, label: "No iniciada", error: null };
  }
  return { tone: "idle" as EmissionTone, label: "Sin iniciar", error: null };
}

function VideoRoutingFields({
  inputs,
  audioDevices,
  videoInputId,
  audioSource,
  audioSourceId,
  onChange,
  onRefreshAudio,
}: {
  inputs: Settings["video"]["inputs"];
  audioDevices: VideoCaptureDevice[];
  videoInputId?: string;
  audioSource?: "mixer" | "device";
  audioSourceId?: string;
  onChange: (patch: {
    videoInputId?: string;
    audioSource?: "mixer" | "device";
    audioSourceId?: string;
  }) => void;
  onRefreshAudio: () => void;
}) {
  const source = audioSource === "device" ? "device" : "mixer";
  return (
    <>
      <div className="field-row">
        <label className="field">
          <span className="field-label">Fuente de vídeo</span>
          <select
            value={videoInputId ?? ""}
            onChange={(e) => onChange({ videoInputId: e.target.value })}
          >
            <option value="">Pantalla externa / programa (lo que está sonando)</option>
            {inputs.map((input) => (
              <option key={input.id} value={input.id}>
                {input.name.trim() || input.source} · {input.kind}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span className="field-label">Fuente de audio</span>
          <select
            value={source}
            onChange={(e) =>
              onChange({
                audioSource: e.target.value === "device" ? "device" : "mixer",
              })
            }
          >
            <option value="mixer">Salida Encoders (lo que está sonando)</option>
            <option value="device">Audio de la capturadora</option>
          </select>
        </label>
      </div>
      {source === "device" && (
        <div className="ndi-source-row">
          <label className="field">
            <span className="field-label">Dispositivo de audio</span>
            <select
              value={audioSourceId ?? ""}
              onChange={(e) => onChange({ audioSourceId: e.target.value })}
            >
              <option value="">Elegir dispositivo…</option>
              {audioDevices.map((device) => (
                <option key={device.id} value={device.id}>
                  {device.name}
                </option>
              ))}
              {audioSourceId && !audioDevices.some((device) => device.id === audioSourceId) && (
                <option value={audioSourceId}>{audioSourceId} (manual)</option>
              )}
            </select>
          </label>
          <button type="button" className="btn btn-sm" onClick={onRefreshAudio}>
            Buscar
          </button>
        </div>
      )}
      {source === "device" && audioDevices.length === 0 && (
        <p className="hint">
          No se han detectado entradas de audio. Pulsa «Buscar» en Ajustes &gt; Vídeo para
          actualizar la lista.
        </p>
      )}
      <p className="hint">
        El audio se usa en las salidas RTMP y NDI. La opción de la mesa envía la misma señal que
        los encoders de audio.
      </p>
    </>
  );
}

export function StreamingTab({
  settings,
  onChange,
  streamStatus = null,
  streamBusy = false,
}: Props) {
  const st = settings.streaming;
  const [captureDevices, setCaptureDevices] = useState<VideoCaptureDevice[]>([]);
  const refreshCapture = useCallback(() => {
    void listVideoCaptureDevices()
      .then(setCaptureDevices)
      .catch(() => setCaptureDevices([]));
  }, []);
  useEffect(() => {
    refreshCapture();
  }, [refreshCapture]);
  const audioDevices = captureDevices.filter((device) => device.kind === "audio");
  // Solo se edita un encoder a la vez; el resto se ve como lista de una línea.
  const [editing, setEditing] = useState<string | null>(null);
  const set = (patch: Partial<StreamingSettings>) =>
    onChange({ ...settings, streaming: { ...st, ...patch } });

  const updateStream = (id: string, patch: Partial<IcecastStream>) =>
    set({
      icecast: st.icecast.map((x) => (x.id === id ? { ...x, ...patch } : x)),
    });

  const addStream = (codec: IcecastCodec) => {
    const created = newStream(codec, settings);
    set({ icecast: [...st.icecast, created] });
    setEditing(created.id);
  };

  // Salidas de vídeo: igual que Icecast, solo una abierta y el resto en una línea.
  const [editingVideo, setEditingVideo] = useState<string | null>(null);
  const setVideo = (patch: Partial<Settings["video"]>) =>
    onChange({ ...settings, video: { ...settings.video, ...patch } });
  const updateVideoOutput = (id: string, patch: Partial<VideoOutput>) =>
    setVideo({
      outputs: settings.video.outputs.map((output) =>
        output.id === id ? { ...output, ...patch } : output,
      ),
    });
  const addVideoOutput = () => {
    const created = newVideoOutput();
    setVideo({ outputs: [...settings.video.outputs, created] });
    setEditingVideo(created.id);
  };
  const removeVideoOutput = (id: string) => {
    setVideo({ outputs: settings.video.outputs.filter((output) => output.id !== id) });
    setEditingVideo((current) => (current === id ? null : current));
  };

  const emissions = [
    ...st.icecast.map((s) => ({
      key: `icecast:${s.id}`,
      name: s.name.trim() || "Icecast",
      detail: `${s.codec === "flac" ? "FLAC" : `AAC ${s.bitrateKbps} kbps`} · ${
        s.host
      }:${s.port}${s.mount}${s.tls ? " · TLS" : ""}`,
      enabled: s.enabled,
      configError: s.enabled ? icecastConfigError(s) : null,
    })),
    ...settings.video.outputs.map((output) => ({
      key: `video:${output.id}`,
      name: output.name.trim() || VIDEO_OUTPUT_KIND[output.kind],
      detail: videoOutputSummary(output),
      enabled: output.enabled,
      configError: output.enabled ? videoOutputConfigError(settings, output) : null,
    })),
  ];
  const rows = emissions.map((emission) => ({
    ...emission,
    status: emissionState(
      streamStatus,
      emission.key,
      emission.enabled,
      streamBusy,
      emission.configError,
    ),
    log: streamStatus?.outputs.find((output) => output.id === emission.key)?.log ?? null,
  }));
  const statusByKey = new Map(rows.map((row) => [row.key, row.status]));
  const dotFor = (key: string) => {
    const status = statusByKey.get(key);
    return (
      <span
        className={`stream-status-dot ${status?.tone ?? "idle"}`}
        title={status?.label ?? "Sin iniciar"}
        aria-label={status?.label ?? "Sin iniciar"}
      />
    );
  };
  const anyError = rows.some((row) => row.status.tone === "error");
  const hasRowError = rows.some((row) => row.status.error);
  const globalError = hasRowError ? null : streamStatus?.lastError ?? null;
  const headerTone: EmissionTone = anyError
    ? "error"
    : streamStatus?.running
      ? "live"
      : streamBusy
        ? "pending"
        : "idle";
  const headerLabel = anyError
    ? streamStatus?.running
      ? "EN VIVO CON ERRORES"
      : "CON ERRORES"
    : streamStatus?.running
      ? "EN VIVO"
      : streamBusy
        ? "CONECTANDO"
        : "DETENIDA";

  return (
    <>
      <div className="camp-head">
        <div>
          <h4>Streaming</h4>
          <p className="hint">
            Emisión de audio a Icecast en FLAC o AAC y salidas de vídeo (pantalla, SDI, NDI o RTMP).
            El motor usa FFmpeg y se inicia con el botón EMITIR de la cabecera. Cada salida elige su
            fuente de vídeo y de audio. La captura de audio toma lo que envíes a la salida Streaming
            de la mesa (canales o buses); si nada va a ella, toma el mismo bus que el VU de salida.
            PCM 48 kHz estéreo.
          </p>
        </div>
      </div>

      <div className="stream-status-panel" aria-label="Estado de las emisiones">
        <div className="stream-status-head">
          <span>Estado de las emisiones</span>
          <span className={`stream-status-summary ${headerTone}`}>{headerLabel}</span>
        </div>
        {rows.map((row) => (
          <div className="stream-status-item" key={row.key}>
            <div className="stream-status-row">
              <span className={`stream-status-dot ${row.status.tone}`} aria-hidden="true" />
              <strong className="stream-status-name" title={row.name}>
                {row.name}
              </strong>
              <span className="stream-status-detail" title={row.detail}>
                {row.detail}
              </span>
              <span className={`stream-status-label ${row.status.tone}`}>
                {row.status.label}
              </span>
            </div>
            {row.status.error && (
              <p className="stream-status-error" title={row.status.error}>
                {row.status.error}
              </p>
            )}
            {row.log && (
              <details className="stream-status-log">
                <summary>Registro de FFmpeg</summary>
                <pre>{row.log}</pre>
              </details>
            )}
          </div>
        ))}
        {globalError && (
          <p className="stream-status-error" title={globalError}>
            {globalError}
          </p>
        )}
      </div>

      <p className="hint">
        El motor busca <code>ffmpeg.exe</code> junto a MiRadio.exe, en una
        carpeta <code>bin</code>o en PATH. También puedes indicar la ruta con la
        variable <code>MIRADIO_FFMPEG</code>. El instalador copia{" "}
        <code>ffmpeg.exe</code> si está junto a <code>instalar.cmd</code>.
      </p>

      <label className="check-row">
        <input
          type="checkbox"
          checked={!!st.autoStart}
          onChange={(e) => set({ autoStart: e.target.checked })}
        />
        <span>Emitir al iniciar MiRadio (pulsa EMITIR solo, unos segundos después de abrir)</span>
      </label>

      <fieldset className="fieldset">
        <legend>Audio por Icecast</legend>
        {st.icecast.length === 0 && (
          <p className="hint">
            Añade una emisión FLAC sin pérdida o una emisión AAC con bitrate
            ajustable.
          </p>
        )}
        <div className="stream-list">
          {st.icecast.map((s) => {
            const isOpen = editing === s.id;
            return (
              <div
                className={`stream-card ${isOpen ? "stream-card-open" : "stream-row"}`}
                key={s.id}
              >
                {isOpen ? (
                  <div className="io-card-head">
                    <input
                      className="io-name"
                      value={s.name}
                      placeholder="Nombre de la emisión"
                      onChange={(e) =>
                        updateStream(s.id, { name: e.target.value })
                      }
                    />
                    <select
                      value={s.codec}
                      onChange={(e) =>
                        updateStream(s.id, {
                          codec: e.target.value as IcecastCodec,
                          bitrateKbps:
                            e.target.value === "flac"
                              ? 0
                              : s.bitrateKbps || 128,
                        })
                      }
                    >
                      <option value="flac">FLAC (sin pérdida)</option>
                      <option value="aac">AAC</option>
                    </select>
                    <label className="check-field io-on">
                      <input
                        type="checkbox"
                        checked={s.enabled}
                        onChange={(e) =>
                          updateStream(s.id, { enabled: e.target.checked })
                        }
                      />
                      Activa
                    </label>
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={() => setEditing(null)}
                    >
                      Listo
                    </button>
                    <button
                      type="button"
                      className="ghost-btn io-del"
                      title="Quitar emisión"
                      onClick={() => {
                        set({
                          icecast: st.icecast.filter((x) => x.id !== s.id),
                        });
                        setEditing(null);
                      }}
                    >
                      <IconTrash size={14} />
                    </button>
                  </div>
                ) : (
                  <div className="stream-line">
                    <input
                      type="checkbox"
                      checked={s.enabled}
                      title={s.enabled ? "Activa" : "Inactiva"}
                      aria-label={`Activar ${s.name}`}
                      onChange={(e) =>
                        updateStream(s.id, { enabled: e.target.checked })
                      }
                    />
                    {dotFor(`icecast:${s.id}`)}
                    <strong className="stream-line-name">
                      {s.name || "Sin nombre"}
                    </strong>
                    <span className="stream-line-codec">
                      {s.codec === "flac"
                        ? "FLAC"
                        : `AAC ${s.bitrateKbps} kbps`}
                    </span>
                    <span className="stream-line-url">
                      {s.tls ? "https" : "http"}://{s.host}:{s.port}
                      {s.mount}
                    </span>
                    <button
                      type="button"
                      className="ghost-btn"
                      title="Editar emisión"
                      aria-label={`Editar ${s.name}`}
                      onClick={() => setEditing(s.id)}
                    >
                      <IconEdit size={14} />
                    </button>
                    <button
                      type="button"
                      className="ghost-btn io-del"
                      title="Quitar emisión"
                      onClick={() =>
                        set({
                          icecast: st.icecast.filter((x) => x.id !== s.id),
                        })
                      }
                    >
                      <IconTrash size={14} />
                    </button>
                  </div>
                )}

                {isOpen && (
                  <>
                    <div className="stream-grid">
                      <label className="field">
                        <span className="field-label">Servidor</span>
                        <input
                          value={s.host}
                          placeholder="icecast.midominio.com"
                          onChange={(e) =>
                            updateStream(s.id, { host: e.target.value })
                          }
                        />
                      </label>
                      <label className="field">
                        <span className="field-label">Puerto</span>
                        <input
                          type="number"
                          min={1}
                          max={65535}
                          value={s.port}
                          onChange={(e) =>
                            updateStream(s.id, {
                              port: Math.max(1, Number(e.target.value) || 8000),
                            })
                          }
                        />
                      </label>
                      <label className="field">
                        <span className="field-label">Montaje</span>
                        <input
                          value={s.mount}
                          placeholder="/miradio"
                          onChange={(e) =>
                            updateStream(s.id, { mount: e.target.value })
                          }
                        />
                      </label>
                      <label className="field">
                        <span className="field-label">Usuario</span>
                        <input
                          value={s.username}
                          onChange={(e) =>
                            updateStream(s.id, { username: e.target.value })
                          }
                        />
                      </label>
                      <label className="field">
                        <span className="field-label">Contraseña</span>
                        <input
                          type="password"
                          value={s.password}
                          onChange={(e) =>
                            updateStream(s.id, { password: e.target.value })
                          }
                        />
                      </label>
                      <label className="field">
                        <span className="field-label">Bitrate</span>
                        <span className="field-unit">
                          <input
                            type="number"
                            min={0}
                            max={1024}
                            value={s.bitrateKbps}
                            disabled={s.codec === "flac"}
                            onChange={(e) =>
                              updateStream(s.id, {
                                bitrateKbps: Math.max(
                                  0,
                                  Number(e.target.value) || 0,
                                ),
                              })
                            }
                          />
                          kbps
                        </span>
                      </label>
                      <label className="field">
                        <span className="field-label">Frecuencia</span>
                        <select
                          value={s.sampleRate}
                          onChange={(e) =>
                            updateStream(s.id, {
                              sampleRate: Number(e.target.value),
                            })
                          }
                        >
                          <option value={44100}>44.1 kHz</option>
                          <option value={48000}>48 kHz</option>
                        </select>
                      </label>
                      <label className="field">
                        <span className="field-label">Canales</span>
                        <select
                          value={s.channels}
                          onChange={(e) =>
                            updateStream(s.id, {
                              channels: Number(e.target.value) === 1 ? 1 : 2,
                            })
                          }
                        >
                          <option value={1}>Mono</option>
                          <option value={2}>Estéreo</option>
                        </select>
                      </label>
                      <label className="field">
                        <span className="field-label">Nombre público</span>
                        <input
                          value={s.stationName}
                          onChange={(e) =>
                            updateStream(s.id, { stationName: e.target.value })
                          }
                        />
                      </label>
                      <label className="field">
                        <span className="field-label">Género</span>
                        <input
                          value={s.genre}
                          placeholder="Variado"
                          onChange={(e) =>
                            updateStream(s.id, { genre: e.target.value })
                          }
                        />
                      </label>
                      <label className="field stream-wide">
                        <span className="field-label">Descripción</span>
                        <input
                          value={s.description}
                          onChange={(e) =>
                            updateStream(s.id, { description: e.target.value })
                          }
                        />
                      </label>
                    </div>

                    <div className="stream-checks">
                      <label className="check-field">
                        <input
                          type="checkbox"
                          checked={s.tls}
                          onChange={(e) =>
                            updateStream(s.id, { tls: e.target.checked })
                          }
                        />
                        HTTPS / TLS
                      </label>
                      <label className="check-field">
                        <input
                          type="checkbox"
                          checked={s.public}
                          onChange={(e) =>
                            updateStream(s.id, { public: e.target.checked })
                          }
                        />
                        Anunciar en el directorio público
                      </label>
                    </div>
                  </>
                )}
              </div>
            );
          })}
        </div>
        <div className="stream-add">
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => addStream("flac")}
          >
            <IconPlus size={14} /> Añadir FLAC
          </button>
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => addStream("aac")}
          >
            <IconPlus size={14} /> Añadir AAC
          </button>
        </div>
      </fieldset>

      <fieldset className="fieldset">
        <legend>Salidas de vídeo</legend>
        <p className="hint">
          Cada salida elige su entrada de vídeo y su audio: la salida Encoders de la mesa (lo que
          está sonando) o el audio de una capturadora. Si no eliges vídeo se usa la pantalla
          externa. Guarda cada salida como en Icecast. Si añades o cambias salidas con la emisión
          en marcha, detén la emisión y vuelve a pulsar EMITIR para aplicarlas.
        </p>
        {settings.video.outputs.length === 0 && (
          <p className="hint">Añade una pantalla, una tarjeta SDI, NDI o una salida RTMP.</p>
        )}
        <div className="stream-list">
          {settings.video.outputs.map((output) => {
            const isOpen = editingVideo === output.id;
            const status = statusByKey.get(`video:${output.id}`);
            return (
              <div
                className={`stream-card ${isOpen ? "stream-card-open" : "stream-row"}`}
                key={output.id}
              >
                {isOpen ? (
                  <div className="io-card-head">
                    <input
                      className="io-name"
                      value={output.name}
                      placeholder="Nombre de la salida"
                      onChange={(e) =>
                        updateVideoOutput(output.id, { name: e.target.value })
                      }
                    />
                    <select
                      value={output.kind}
                      onChange={(e) => {
                        const kind = e.target.value as VideoOutputKind;
                        updateVideoOutput(output.id, {
                          kind,
                          source:
                            kind === "ndi"
                              ? output.name && output.name !== "Salida"
                                ? output.name
                                : "MiRadio Programa"
                              : kind === "screen"
                                ? "0"
                                : "",
                        });
                      }}
                    >
                      {(Object.keys(VIDEO_OUTPUT_KIND) as VideoOutputKind[]).map((kind) => (
                        <option key={kind} value={kind}>
                          {VIDEO_OUTPUT_KIND[kind]}
                        </option>
                      ))}
                    </select>
                    <label className="check-field io-on">
                      <input
                        type="checkbox"
                        checked={output.enabled}
                        onChange={(e) =>
                          updateVideoOutput(output.id, { enabled: e.target.checked })
                        }
                      />
                      Activa
                    </label>
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={() => setEditingVideo(null)}
                    >
                      Guardar
                    </button>
                    <button
                      type="button"
                      className="ghost-btn io-del"
                      title="Quitar salida"
                      onClick={() => removeVideoOutput(output.id)}
                    >
                      <IconTrash size={14} />
                    </button>
                  </div>
                ) : (
                  <div className="stream-line">
                    <input
                      type="checkbox"
                      checked={output.enabled}
                      title={output.enabled ? "Activa" : "Inactiva"}
                      aria-label={`Activar ${output.name || VIDEO_OUTPUT_KIND[output.kind]}`}
                      onChange={(e) =>
                        updateVideoOutput(output.id, { enabled: e.target.checked })
                      }
                    />
                    <span
                      className={`stream-status-dot ${status?.tone ?? "idle"}`}
                      title={status?.label ?? "Sin iniciar"}
                      aria-label={status?.label ?? "Sin iniciar"}
                    />
                    <strong className="stream-line-name">
                      {output.name || "Sin nombre"}
                    </strong>
                    <span className="stream-line-codec">
                      {VIDEO_OUTPUT_KIND[output.kind]}
                    </span>
                    <span className="stream-line-url" title={videoOutputSummary(output)}>
                      {videoOutputSummary(output)}
                    </span>
                    <button
                      type="button"
                      className="ghost-btn"
                      title="Editar salida"
                      aria-label={`Editar ${output.name || VIDEO_OUTPUT_KIND[output.kind]}`}
                      onClick={() => setEditingVideo(output.id)}
                    >
                      <IconEdit size={14} />
                    </button>
                    <button
                      type="button"
                      className="ghost-btn io-del"
                      title="Quitar salida"
                      onClick={() => removeVideoOutput(output.id)}
                    >
                      <IconTrash size={14} />
                    </button>
                  </div>
                )}

                {isOpen && (
                  <>
                    <label className="field">
                      <span className="field-label">
                        {output.kind === "ndi" ? "Nombre de la fuente NDI" : "Destino"}
                      </span>
                      <input
                        value={output.source}
                        placeholder={videoOutputPlaceholder(output.kind)}
                        onChange={(e) =>
                          updateVideoOutput(output.id, { source: e.target.value })
                        }
                      />
                    </label>
                    <VideoRoutingFields
                      inputs={settings.video.inputs}
                      audioDevices={audioDevices}
                      videoInputId={output.videoInputId}
                      audioSource={output.audioSource}
                      audioSourceId={output.audioSourceId}
                      onChange={(patch) => updateVideoOutput(output.id, patch)}
                      onRefreshAudio={refreshCapture}
                    />
                    <div className="io-format">
                      <label className="field">
                        <span className="field-label">Ancho</span>
                        <input
                          type="number"
                          min={320}
                          max={7680}
                          value={output.width}
                          onChange={(e) =>
                            updateVideoOutput(output.id, {
                              width: Math.max(0, Number(e.target.value) || 0),
                            })
                          }
                        />
                      </label>
                      <label className="field">
                        <span className="field-label">Alto</span>
                        <input
                          type="number"
                          min={240}
                          max={4320}
                          value={output.height}
                          onChange={(e) =>
                            updateVideoOutput(output.id, {
                              height: Math.max(0, Number(e.target.value) || 0),
                            })
                          }
                        />
                      </label>
                      <label className="field">
                        <span className="field-label">FPS</span>
                        <input
                          type="number"
                          min={1}
                          max={120}
                          value={output.fps}
                          onChange={(e) =>
                            updateVideoOutput(output.id, {
                              fps: Math.max(1, Number(e.target.value) || 25),
                            })
                          }
                        />
                      </label>
                      {output.kind !== "ndi" && (
                        <label className="field">
                          <span className="field-label">Bitrate</span>
                          <span className="field-unit">
                            <input
                              type="number"
                              min={0}
                              max={100000}
                              value={output.bitrateKbps}
                              onChange={(e) =>
                                updateVideoOutput(output.id, {
                                  bitrateKbps: Math.max(0, Number(e.target.value) || 0),
                                })
                              }
                            />
                            kbps
                          </span>
                        </label>
                      )}
                    </div>
                    {output.kind === "ndi" && (
                      <p className="hint">
                        El audio de esta salida NDI es la mezcla que va a la salida
                        «Streaming» de la mesa.
                      </p>
                    )}
                  </>
                )}
              </div>
            );
          })}
        </div>
        <div className="stream-add">
          <button type="button" className="btn btn-sm" onClick={addVideoOutput}>
            <IconPlus size={14} /> Añadir salida
          </button>
        </div>
      </fieldset>
    </>
  );
}
