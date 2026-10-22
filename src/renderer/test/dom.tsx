import {
  act,
  fireEvent,
  render as rtlRender,
  type RenderOptions,
  waitFor,
} from "@testing-library/react";
import { type ReactElement } from "react";
import { vi } from "vite-plus/test";

export function render(ui: ReactElement, options?: Omit<RenderOptions, "wrapper">) {
  return rtlRender(ui, options);
}

export function textContent(node: ParentNode): string {
  return node.textContent ?? "";
}

export function textContentIncludingShadowRoots(node: ParentNode): string {
  const chunks = [textContent(node)];

  for (const element of node.querySelectorAll<HTMLElement>("*")) {
    if (!element.shadowRoot) continue;
    chunks.push(textContentIncludingShadowRoots(element.shadowRoot));
  }

  return chunks.join("");
}

export async function settleAsyncRender() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/** Commit the trigger before waiting for imports started by its lazy children. */
export async function settleLazyRender() {
  await settleAsyncRender();
  await act(async () => {
    await vi.dynamicImportSettled();
  });
}

/** Exercise the complete browser press ingress owned by Nodex dropdown triggers. */
export async function openNodexMenu(trigger: HTMLElement) {
  await act(async () => {
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
    fireEvent.mouseDown(trigger, { button: 0, ctrlKey: false });
    fireEvent.pointerUp(trigger, { button: 0, ctrlKey: false });
    fireEvent.mouseUp(trigger, { button: 0, ctrlKey: false });
    fireEvent.click(trigger);
    await Promise.resolve();
  });
  await settleAsyncRender();
}

export async function waitForCodeHighlight(node: ParentNode) {
  await waitFor(() => {
    // Before Shiki resolves, and for unsupported grammars, code renders without a theme color.
    const highlightedCode = Array.from(
      node.querySelectorAll<HTMLElement>("[data-readonly-code-block] code span"),
    ).some((token) => {
      const color = token.style.getPropertyValue("--shiki-light").trim();
      return color !== "" && color !== "inherit";
    });
    if (!highlightedCode) {
      throw new Error("Expected code block highlighting to finish.");
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
