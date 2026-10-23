import { useCallback, useEffect, useRef, useState } from "react";
import { listAudioDevices, type Device } from "../audioDevices";
import { IconTrash } from "../icons";
import type { AudioDeviceSetting, Settings } from "../types";

interface Props {
  settings: Settings;
  onChange: (s: Settings) => void;
}

interface Row {
  device: Device;
  available: boolean;
  setting?: AudioDeviceSetting;
}

function DeviceRow({
  row,
  onToggle,
  onRename,
  onRemove,
}: {
  row: Row;
  onToggle: (on: boolean) => void;
  onRename: (name: string) => void;
  onRemove: () => void;
}) {
  const { device, available, setting } = row;
  return (
    <div className="stream-card stream-row">
      <div className="stream-line">
        <input
          type="checkbox"
          checked={!!setting?.enabled}
          aria-label={`Habilitar ${setting?.name || device.label}`}
          title={setting?.enabled ? "Habilitado en la mesa" : "Deshabilitado"}
          onChange={(e) => onToggle(e.target.checked)}
        />
        <input
          className="io-name device-name"
          value={setting?.name ?? ""}
          placeholder={device.label}
          aria-label={`Nombre de ${device.label}`}
          title="Nombre que verás en la mesa"
          onChange={(e) => onRename(e.target.value)}
        />
        <span className="stream-line-codec">{device.kind === "audioinput" ? "IN" : "OUT"}</span>
        <span className="stream-line-url" title={device.label}>
          {available ? device.label : "No disponible"}
        </span>
        {setting ? (
          <button
            type="button"
            className="ghost-btn io-del"
            title="Quitar de la lista"
            aria-label={`Quitar ${setting.name || device.label}`}
            onClick={onRemove}
          >
            <IconTrash size={14} />
          </button>
        ) : (
          <span className="device-del-space" />
        )}
      </div>
    </div>
  );
}

/**
 * Ajustes > Sonido: elige que entradas y salidas estarán disponibles en la
 * mesa y con qué nombre aparecen. La mesa se edita en su propia ventana.
 */
