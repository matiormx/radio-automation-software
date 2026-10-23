import { nativeDevices, nativeInputs } from "./nativeEngine";
import type { AudioDeviceSetting } from "./types";

export interface Device {
  id: string;
  label: string;
  kind: "audioinput" | "audiooutput";
}

export function deviceKey(kind: Device["kind"], id: string): string {
  return `${kind}:${id}`;
}

function fallbackLabel(kind: Device["kind"], index: number): string {
  return `${kind === "audioinput" ? "Entrada" : "Salida"} de audio ${index + 1}`;
}

function unique(devices: Device[]): Device[] {
  const seen = new Set<string>();
  const out: Device[] = [];
  for (const d of devices) {
    const key = deviceKey(d.kind, d.id);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(d);
  }
  return out;
}

async function webDevices(): Promise<{ inputs: Device[]; outputs: Device[] }> {
  const list = (await navigator.mediaDevices?.enumerateDevices?.()) ?? [];
  const counts = { audioinput: 0, audiooutput: 0 };
  const inputs: Device[] = [];
  const outputs: Device[] = [];
  for (const d of list) {
    if (d.kind !== "audioinput" && d.kind !== "audiooutput") continue;
    if (!d.deviceId || d.deviceId === "default") continue;
    const index = counts[d.kind]++;
    const device: Device = {
      id: d.deviceId,
      label: d.label?.trim() || fallbackLabel(d.kind, index),
      kind: d.kind,
    };
    if (d.kind === "audioinput") inputs.push(device);
    else outputs.push(device);
  }
  return { inputs: unique(inputs), outputs: unique(outputs) };
}

/** Tarjetas que ve cada motor: nombres en el nativo, deviceId en el WebView. */
export async function listAudioDevices(
  isNative: boolean,
): Promise<{ inputs: Device[]; outputs: Device[] }> {
  if (!isNative) return webDevices();
  const [ins, outs] = await Promise.all([
    nativeInputs().catch(() => [] as string[]),
    nativeDevices().catch(() => [] as string[]),
  ]);
  return {
    inputs: unique(ins.map((n) => ({ id: n, label: n, kind: "audioinput" as const }))),
    outputs: unique(outs.map((n) => ({ id: n, label: n, kind: "audiooutput" as const }))),
  };
}

/** Solo las tarjetas habilitadas en Ajustes > Sonido, con su alias. */
export function visibleDevices(
  devices: Device[],
  config: AudioDeviceSetting[] | undefined,
): Device[] {
  const all = config ?? [];
  return devices
    .filter((d) => all.some((c) => c.kind === d.kind && c.id === d.id && c.enabled))
    .map((d) => {
      const alias = all.find((c) => c.kind === d.kind && c.id === d.id)?.name?.trim();
      return alias ? { ...d, label: alias } : d;
    });
}
