import { useCallback, useEffect, useState } from "react";
import type {
  InsertSettings,
  LevelerSettings,
  MixerBus,
  MixerChannel,
  MixerInput,
  Settings,
} from "../types";
import { levelerOf } from "../leveler";
import { IconPlus, IconTrash } from "../icons";
import type { SoundMixer } from "../mixer";
import { MAX_GAIN_DB, MIN_GAIN_DB } from "../mixer";

interface MixerPanelProps {
  settings: Settings;
  mixer: SoundMixer | null;
  onChange: (s: Settings) => void;
}

/** Nivelador automatico de ganancia de un canal o bus: se activa aqui. */
function LevelerControls({
  owner,
  label,
  onChange,
}: {
  owner: { leveler?: LevelerSettings };
  label: string;
  onChange: (leveler: LevelerSettings) => void;
}) {
  const lv = levelerOf(owner);
  const set = (patch: Partial<LevelerSettings>) =>
    onChange({ ...lv, ...patch });
  return (
    <div className="mixer-leveler">
      <label className="check-row">
        <input
          type="checkbox"
          checked={lv.enabled}
          aria-label={`Nivelador automático de ${label}`}
          onChange={(e) => set({ enabled: e.target.checked })}
        />
        <span>Nivelador automático</span>
      </label>
      {lv.enabled && (
        <div className="mixer-leveler-params">
          <label>
            <span>Objetivo (LUFS)</span>
            <input
              type="number"
              min={-30}
              max={-8}
              step={1}
              value={lv.targetLufs}
              onChange={(e) =>
                set({
                  targetLufs: Math.max(
                    -30,
                    Math.min(-8, Number(e.target.value) || -16),
                  ),
                })
              }
            />
          </label>
          <label>
            <span>Rango (± dB)</span>
            <input
              type="number"
              min={0}
              max={18}
              step={1}
              value={lv.maxGainDb}
              onChange={(e) =>
                set({
                  maxGainDb: Math.max(
                    0,
                    Math.min(18, Number(e.target.value) || 0),
                  ),
                })
              }
            />
          </label>
        </div>
      )}
    </div>
  );
}

function InsertControls({
  owner,
  label,
  inputs,
  outputs,
  onChange,
}: {
  owner: { insert?: InsertSettings };
  label: string;
  inputs: Device[];
  outputs: Device[];
  onChange: (insert: InsertSettings) => void;
}) {
  const ins: InsertSettings = {
    enabled: !!owner.insert?.enabled,
    sendDeviceId: owner.insert?.sendDeviceId ?? "",
    returnDeviceId: owner.insert?.returnDeviceId ?? "",
  };
  const set = (patch: Partial<InsertSettings>) =>
    onChange({ ...ins, ...patch });
  const incomplete = ins.enabled && (!ins.sendDeviceId || !ins.returnDeviceId);
  return (
    <div className="mixer-leveler">
      <label className="check-row">
        <input
          type="checkbox"
          checked={ins.enabled}
          aria-label={`Insert de ${label}`}
          onChange={(e) => set({ enabled: e.target.checked })}
        />
        <span>Insert (envío / retorno)</span>
      </label>
      {ins.enabled && (
        <div className="mixer-insert">
          <label className="mixer-field">
            <span>Envío</span>
            <select
              value={ins.sendDeviceId}
              onChange={(e) => set({ sendDeviceId: e.target.value })}
            >
              <option value="">Elige salida…</option>
              {outputs.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.label}
                </option>
              ))}
              {ins.sendDeviceId &&
                !outputs.some((d) => d.id === ins.sendDeviceId) && (
                  <option value={ins.sendDeviceId}>Salida no disponible</option>
                )}
            </select>
          </label>
          <label className="mixer-field">
            <span>Retorno</span>
            <select
              value={ins.returnDeviceId}
              onChange={(e) => set({ returnDeviceId: e.target.value })}
            >
              <option value="">Elige entrada…</option>
              {inputs.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.label}
                </option>
              ))}
              {ins.returnDeviceId &&
                !inputs.some((d) => d.id === ins.returnDeviceId) && (
                  <option value={ins.returnDeviceId}>
                    Entrada no disponible
                  </option>
                )}
            </select>
          </label>
          <p className="mixer-insert-hint">
            {incomplete
              ? "Elige envío y retorno; mientras tanto el canal suena directo."
              : "Usa un cable virtual hacia el procesador (p. ej. SuperRack) y otro de vuelta. Añade algo de latencia."}
          </p>
        </div>
      )}
    </div>
  );
}

