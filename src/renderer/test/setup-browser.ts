import { cleanup, configure } from "@testing-library/react";
import { afterEach, beforeAll } from "vite-plus/test";
import markdownWasmUrl from "../../shared/generated/nodex-markdown-wasm/nodex_markdown_bg.wasm?url";
import { initMarkdown } from "../../shared/nodex-markdown";
import { ASYNC_WAIT_TIMEOUT_MS } from "../../../config/test-timeouts";

configure({ asyncUtilTimeout: ASYNC_WAIT_TIMEOUT_MS });

beforeAll(() => initMarkdown(markdownWasmUrl));

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

afterEach(() => {
  cleanup();
  localStorage.clear();
  sessionStorage.clear();
  document.body.innerHTML = "";
  document.body.removeAttribute("style");
});
