import { act, renderHook } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vite-plus/test";
import { useMarkerNavigationIdleReady } from "./marker-navigation-rail";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

test("waits for idle again after the marker count falls below its threshold", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("requestIdleCallback", undefined);
  const { result, rerender, unmount } = renderHook(
    ({ count }) => useMarkerNavigationIdleReady(count, 3),
    { initialProps: { count: 3 } },
  );
  await act(async () => vi.advanceTimersByTime(1));
  expect(result.current).toBe(true);
  rerender({ count: 2 });
  expect(result.current).toBe(false);
  rerender({ count: 3 });
  expect(result.current).toBe(false);
  unmount();
  await act(async () => vi.advanceTimersByTime(1));
  expect(vi.getTimerCount()).toBe(0);
});
