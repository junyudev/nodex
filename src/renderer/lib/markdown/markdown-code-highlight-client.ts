import { CODE_HIGHLIGHT_LANGUAGES } from "./markdown-code-highlight-languages";
import {
  createCodeHighlightQueue,
  type RequestCodeHighlight,
} from "./markdown-code-highlight-queue";

const supported = new Set(CODE_HIGHLIGHT_LANGUAGES);

export function supportsCodeHighlight(language: string): boolean {
  return supported.has(language);
}

const enqueue = createCodeHighlightQueue(
  () =>
    new Worker(new URL("./markdown-code-highlight.worker.ts", import.meta.url), { type: "module" }),
  () => import("./markdown-code-highlight-engine").then(({ highlightCode }) => highlightCode),
);

/** Plaintext and unknown grammars never start the worker or load the fallback. */
export const requestCodeHighlight: RequestCodeHighlight = (input, onResult, canFallback) => {
  if (!input.code || !supportsCodeHighlight(input.language)) return () => {};
  return enqueue(input, onResult, canFallback);
};
