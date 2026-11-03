import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { act, renderHook } from "@testing-library/react";
import { createElement } from "react";
import { render } from "@/test/dom";
import { useWorkedForLabelText } from "./use-worked-for-label";

const originalDateNow = Date.now;
const originalSetInterval = window.setInterval;
const originalClearInterval = window.clearInterval;

afterEach(() => {
  Object.defineProperty(Date, "now", {
    configurable: true,
    value: originalDateNow,
  });
  window.setInterval = originalSetInterval;
  window.clearInterval = originalClearInterval;
});

function WorkedForProbe({ renderNonce }: { renderNonce: number }) {
  const label = useWorkedForLabelText({
    timing: {
      status: "working",
      startedAtMs: 1_000,
      completedAtMs: null,
    },
    durationMs: null,
  });

  return createElement("div", null, `${label ?? ""}:${renderNonce}`);
}

describe("useWorkedForLabelText", () => {
  test("keeps one active timer across new-but-equal timing rerenders", async () => {
    let nowMs = 1_500;
    const intervalCallbacks: Array<() => void> = [];
    const clearedIntervals: number[] = [];

    Object.defineProperty(Date, "now", {
      configurable: true,
      value: () => nowMs,
    });
    window.setInterval = ((callback: TimerHandler, timeout?: number) => {
      expect(timeout).toBe(1000);
      intervalCallbacks.push(callback as () => void);
      return intervalCallbacks.length;
    }) as typeof window.setInterval;
    window.clearInterval = ((timerId?: number) => {
      if (typeof timerId === "number") {
        clearedIntervals.push(timerId);
      }
    }) as typeof window.clearInterval;

    const view = render(createElement(WorkedForProbe, { renderNonce: 0 }));
    await act(async () => {
      await Promise.resolve();
    });

    expect(intervalCallbacks.length).toBe(1);
    expect(clearedIntervals.length).toBe(0);
    expect(Boolean(view.container.textContent?.includes("Working:0"))).toBe(true);

    for (let renderNonce = 1; renderNonce <= 4; renderNonce += 1) {
      await act(async () => {
        view.rerender(createElement(WorkedForProbe, { renderNonce }));
        await Promise.resolve();
      });
    }

    expect(intervalCallbacks.length).toBe(1);
    expect(clearedIntervals.length).toBe(0);

    nowMs = 66_000;
    await act(async () => {
      intervalCallbacks[0]?.();
      await Promise.resolve();
    });

    expect(Boolean(view.container.textContent?.includes("Working for 1m 5s:4"))).toBe(true);
  });
});

test("resuming work samples the clock immediately and releases its timer when idle", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(1_500);
  const view = renderHook(
    ({ working }) =>
      useWorkedForLabelText({
        timing: working ? { status: "working", startedAtMs: 1_000, completedAtMs: null } : null,
        durationMs: null,
      }),
    { initialProps: { working: false } },
  );
  try {
    vi.setSystemTime(66_000);
    await act(async () => {
      view.rerender({ working: true });
    });
    expect(view.result.current).toBe("Working for 1m 5s");
    expect(vi.getTimerCount()).toBe(1);
    await act(async () => {
      view.rerender({ working: false });
    });
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    view.unmount();
    vi.useRealTimers();
  }
});
