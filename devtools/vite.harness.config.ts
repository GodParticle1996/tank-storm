// Vite config for the visual harness ONLY.
//
// Two reasons this exists instead of reusing vite.config.ts:
//   1. the shipped config runs vite-plugin-electron, which spawns Electron when
//      the dev server starts and dies on this Node build,
//   2. headless Chrome here cannot reach localhost, so the harness is BUILT to
//      static files and opened over file:// — which `base: "./"` makes work.
//
// Nothing here affects `npm run build` or the packaged app.
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "path";

export default defineConfig({
  root: resolve(__dirname, ".."),
  base: "./",
  plugins: [react()],
  resolve: { alias: { "@": resolve(__dirname, "../src") } },
  server: { port: 5199, strictPort: true },
  build: {
    outDir: resolve(__dirname, "dist-harness"),
    emptyOutDir: true,
    rollupOptions: { input: resolve(__dirname, "../harness.html") },
  },
});
