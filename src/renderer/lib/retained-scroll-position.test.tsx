import { act, fireEvent } from "@testing-library/react";
import { describe, expect, test } from "vite-plus/test";
import {
  forgetRetainedScrollPosition,
  readRetainedScrollPosition,
  rememberRetainedScrollPosition,
  restoreRetainedScrollPosition,
  useRetainedScrollPosition,
} from "./retained-scroll-position";
import { render } from "../test/dom";

function setScrollPosition(element: HTMLElement, top: number, left: number): void {
  element.scrollTop = top;
  element.scrollLeft = left;
}

function ScrollProbe({
  scrollKey,
  retryFrames = 0,
}: {
  scrollKey: string | null;
  retryFrames?: 0 | 1 | 2;
}) {
  const { ref, onScroll } = useRetainedScrollPosition<HTMLDivElement>(scrollKey, {
    retryFrames,
  });
  return (
    <div
      ref={ref}
      data-testid="scroll-probe"
      onScroll={onScroll}
      style={{ height: 40, width: 40, overflow: "auto" }}
    >
      <div style={{ height: 400, width: 400 }} />
    </div>
  );
}

describe("retained scroll position", () => {
  test("saves and restores vertical and horizontal scroll", () => {
    const key = "test:retained-scroll:save-restore";
    const element = document.createElement("div");
    setScrollPosition(element, 128, 24);

    rememberRetainedScrollPosition(key, element);
    setScrollPosition(element, 0, 0);

    expect(restoreRetainedScrollPosition(key, element)).toBe(true);
    expect(element.scrollTop).toBe(128);
    expect(element.scrollLeft).toBe(24);
  });

  test("restores only the requested axis", () => {
    const key = "test:retained-scroll:axis";
    const source = document.createElement("div");
    const target = document.createElement("div");
    setScrollPosition(source, 128, 24);
    setScrollPosition(target, 0, 0);

    rememberRetainedScrollPosition(key, source);

    expect(restoreRetainedScrollPosition(key, target, { axis: "vertical" })).toBe(true);
    expect(target.scrollTop).toBe(128);
    expect(target.scrollLeft).toBe(0);
  });

  test("returns no snapshot for missing keys", () => {
    forgetRetainedScrollPosition("test:retained-scroll:missing");
    expect(readRetainedScrollPosition("test:retained-scroll:missing") === null).toBe(true);
  });

  test("flushes the latest mounted element position on cleanup", () => {
    const key = "test:retained-scroll:cleanup";
    forgetRetainedScrollPosition(key);
    const view = render(<ScrollProbe scrollKey={key} />);
    const element = view.getByTestId("scroll-probe");
    Object.defineProperty(element, "getClientRects", {
      configurable: true,
      value: () => [{ width: 40, height: 40 }],
    });

    setScrollPosition(element, 96, 12);
    act(() => {
      view.unmount();
    });

    const snapshot = readRetainedScrollPosition(key);
    expect(snapshot?.top ?? -1).toBe(96);
    expect(snapshot?.left ?? -1).toBe(12);
  });

  test("records scroll events without React state updates", () => {
    const key = "test:retained-scroll:event";
    forgetRetainedScrollPosition(key);
    const view = render(<ScrollProbe scrollKey={key} />);
    const element = view.getByTestId("scroll-probe");

    act(() => {
      setScrollPosition(element, 140, 32);
      fireEvent.scroll(element);
    });

    const snapshot = readRetainedScrollPosition(key);
    expect(snapshot?.top ?? -1).toBe(140);
    expect(snapshot?.left ?? -1).toBe(32);
  });

  test("restores immediately and retries after animation frames when requested", () => {
    const key = "test:retained-scroll:retry";
    const source = document.createElement("div");
    const target = document.createElement("div");
    setScrollPosition(source, 220, 44);
    setScrollPosition(target, 0, 0);
    rememberRetainedScrollPosition(key, source);

    const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
    const callbacks: FrameRequestCallback[] = [];
    globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) => {
      callbacks.push(callback);
      return callbacks.length;
    }) as typeof requestAnimationFrame;

    try {
      expect(restoreRetainedScrollPosition(key, target, { retryFrames: 2 })).toBe(true);
      expect(target.scrollTop).toBe(220);
      setScrollPosition(target, 0, 0);
      callbacks.shift()?.(0);
      expect(target.scrollTop).toBe(220);
      setScrollPosition(target, 0, 0);
      callbacks.shift()?.(16);
      expect(target.scrollTop).toBe(220);
      expect(target.scrollLeft).toBe(44);
    } finally {
      globalThis.requestAnimationFrame = originalRequestAnimationFrame;
    }
  });

  test("saves old and new keys separately when a mounted node changes keys", () => {
    const firstKey = "test:retained-scroll:key-change:first";
    const secondKey = "test:retained-scroll:key-change:second";
    forgetRetainedScrollPosition(firstKey);
    forgetRetainedScrollPosition(secondKey);
    const view = render(<ScrollProbe scrollKey={firstKey} />);
    const element = view.getByTestId("scroll-probe");

    act(() => {
      setScrollPosition(element, 144, 12);
      fireEvent.scroll(element);
    });

    view.rerender(<ScrollProbe scrollKey={secondKey} />);

    act(() => {
      setScrollPosition(element, 288, 24);
      fireEvent.scroll(element);
      view.unmount();
    });

    expect(readRetainedScrollPosition(firstKey)?.top ?? -1).toBe(144);
    expect(readRetainedScrollPosition(firstKey)?.left ?? -1).toBe(12);
    expect(readRetainedScrollPosition(secondKey)?.top ?? -1).toBe(288);
    expect(readRetainedScrollPosition(secondKey)?.left ?? -1).toBe(24);
  });

  test("cancels stale retry restores after a mounted node changes keys", () => {
    const firstKey = "test:retained-scroll:retry-key-change:first";
    const secondKey = "test:retained-scroll:retry-key-change:second";
    forgetRetainedScrollPosition(firstKey);
    forgetRetainedScrollPosition(secondKey);
    const source = document.createElement("div");
    setScrollPosition(source, 160, 10);
    rememberRetainedScrollPosition(firstKey, source);

    const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
    const callbacks: FrameRequestCallback[] = [];
    globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) => {
      callbacks.push(callback);
      return callbacks.length;
    }) as typeof requestAnimationFrame;

    try {
      const view = render(<ScrollProbe scrollKey={firstKey} retryFrames={2} />);
      const element = view.getByTestId("scroll-probe");
      expect(element.scrollTop).toBe(160);

      setScrollPosition(element, 0, 0);
      view.rerender(<ScrollProbe scrollKey={secondKey} retryFrames={2} />);
      callbacks.shift()?.(0);
      callbacks.shift()?.(16);

      expect(element.scrollTop).toBe(0);
      view.unmount();
    } finally {
      globalThis.requestAnimationFrame = originalRequestAnimationFrame;
    }
  });

  test("does not overwrite the last known snapshot when cleanup cannot measure layout", () => {
    const key = "test:retained-scroll:hidden-cleanup";
    forgetRetainedScrollPosition(key);
    const view = render(<ScrollProbe scrollKey={key} />);
    const element = view.getByTestId("scroll-probe");

    act(() => {
      setScrollPosition(element, 96, 18);
      fireEvent.scroll(element);
    });
    Object.defineProperty(element, "getClientRects", {
      configurable: true,
      value: () => ({ length: 0 }),
    });
    setScrollPosition(element, 0, 0);

    act(() => {
      view.unmount();
    });

    expect(readRetainedScrollPosition(key)?.top ?? -1).toBe(96);
    expect(readRetainedScrollPosition(key)?.left ?? -1).toBe(18);
  });

  test("evicts the oldest entries after the bounded cap", () => {
    const element = document.createElement("div");
    for (let index = 0; index < 250; index += 1) {
      setScrollPosition(element, index, index);
      rememberRetainedScrollPosition(`test:retained-scroll:lru:${index}`, element);
    }

    expect(readRetainedScrollPosition("test:retained-scroll:lru:0") === null).toBe(true);
    expect(readRetainedScrollPosition("test:retained-scroll:lru:249")?.top ?? -1).toBe(249);
  });
});
