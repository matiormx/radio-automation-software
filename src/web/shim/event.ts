// Sustituto de @tauri-apps/api/event: avisos dentro de la propia página.
export type UnlistenFn = () => void;
type Handler = (e: { event: string; payload: unknown; id: number }) => void;
const handlers = new Map<string, Set<Handler>>();

export async function listen<T>(event: string, cb: (e: { event: string; payload: T; id: number }) => void): Promise<UnlistenFn> {
  const set = handlers.get(event) ?? new Set<Handler>();
  set.add(cb as Handler);
  handlers.set(event, set);
  return () => set.delete(cb as Handler);
}

export async function once<T>(event: string, cb: (e: { event: string; payload: T; id: number }) => void): Promise<UnlistenFn> {
  const off = await listen<T>(event, (e) => {
    off();
    cb(e);
  });
  return off;
}

export async function emit(event: string, payload?: unknown): Promise<void> {
  for (const h of [...(handlers.get(event) ?? [])]) {
    try {
      h({ event, payload, id: 0 });
    } catch (e) {
      console.error(e);
    }
  }
}

export const emitTo = (_target: unknown, event: string, payload?: unknown) => emit(event, payload);
