import tailwindcss from "@tailwindcss/postcss";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";
import {
  createRendererCompilerIntegration,
  isRendererCompilerSource,
} from "./renderer-react-compiler";

export function createRendererVitePlugins(root = process.cwd()) {
  const compiler = createRendererCompilerIntegration(root);
  return [
    compiler.coverage,
    react({
      // Compiler sources are checked after Babel parses. Skip that work at the plugin boundary,
      // while leaving the React plugin's native JSX and Fast Refresh coverage unchanged.
      babel: (id) => ({
        plugins: isRendererCompilerSource(id, root)
          ? [["babel-plugin-react-compiler", compiler.options]]
          : [],
      }),
    }),
  ];
}

export const rendererViteResolve = {
  alias: {
    "@": resolve(process.cwd(), "src/renderer"),
  },
};

export const rendererViteCss = {
  postcss: {
    plugins: [tailwindcss],
  },
};
