import {
  act,
  fireEvent,
  render as rtlRender,
  type RenderOptions,
  waitFor,
} from "@testing-library/react";
import { type ReactElement } from "react";
import { vi } from "vite-plus/test";
import type { HighlightOptions } from "@streamdown/code";

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
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: "mouse" });
    fireEvent.mouseDown(trigger, { button: 0, ctrlKey: false });
    fireEvent.pointerUp(trigger, { button: 0, ctrlKey: false, pointerType: "mouse" });
    fireEvent.mouseUp(trigger, { button: 0, ctrlKey: false });
    fireEvent.click(trigger);
    // Base UI opens pointer-triggered menus in a frame after mousedown's focus.
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  });
  await settleAsyncRender();
}

export async function waitForCodeHighlight(node: ParentNode) {
  await settleLazyRender();
  await act(async () => {
    const [{ streamdownCodePlugin }, { CODE_BLOCK_THEME_PAIR }, { resolveReadonlyCodeLanguage }] =
      await Promise.all([
        import("@/lib/markdown/markdown-code-highlighter"),
        import("@/lib/syntax-highlighting"),
        import("@/lib/code-block-presentation"),
      ]);
    const languages = new Set(
      Array.from(node.querySelectorAll<HTMLElement>("[data-readonly-code-block]")).map(
        (block) => resolveReadonlyCodeLanguage(block.dataset.language ?? "text").highlightLanguage,
      ),
    );
    // Native grammar imports bypass Vitest's import tracker. Await the actual plugin,
    // using empty code so the component still owns its complete or streaming token result.
    await Promise.all(
      Array.from(
        languages,
        (language) =>
          new Promise<void>((resolve) => {
            const result = streamdownCodePlugin.highlight(
              {
                code: "",
                language: language as HighlightOptions["language"],
                themes: [...CODE_BLOCK_THEME_PAIR],
              },
              () => resolve(),
            );
            if (result) resolve();
          }),
      ),
    );
  });
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

/**
 * Moves a mouse pointer onto an element with the event sequence a browser produces
 * (pointerover, pointerenter, mouseover, mouseenter, pointermove, mousemove), so hover-driven
 * popups such as tooltips see the same signals they get from a real pointer.
 */
export function hoverWithMouse(element: Element) {
  fireEvent.pointerOver(element, { pointerType: "mouse" });
  fireEvent.pointerEnter(element, { pointerType: "mouse" });
  fireEvent.mouseOver(element);
  fireEvent.mouseEnter(element);
  fireEvent.pointerMove(element, { pointerType: "mouse" });
  fireEvent.mouseMove(element);
}
