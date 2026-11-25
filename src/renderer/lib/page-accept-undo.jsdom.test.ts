import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const acceptPageWork = vi.hoisted(() =>
  vi.fn<(pageId: string, episode?: string) => Promise<void>>(),
);
vi.mock("./page-turn-runtime", () => ({ acceptPageWork }));

import {
  ACCEPT_UNDO_WINDOW_MS,
  flushPendingAccepts,
  scheduleAccept,
  useReviewAccepted,
} from "./page-accept-undo";

const review = { page_id: "page-login", episode: "episode-review" };

describe("accepting a review with Undo", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    acceptPageWork.mockReset();
    acceptPageWork.mockResolvedValue(undefined);
  });
  afterEach(async () => {
    flushPendingAccepts();
    await act(async () => {
      await vi.runAllTimersAsync();
    });
    vi.useRealTimers();
  });

  it("waits out its Undo window before it reaches Core, then sends the episode the reader saw", async () => {
    const { result } = renderHook(() => useReviewAccepted(review));
    act(() => {
      scheduleAccept(review);
    });
    // The review reads as decided at once, so nothing offers it again while Undo is open.
    expect(result.current).toBe(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ACCEPT_UNDO_WINDOW_MS - 1);
    });
    expect(acceptPageWork).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(acceptPageWork).toHaveBeenCalledExactlyOnceWith("page-login", "episode-review");
    expect(result.current).toBe(false);
  });

  it("takes an accept back entirely when Undo comes within the window", async () => {
    const { result } = renderHook(() => useReviewAccepted(review));
    let accept: ReturnType<typeof scheduleAccept> | undefined;
    act(() => {
      accept = scheduleAccept(review);
    });
    act(() => {
      expect(accept?.undo()).toBe(true);
    });
    expect(result.current).toBe(false);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ACCEPT_UNDO_WINDOW_MS * 2);
    });
    expect(acceptPageWork).not.toHaveBeenCalled();
  });

  it("keeps the review decided until Core answers, and offers no Undo once it is sent", async () => {
    let answer: () => void = () => {};
    acceptPageWork.mockReturnValue(
      new Promise<void>((resolve) => {
        answer = resolve;
      }),
    );
    const { result } = renderHook(() => useReviewAccepted(review));
    let accept: ReturnType<typeof scheduleAccept> | undefined;
    act(() => {
      accept = scheduleAccept(review);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ACCEPT_UNDO_WINDOW_MS);
    });
    expect(accept?.undo()).toBe(false);
    expect(result.current).toBe(true);
    await act(async () => {
      answer();
      await Promise.resolve();
    });
    expect(result.current).toBe(false);
  });

  it("sends the reader's decision when the window closes before Undo runs out", async () => {
    act(() => {
      scheduleAccept(review);
    });
    act(() => {
      window.dispatchEvent(new Event("pagehide"));
    });
    expect(acceptPageWork).toHaveBeenCalledExactlyOnceWith("page-login", "episode-review");
  });
});
