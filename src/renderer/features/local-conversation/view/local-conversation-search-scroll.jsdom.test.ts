import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import {
  scrollToLocalConversationSearchMatch,
  waitForLocalConversationSearchLayout,
} from "./local-conversation-search-scroll";

function frames() {
  let next = 0;
  const pending = new Map<number, FrameRequestCallback>();
  vi.stubGlobal("requestAnimationFrame", (fn: FrameRequestCallback) => {
    pending.set(++next, fn);
    return next;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => pending.delete(id));
  return {
    pending,
    flush: () => {
      for (const [id, fn] of [...pending]) {
        pending.delete(id);
        fn(0);
      }
    },
  };
}
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("search scroll readiness", () => {
  test("settles an already aborted navigation without querying or scrolling", async () => {
    const abort = new AbortController();
    abort.abort();
    const readMatch = vi.fn();
    const scroll = vi.fn();
    await scrollToLocalConversationSearchMatch({ readMatch, scroll, signal: abort.signal });
    expect(readMatch).not.toHaveBeenCalled();
    expect(scroll).not.toHaveBeenCalled();
  });
  test("waits two layout frames and cancels promptly when rendering is suspended", async () => {
    const frame = frames();
    const abort = new AbortController();
    let settled = false;
    const result = waitForLocalConversationSearchLayout(abort.signal).then(() => {
      settled = true;
    });
    frame.flush();
    await Promise.resolve();
    expect(settled).toBe(false);
    abort.abort();
    await result;
    expect(frame.pending.size).toBe(0);
  });
  test("scrolls exactly the deferred mark and releases its frame and timeout", async () => {
    vi.useFakeTimers();
    const frame = frames();
    let target: HTMLElement | null = null;
    const scroll = vi.fn();
    const result = scrollToLocalConversationSearchMatch({ readMatch: () => target, scroll });
    frame.flush();
    expect(scroll).not.toHaveBeenCalled();
    target = document.createElement("mark");
    frame.flush();
    await result;
    expect(scroll).toHaveBeenCalledExactlyOnceWith(target);
    expect(frame.pending.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
  test("bounds missing-mark polling at 1500ms without scrolling to another occurrence", async () => {
    vi.useFakeTimers();
    const frame = frames();
    const scroll = vi.fn();
    const result = scrollToLocalConversationSearchMatch({ readMatch: () => null, scroll });
    await vi.advanceTimersByTimeAsync(1_500);
    await result;
    expect(scroll).not.toHaveBeenCalled();
    expect(frame.pending.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});