interface Device {
  id: string;
  label: string;
  kind: "audioinput" | "audiooutput";
}

/** Paleta fija de 16 colores: más fácil igualar canales entre sí. */
const COLORS = [
  "#4f8cff",
  "#59d98c",
  "#ffb84d",
  "#f87171",
  "#c084fc",
  "#22d3ee",
  "#f472b6",
  "#a3e635",
  "#2563eb",
  "#16a34a",
  "#f97316",
  "#dc2626",
  "#9333ea",
  "#0891b2",
  "#db2777",
  "#94a3b8",
];

function ColorSwatches({
  value,
  label,
  onChange,
}: {
  value: string;
  label: string;
  onChange: (color: string) => void;
}) {
  return (
    <div
      className="mixer-swatches"
      role="radiogroup"
      aria-label={`Color de ${label}`}
    >
      {COLORS.map((c) => (
        <button
          key={c}
          type="button"
          role="radio"
          aria-checked={c.toLowerCase() === value.toLowerCase()}
          className={`mixer-swatch ${c.toLowerCase() === value.toLowerCase() ? "mixer-swatch-on" : ""}`}
          style={{ background: c }}
          title={c}
          onClick={() => onChange(c)}
        />
      ))}
    </div>
  );
}

function nextColor(count: number): string {
  return COLORS[count % COLORS.length];
}

