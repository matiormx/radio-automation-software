// Sustituto de @tauri-apps/api/core en la gestión web: las órdenes que la
// interfaz manda al núcleo de OmniCaster las atiende el almacén web, que
// trabaja contra el maestro.
import { webInvoke, mediaUrl } from "../store";

export function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  return webInvoke(cmd, args ?? {}) as Promise<T>;
}

export function convertFileSrc(path: string): string {
  return mediaUrl(path);
}
