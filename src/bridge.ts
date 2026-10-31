import { emit, listen, type UnlistenFn } from "@tauri-apps/api/event";
import { availableMonitors, currentMonitor, getCurrentWindow, LogicalPosition, LogicalSize, PhysicalPosition, type Window } from "@tauri-apps/api/window";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";

/**
 * Ventanas de herramientas (Ajustes, Mixer...) y su puente con la ventana
 * principal. El audio y la logica viven en la principal: las demas piden
 * acciones con `callMain` y reciben el estado compartido por `onMainState`.
 */

export type ToolKind = "settings" | "mixer" | "library" | "chat";

export function toolKind(): ToolKind | "videoout" | "videonp" | "ai" | null {
  const w = new URLSearchParams(window.location.search).get("w");
  return w === "settings" || w === "mixer" || w === "library" || w === "chat" || w === "videoout" || w === "videonp" || w === "ai" ? w : null;
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

let videoOutWatch: number | undefined;
let npWatch: number | undefined;

/**
 * Vigila que una ventana escondida siga fuera de la vista. Solo la vuelve a
 * mover (sin tocar su orden ni el foco: hacerlo cada 2 s en Linux traia la
 * ventana principal al frente y tapaba Ajustes). Si el sistema no la deja
 * fuera de la pantalla, deja de insistir tras unos intentos.
 */
function watchParked(win: WebviewWindow): number {
  let misses = 0;
  const id = window.setInterval(async () => {
    const p = await win.outerPosition().catch(() => null);
    if (!p || p.x <= -10000) {
      misses = 0;
      return;
    }
    misses += 1;
    if (misses > 3) {
      window.clearInterval(id);
      return;
    }
    await win.setPosition(new PhysicalPosition(-32000, -32000)).catch(() => undefined);
  }, 2000);
  return id;
}

/** Esconde una ventana: fuera de todos los monitores, al fondo, sin clics ni foco. */
async function parkWindow(win: WebviewWindow) {
  await win.setFullscreen(false).catch(() => undefined);
  await win.setPosition(new PhysicalPosition(-32000, -32000)).catch(() => undefined);
  await win.setAlwaysOnTop(false).catch(() => undefined);
  await win.setAlwaysOnBottom(true).catch(() => undefined);
  await win.setSkipTaskbar(true).catch(() => undefined);
  await win.setIgnoreCursorEvents(true).catch(() => undefined);
  await win.setFocusable(false).catch(() => undefined);
}

/**
 * Abre (o mueve) la ventana de video a pantalla completa en el monitor elegido.
 * Devuelve "hidden" si ese monitor es el de OmniCaster (o no hay otro): la
 * ventana no se muestra nunca ahi, queda oculta y se sigue emitiendo.
 */
export async function openVideoOut(monitor: number): Promise<boolean | "hidden"> {
  try {
    const ms = await availableMonitors();
    const m = ms[monitor] ?? ms[0];
    const main = await currentMonitor();
    const sameAsMain = !!m && !!main && m.position.x === main.position.x && m.position.y === main.position.y;
    const hidden = ms.length < 2 || sameAsMain;
    const sf = m?.scaleFactor ?? 1;
    const x = m ? m.position.x / sf : 0;
    const y = m ? m.position.y / sf : 0;
    const w = m ? m.size.width / sf : 1280;
    const h = m ? m.size.height / sf : 720;
    let win = await WebviewWindow.getByLabel("videoout");
    if (!win) {
      win = new WebviewWindow("videoout", {
        url: "index.html?w=videoout",
        title: "OmniCaster Programa",
        x: hidden ? -20000 : x,
        y: hidden ? 0 : y,
        width: hidden ? 1280 : w,
        height: hidden ? 720 : h,
        decorations: false,
        shadow: false,
        focus: false,
        skipTaskbar: true,
        alwaysOnTop: !hidden,
        dragDropEnabled: false,
      });
      const created = await new Promise<boolean>((resolve) => {
        void win!.once("tauri://created", () => resolve(true));
        void win!.once("tauri://error", () => resolve(false));
      });
      if (!created) return false;
    }
    window.clearInterval(videoOutWatch);
    videoOutWatch = undefined;
    await win.setTitle("OmniCaster Programa").catch(() => undefined);
    await win.show().catch(() => undefined);
    if (hidden) {
      await parkWindow(win);
      // Windows la recoloca a veces: se vigila que siga fuera de la vista.
      videoOutWatch = watchParked(win);
      return "hidden";
    }
    const place = async (full: boolean) => {
      await win!.setIgnoreCursorEvents(false).catch(() => undefined);
      await win!.setAlwaysOnBottom(false).catch(() => undefined);
      await win!.setFullscreen(false).catch(() => undefined);
      await win!.setPosition(new LogicalPosition(x, y)).catch(() => undefined);
      await win!.setSize(new LogicalSize(w, h)).catch(() => undefined);
      await win!.setAlwaysOnTop(true).catch(() => undefined);
      if (full) await win!.setFullscreen(true).catch(() => undefined);
    };
    await place(true);
    // Vigilante: siempre en su monitor, a pantalla completa y por encima de todo.
    const target = win;
    videoOutWatch = window.setInterval(async () => {
      const [p, full] = await Promise.all([
        target.outerPosition().catch(() => null),
        target.isFullscreen().catch(() => true),
      ]);
      const off = !p || p.x < (m?.position.x ?? 0) - 2 || p.x >= (m?.position.x ?? 0) + (m?.size.width ?? 1) || p.y < (m?.position.y ?? 0) - 2 || p.y >= (m?.position.y ?? 0) + (m?.size.height ?? 1);
      if (off || !full) await place(true);
      else await target.setAlwaysOnTop(true).catch(() => undefined);
    }, 2000);
    return true;
  } catch {
    return false;
  }
}

export async function closeVideoOut(): Promise<void> {
  window.clearInterval(videoOutWatch);
  videoOutWatch = undefined;
  try {
    const win = await WebviewWindow.getByLabel("videoout");
    await win?.destroy();
  } catch {
    /* ya cerrada */
  }
}

/**
 * Ventana «OmniCaster Lo que suena»: solo lo que suena (vídeo o portada, nunca
 * cámaras ni NDI). Va fuera de la pantalla, sin barra de tareas; FFmpeg la
 * captura para las salidas que emiten «Lo que está sonando».
 */
export async function openNowPlayingOut(width: number, height: number): Promise<boolean> {
  try {
    const w = Math.max(320, Math.round(width));
    const h = Math.max(180, Math.round(height));
    let win = await WebviewWindow.getByLabel("videonp");
    if (!win) {
      win = new WebviewWindow("videonp", {
        url: "index.html?w=videonp",
        title: "OmniCaster Lo que suena",
        x: -20000,
        y: 0,
        width: w,
        height: h,
        decorations: false,
        shadow: false,
        focus: false,
        resizable: false,
        skipTaskbar: true,
        dragDropEnabled: false,
        // Fuera de la vista: que no deje de pintar.
        backgroundThrottling: "disabled" as never,
      });
      const created = await new Promise<boolean>((resolve) => {
        void win!.once("tauri://created", () => resolve(true));
        void win!.once("tauri://error", () => resolve(false));
      });
      if (!created) return false;
    } else {
      await win.setSize(new LogicalSize(w, h)).catch(() => undefined);
    }
    // Windows suele ignorar la posicion al crear: se esconde despues, fuera de
    // todos los monitores, al fondo y sin recibir clics ni foco.
    await parkWindow(win);
    window.clearInterval(npWatch);
    npWatch = watchParked(win);
    return true;
  } catch {
    return false;
  }
}

export async function closeNowPlayingOut(): Promise<void> {
  window.clearInterval(npWatch);
  npWatch = undefined;
  try {
    const win = await WebviewWindow.getByLabel("videonp");
    await win?.destroy();
  } catch {
    /* ya cerrada */
  }
}

const TOOL_SIZES: Record<ToolKind, { title: string; width: number; height: number; minWidth: number; minHeight: number }> = {
  settings: { title: "Ajustes — OmniCaster", width: 1180, height: 820, minWidth: 820, minHeight: 560 },
  library: { title: "Librería — OmniCaster", width: 1360, height: 860, minWidth: 900, minHeight: 560 },
  mixer: { title: "Mixer — OmniCaster", width: 1240, height: 860, minWidth: 420, minHeight: 600 },
  chat: { title: "Chat — OmniCaster", width: 420, height: 680, minWidth: 300, minHeight: 360 },
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

/**
 * Abre (o trae al frente) la ventana aparte del analizador de IA. Es una
 * ventana normal (con su barra del sistema): se puede minimizar y el
 * analisis sigue mientras se trabaja en la principal. Los datos (canciones
 * y ajustes) ya fueron guardados en disco con aiWindowPayloadSet.
 */
export async function openAiWindow(): Promise<boolean> {
  try {
    const existing = await WebviewWindow.getByLabel("ai");
    if (existing) {
      await existing.unminimize().catch(() => undefined);
      await existing.show().catch(() => undefined);
      await existing.setFocus().catch(() => undefined);
      await emit("ai://open", true);
      return true;
    }
    const win = new WebviewWindow("ai", {
      url: "index.html?w=ai",
      title: "OmniCaster · Análisis de metadatos con IA",
      width: 1020,
      height: 760,
      minWidth: 700,
      minHeight: 480,
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
