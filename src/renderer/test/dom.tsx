import {
  act,
  fireEvent,
  render as rtlRender,
  type RenderOptions,
  waitFor,
} from "@testing-library/react";
import { type ReactElement } from "react";
import { renderWithAppMaitai } from "./app-maitai";
import { TestThreadRouteScopePath } from "./maitai-scope-harness";

export function render(ui: ReactElement, options?: Omit<RenderOptions, "wrapper">) {
  return rtlRender(ui, options);
}

export function renderWithMaitai(ui: ReactElement, options?: RenderOptions) {
  const { wrapper: NestedWrapper, ...renderOptions } = options ?? {};
  return renderWithAppMaitai(ui, {
    ...renderOptions,
    wrapper: ({ children }) => (
      <TestThreadRouteScopePath>
        {NestedWrapper ? <NestedWrapper>{children}</NestedWrapper> : children}
      </TestThreadRouteScopePath>
    ),
  });
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

export async function waitForStreamdownCodeHighlight(node: ParentNode) {
  await waitFor(() => {
    const highlightedCode = node.querySelector('pre code span[style*="--sdm-c"]');
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
