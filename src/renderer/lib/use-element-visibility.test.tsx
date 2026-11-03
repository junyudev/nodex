import { act, renderHook } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vite-plus/test";
import { useElementVisibility } from "./use-element-visibility";

afterEach(() => vi.unstubAllGlobals());

test("resets prewarm visibility for another node or margin and releases observations", async () => {
  const callbacks: IntersectionObserverCallback[] = [];
  const disconnects: Array<ReturnType<typeof vi.fn>> = [];
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      disconnect = vi.fn();
      observe = vi.fn();
      constructor(callback: IntersectionObserverCallback) {
        callbacks.push(callback);
        disconnects.push(this.disconnect);
      }
    },
  );
  const { result, rerender, unmount } = renderHook(({ margin }) => useElementVisibility(margin), {
    initialProps: { margin: "160px 0px" },
  });
  const element = document.createElement("div");
  await act(async () => result.current.ref(element));
  await act(async () =>
    callbacks[0]!(
      [
        {
          isIntersecting: true,
          boundingClientRect: { top: 0, left: 0, right: 20, bottom: 20, width: 20, height: 20 },
        } as IntersectionObserverEntry,
      ],
      {} as IntersectionObserver,
    ),
  );
  expect(result.current.visible).toBe(true);
  rerender({ margin: "20px" });
  expect(result.current.visible).toBe(false);
  expect(disconnects[0]).toHaveBeenCalledOnce();
  await act(async () => result.current.ref(document.createElement("div")));
  expect(result.current.visible).toBe(false);
  unmount();
  expect(disconnects.every((disconnect) => disconnect.mock.calls.length === 1)).toBe(true);
});

test("falls back to visible and records document order without an observer", async () => {
  vi.stubGlobal("IntersectionObserver", undefined);
  const { result } = renderHook(() => useElementVisibility());
  const element = document.createElement("div");
  Object.defineProperty(element, "offsetTop", { value: 42 });
  await act(async () => result.current.ref(element));
  expect(result.current.visible).toBe(true);
  expect(result.current.intersecting).toBe(true);
  expect(result.current.documentOrder).toBe(42);
});
