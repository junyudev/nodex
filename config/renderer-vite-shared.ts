import tailwindcss from "@tailwindcss/postcss";
import babel from "@rolldown/plugin-babel";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import { resolve } from "node:path";
import type { Plugin } from "vite";
import {
  createRendererCompilerIntegration,
  isRendererCompilerSource,
} from "./renderer-react-compiler";

export async function createRendererVitePlugins(root = process.cwd()) {
  const compiler = createRendererCompilerIntegration(root);
  const compilerPlugin = await babel({
    include: (id) => !!id && isRendererCompilerSource(id, root),
    presets: [reactCompilerPreset(compiler.options)],
  });
  return [
    compiler.coverage,
    ...react(),
    compiler.cacheTransform(compilerPlugin as unknown as Plugin),
  ];
}

export const rendererViteResolve = {
  alias: {
    "@": resolve(process.cwd(), "src/renderer"),
  },
};

/** Keep the worker and its back-importing lazy chunks at canonical ESM URLs. */
export const rendererViteOptimizeDeps = {
  exclude: ["@pierre/diffs/worker/worker.js"],
};

/** Workers ship as ES modules so their own dynamic imports (such as the highlighter) split normally. */
export const rendererViteWorker = {
  format: "es" as const,
};

export const rendererViteCss = {
  postcss: {
    plugins: [tailwindcss],
  },
};
