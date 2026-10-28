import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import { initMarkdownSync } from "../src/shared/nodex-markdown";

initMarkdownSync(
  readFileSync(
    resolve(process.cwd(), "src/shared/generated/nodex-markdown-wasm/nodex_markdown_bg.wasm"),
  ),
);
