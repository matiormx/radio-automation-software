import { emit, listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";

/**
 * Ventanas de herramientas (Ajustes, Mixer...) y su puente con la ventana
 * principal. El audio y la logica viven en la principal: las demas piden
 * acciones con `callMain` y reciben el estado compartido por `onMainState`.
 */

export type ToolKind = "settings" | "mixer" | "library";

export function toolKind(): ToolKind | null {
  const w = new URLSearchParams(window.location.search).get("w");
  return w === "settings" || w === "mixer" || w === "library" ? w : null;
}

const TOOL_SIZES: Record<ToolKind, { title: string; width: number; height: number; minWidth: number; minHeight: number }> = {
  settings: { title: "Ajustes — MiRadio", width: 1180, height: 820, minWidth: 820, minHeight: 560 },
  library: { title: "Librería — MiRadio", width: 1360, height: 860, minWidth: 900, minHeight: 560 },
  mixer: { title: "Mixer — MiRadio", width: 1240, height: 860, minWidth: 420, minHeight: 600 },
};

/** Abre (o trae al frente) una ventana de herramienta. */
export async function openToolWindow(kind: ToolKind): Promise<boolean> {
  try {
    const existing = await WebviewWindow.getByLabel(kind);
    if (existing) {
      await existing.unminimize().catch(() => undefined);
      await existing.show().catch(() => undefined);
      await existing.setFocus().catch(() => undefined);
      return true;
    }
    const size = TOOL_SIZES[kind];
    const win = new WebviewWindow(kind, {
      url: `index.html?w=${kind}`,
      title: size.title,
      width: size.width,
      height: size.height,
      minWidth: size.minWidth,
      minHeight: size.minHeight,
      decorations: false,
      shadow: true,
      center: true,
      dragDropEnabled: false,
    });
    return await new Promise<boolean>((resolve) => {
      void win.once("tauri://created", () => resolve(true));
      void win.once("tauri://error", () => resolve(false));
    });
  } catch {
    return false;
  }
}

// ------------------------------------------------------------ llamadas

interface CallMsg {
  id: string;
  name: string;
  args: unknown[];
}

interface ReplyMsg {
  id: string;
  ok: boolean;
  value?: unknown;
  error?: string;
}

type Handlers = Record<string, (...args: never[]) => unknown>;

/** Ventana principal: atiende las llamadas de las demas ventanas. */
export function serveMain(getHandlers: () => Handlers): Promise<UnlistenFn> {
  return listen<CallMsg>("bridge://call", async (event) => {
    const { id, name, args } = event.payload;
    const fn = getHandlers()[name] as ((...a: unknown[]) => unknown) | undefined;
    let reply: ReplyMsg;
    if (!fn) {
      reply = { id, ok: false, error: `Acción desconocida: ${name}` };
    } else {
      try {
        reply = { id, ok: true, value: await fn(...(args ?? [])) };
      } catch (error) {
        reply = { id, ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    }
    await emit("bridge://reply", reply);
  });
}

let replyListener: Promise<UnlistenFn> | null = null;
const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

/** Ventana de herramienta: pide una accion a la principal. */
export async function callMain<T = unknown>(name: string, ...args: unknown[]): Promise<T> {
  if (!replyListener) {
    replyListener = listen<ReplyMsg>("bridge://reply", (event) => {
      const r = event.payload;
      const p = pending.get(r.id);
      if (!p) return;
      pending.delete(r.id);
      if (r.ok) p.resolve(r.value);
      else p.reject(new Error(r.error ?? "Error"));
    });
  }
  await replyListener;
  const id = `${getCurrentWindow().label}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      pending.delete(id);
      reject(new Error("La ventana principal no responde"));
    }, 120000);
    pending.set(id, {
      resolve: (v) => {
        window.clearTimeout(timer);
        resolve(v as T);
      },
      reject: (e) => {
        window.clearTimeout(timer);
        reject(e);
      },
    });
    void emit("bridge://call", { id, name, args } satisfies CallMsg);
  });
}

// ------------------------------------------------------------ estado

/** Ventana principal: publica el estado compartido. */
export function publishState<T>(state: T): void {
  void emit("bridge://state", state);
}

/** Ventana de herramienta: recibe el estado compartido. */
export function onMainState<T>(fn: (state: T) => void): Promise<UnlistenFn> {
  return listen<T>("bridge://state", (event) => fn(event.payload));
}
