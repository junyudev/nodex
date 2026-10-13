import { cjk } from "@streamdown/cjk";
import { createMathPlugin } from "@streamdown/math";
import { streamdownCodePlugin } from "./markdown-code-highlighter";
import { streamdownMermaidPlugin } from "../mermaid-runtime";

/** Document-only plugins load when a document surface is first presented. */
export const markdownDocumentPlugins = {
  code: streamdownCodePlugin,
  mermaid: streamdownMermaidPlugin,
  math: createMathPlugin({ errorColor: "var(--foreground-tertiary)" }),
  cjk,
} as const;
