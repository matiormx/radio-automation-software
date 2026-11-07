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
/** Elegir rutas del disco no tiene sentido aquí (se sube con el botón de subir). */
export async function open(_opts?: unknown): Promise<null> {
  return null;
}
export async function save(_opts?: unknown): Promise<null> {
  return null;
}
