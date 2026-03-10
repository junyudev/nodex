import { useMemo } from "react";
import { Streamdown } from "streamdown";
import type { Pluggable } from "unified";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkBreaks from "remark-breaks";
import rehypeKatex from "rehype-katex";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import { harden } from "rehype-harden";
import { markdownComponents } from "./markdown-components";
import "katex/dist/katex.min.css";

interface MarkdownCoreProps {
  content: string;
  parseIncompleteMarkdown?: boolean;
  preserveLineBreaks?: boolean;
}

function normalizeMarkdown(content: string): string {
  const normalizedNewlines = content
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/[\u2028\u2029\u0085]/g, "\n");

  return normalizedNewlines.replace(/\n{3,}/g, "\n\n");
}

const REMARK_PLUGINS: Pluggable[] = [
  [remarkGfm, {}],
  [remarkMath, { singleDollarTextMath: false }],
];

const REMARK_PLUGINS_WITH_BREAKS: Pluggable[] = [
  [remarkGfm, {}],
  remarkBreaks,
  [remarkMath, { singleDollarTextMath: false }],
];

const sanitizeSchema = {
  ...defaultSchema,
  tagNames: [
    ...(defaultSchema.tagNames ?? []),
    "math",
    "mrow",
    "mi",
    "mo",
    "mn",
    "msup",
    "msub",
    "mfrac",
    "munder",
    "mover",
    "mtable",
    "mtr",
    "mtd",
    "mspace",
    "mtext",
    "semantics",
    "annotation",
    "munderover",
    "msqrt",
    "mroot",
    "mpadded",
    "mphantom",
    "menclose",
    "details",
    "summary",
  ],
  attributes: {
    ...defaultSchema.attributes,
    span: [...(defaultSchema.attributes?.span ?? []), "style"],
    math: ["xmlns", "display"],
    annotation: ["encoding"],
    "*": [...(defaultSchema.attributes?.["*"] ?? []), "className", "class"],
  },
};

const REHYPE_PLUGINS: Pluggable[] = [
  rehypeRaw,
  [rehypeSanitize, sanitizeSchema],
  [
    harden,
    {
      // Markdown content is treated as untrusted; rehype-harden blocks unsafe URL schemes.
      allowedImagePrefixes: ["*", "/"],
      allowedLinkPrefixes: ["*"],
      defaultOrigin: "https://nodex.invalid",
      allowDataImages: true,
    },
  ],
  [rehypeKatex, { errorColor: "var(--foreground-tertiary)" }],
];

export function MarkdownCore({
  content,
  parseIncompleteMarkdown = false,
  preserveLineBreaks = false,
}: MarkdownCoreProps) {
  const normalizedContent = useMemo(() => normalizeMarkdown(content), [content]);

  return (
    <Streamdown
      components={markdownComponents}
      remarkPlugins={preserveLineBreaks ? REMARK_PLUGINS_WITH_BREAKS : REMARK_PLUGINS}
      rehypePlugins={REHYPE_PLUGINS}
      parseIncompleteMarkdown={parseIncompleteMarkdown}
      mode={parseIncompleteMarkdown ? "streaming" : "static"}
      className="space-y-1"
      controls={{ table: false, code: true, mermaid: true }}
    >
      {normalizedContent}
    </Streamdown>
  );
}