function newId(): string {
  if (
    typeof crypto !== "undefined" &&
    typeof crypto.randomUUID === "function"
  ) {
    return crypto.randomUUID();
  }
  return `mixer-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function fmtDb(db: number): string {
  if (db <= MIN_GAIN_DB) return "-∞ dB";
  const value = db.toFixed(1).replace(".", ",");
  return `${db > 0 ? "+" : ""}${value} dB`;
}

function deviceLabel(
  kind: "audioinput" | "audiooutput",
  index: number,
): string {
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
      setDeviceError(
        `No se concedió acceso a las entradas de audio: ${String(e)}`,
      );
    } finally {
      setAsking(false);
    }
  };

  const channels = settings.mixerChannels ?? [];
  const buses = settings.mixerBuses ?? [];
  const inputs = devices.filter((d) => d.kind === "audioinput");
  const outputs = devices.filter(
    (d) => d.kind === "audiooutput" && d.id !== "default",
  );
  const canChooseOutputs =
    typeof HTMLMediaElement !== "undefined" &&
    "setSinkId" in HTMLMediaElement.prototype;

  const setChannels = (next: MixerChannel[]) =>
    onChange({ ...settings, mixerChannels: next });
  const setBuses = (next: MixerBus[]) =>
    onChange({ ...settings, mixerBuses: next });

  const patchChannel = (id: string, patch: Partial<MixerChannel>) => {
    setChannels(
      channels.map((ch) => (ch.id === id ? { ...ch, ...patch } : ch)),
    );
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
    onChange({
      ...settings,
      mixerBuses: buses.filter((bus) => bus.id !== id),
      mixerChannels: channels.map((ch) =>
        ch.output.kind === "bus" && ch.output.id === id
          ? { ...ch, output: { kind: "device", id: "default" } }
          : ch,
      ),
      monitorBusId: settings.monitorBusId === id ? "" : settings.monitorBusId,
    });
  };

  const musicChannels = channels.filter(
    (ch) =>
      ch.input.kind === "app" &&
      ch.input.app !== "preview" &&
      ch.input.app !== "call",
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
            Cada canal recibe una fuente y la envía a un bus o directamente a
            una tarjeta. Los buses suman varios canales antes de salir.
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
          <button
            type="button"
            className="btn btn-sm btn-accent"
            onClick={addChannel}
          >
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
          Este WebView no permite enrutar a varias tarjetas de salida. La mesa
          funcionará, pero todo saldrá por la salida predeterminada del sistema.
        </div>
      )}

      <p className="hint">
        Las entradas y salidas son las tarjetas físicas o virtuales del equipo.
        Las fuentes «aplicación» son la reproducción de la radio y la preescucha
        del normalizador.
        {!navigator.mediaDevices &&
          " Este WebView no permite seleccionar dispositivos."}
      </p>

      <div className="mixer-monitor-row">
        <div className="mixer-monitor-text">
          <strong>VU de salida</strong>
          <span>
            Elige la señal que muestra el medidor vertical de la pantalla
            principal.
          </span>
        </div>
        <select
          value={settings.monitorBusId}
          aria-label="Bus de monitorización del VU"
          onChange={(e) =>
            onChange({ ...settings, monitorBusId: e.target.value })
          }
        >
          <option value="">Salida general (master)</option>
          {buses.map((bus) => (
            <option key={bus.id} value={bus.id}>
              {bus.name}
            </option>
          ))}
          {settings.monitorBusId &&
            !buses.some((bus) => bus.id === settings.monitorBusId) && (
              <option value={settings.monitorBusId}>Bus no disponible</option>
            )}
        </select>
      </div>

      {channels.length === 0 && buses.length === 0 ? (
        <div className="mixer-empty">
          <strong>Sin canales configurados</strong>
          <span>
            La reproducción y la preescucha salen por la salida predeterminada
            del sistema. Crea un canal para asignar fuentes y tarjetas.
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
              <p className="hint">
                Sin canales. Añade uno para enrutar una fuente.
              </p>
            ) : (
              <div className="mixer-strips">
                {channels.map((ch) => (
                  <article className="mixer-strip" key={ch.id}>
                    <div
                      className="mixer-strip-color"
                      style={{ background: ch.color }}
                    />
                    <div className="mixer-strip-head">
                      <input
                        className="mixer-name"
                        value={ch.name}
                        aria-label="Nombre del canal"
                        onChange={(e) =>
                          patchChannel(ch.id, { name: e.target.value })
                        }
                      />
                      <button
                        type="button"
                        className="ghost-btn mixer-remove"
                        title="Eliminar canal"
                        onClick={() =>
                          setChannels(channels.filter((c) => c.id !== ch.id))
                        }
                      >
                        <IconTrash size={13} />
                      </button>
                    </div>

                    <div className="mixer-color-row">
                      <span>Color</span>
                      <ColorSwatches
                        value={ch.color}
                        label={ch.name}
                        onChange={(color) => patchChannel(ch.id, { color })}
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
                                  app:
                                    value === "preview"
                                      ? "preview"
                                      : value === "call"
                                        ? "call"
                                        : "music",
                                  deviceId: "",
                                }
                              : { kind: "device", app: "", deviceId: value };
                          patchChannel(ch.id, { input });
                        }}
                      >
                        <optgroup label="Aplicación">
                          <option value="app:music">
                            Reproducción de música
                          </option>
                          <option value="app:preview">
                            Preescucha de canciones
                          </option>
                          <option value="app:call">Llamadas de oyentes</option>
                        </optgroup>
                        <optgroup label="Tarjetas de entrada">
                          {inputs.map((d) => (
                            <option key={d.id} value={`device:${d.id}`}>
                              {d.label}
                            </option>
                          ))}
                          {ch.input.kind === "device" &&
                            !inputs.some(
                              (d) => d.id === (ch.input.deviceId || "default"),
                            ) && (
                              <option
                                value={`device:${ch.input.deviceId || "default"}`}
                              >
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
                        <optgroup label="Emisión">
                          <option value="device:streaming">
                            Streaming (encoders)
                          </option>
                        </optgroup>
                        <optgroup label="Tarjetas de salida">
                          <option value="device:default">
                            Salida predeterminada
                          </option>
                          {outputs.map((d) => (
                            <option key={d.id} value={`device:${d.id}`}>
                              {d.label}
                            </option>
                          ))}
                          {ch.output.kind === "device" &&
                            ch.output.id !== "default" &&
                            ch.output.id !== "streaming" &&
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
                        title="Doble clic: 0 dB"
                        onDoubleClick={() => patchChannel(ch.id, { gainDb: 0 })}
                        onChange={(e) =>
                          patchChannel(ch.id, {
                            gainDb: Number(e.target.value) || 0,
                          })
                        }
                      />
                      <span>{fmtDb(ch.gainDb)}</span>
                    </div>

                    <InsertControls
                      owner={ch}
                      label={ch.name}
                      inputs={inputs}
                      outputs={outputs}
                      onChange={(insert) => patchChannel(ch.id, { insert })}
                    />

                    <LevelerControls
                      owner={ch}
                      label={ch.name}
                      onChange={(leveler) => patchChannel(ch.id, { leveler })}
                    />

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
                Sin buses. Los canales pueden salir directamente a una tarjeta o
                sumarse a un bus.
              </p>
            ) : (
              <div className="mixer-strips">
                {buses.map((bus) => {
                  const feeding = channels.filter(
                    (ch) => ch.output.kind === "bus" && ch.output.id === bus.id,
                  ).length;
                  return (
                    <article className="mixer-strip" key={bus.id}>
                      <div
                        className="mixer-strip-color"
                        style={{ background: bus.color }}
                      />
                      <div className="mixer-strip-head">
                        <input
                          className="mixer-name"
                          value={bus.name}
                          aria-label="Nombre del bus"
                          onChange={(e) =>
                            patchBus(bus.id, { name: e.target.value })
                          }
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
                        <ColorSwatches
                          value={bus.color}
                          label={bus.name}
                          onChange={(color) => patchBus(bus.id, { color })}
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
                          <option value="streaming">
                            Streaming (encoders)
                          </option>
                          <option value="default">Salida predeterminada</option>
                          {outputs.map((d) => (
                            <option key={d.id} value={d.id}>
                              {d.label}
                            </option>
                          ))}
                          {bus.outputDeviceId !== "default" &&
                            bus.outputDeviceId !== "streaming" &&
                            !outputs.some(
                              (d) => d.id === bus.outputDeviceId,
                            ) && (
                              <option value={bus.outputDeviceId}>
                                Salida no disponible
                              </option>
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
                          title="Doble clic: 0 dB"
                          onDoubleClick={() => patchBus(bus.id, { gainDb: 0 })}
                          onChange={(e) =>
                            patchBus(bus.id, {
                              gainDb: Number(e.target.value) || 0,
                            })
                          }
                        />
                        <span>{fmtDb(bus.gainDb)}</span>
                      </div>

                      <InsertControls
                        owner={bus}
                        label={bus.name}
                        inputs={inputs}
                        outputs={outputs}
                        onChange={(insert) => patchBus(bus.id, { insert })}
                      />

                      <LevelerControls
                        owner={bus}
                        label={bus.name}
                        onChange={(leveler) => patchBus(bus.id, { leveler })}
                      />

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

      {channels.length > 0 &&
        (musicChannels === 0 || previewChannels === 0) && (
          <p className="hint mixer-warning">
            {musicChannels === 0 &&
              "La reproducción no tiene canal: sonará por la salida predeterminada. "}
            {previewChannels === 0 &&
              "La preescucha no tiene canal: sonará por la salida predeterminada."}
          </p>
        )}

      <p className="hint">
        Reproducción asignada a {musicChannels} canal(es) · Preescucha asignada
        a {previewChannels} canal(es).
      </p>
    </div>
  );
}
