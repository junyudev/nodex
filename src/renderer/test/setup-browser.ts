import { cleanup } from "@testing-library/react";
import { afterEach, beforeAll } from "vite-plus/test";
import markdownWasmUrl from "../../shared/generated/nodex-markdown-wasm/nodex_markdown_bg.wasm?url";
import { initMarkdown } from "../../shared/nodex-markdown";

beforeAll(() => initMarkdown(markdownWasmUrl));

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

afterEach(() => {
  cleanup();
  localStorage.clear();
  sessionStorage.clear();
  document.body.innerHTML = "";
  document.body.removeAttribute("style");
});
