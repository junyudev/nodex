import { codeBlockOptions } from "@blocknote/code-block";
import type { CodeBlockOptions } from "@blocknote/core";
import { preloadBlockNoteDualThemeParser } from "@/lib/syntax-highlighting";

export const editorCodeBlockOptions: CodeBlockOptions = {
  ...codeBlockOptions,
  defaultLanguage: "text",
  createHighlighter: preloadBlockNoteDualThemeParser,
};
