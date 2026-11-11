import markdownWasm from "../src/shared/generated/nodex-markdown-wasm/nodex_markdown_bg.wasm?url&inline";
import { initMarkdownSync } from "../src/shared/nodex-markdown";

initMarkdownSync(Buffer.from(markdownWasm.slice(markdownWasm.indexOf(",") + 1), "base64"));
