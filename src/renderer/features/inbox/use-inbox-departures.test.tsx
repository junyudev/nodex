import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import type { InboxItem } from "../../../shared/inbox";
import {
  INBOX_DEPARTURE_MS,
  INBOX_DEPARTURE_RELEASE_MS,
  retainDeparted,
  useInboxDepartures,
} from "./use-inbox-departures";

const message = (pageId: string, submittedAt: string): InboxItem => ({
  pageId,
  outcome: null,
  basis: { pageId, contentHash: "content:1" },
  pageKey: null,
  pageStatus: null,
  title: pageId,
  body: pageId,
  bodyTruncated: false,
  bodyEditable: true,
  submittedAt,
  source: { kind: "user" },
  kind: null,
  important: false,
  state: "open",
  suggestionState: "settled",
  suggestionError: null,
  firing: null,
  scope: { kind: "library" },
  location: { kind: "inbox" },
  proposal: null,
  revision: 1,
});

// Newest first, as Core lists the Inbox.
const newest = message("page:newest", "2026-10-11T12:00:00.000Z");
const middle = message("page:middle", "2026-10-11T11:00:00.000Z");
const oldest = message("page:oldest", "2026-10-11T10:00:00.000Z");
const ids = (items: readonly InboxItem[]) => items.map((item) => item.pageId);

describe("retainDeparted", () => {
  test("puts a decided message Core no longer lists back where it was", () => {
    expect(ids(retainDeparted([newest, oldest], [middle]))).toEqual(ids([newest, middle, oldest]));
    expect(ids(retainDeparted([middle, oldest], [newest]))).toEqual(ids([newest, middle, oldest]));
    expect(ids(retainDeparted([newest, middle], [oldest]))).toEqual(ids([newest, middle, oldest]));
    // Still listed, it is not repeated.
    expect(ids(retainDeparted([newest, middle], [middle]))).toEqual(ids([newest, middle]));
  });
});

describe("useInboxDepartures", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  test("a decided message shows where it went in place, then folds away", async () => {
    const hook = renderHook(({ items }) => useInboxDepartures(items), {
      initialProps: { items: [newest, middle, oldest] as readonly InboxItem[] },
    });
    act(() => {
      hook.result.current.depart([middle], {
        kind: "chat",
        type: "new_chat",
        sessionId: "session:new",
        chatTitle: null,
        projectName: "Nodex",
      });
    });
    expect(hook.result.current.outcomeOf("page:middle")).toMatchObject({
      label: "Starting a chat in Nodex",
      open: { kind: "session", sessionId: "session:new" },
    });
    expect(hook.result.current.outcomeOf("page:newest")).toBeNull();

    // Core takes it out of the Inbox; it keeps its place until its moment is over.
    hook.rerender({ items: [newest, oldest] });
    expect(ids(hook.result.current.items)).toEqual(ids([newest, middle, oldest]));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(INBOX_DEPARTURE_MS);
    });
    expect(ids(hook.result.current.items)).toEqual(ids([newest, oldest]));
    expect(hook.result.current.outcomeOf("page:middle")).toBeNull();
  });

  test("a message stays while the pointer rests on it and leaves soon after", async () => {
    const hook = renderHook(({ items }) => useInboxDepartures(items), {
      initialProps: { items: [newest, middle] as readonly InboxItem[] },
    });
    act(() => hook.result.current.depart([newest], { kind: "done" }));
    hook.rerender({ items: [middle] });
    act(() => hook.result.current.hold("page:newest", true));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(INBOX_DEPARTURE_MS * 3);
    });
    expect(hook.result.current.outcomeOf("page:newest")).toMatchObject({ label: "Done" });

    act(() => hook.result.current.hold("page:newest", false));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(INBOX_DEPARTURE_RELEASE_MS);
    });
    expect(ids(hook.result.current.items)).toEqual(["page:middle"]);
  });

  test("the pointer that decided a message holds it, but never cuts its moment short", async () => {
    const hook = renderHook(({ items }) => useInboxDepartures(items), {
      initialProps: { items: [newest, middle] as readonly InboxItem[] },
    });
    // The pointer is on the card when its decision button is clicked.
    act(() => hook.result.current.hold("page:newest", true));
    act(() => hook.result.current.depart([newest], { kind: "keep" }));
    hook.rerender({ items: [middle] });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(INBOX_DEPARTURE_MS * 2);
    });
    expect(hook.result.current.outcomeOf("page:newest")).toMatchObject({ label: "Kept" });

    // Leaving right after deciding still leaves the outcome up for its full moment.
    hook.rerender({ items: [newest, middle] });
    act(() => hook.result.current.depart([middle], { kind: "done" }));
    act(() => hook.result.current.hold("page:middle", true));
    act(() => hook.result.current.hold("page:middle", false));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(INBOX_DEPARTURE_RELEASE_MS);
    });
    expect(hook.result.current.outcomeOf("page:middle")).not.toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(INBOX_DEPARTURE_MS - INBOX_DEPARTURE_RELEASE_MS);
    });
    expect(hook.result.current.outcomeOf("page:middle")).toBeNull();
  });
});