export function SoundTab({ settings, onChange }: Props) {
  const isNative = settings.audioEngine === "native";
  const [inputs, setInputs] = useState<Device[]>([]);
  const [outputs, setOutputs] = useState<Device[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [asking, setAsking] = useState(false);
  const request = useRef(0);
  const config = settings.audioDevices ?? [];

  const refresh = useCallback(async () => {
    const id = ++request.current;
    setBusy(true);
    try {
      const next = await listAudioDevices(isNative);
      if (id !== request.current) return;
      setInputs(next.inputs);
      setOutputs(next.outputs);
      setError("");
    } catch (e) {
      if (id === request.current) setError(`No se pudieron leer los dispositivos: ${String(e)}`);
    } finally {
      if (id === request.current) setBusy(false);
    }
  }, [isNative]);

  useEffect(() => {
    void refresh();
    if (isNative) return () => {
      request.current += 1;
    };
    const media = navigator.mediaDevices;
    if (!media?.addEventListener) return () => {
      request.current += 1;
    };
    const onChangeDevices = () => void refresh();
    media.addEventListener("devicechange", onChangeDevices);
    return () => {
      request.current += 1;
      media.removeEventListener("devicechange", onChangeDevices);
    };
  }, [refresh, isNative]);

  const askPermission = async () => {
    if (!navigator.mediaDevices?.getUserMedia) {
      setError("Este equipo no permite capturar audio.");
      return;
    }
    setAsking(true);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      for (const track of stream.getTracks()) track.stop();
      await refresh();
    } catch (e) {
      setError(`No se concedió acceso a las entradas de audio: ${String(e)}`);
    } finally {
      setAsking(false);
    }
  };

  const settingFor = (device: Device) =>
    config.find((c) => c.kind === device.kind && c.id === device.id);

  const patchDevice = (device: Device, patch: Partial<AudioDeviceSetting>) => {
    const existing = settingFor(device);
    if (existing) {
      onChange({
        ...settings,
        audioDevices: config.map((c) => (c === existing ? { ...c, ...patch } : c)),
      });
      return;
    }
    onChange({
      ...settings,
      audioDevices: [
        ...config,
        {
          id: device.id,
          kind: device.kind,
          label: device.label,
          name: "",
          enabled: false,
          ...patch,
        },
      ],
    });
  };

  const removeDevice = (device: Device) =>
    onChange({
      ...settings,
      audioDevices: config.filter((c) => !(c.kind === device.kind && c.id === device.id)),
    });

  const rowsFor = (kind: Device["kind"]): Row[] => {
    const list = kind === "audioinput" ? inputs : outputs;
    const rows: Row[] = list.map((device) => ({
      device,
      available: true,
      setting: settingFor(device),
    }));
    const seen = new Set(list.map((d) => d.id));
    for (const c of config) {
      if (c.kind !== kind || seen.has(c.id)) continue;
      seen.add(c.id);
      rows.push({
        device: { id: c.id, label: c.label || c.id, kind: c.kind },
        available: false,
        setting: c,
      });
    }
    return rows;
  };

  const section = (kind: Device["kind"], title: string, hint: string) => {
    const rows = rowsFor(kind);
    const enabled = rows.filter((r) => r.setting?.enabled).length;
    return (
      <div className="device-group">
        <div className="device-head">
          <strong>{title}</strong>
          <span>
            {enabled} de {rows.length} habilitadas
          </span>
        </div>
        {rows.length === 0 ? (
          <p className="hint">{hint}</p>
        ) : (
          <div className="stream-list">
            {rows.map((row) => (
              <DeviceRow
                key={`${row.device.kind}:${row.device.id}`}
                row={row}
                onToggle={(on) => patchDevice(row.device, { enabled: on, label: row.device.label })}
                onRename={(name) => patchDevice(row.device, { name })}
                onRemove={() => removeDevice(row.device)}
              />
            ))}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="mixer-panel">
      <div className="mixer-toolbar">
        <div className="mixer-toolbar-text">
          <strong>Sonido</strong>
          <span>
            Elige las tarjetas que estarán disponibles en la mesa y ponles el nombre que quieras ver allí.
            La mesa se abre desde la barra superior.
          </span>
        </div>
        <div className="mixer-toolbar-actions">
          <button type="button" className="btn btn-sm" onClick={() => void refresh()} disabled={busy}>
            {busy ? "Actualizando…" : "Actualizar"}
          </button>
          {!isNative && (
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => void askPermission()}
              disabled={asking}
              title="Solicita permiso para ver los nombres de las entradas"
            >
              {asking ? "Solicitando…" : "Ver entradas"}
            </button>
          )}
        </div>
      </div>

      <div className="mixer-monitor-row">
        <div className="mixer-monitor-text">
          <strong>Motor de audio</strong>
          <span>
            {isNative
              ? "Nativo (beta): MiRadio reproduce y mezcla directamente en las tarjetas. Las entradas y salidas de la mesa son las del sistema."
              : "Web: el audio pasa por el motor de la ventana. Elige aquí las tarjetas antes de montar la mesa."}
          </span>
        </div>
        <select
          value={settings.audioEngine ?? "web"}
          aria-label="Motor de audio"
          onChange={(e) => {
            const next = e.target.value === "native" ? "native" : "web";
            if (
              !window.confirm(
                "Cambiar de motor detiene la reproducción. ¿Continuar? (No lo cambies en pleno directo.)",
              )
            )
              return;
            onChange({ ...settings, audioEngine: next });
          }}
        >
          <option value="web">Web (estable)</option>
          <option value="native">Nativo (beta)</option>
        </select>
      </div>

      {error && <div className="form-error">{error}</div>}
      {!isNative && typeof HTMLMediaElement !== "undefined" && !("setSinkId" in HTMLMediaElement.prototype) && (
        <div className="form-error">
          Este WebView no permite enrutar a varias tarjetas de salida. La mesa funcionará, pero todo saldrá por
          la salida predeterminada del sistema.
        </div>
      )}

      {section("audioinput", "Entradas", "No hay entradas disponibles. Pulsa «Ver entradas» o actualiza.")}
      {section("audiooutput", "Salidas", "No hay salidas disponibles. Pulsa «Actualizar».")}
    </div>
  );
}
