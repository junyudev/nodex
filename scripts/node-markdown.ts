import { readFileSync } from "node:fs";
import { join } from "node:path";
import { initMarkdownSync } from "../src/shared/nodex-markdown";

// Node entrypoints supply their source root explicitly, including bundled tooling.
export const initializeNodeMarkdown = (repositoryRoot: string): void => {
  initMarkdownSync(
    readFileSync(
      join(repositoryRoot, "src/shared/generated/nodex-markdown-wasm/nodex_markdown_bg.wasm"),
    ),
  );
};
