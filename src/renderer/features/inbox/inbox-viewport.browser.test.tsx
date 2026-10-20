import { act, render, screen } from "@testing-library/react";
import { useRef } from "react";
import { describe, expect, test, vi } from "vite-plus/test";
import type { InboxItem, InboxWindowFilter } from "../../../shared/inbox";
import { initiallyFollowsInbox, useInboxViewport } from "./use-inbox-viewport";

const ROW_PX = 100;
const VIEWPORT_PX = 300;

/** Newest first, as Core windows return them. */
const messages = (count: number, prefix = "m") =>
  Array.from(
    { length: count },
    (_, index) => ({ pageId: `${prefix}${count - index}` }) as InboxItem,
  );

/** The Inbox route's stream reduced to what keeping a place depends on. */
function Stream({
  scopeKey,
  items,
  view = "inbox",
  hasNextPage = false,
  fetchNextPage = async () => undefined,
}: {
  scopeKey: string;
  items: readonly InboxItem[];
  view?: InboxWindowFilter;
  hasNextPage?: boolean;
  fetchNextPage?: () => Promise<unknown>;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(initiallyFollowsInbox(scopeKey));
  const viewport = useInboxViewport({
    scopeKey,
    view,
    scrollRef,
    stickToBottomRef,
    items,
    ready: true,
    hasNextPage,
    isFetchingNextPage: false,
    fetchNextPage,
  });
  const ordered = view === "inbox" ? items.toReversed() : items;
  return (
    <div
      ref={scrollRef}
      data-testid="scroller"
      onScroll={viewport.onScroll}
      style={{ height: VIEWPORT_PX, overflowY: "auto" }}
    >
      {ordered.map((item) => (
        <div key={item.pageId} data-inbox-page-id={item.pageId} style={{ height: ROW_PX }}>
          {item.pageId}
        </div>
      ))}
    </div>
  );
}

const scroller = () => screen.getByTestId("scroller");
const frames = () =>
  new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
const scrollTo = async (top: number) => {
  await act(async () => {
    scroller().scrollTop = top;
    await frames();
  });
};
const offsetOf = (pageId: string) =>
  screen.getByText(pageId).getBoundingClientRect().top - scroller().getBoundingClientRect().top;
const atBottom = () =>
  scroller().scrollHeight - scroller().scrollTop - scroller().clientHeight <= 1;

describe("an Inbox's place", () => {
  test("returns to the message the reader left at, though messages above it were handled", async () => {
    const items = messages(20);
    const first = render(<Stream scopeKey="test:anchor" items={items} />);
    expect(atBottom()).toBe(true);
    await scrollTo(650);
    // Oldest first, m8 is the first message wholly in view, 50px below the top.
    expect(offsetOf("m8")).toBe(50);
    first.unmount();

    // Two older messages were handled while the reader was away.
    render(
      <Stream
        scopeKey="test:anchor"
        items={items.filter((item) => !["m1", "m2"].includes(item.pageId))}
      />,
    );
    expect(offsetOf("m8")).toBe(50);
  });

  test("keeps following the newest messages when the reader left there", async () => {
    const first = render(<Stream scopeKey="test:latest" items={messages(20)} />);
    expect(atBottom()).toBe(true);
    first.unmount();
    render(<Stream scopeKey="test:latest" items={messages(25)} />);
    expect(atBottom()).toBe(true);
  });

  test("settles at the newest messages when the message it left at was handled", async () => {
    const items = messages(20);
    const first = render(<Stream scopeKey="test:handled" items={items} />);
    await scrollTo(650);
    first.unmount();
    render(<Stream scopeKey="test:handled" items={items.filter((item) => item.pageId !== "m8")} />);
    expect(atBottom()).toBe(true);
  });

  test("keeps a place in each view", async () => {
    const items = messages(20);
    const view = render(<Stream scopeKey="test:views" items={items} />);
    await scrollTo(650);
    view.rerender(<Stream scopeKey="test:views" items={items} view="processed" />);
    // History opens at its newest message, at the top.
    expect(scroller().scrollTop).toBe(0);
    await scrollTo(420);
    view.rerender(<Stream scopeKey="test:views" items={items} />);
    expect(offsetOf("m8")).toBe(50);
    view.rerender(<Stream scopeKey="test:views" items={items} view="processed" />);
    expect(scroller().scrollTop).toBe(420);
  });

  test("loads earlier windows to find the message it left at", async () => {
    const all = messages(20);
    const first = render(<Stream scopeKey="test:earlier" items={all} />);
    await scrollTo(150);
    // m3 is wholly in view first; only the newest ten messages load on return.
    expect(offsetOf("m3")).toBe(50);
    first.unmount();

    const fetchNextPage = vi.fn(async () => undefined);
    const view = render(
      <Stream
        scopeKey="test:earlier"
        items={all.slice(0, 10)}
        hasNextPage
        fetchNextPage={fetchNextPage}
      />,
    );
    expect(fetchNextPage).toHaveBeenCalledTimes(1);
    view.rerender(<Stream scopeKey="test:earlier" items={all} fetchNextPage={fetchNextPage} />);
    expect(offsetOf("m3")).toBe(50);
  });
});
