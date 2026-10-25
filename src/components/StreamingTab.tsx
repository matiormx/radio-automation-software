import { useState } from "react";
import type {
  IcecastCodec,
  IcecastStream,
  RtmpOutput,
  Settings,
  StreamStatus,
  StreamingSettings,
} from "../types";
import { IconEdit, IconPlus, IconTrash } from "../icons";

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

function safeRtmp(url: string): string {
  const trimmed = url.trim();
  if (!trimmed) return "Sin destino";
  const scheme = trimmed.indexOf("://");
  const prefix = scheme >= 0 ? trimmed.slice(0, scheme + 3) : "";
  const rest = scheme >= 0 ? trimmed.slice(scheme + 3) : trimmed;
  const boundary = rest.search(/[/?#]/);
  const authority = boundary < 0 ? rest : rest.slice(0, boundary);
  const at = authority.lastIndexOf("@");
  const safeAuthority = at >= 0 ? `***@${authority.slice(at + 1)}` : authority;
  return boundary < 0 ? `${prefix}${safeAuthority}` : `${prefix}${safeAuthority}/***`;
}

function icecastConfigError(s: IcecastStream): string | null {
  if (!s.host.trim()) return "Falta el servidor.";
  if (!s.port) return "El puerto no es válido.";
  const mount = s.mount.trim();
  if (!mount || mount === "/") return "Falta el montaje.";
  return null;
}

function rtmpConfigError(settings: Settings, url: string): string | null {
  if (!settings.video.enabled) return "Activa el motor de vídeo en Ajustes > Vídeo.";
  if (!settings.video.inputs.some((i) => i.enabled && i.source.trim())) {
    return "Añade una entrada de vídeo activa en Ajustes > Vídeo.";
  }
  const target = url.trim().toLowerCase();
  if (!target) return "Falta la URL RTMP.";
  if (!target.startsWith("rtmp://") && !target.startsWith("rtmps://")) {
    return "La URL debe empezar por rtmp:// o rtmps://.";
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

export function StreamingTab({
  settings,
  onChange,
  streamStatus = null,
  streamBusy = false,
}: Props) {
  const st = settings.streaming;
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

  const updateRtmp = (patch: Partial<RtmpOutput>) =>
    set({ rtmp: { ...st.rtmp, ...patch } });

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
    {
      key: "rtmp",
      name: "Vídeo RTMP",
      detail: safeRtmp(st.rtmp.url),
      enabled: st.rtmp.enabled,
      configError: st.rtmp.enabled ? rtmpConfigError(settings, st.rtmp.url) : null,
    },
    ...settings.video.outputs
      .filter((output) => output.kind === "rtmp")
      .map((output) => ({
        key: `video:${output.id}`,
        name: output.name.trim() || "Salida RTMP",
        detail: safeRtmp(output.source),
        enabled: output.enabled,
        configError: output.enabled ? rtmpConfigError(settings, output.source) : null,
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
  }));
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
            Emisión de audio a Icecast en FLAC o AAC y salida de vídeo por RTMP
            a un servidor externo (por ejemplo Restream). El motor usa FFmpeg y se inicia con el botón
            EMITIR de la cabecera. La captura toma lo que envíes a la salida
            Streaming de la mesa (canales o buses); si nada va a ella, toma el
            mismo bus que el VU de salida. PCM 48 kHz estéreo.
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
        <legend>Vídeo por RTMP</legend>
        <label className="check-field">
          <input
            type="checkbox"
            checked={st.rtmp.enabled}
            onChange={(e) => updateRtmp({ enabled: e.target.checked })}
          />
          Emitir vídeo por RTMP
        </label>
        <label className="field">
          <span className="field-label">Servidor RTMP</span>
          <input
            value={st.rtmp.url}
            placeholder="rtmp://live.restream.io/live/TU_CLAVE"
            onChange={(e) => updateRtmp({ url: e.target.value })}
          />
        </label>
        <div className="rtmp-grid">
          <label className="field">
            <span className="field-label">Ancho</span>
            <input
              type="number"
              min={320}
              max={7680}
              value={st.rtmp.width}
              onChange={(e) =>
                updateRtmp({ width: Math.max(0, Number(e.target.value) || 0) })
              }
            />
          </label>
          <label className="field">
            <span className="field-label">Alto</span>
            <input
              type="number"
              min={240}
              max={4320}
              value={st.rtmp.height}
              onChange={(e) =>
                updateRtmp({ height: Math.max(0, Number(e.target.value) || 0) })
              }
            />
          </label>
          <label className="field">
            <span className="field-label">FPS</span>
            <input
              type="number"
              min={1}
              max={120}
              value={st.rtmp.fps}
              onChange={(e) =>
                updateRtmp({ fps: Math.max(1, Number(e.target.value) || 25) })
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
                value={st.rtmp.bitrateKbps}
                onChange={(e) =>
                  updateRtmp({
                    bitrateKbps: Math.max(0, Number(e.target.value) || 0),
                  })
                }
              />
              kbps
            </span>
          </label>
          <label className="field">
            <span className="field-label">Keyframe</span>
            <span className="field-unit">
              <input
                type="number"
                min={1}
                max={10}
                value={st.rtmp.keyframeSecs}
                onChange={(e) =>
                  updateRtmp({
                    keyframeSecs: Math.max(1, Number(e.target.value) || 2),
                  })
                }
              />
              s
            </span>
          </label>
        </div>
        <p className="hint">
          La emisión RTMP empuja el programa de vídeo al servidor indicado. Para
          Restream usa <code>rtmp://live.restream.io/live/TU_CLAVE</code> o la
          URL <code>rtmps://</code> que muestra su panel; RTMPS necesita un
          FFmpeg con TLS (el build NDI lo incluye). TU_CLAVE es la clave de
          emisión de tu panel de Restream. Usa la primera entrada de vídeo
          activa.
        </p>
      </fieldset>
    </>
  );
}
