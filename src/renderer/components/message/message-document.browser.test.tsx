import { render as renderElement } from "@testing-library/react";
import type { ReactElement } from "react";
import { describe, expect, test } from "vite-plus/test";

import "../../globals.css";
import { TestQueryProvider } from "@/test/query";
import { MessageText } from "./message-document";

const render = (ui: ReactElement) => renderElement(ui, { wrapper: TestQueryProvider });

/** Where the first character of `text` is drawn. */
function leftOf(container: HTMLElement, text: string): number {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const offset = node.textContent!.indexOf(text);
    if (offset === -1) continue;
    const range = document.createRange();
    range.setStart(node, offset);
    range.setEnd(node, offset + 1);
    return range.getBoundingClientRect().left;
  }
  throw new Error(`"${text}" is not rendered`);
}

describe("message indentation in Chromium", () => {
  test("lines indented with spaces read indented, as written", () => {
    const view = render(
      <MessageText text={"Plan:\n  first, the toolbar\n    then the dialogs\nDone."} />,
    );
    const margin = leftOf(view.container, "Plan:");
    const first = leftOf(view.container, "first");
    expect(first).toBeGreaterThan(margin + 4);
    expect(leftOf(view.container, "then")).toBeGreaterThan(first + 4);
    expect(leftOf(view.container, "Done.")).toBe(margin);
  });

  test("lines nested with tabs step in a level each", () => {
    const view = render(<MessageText text={"Plan:\n\tfirst\n\t\tthen"} />);
    const first = leftOf(view.container, "first");
    expect(first).toBeGreaterThan(leftOf(view.container, "Plan:") + 8);
    expect(leftOf(view.container, "then")).toBeGreaterThan(first + 8);
  });

  test("a line indented under a list item stays with the item", () => {
    const view = render(
      <MessageText text={"- item\n  continued under the item\n  - nested\n- next"} />,
    );
    expect(leftOf(view.container, "continued")).toBe(leftOf(view.container, "item"));
    expect(leftOf(view.container, "nested")).toBeGreaterThan(leftOf(view.container, "item"));
    expect(leftOf(view.container, "next")).toBe(leftOf(view.container, "item"));
  });
});

describe("message images in Chromium", () => {
  test("an image between paragraphs is no taller than an image in an Agent's reply", async () => {
    const tall = `data:image/svg+xml;base64,${btoa(
      "<svg xmlns='http://www.w3.org/2000/svg' width='100' height='1000'/>",
    )}`;
    const view = render(
      <div style={{ width: 420 }}>
        <MessageText text={`Before\n\n![](${tall})\n\nAfter`} />
      </div>,
    );
    const image = view.getByRole("img");
    await expect.poll(() => image.getBoundingClientRect().height).toBeGreaterThan(0);
    const { height, width, top, bottom } = image.getBoundingClientRect();
    // `max-h-50`, as an Agent's reply shows an image, keeping the picture's shape.
    expect(height).toBeCloseTo(200, 0);
    expect(width).toBeLessThan(height / 5);
    expect(top).toBeGreaterThan(view.getByText("Before").getBoundingClientRect().bottom);
    expect(bottom).toBeLessThan(view.getByText("After").getBoundingClientRect().top);
  });
});
