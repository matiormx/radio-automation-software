import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { renameSync, existsSync } from "node:fs";

// Gestión web del maestro: la misma interfaz de OmniCaster, para el
// navegador. Las órdenes al núcleo (Tauri) las atiende src/web/store.ts.
// Se compila con `npm run build:web` y se sirve en https://<maestro>/app/.
const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const outDir = process.env.WEB_OUT || r("./dist-web");

export default defineConfig({
  base: "/app/",
  plugins: [
    react(),
    {
      name: "web-index",
      closeBundle() {
        const from = `${outDir}/web.html`;
        if (existsSync(from)) renameSync(from, `${outDir}/index.html`);
      },
    },
  ],
  define: { "import.meta.env.VITE_WEB": JSON.stringify("1") },
  resolve: {
    alias: [
      { find: "@tauri-apps/api/core", replacement: r("./src/web/shim/core.ts") },
      { find: "@tauri-apps/api/event", replacement: r("./src/web/shim/event.ts") },
      { find: "@tauri-apps/api/window", replacement: r("./src/web/shim/window.ts") },
      { find: "@tauri-apps/api/webviewWindow", replacement: r("./src/web/shim/webviewWindow.ts") },
      { find: "@tauri-apps/plugin-dialog", replacement: r("./src/web/shim/dialog.ts") },
      { find: "@tauri-apps/plugin-process", replacement: r("./src/web/shim/process.ts") },
      { find: "@tauri-apps/plugin-updater", replacement: r("./src/web/shim/updater.ts") },
    ],
  },
  build: {
    outDir,
    emptyOutDir: true,
    target: "es2020",
    sourcemap: false,
    rollupOptions: { input: r("./web.html") },
  },
});
