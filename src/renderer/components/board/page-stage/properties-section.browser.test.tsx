import { act, render } from "@testing-library/react";
import { describe, expect, test, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import type { PageStageRelatedChat } from "./types";
import { RelatedChatPropertyChip } from "./properties-section";
import "../../../globals.css";

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
    const restingTailGap = chip.getBoundingClientRect().right - label.getBoundingClientRect().right;

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
