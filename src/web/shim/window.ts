// Sustituto de @tauri-apps/api/window: en el navegador no hay ventanas que
// mover ni cerrar; todo responde «sin hacer nada».
/* eslint-disable @typescript-eslint/no-explicit-any */
const noop: any = new Proxy(function () {}, {
  get: (_t, prop) => {
    if (prop === "then") return undefined;
    if (prop === "label") return "main";
    if (typeof prop === "string" && prop.startsWith("on")) return async () => () => undefined;
    return async () => null;
  },
  apply: () => noop,
});

export type Window = any;
export function getCurrentWindow(): any {
  return noop;
}
export async function availableMonitors(): Promise<any[]> {
  return [];
}
export async function currentMonitor(): Promise<any> {
  return null;
}
export class LogicalPosition {
  constructor(public x: number, public y: number) {}
}
export class LogicalSize {
  constructor(public width: number, public height: number) {}
}
export class PhysicalPosition {
  constructor(public x: number, public y: number) {}
}
export class PhysicalSize {
  constructor(public width: number, public height: number) {}
}
