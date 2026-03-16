import { codeBlockOptions } from "@blocknote/code-block";
import type { CodeBlockOptions } from "@blocknote/core";

export const editorCodeBlockOptions: CodeBlockOptions = {
  ...codeBlockOptions,
  defaultLanguage: "text",
};
