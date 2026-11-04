import { highlightCode } from "./markdown-code-highlight-engine";
import type { CodeHighlightRequest, CodeHighlightTokens } from "./markdown-code-highlight-queue";

// The app-owned entry is the only module that binds the port. Lazy Shiki grammars never import it.
const scope = self as unknown as {
  addEventListener(
    type: "message",
    listener: (event: MessageEvent<CodeHighlightRequest>) => void,
  ): void;
  postMessage(result: CodeHighlightTokens | null): void;
};
scope.addEventListener("message", ({ data }) => {
  void highlightCode(data)
    .catch(() => null)
    .then((result) => {
      // oxlint-disable-next-line unicorn/require-post-message-target-origin -- A dedicated worker answers its own port, which has no target origin.
      scope.postMessage(result);
    });
});
