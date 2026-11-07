/* eslint-disable @typescript-eslint/no-explicit-any */
// Sustituto de @tauri-apps/api/webviewWindow: no hay ventanas aparte.
export class WebviewWindow {
  constructor(..._args: any[]) {}
  static async getByLabel(_l: string): Promise<WebviewWindow | null> {
    return null;
  }
  async once(..._a: any[]) {
    return () => undefined;
  }
  async listen(..._a: any[]) {
    return () => undefined;
  }
  async show() {}
  async hide() {}
  async close() {}
  async setFocus() {}
  async unminimize() {}
  async isVisible() {
    return false;
  }
}
