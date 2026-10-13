import tailwindcss from "@tailwindcss/postcss";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";
import { createRendererCompilerIntegration } from "./renderer-react-compiler";

export function createRendererVitePlugins() {
  const compiler = createRendererCompilerIntegration();
  return [
    compiler.coverage,
    react({ babel: { plugins: [["babel-plugin-react-compiler", compiler.options]] } }),
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
