import { act, render as rtlRender, type RenderOptions, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";

export function render(ui: ReactElement, options?: Omit<RenderOptions, "wrapper">) {
  return rtlRender(ui, options);
}

export function textContent(node: ParentNode): string {
  return node.textContent ?? "";
}

export async function settleAsyncRender() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

export async function waitForStreamdownCodeHighlight(node: ParentNode) {
  await waitFor(() => {
    const highlightedCode = node.querySelector('pre[style*="--shiki-dark-bg"]');
    if (!highlightedCode) {
      throw new Error("Expected Streamdown code block highlighting to finish.");
    }
  });
}

export async function waitForStreamdownMermaidBlock(node: ParentNode) {
  await waitFor(() => {
    const mermaidBlock = node.querySelector('[data-streamdown="mermaid-block"]');
    if (!mermaidBlock) {
      throw new Error("Expected Streamdown mermaid block to finish loading.");
    }
  });
}
