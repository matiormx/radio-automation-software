import type { Settings } from "./types";

/** Tamaño y contraste de la interfaz (Ajustes › General › Apariencia). */
let mq: MediaQueryList | null = null;
let mqTheme = "dark";
let applyTheme: () => void = () => undefined;

export function applyAppearance(s: Pick<Settings, "uiScale" | "uiContrast" | "uiTheme"> | null | undefined) {
  const root = document.documentElement;
  const scale = Math.min(160, Math.max(80, s?.uiScale || 100));
  // zoom lo entienden WebView2 y WebKitGTK; todo escala igual (texto y botones).
  (root.style as CSSStyleDeclaration & { zoom: string }).zoom = scale === 100 ? "" : String(scale / 100);
  const c = s?.uiContrast || "normal";
  if (c === "normal") root.removeAttribute("data-contrast");
  else root.setAttribute("data-contrast", c);
  // Tema claro u oscuro (o el del sistema, siguiéndolo si cambia)
  mqTheme = s?.uiTheme || "dark";
  const set = () => {
    const light = mqTheme === "light" || (mqTheme === "system" && !!mq?.matches);
    if (light) root.setAttribute("data-theme", "light");
    else root.removeAttribute("data-theme");
  };
  if (!mq && typeof window !== "undefined" && window.matchMedia) {
    mq = window.matchMedia("(prefers-color-scheme: light)");
    mq.addEventListener?.("change", () => applyTheme());
  }
  applyTheme = set;
  set();
}
