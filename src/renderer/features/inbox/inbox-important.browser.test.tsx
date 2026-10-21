import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useLayoutEffect, useRef } from "react";
import { describe, expect, test, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import "@/globals.css";
import { installRendererThemeFixture } from "@/test/renderer-theme";
import type { InboxImportantMessage, InboxItem } from "../../../shared/inbox";
import { InboxImportantBar } from "./inbox-important";
import { inboxBuriedImportant } from "./inbox-presentation";
import { useInboxJump, useInboxMessagesInView } from "./use-inbox-important";

installRendererThemeFixture();

const ROW_PX = 100;
const VIEWPORT_PX = 300;
const NOW_MS = Date.parse("2026-10-20T12:00:00.000Z");

/** Newest first, as Core windows return them. */
const messages = (count: number) =>
  Array.from({ length: count }, (_, index) => ({ pageId: `m${count - index}` }) as InboxItem);

const important = (...pageIds: string[]): InboxImportantMessage[] =>
  pageIds.map((pageId) => ({
    pageId,
    title: `Important ${pageId}`,
    submittedAt: "2026-10-16T12:00:00.000Z",
  }));

const noMoreWindows = async () => undefined;

/** The Inbox route's stream reduced to what pointing back to important messages depends on. */
function Stream({
  items,
  marked,
  hasNextPage = false,
  fetchNextPage = noMoreWindows,
}: {
  items: readonly InboxItem[];
  marked: readonly InboxImportantMessage[];
  hasNextPage?: boolean;
  fetchNextPage?: () => Promise<unknown>;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);
  const inView = useInboxMessagesInView(
    scrollRef,
    marked.map((message) => message.pageId),
  );
  const jump = useInboxJump({
    scrollRef,
    stickToBottomRef,
    hasNextPage,
    isFetchingNextPage: false,
    fetchNextPage,
  });
  // The Inbox opens at its newest messages, against the composer.
  useLayoutEffect(() => {
    const scroller = scrollRef.current;
    if (scroller) scroller.scrollTop = scroller.scrollHeight;
  }, []);
  return (
    <div style={{ position: "relative" }}>
      <InboxImportantBar
        buried={inboxBuriedImportant(marked, marked.length, inView)}
        nowMs={NOW_MS}
        onJump={jump.jump}
      />
      <div
        ref={scrollRef}
        data-testid="scroller"
        style={{ height: VIEWPORT_PX, overflowY: "auto" }}
      >
        {items.toReversed().map((item) => (
          <div key={item.pageId} data-inbox-page-id={item.pageId} style={{ height: ROW_PX }}>
            {item.pageId}
          </div>
        ))}
      </div>
    </div>
  );
}

const scroller = () => screen.getByTestId("scroller");
const bar = () => screen.queryByTestId("inbox-important-bar");
const frames = () =>
  new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
const settle = () =>
  act(async () => {
    await frames();
  });
const inView = (pageId: string) => {
  const row = screen.getByText(pageId).getBoundingClientRect();
  const bounds = scroller().getBoundingClientRect();
  return row.bottom > bounds.top && row.top < bounds.bottom;
};

/** A computed color's alpha, whichever syntax the engine reports it in. */
const alphaOf = (color: string) => {
  const slash = /\/\s*([\d.]+)(%?)\s*\)$/.exec(color);
  if (slash) return Number(slash[1]) / (slash[2] ? 100 : 1);
  const rgba = /^rgba\((?:[^,]+,){3}\s*([\d.]+)\)$/.exec(color);
  return rgba ? Number(rgba[1]) : 1;
};

describe("important messages out of view", () => {
  test("are pointed back to only while they are out of view", async () => {
    render(<Stream items={messages(20)} marked={important("m3")} />);
    await settle();
    expect(bar()?.textContent).toContain("Important m3");
    // It has waited four days.
    expect(bar()?.textContent).toContain("4d");

    await act(async () => {
      scroller().scrollTop = 0;
      await frames();
    });
    await waitFor(() => expect(bar()).toBeNull());
  });

  test("bring the reader back to the longest-waiting one, then point at the next", async () => {
    render(<Stream items={messages(20)} marked={important("m2", "m14")} />);
    await settle();
    expect(bar()?.textContent).toContain("Important m2");
    expect(bar()?.textContent).toContain("1/2");

    await act(async () => {
      fireEvent.click(bar()!);
      await frames();
    });
    await waitFor(() => expect(inView("m2")).toBe(true));
    await waitFor(() => expect(bar()?.textContent).toContain("Important m14"));
    expect(bar()?.textContent).toContain("2/2");
  });

  test("load earlier windows to find one further back than the stream has loaded", async () => {
    const all = messages(20);
    const fetchNextPage = vi.fn(async () => undefined);
    const view = render(
      <Stream
        items={all.slice(0, 10)}
        marked={important("m3")}
        hasNextPage
        fetchNextPage={fetchNextPage}
      />,
    );
    await settle();
    await act(async () => {
      fireEvent.click(bar()!);
      await frames();
    });
    expect(fetchNextPage).toHaveBeenCalledTimes(1);

    view.rerender(<Stream items={all} marked={important("m3")} fetchNextPage={fetchNextPage} />);
    await waitFor(() => expect(inView("m3")).toBe(true));
    await waitFor(() => expect(bar()).toBeNull());
  });
  test("are named on a surface that stays opaque under the pointer", async () => {
    render(<Stream items={messages(20)} marked={important("m3")} />);
    await settle();
    await act(async () => {
      await userEvent.hover(bar()!);
    });
    const style = getComputedStyle(bar()!);
    // The hover tint is translucent, so it lies over the surface rather than replacing it.
    expect(alphaOf(style.backgroundColor)).toBe(1);
    expect(style.backgroundImage).toContain("gradient");
  });
});
