import { act, render } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import * as Y from "yjs";
import { CollaborativePageTitle } from "@/components/block-documents/collaborative-page-title";
import { PageStageContentLayout, PageTitlePlaceholder } from "./frame";
import "../../../globals.css";
import { userEvent } from "vite-plus/test/browser";
import type { PageStageRelatedChat } from "./types";
import { RelatedChatPropertyChip } from "./properties-section";

describe("frame", () => {
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
});

describe("properties section", () => {
  const linkedChat = {
    sessionId: "session-linked",
    projectId: "project-1",
    projectName: "Nodex",
    displayTitle: "Research follow-up",
    threadId: null,
    executionRef: null,
    threadPreview: "",
    threadStatus: null,
    threadArchived: false,
    unread: false,
    report: null,
    sessionArchived: false,
    conversationRecencyAt: null,
    linkedAt: "2026-08-28T00:00:00Z",
  } satisfies PageStageRelatedChat;

  const settleLayout = async (): Promise<void> => {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    await Promise.resolve();
  };

  describe("RelatedChatPropertyChip in Chromium", () => {
    test("reveals removal over the label without reserving space or changing chip width", async () => {
      // Native hover survives replacing the previously clicked target at this position.
      const previous = render(<button type="button">Previous control</button>);
      await act(async () => {
        await userEvent.click(previous.getByRole("button"));
      });
      previous.unmount();
      const onOpen = vi.fn(async () => undefined);
      const onRemove = vi.fn(async () => undefined);
      const view = render(
        <RelatedChatPropertyChip
          chat={linkedChat}
          current={false}
          saving={false}
          onOpen={onOpen}
          onRemove={onRemove}
        />,
      );
      await act(settleLayout);

      const chip = view.container.querySelector<HTMLElement>(
        '[data-page-stage-related-chat-chip="true"]',
      );
      if (!chip) throw new Error("Expected linked Chat chip");
      const label = view.getByText(linkedChat.displayTitle);
      const remove = view.getByRole("button", {
        name: `Remove relation to ${linkedChat.displayTitle}`,
      });
      expect(chip.matches(":hover")).toBe(true);
      expect(chip.matches(":focus-within")).toBe(false);

      // Establish rest explicitly instead of inheriting the browser's pointer position.
      await act(async () => {
        await userEvent.unhover(chip);
        await settleLayout();
      });
      expect(chip.matches(":hover")).toBe(false);
      const restingChipWidth = chip.getBoundingClientRect().width;
      const restingTailGap =
        chip.getBoundingClientRect().right - label.getBoundingClientRect().right;

      expect(restingTailGap).toBeGreaterThan(5);
      expect(restingTailGap).toBeLessThan(8);
      expect(getComputedStyle(remove).opacity).toBe("0");
      expect(getComputedStyle(remove).pointerEvents).toBe("none");

      await act(async () => {
        await userEvent.hover(chip);
        await settleLayout();
      });

      expect(chip.getBoundingClientRect().width).toBeCloseTo(restingChipWidth, 1);
      expect(getComputedStyle(remove).opacity).toBe("1");
      expect(getComputedStyle(remove).pointerEvents).toBe("auto");
      expect(remove.getBoundingClientRect().left).toBeLessThan(label.getBoundingClientRect().right);

      await act(async () => {
        await userEvent.unhover(chip);
        await settleLayout();
      });
      expect(getComputedStyle(remove).opacity).toBe("0");
      expect(getComputedStyle(remove).pointerEvents).toBe("none");

      await act(async () => {
        await userEvent.tab();
        await settleLayout();
      });
      expect(chip.matches(":hover")).toBe(false);
      expect(document.activeElement).toBe(
        view.getByRole("button", { name: linkedChat.displayTitle }),
      );
      expect(chip.matches(":focus-within")).toBe(true);
      expect(getComputedStyle(remove).opacity).toBe("1");
      expect(getComputedStyle(remove).pointerEvents).toBe("auto");
      expect(chip.getBoundingClientRect().width).toBeCloseTo(restingChipWidth, 1);

      await act(async () => {
        await userEvent.click(remove);
        await Promise.resolve();
      });
      expect(onRemove).toHaveBeenCalledTimes(1);
      expect(onOpen).not.toHaveBeenCalled();
    });
  });
});
