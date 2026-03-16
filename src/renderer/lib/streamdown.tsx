import { cjk } from "@streamdown/cjk";
import { createCodePlugin } from "@streamdown/code";
import { createMathPlugin } from "@streamdown/math";
import { createMermaidPlugin } from "@streamdown/mermaid";
import remarkBreaks from "remark-breaks";
import {
  defaultRemarkPlugins,
  type Components,
  type MermaidErrorComponentProps,
} from "streamdown";
import type { Pluggable } from "unified";
import { FileLinkAnchor } from "@/components/shared/file-link-anchor";
import { NFM_CODE_THEME_PAIR } from "./syntax-highlighting";

import "katex/dist/katex.min.css";

export const streamdownCodePlugin = createCodePlugin({
  themes: [NFM_CODE_THEME_PAIR[0], NFM_CODE_THEME_PAIR[1]],
});

export const streamdownPlugins = {
  code: streamdownCodePlugin,
  mermaid: createMermaidPlugin({
    config: {
      startOnLoad: false,
      securityLevel: "strict",
      theme: "default",
      suppressErrorRendering: true,
    },
  }),
  math: createMathPlugin({
    errorColor: "var(--foreground-tertiary)",
  }),
  cjk,
} as const;

export const streamdownComponents: Components = {
  a: ({ href, children, className }) => (
    <FileLinkAnchor href={href} className={className} showLocalFileTooltip>
      {children}
    </FileLinkAnchor>
  ),
};

export const streamdownRemarkPluginsWithBreaks: Pluggable[] = [
  ...Object.values(defaultRemarkPlugins),
  remarkBreaks,
];

export function StreamdownMermaidError({ error }: MermaidErrorComponentProps) {
  return (
    <div className="rounded-md border border-(--destructive)/30 bg-(--destructive)/10 px-3 py-2 text-sm text-(--destructive)">
      Mermaid Error: {error}
    </div>
  );
}
