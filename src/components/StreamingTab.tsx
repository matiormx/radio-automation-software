import { useState } from "react";
import type {
  IcecastCodec,
  IcecastStream,
  RtspOutput,
  Settings,
  StreamingSettings,
} from "../types";
import { IconEdit, IconPlus, IconTrash } from "../icons";

interface Props {
  settings: Settings;
  onChange: (s: Settings) => void;
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

export function StreamingTab({ settings, onChange }: Props) {
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

  const updateRtsp = (patch: Partial<RtspOutput>) =>
    set({ rtsp: { ...st.rtsp, ...patch } });

  return (
    <>
      <div className="camp-head">
        <div>
          <h4>Streaming</h4>
          <p className="hint">
            Emisión de audio a Icecast en FLAC o AAC y salida de vídeo por RTSP
            a un servidor externo. El motor usa FFmpeg y se inicia con el botón
            EMITIR de la cabecera. La captura toma lo que envíes a la salida
            Streaming de la mesa (canales o buses); si nada va a ella, toma el
            mismo bus que el VU de salida. PCM 48 kHz estéreo.
          </p>
        </div>
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
        <legend>Vídeo por RTSP</legend>
        <label className="check-field">
          <input
            type="checkbox"
            checked={st.rtsp.enabled}
            onChange={(e) => updateRtsp({ enabled: e.target.checked })}
          />
          Emitir vídeo por RTSP
        </label>
        <label className="field">
          <span className="field-label">Servidor RTSP</span>
          <input
            value={st.rtsp.url}
            placeholder="rtsp://servidor:8554/miradio"
            onChange={(e) => updateRtsp({ url: e.target.value })}
          />
        </label>
        <div className="rtsp-grid">
          <label className="field">
            <span className="field-label">Transporte</span>
            <select
              value={st.rtsp.transport}
              onChange={(e) =>
                updateRtsp({
                  transport: e.target.value === "udp" ? "udp" : "tcp",
                })
              }
            >
              <option value="tcp">TCP</option>
              <option value="udp">UDP</option>
            </select>
          </label>
          <label className="field">
            <span className="field-label">Ancho</span>
            <input
              type="number"
              min={320}
              max={7680}
              value={st.rtsp.width}
              onChange={(e) =>
                updateRtsp({ width: Math.max(0, Number(e.target.value) || 0) })
              }
            />
          </label>
          <label className="field">
            <span className="field-label">Alto</span>
            <input
              type="number"
              min={240}
              max={4320}
              value={st.rtsp.height}
              onChange={(e) =>
                updateRtsp({ height: Math.max(0, Number(e.target.value) || 0) })
              }
            />
          </label>
          <label className="field">
            <span className="field-label">FPS</span>
            <input
              type="number"
              min={1}
              max={120}
              value={st.rtsp.fps}
              onChange={(e) =>
                updateRtsp({ fps: Math.max(1, Number(e.target.value) || 25) })
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
                value={st.rtsp.bitrateKbps}
                onChange={(e) =>
                  updateRtsp({
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
                value={st.rtsp.keyframeSecs}
                onChange={(e) =>
                  updateRtsp({
                    keyframeSecs: Math.max(1, Number(e.target.value) || 2),
                  })
                }
              />
              s
            </span>
          </label>
        </div>
        <p className="hint">
          La emisión RTSP empuja el programa de vídeo al servidor indicado. Usa
          la primera entrada de vídeo activa. La salida NDI se activará en la
          segunda fase.
        </p>
      </fieldset>
    </>
  );
}
