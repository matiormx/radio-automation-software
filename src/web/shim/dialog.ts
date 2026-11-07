// Sustituto de @tauri-apps/plugin-dialog con los diálogos del navegador.
export async function ask(message: string, _opts?: unknown): Promise<boolean> {
  return window.confirm(message);
}
export async function confirm(message: string, _opts?: unknown): Promise<boolean> {
  return window.confirm(message);
}
export async function message(msg: string, _opts?: unknown): Promise<void> {
  window.alert(msg);
}
import { uploadImage } from "../store";

/**
 * Elegir un archivo: las imágenes (portadas) se suben a la nube y se devuelve
 * su referencia («media:…»). Para el audio está el botón de subir.
 */
export async function open(opts?: { filters?: { extensions?: string[] }[] }): Promise<string | null> {
  const exts = (opts?.filters ?? []).flatMap((f) => f.extensions ?? []);
  if (!exts.some((e) => ["png", "jpg", "jpeg", "webp", "gif"].includes(e))) return null;
  const file = await new Promise<File | null>((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/png,image/jpeg,image/webp,image/gif";
    input.style.display = "none";
    document.body.appendChild(input);
    let done = false;
    const end = (f: File | null) => {
      if (done) return;
      done = true;
      input.remove();
      resolve(f);
    };
    input.onchange = () => end(input.files?.[0] ?? null);
    input.oncancel = () => window.setTimeout(() => end(input.files?.[0] ?? null), 800);
    input.click();
  });
  if (!file) return null;
  if (file.size > 20 * 1024 * 1024) {
    window.alert("La imagen es demasiado grande (máximo 20 MB)");
    return null;
  }
  return uploadImage(file);
}
export async function save(_opts?: unknown): Promise<null> {
  return null;
}
