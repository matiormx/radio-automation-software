import type { Settings } from "./types";

/** Tamaño y contraste de la interfaz (Ajustes › General › Apariencia). */
export function applyAppearance(s: Pick<Settings, "uiScale" | "uiContrast"> | null | undefined) {
  const root = document.documentElement;
  const scale = Math.min(160, Math.max(80, s?.uiScale || 100));
  // zoom lo entienden WebView2 y WebKitGTK; todo escala igual (texto y botones).
  (root.style as CSSStyleDeclaration & { zoom: string }).zoom = scale === 100 ? "" : String(scale / 100);
  const c = s?.uiContrast || "normal";
  if (c === "normal") root.removeAttribute("data-contrast");
  else root.setAttribute("data-contrast", c);
}
