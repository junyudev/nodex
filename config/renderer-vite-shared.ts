import tailwindcss from "@tailwindcss/postcss";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";
import {
  createRendererCompilerBabelPlugin,
  createRendererCompilerIntegration,
} from "./renderer-react-compiler";

export async function createRendererVitePlugins(root = process.cwd()) {
  const compiler = createRendererCompilerIntegration(root);
  const compilerPlugin = await createRendererCompilerBabelPlugin(root, compiler.options);
  return [compiler.coverage, ...react(), compiler.cacheTransform(compilerPlugin)];
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
