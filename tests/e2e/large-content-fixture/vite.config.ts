import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import {
  createRendererVitePlugins,
  rendererViteCss,
  rendererViteResolve,
} from "../../../config/renderer-vite-shared";

// Built through Vite's own config loader, so the renderer toolchain is never loaded into a
// Playwright spec.
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  base: "./",
  logLevel: "warn",
  resolve: rendererViteResolve,
  css: rendererViteCss,
  plugins: createRendererVitePlugins(),
  build: { emptyOutDir: true },
});
