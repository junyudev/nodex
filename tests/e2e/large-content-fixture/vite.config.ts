import { fileURLToPath } from "node:url";
import { defineConfig, type UserConfig } from "vite";
import {
  createRendererVitePlugins,
  rendererViteCss,
  rendererViteResolve,
} from "../../../config/renderer-vite-shared";

// Built through Vite's own config loader, so the renderer toolchain is never loaded into a
// Playwright spec.
export default defineConfig(async (): Promise<UserConfig> => ({
  root: fileURLToPath(new URL(".", import.meta.url)),
  base: "./",
  logLevel: "warn",
  resolve: rendererViteResolve,
  css: rendererViteCss,
  plugins: await createRendererVitePlugins(),
  build: { emptyOutDir: true },
}));
