import { emit, listen, type UnlistenFn } from "@tauri-apps/api/event";
import { availableMonitors, currentMonitor, getCurrentWindow, LogicalPosition, LogicalSize, type Window } from "@tauri-apps/api/window";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";

/**
 * Ventanas de herramientas (Ajustes, Mixer...) y su puente con la ventana
 * principal. El audio y la logica viven en la principal: las demas piden
 * acciones con `callMain` y reciben el estado compartido por `onMainState`.
 */

export type ToolKind = "settings" | "mixer" | "library" | "chat";

export function toolKind(): ToolKind | "videoout" | null {
  const w = new URLSearchParams(window.location.search).get("w");
  return w === "settings" || w === "mixer" || w === "library" || w === "chat" || w === "videoout" ? w : null;
}

// ------------------------------------------------------------ video de emision

export interface MonitorInfo {
  index: number;
  name: string;
  width: number;
  height: number;
}

export async function listMonitors(): Promise<MonitorInfo[]> {
  try {
    const ms = await availableMonitors();
    return ms.map((m, index) => ({
      index,
      name: m.name ?? `Pantalla ${index + 1}`,
      width: Math.round(m.size.width / m.scaleFactor),
      height: Math.round(m.size.height / m.scaleFactor),
    }));
  } catch {
    return [];
  }
}

/** Abre (o mueve) la ventana de video a pantalla completa en el monitor elegido. */
export async function openVideoOut(monitor: number): Promise<boolean> {
  try {
    const ms = await availableMonitors();
    const m = ms[monitor] ?? ms[0];
    const sf = m?.scaleFactor ?? 1;
    const x = m ? m.position.x / sf : 0;
    const y = m ? m.position.y / sf : 0;
    const w = m ? m.size.width / sf : 1280;
    const h = m ? m.size.height / sf : 720;
    let win = await WebviewWindow.getByLabel("videoout");
    if (!win) {
      win = new WebviewWindow("videoout", {
        url: "index.html?w=videoout",
        title: "MiRadio Programa",
        x,
        y,
        width: w,
        height: h,
        decorations: false,
        shadow: false,
        focus: false,
        dragDropEnabled: false,
      });
      const created = await new Promise<boolean>((resolve) => {
        void win!.once("tauri://created", () => resolve(true));
        void win!.once("tauri://error", () => resolve(false));
      });
      if (!created) return false;
    } else {
      await win.setFullscreen(false).catch(() => undefined);
      await win.setPosition(new LogicalPosition(x, y)).catch(() => undefined);
      await win.setSize(new LogicalSize(w, h)).catch(() => undefined);
      await win.setTitle("MiRadio Programa").catch(() => undefined);
      await win.show().catch(() => undefined);
    }
    // En un monitor aparte, pantalla completa; en el mismo, ventana normal.
    if (ms.length > 1) await win.setFullscreen(true).catch(() => undefined);
    return true;
  } catch {
    return false;
  }
}

export async function closeVideoOut(): Promise<void> {
  try {
    const win = await WebviewWindow.getByLabel("videoout");
    await win?.destroy();
  } catch {
    /* ya cerrada */
  }
}

const TOOL_SIZES: Record<ToolKind, { title: string; width: number; height: number; minWidth: number; minHeight: number }> = {
  settings: { title: "Ajustes — MiRadio", width: 1180, height: 820, minWidth: 820, minHeight: 560 },
  library: { title: "Librería — MiRadio", width: 1360, height: 860, minWidth: 900, minHeight: 560 },
  mixer: { title: "Mixer — MiRadio", width: 1240, height: 860, minWidth: 420, minHeight: 600 },
  chat: { title: "Chat — MiRadio", width: 420, height: 680, minWidth: 300, minHeight: 360 },
};

/** Area util de la pantalla (sin barra de tareas), en pixeles logicos. */
export async function workArea(): Promise<{ width: number; height: number } | null> {
  try {
    const m = await currentMonitor();
    if (!m) return null;
    const wa = m.workArea ?? { size: m.size };
    return { width: wa.size.width / m.scaleFactor, height: wa.size.height / m.scaleFactor };
  } catch {
    return null;
  }
}

/** Tamaño de una ventana de herramienta que cabe en la pantalla. */
async function fittedSize(kind: ToolKind) {
  const size = TOOL_SIZES[kind];
  const wa = await workArea();
  if (!wa) return size;
  const width = Math.min(size.width, Math.round(wa.width - 24));
  const height = Math.min(size.height, Math.round(wa.height - 24));
  return {
    ...size,
    width,
    height,
    minWidth: Math.min(size.minWidth, width),
    minHeight: Math.min(size.minHeight, height),
  };
}

/** Si la ventana es mas grande que la pantalla, la ajusta (o la maximiza). */
export async function fitToScreen(win: Window = getCurrentWindow(), maximizeIfSmall = false): Promise<void> {
  try {
    const wa = await workArea();
    if (!wa) return;
    const sf = await win.scaleFactor();
    const outer = await win.outerSize();
    const w = outer.width / sf;
    const h = outer.height / sf;
    if (w > wa.width || h > wa.height) {
      await win.setSize(new LogicalSize(Math.min(w, wa.width - 16), Math.min(h, wa.height - 16)));
      await win.center();
    }
    if (maximizeIfSmall && (wa.width < 1500 || wa.height < 900)) {
      await win.maximize();
    }
  } catch {
    /* sin permisos o sin monitor: se queda como esta */
  }
}

/**
 * Crea la ventana oculta y ya cargada, para que abrirla despues sea
 * instantaneo (arrancar un WebView desde cero tarda segundos).
 */
export async function prewarmToolWindow(kind: ToolKind): Promise<void> {
  try {
    if (await WebviewWindow.getByLabel(kind)) return;
    const size = await fittedSize(kind);
    new WebviewWindow(kind, {
      url: `index.html?w=${kind}`,
      title: size.title,
      width: size.width,
      height: size.height,
      minWidth: size.minWidth,
      minHeight: size.minHeight,
      decorations: false,
      shadow: true,
      center: true,
      visible: false,
      dragDropEnabled: false,
    });
  } catch {
    /* se creara al abrirla */
  }
}

const SNAPSHOT_KEY = "miradio.bridge.state";

/** Ultimo estado compartido guardado: permite pintar la ventana al instante. */
export function readStateSnapshot<T>(): T | null {
  try {
    const raw = localStorage.getItem(SNAPSHOT_KEY);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

/** Abre (o trae al frente) una ventana de herramienta. */
export async function openToolWindow(kind: ToolKind): Promise<boolean> {
  try {
    const existing = await WebviewWindow.getByLabel(kind);
    if (existing) {
      await existing.unminimize().catch(() => undefined);
      await fitToScreen(existing as unknown as Window);
      await existing.show().catch(() => undefined);
      await existing.setFocus().catch(() => undefined);
      return true;
    }
    const size = await fittedSize(kind);
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
  return callMainTimeout<T>(120000, name, ...args);
}

export async function callMainTimeout<T = unknown>(timeoutMs: number, name: string, ...args: unknown[]): Promise<T> {
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
    }, timeoutMs);
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
  try {
    localStorage.setItem(SNAPSHOT_KEY, JSON.stringify(state));
  } catch {
    /* sin almacenamiento: solo se pierde la pintura instantanea */
  }
  void emit("bridge://state", state);
}

/** Ventana de herramienta: recibe el estado compartido. */
export function onMainState<T>(fn: (state: T) => void): Promise<UnlistenFn> {
  return listen<T>("bridge://state", (event) => fn(event.payload));
}
