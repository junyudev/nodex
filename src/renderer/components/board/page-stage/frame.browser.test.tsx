import { act, render } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vite-plus/test";
import * as Y from "yjs";

import { CollaborativePageTitle } from "@/components/block-documents/collaborative-page-title";
import { PageStageContentLayout, PageTitlePlaceholder } from "./frame";
import "../../../globals.css";

const TITLE = "Ship the isolated UI workflow across every supported panel width";

const settleLayout = async (): Promise<void> => {
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  await Promise.resolve();
};

const QuietSyncStatus = () => null;

const titleBox = (element: HTMLElement) => {
  const style = getComputedStyle(element);
  const rect = element.getBoundingClientRect();
  return {
    top: rect.top,
    left: rect.left,
    width: rect.width,
    height: rect.height,
    fontFamily: style.fontFamily,
    fontSize: style.fontSize,
    fontWeight: style.fontWeight,
    lineHeight: style.lineHeight,
  };
};

afterEach(() => document.body.replaceChildren());

describe("Page Stage title placeholder in Chromium", () => {
  test("occupies the editable title's exact box, so opening a Page never re-wraps it", async () => {
    const document = new Y.Doc();
    const title = document.getText("title");
    title.insert(0, TITLE);
    const view = render(
      <div style={{ display: "flex", gap: 0, width: 420 }}>
        <div style={{ width: 210 }}>
          <PageStageContentLayout title={<PageTitlePlaceholder title={TITLE} />} body={null} />
        </div>
        <div style={{ width: 210 }}>
          <PageStageContentLayout
            title={<CollaborativePageTitle title={title} />}
            syncStatus={<QuietSyncStatus />}
            body={null}
          />
        </div>
      </div>,
    );
    try {
      await act(settleLayout);
      const placeholder = view.container.querySelector<HTMLElement>(
        '[data-page-title-placeholder="true"]',
      );
      if (!placeholder) throw new Error("Expected title placeholder");
      const editable = view.getByRole("textbox", { name: "Page title" });

      const expected = titleBox(editable);
      const actual = titleBox(placeholder);
      expect(actual.fontWeight).toBe("600");
      expect({ ...actual, left: actual.left + 210 }).toEqual(expected);
      expect(actual.height).toBeGreaterThan(Number.parseFloat(actual.lineHeight));
    } finally {
      view.unmount();
      document.destroy();
    }
  });
});
