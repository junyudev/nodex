import { afterEach, describe, expect, test } from "vite-plus/test";
import { subscribeToElementResize } from "./resize-observer-motion-values";

const originalResizeObserver = globalThis.ResizeObserver;

afterEach(() => {
  if (typeof originalResizeObserver === "undefined") {
    Reflect.deleteProperty(globalThis, "ResizeObserver");
    return;
  }
  Object.defineProperty(globalThis, "ResizeObserver", {
    configurable: true,
    value: originalResizeObserver,
    writable: true,
  });
});

describe("shared resize subscriptions", () => {
  test("replays an entry once to a subscription added during that entry's delivery", () => {
    let deliver: ((entries: ResizeObserverEntry[]) => void) | undefined;
    class TestResizeObserver implements ResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        deliver = (entries) => callback(entries, this);
      }
      disconnect() {}
      observe() {}
      unobserve() {}
    }
    Object.defineProperty(globalThis, "ResizeObserver", {
      configurable: true,
      value: TestResizeObserver,
      writable: true,
    });
    const element = document.createElement("div");
    const calls: string[] = [];
    let releaseAdded: (() => void) | undefined;
    const releaseFirst = subscribeToElementResize(element, () => {
      calls.push("first");
      releaseAdded ??= subscribeToElementResize(element, () => calls.push("added"));
    });
    const releaseSecond = subscribeToElementResize(element, () => calls.push("second"));
    const entry: ResizeObserverEntry = {
      target: element,
      contentRect: new DOMRect(0, 0, 120, 80),
      borderBoxSize: [{ blockSize: 80, inlineSize: 120 }],
      contentBoxSize: [{ blockSize: 80, inlineSize: 120 }],
      devicePixelContentBoxSize: [{ blockSize: 80, inlineSize: 120 }],
    };
    try {
      if (!deliver) throw new Error("Expected the shared resize observer.");
      deliver([entry]);
      expect(calls).toEqual(["first", "added", "second"]);

      deliver([entry]);
      expect(calls).toEqual(["first", "added", "second", "first", "second", "added"]);
    } finally {
      releaseFirst();
      releaseSecond();
      releaseAdded?.();
    }
  });
});
