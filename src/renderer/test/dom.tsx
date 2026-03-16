import { render as rtlRender, type RenderOptions } from "@testing-library/react";
import type { ReactElement } from "react";

export function render(ui: ReactElement, options?: Omit<RenderOptions, "wrapper">) {
  return rtlRender(ui, options);
}

export function textContent(node: ParentNode): string {
  return node.textContent ?? "";
}
