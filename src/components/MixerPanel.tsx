import { useCallback, useEffect, useState } from "react";
import type { MixerBus, MixerChannel, MixerInput, Settings } from "../types";
import { IconPlus, IconTrash } from "../icons";
import type { SoundMixer } from "../mixer";
import { MAX_GAIN_DB, MIN_GAIN_DB } from "../mixer";

interface MixerPanelProps {
  settings: Settings;
  mixer: SoundMixer | null;
  onChange: (s: Settings) => void;
}

interface Device {
  id: string;
  label: string;
  kind: "audioinput" | "audiooutput";
}

const COLORS = [
  "#4f8cff",
  "#59d98c",
  "#ffb84d",
  "#f87171",
  "#c084fc",
  "#22d3ee",
  "#f472b6",
  "#a3e635",
];

function nextColor(count: number): string {
  return COLORS[count % COLORS.length];
}

function newId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `mixer-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function fmtDb(db: number): string {
  if (db <= MIN_GAIN_DB) return "-∞ dB";
  const value = db.toFixed(1).replace(".", ",");
  return `${db > 0 ? "+" : ""}${value} dB`;
}

function deviceLabel(kind: "audioinput" | "audiooutput", index: number): string {
  return `${kind === "audioinput" ? "Entrada" : "Salida"} de audio ${index + 1}`;
}

export function MixerPanel({ settings, mixer, onChange }: MixerPanelProps) {
  const [devices, setDevices] = useState<Device[]>([]);
  const [deviceError, setDeviceError] = useState("");
  const [asking, setAsking] = useState(false);

  const refreshDevices = useCallback(async () => {
    if (!navigator.mediaDevices?.enumerateDevices) {
      setDeviceError("Este equipo no expone dispositivos de audio al WebView.");
      return;
    }
    try {
      const list = await navigator.mediaDevices.enumerateDevices();
      const counts = { audioinput: 0, audiooutput: 0 };
      const next: Device[] = [];
      for (const d of list) {
        if (d.kind !== "audioinput" && d.kind !== "audiooutput") continue;
        if (!d.deviceId) continue;
        const index = counts[d.kind]++;
        next.push({
          id: d.deviceId,
          label: d.label?.trim() || deviceLabel(d.kind, index),
          kind: d.kind,
        });
      }
      setDevices(next);
      setDeviceError("");
    } catch (e) {
      setDeviceError(`No se pudieron enumerar los dispositivos: ${String(e)}`);
    }
  }, []);

  useEffect(() => {
    void refreshDevices();
    void mixer?.resume();
    const media = navigator.mediaDevices;
    if (!media?.addEventListener) return;
    const onChangeDevices = () => {
      void refreshDevices().then(() => mixer?.retryOutputs());
    };
    media.addEventListener("devicechange", onChangeDevices);
    return () => media.removeEventListener("devicechange", onChangeDevices);
  }, [refreshDevices, mixer]);

  const askPermission = async () => {
    if (!navigator.mediaDevices?.getUserMedia) {
      setDeviceError("Este equipo no permite capturar audio.");
      return;
    }
    setAsking(true);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      for (const track of stream.getTracks()) track.stop();
      await refreshDevices();
      mixer?.retryInputs();
    } catch (e) {
      setDeviceError(`No se concedió acceso a las entradas de audio: ${String(e)}`);
    } finally {
      setAsking(false);
    }
  };

  const channels = settings.mixerChannels ?? [];
  const buses = settings.mixerBuses ?? [];
  const inputs = devices.filter((d) => d.kind === "audioinput");
  const outputs = devices.filter((d) => d.kind === "audiooutput" && d.id !== "default");
  const canChooseOutputs =
    typeof HTMLMediaElement !== "undefined" && "setSinkId" in HTMLMediaElement.prototype;

  const setChannels = (next: MixerChannel[]) => onChange({ ...settings, mixerChannels: next });
  const setBuses = (next: MixerBus[]) => onChange({ ...settings, mixerBuses: next });

  const patchChannel = (id: string, patch: Partial<MixerChannel>) => {
    setChannels(channels.map((ch) => (ch.id === id ? { ...ch, ...patch } : ch)));
  };

  const patchBus = (id: string, patch: Partial<MixerBus>) => {
    setBuses(buses.map((bus) => (bus.id === id ? { ...bus, ...patch } : bus)));
  };

  const addChannel = () => {
    const output = buses[0]
      ? { kind: "bus" as const, id: buses[0].id }
      : { kind: "device" as const, id: "default" };
    const channel: MixerChannel = {
      id: newId(),
      name: `Canal ${channels.length + 1}`,
      color: nextColor(channels.length),
      input: { kind: "app", app: "music", deviceId: "" },
      output,
      gainDb: 0,
      muted: false,
    };
    setChannels([...channels, channel]);
  };

  const addBus = () => {
    const bus: MixerBus = {
      id: newId(),
      name: `Bus ${buses.length + 1}`,
      color: nextColor(channels.length + buses.length + 1),
      outputDeviceId: "default",
      gainDb: 0,
      muted: false,
    };
    setBuses([...buses, bus]);
  };

  const removeBus = (id: string) => {
    setBuses(buses.filter((bus) => bus.id !== id));
    setChannels(
      channels.map((ch) =>
        ch.output.kind === "bus" && ch.output.id === id
          ? { ...ch, output: { kind: "device", id: "default" } }
          : ch,
      ),
    );
  };

  const musicChannels = channels.filter(
    (ch) => ch.input.kind === "app" && ch.input.app !== "preview",
  ).length;
  const previewChannels = channels.filter(
    (ch) => ch.input.kind === "app" && ch.input.app === "preview",
  ).length;

  return (
    <div className="mixer-panel">
      <div className="mixer-toolbar">
        <div className="mixer-toolbar-text">
          <strong>Mesa de sonido</strong>
          <span>
            Cada canal recibe una fuente y la envía a un bus o directamente a una tarjeta. Los
            buses suman varios canales antes de salir.
          </span>
        </div>
        <div className="mixer-toolbar-actions">
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => {
              void refreshDevices().then(() => mixer?.retryOutputs());
            }}
          >
            Actualizar dispositivos
          </button>
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => void askPermission()}
            disabled={asking}
            title="Solicita permiso para ver los nombres de las entradas y poder usarlas"
          >
            {asking ? "Solicitando…" : "Ver entradas"}
          </button>
          <button type="button" className="btn btn-sm btn-accent" onClick={addChannel}>
            <IconPlus size={13} /> Canal
          </button>
          <button type="button" className="btn btn-sm" onClick={addBus}>
            <IconPlus size={13} /> Bus
          </button>
        </div>
      </div>

      {deviceError && <div className="form-error">{deviceError}</div>}
      {!canChooseOutputs && (
        <div className="form-error">
          Este WebView no permite enrutar a varias tarjetas de salida. La mesa funcionará, pero
          todo saldrá por la salida predeterminada del sistema.
        </div>
      )}

      <p className="hint">
        Las entradas y salidas son las tarjetas físicas o virtuales del equipo. Las fuentes
        «aplicación» son la reproducción de la radio y la preescucha del normalizador.
        {!navigator.mediaDevices && " Este WebView no permite seleccionar dispositivos."}
      </p>

      {channels.length === 0 && buses.length === 0 ? (
        <div className="mixer-empty">
          <strong>Sin canales configurados</strong>
          <span>
            La reproducción y la preescucha salen por la salida predeterminada del sistema. Crea
            un canal para asignar fuentes y tarjetas.
          </span>
        </div>
      ) : (
        <div className="mixer-boards">
          <section className="mixer-group">
            <header className="mixer-group-head">
              <h4>Canales</h4>
              <span>{channels.length}</span>
            </header>
            {channels.length === 0 ? (
              <p className="hint">Sin canales. Añade uno para enrutar una fuente.</p>
            ) : (
              <div className="mixer-strips">
                {channels.map((ch) => (
                  <article className="mixer-strip" key={ch.id}>
                    <div className="mixer-strip-color" style={{ background: ch.color }} />
                    <div className="mixer-strip-head">
                      <input
                        className="mixer-name"
                        value={ch.name}
                        aria-label="Nombre del canal"
                        onChange={(e) => patchChannel(ch.id, { name: e.target.value })}
                      />
                      <button
                        type="button"
                        className="ghost-btn mixer-remove"
                        title="Eliminar canal"
                        onClick={() => setChannels(channels.filter((c) => c.id !== ch.id))}
                      >
                        <IconTrash size={13} />
                      </button>
                    </div>

                    <div className="mixer-color-row">
                      <span>Color</span>
                      <input
                        type="color"
                        value={ch.color}
                        aria-label={`Color de ${ch.name}`}
                        onChange={(e) => patchChannel(ch.id, { color: e.target.value })}
                      />
                    </div>

                    <label className="mixer-field">
                      <span>Entrada</span>
                      <select
                        value={
                          ch.input.kind === "app"
                            ? `app:${ch.input.app || "music"}`
                            : `device:${ch.input.deviceId || "default"}`
                        }
                        onChange={(e) => {
                          const [kind, ...rest] = e.target.value.split(":");
                          const value = rest.join(":");
                          const input: MixerInput =
                            kind === "app"
                              ? {
                                  kind: "app",
                                  app: value === "preview" ? "preview" : "music",
                                  deviceId: "",
                                }
                              : { kind: "device", app: "", deviceId: value };
                          patchChannel(ch.id, { input });
                        }}
                      >
                        <optgroup label="Aplicación">
                          <option value="app:music">Reproducción de música</option>
                          <option value="app:preview">Preescucha de canciones</option>
                        </optgroup>
                        <optgroup label="Tarjetas de entrada">
                          {inputs.map((d) => (
                            <option key={d.id} value={`device:${d.id}`}>
                              {d.label}
                            </option>
                          ))}
                          {ch.input.kind === "device" &&
                            !inputs.some((d) => d.id === (ch.input.deviceId || "default")) && (
                              <option value={`device:${ch.input.deviceId || "default"}`}>
                                Entrada no disponible
                              </option>
                            )}
                        </optgroup>
                      </select>
                    </label>

                    <label className="mixer-field">
                      <span>Salida</span>
                      <select
                        value={
                          ch.output.kind === "bus"
                            ? `bus:${ch.output.id}`
                            : `device:${ch.output.id || "default"}`
                        }
                        onChange={(e) => {
                          const [kind, ...rest] = e.target.value.split(":");
                          const id = rest.join(":");
                          patchChannel(ch.id, {
                            output:
                              kind === "bus"
                                ? { kind: "bus", id }
                                : { kind: "device", id: id || "default" },
                          });
                        }}
                      >
                        {buses.length > 0 && (
                          <optgroup label="Buses">
                            {buses.map((bus) => (
                              <option key={bus.id} value={`bus:${bus.id}`}>
                                {bus.name}
                              </option>
                            ))}
                          </optgroup>
                        )}
                        <optgroup label="Tarjetas de salida">
                          <option value="device:default">Salida predeterminada</option>
                          {outputs.map((d) => (
                            <option key={d.id} value={`device:${d.id}`}>
                              {d.label}
                            </option>
                          ))}
                          {ch.output.kind === "device" &&
                            ch.output.id !== "default" &&
                            !outputs.some((d) => d.id === ch.output.id) && (
                              <option value={`device:${ch.output.id}`}>
                                Salida no disponible
                              </option>
                            )}
                        </optgroup>
                      </select>
                    </label>

                    <div className="mixer-fader">
                      <input
                        type="range"
                        min={MIN_GAIN_DB}
                        max={MAX_GAIN_DB}
                        step={0.5}
                        value={ch.gainDb}
                        aria-label={`Volumen de ${ch.name}`}
                        onChange={(e) =>
                          patchChannel(ch.id, { gainDb: Number(e.target.value) || 0 })
                        }
                      />
                      <span>{fmtDb(ch.gainDb)}</span>
                    </div>

                    <button
                      type="button"
                      className={`btn btn-sm mixer-mute ${ch.muted ? "mixer-mute-on" : ""}`}
                      aria-pressed={ch.muted}
                      onClick={() => patchChannel(ch.id, { muted: !ch.muted })}
                    >
                      {ch.muted ? "Silenciado" : "Silencio"}
                    </button>
                  </article>
                ))}
              </div>
            )}
          </section>

          <section className="mixer-group">
            <header className="mixer-group-head">
              <h4>Buses</h4>
              <span>{buses.length}</span>
            </header>
            {buses.length === 0 ? (
              <p className="hint">
                Sin buses. Los canales pueden salir directamente a una tarjeta o sumarse a un bus.
              </p>
            ) : (
              <div className="mixer-strips">
                {buses.map((bus) => {
                  const feeding = channels.filter(
                    (ch) => ch.output.kind === "bus" && ch.output.id === bus.id,
                  ).length;
                  return (
                    <article className="mixer-strip" key={bus.id}>
                      <div className="mixer-strip-color" style={{ background: bus.color }} />
                      <div className="mixer-strip-head">
                        <input
                          className="mixer-name"
                          value={bus.name}
                          aria-label="Nombre del bus"
                          onChange={(e) => patchBus(bus.id, { name: e.target.value })}
                        />
                        <button
                          type="button"
                          className="ghost-btn mixer-remove"
                          title="Eliminar bus"
                          onClick={() => removeBus(bus.id)}
                        >
                          <IconTrash size={13} />
                        </button>
                      </div>

                      <div className="mixer-color-row">
                        <span>Color</span>
                        <input
                          type="color"
                          value={bus.color}
                          aria-label={`Color de ${bus.name}`}
                          onChange={(e) => patchBus(bus.id, { color: e.target.value })}
                        />
                      </div>

                      <label className="mixer-field">
                        <span>Salida</span>
                        <select
                          value={bus.outputDeviceId || "default"}
                          onChange={(e) =>
                            patchBus(bus.id, { outputDeviceId: e.target.value })
                          }
                        >
                          <option value="default">Salida predeterminada</option>
                          {outputs.map((d) => (
                            <option key={d.id} value={d.id}>
                              {d.label}
                            </option>
                          ))}
                          {bus.outputDeviceId !== "default" &&
                            !outputs.some((d) => d.id === bus.outputDeviceId) && (
                              <option value={bus.outputDeviceId}>Salida no disponible</option>
                            )}
                        </select>
                      </label>

                      <div className="mixer-field mixer-static">
                        <span>Canales</span>
                        <strong>{feeding}</strong>
                      </div>

                      <div className="mixer-fader">
                        <input
                          type="range"
                          min={MIN_GAIN_DB}
                          max={MAX_GAIN_DB}
                          step={0.5}
                          value={bus.gainDb}
                          aria-label={`Volumen de ${bus.name}`}
                          onChange={(e) =>
                            patchBus(bus.id, { gainDb: Number(e.target.value) || 0 })
                          }
                        />
                        <span>{fmtDb(bus.gainDb)}</span>
                      </div>

                      <button
                        type="button"
                        className={`btn btn-sm mixer-mute ${bus.muted ? "mixer-mute-on" : ""}`}
                        aria-pressed={bus.muted}
                        onClick={() => patchBus(bus.id, { muted: !bus.muted })}
                      >
                        {bus.muted ? "Silenciado" : "Silencio"}
                      </button>
                    </article>
                  );
                })}
              </div>
            )}
          </section>
        </div>
      )}

      {channels.length > 0 && (musicChannels === 0 || previewChannels === 0) && (
        <p className="hint mixer-warning">
          {musicChannels === 0 && "La reproducción no tiene canal: sonará por la salida predeterminada. "}
          {previewChannels === 0 &&
            "La preescucha no tiene canal: sonará por la salida predeterminada."}
        </p>
      )}

      <p className="hint">
        Reproducción asignada a {musicChannels} canal(es) · Preescucha asignada a{" "}
        {previewChannels} canal(es).
      </p>
    </div>
  );
}
