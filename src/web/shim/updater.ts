export type Update = { version: string; body?: string; downloadAndInstall: (cb?: unknown) => Promise<void> };
export async function check(): Promise<Update | null> {
  return null;
}
