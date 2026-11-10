import markdownWasmUrl from "../../shared/generated/nodex-markdown-wasm/nodex_markdown_bg.wasm?url";
import { initMarkdown } from "../../shared/nodex-markdown";

export function initializeRendererMarkdown(): Promise<void> {
  return initMarkdown(markdownWasmUrl);
}
