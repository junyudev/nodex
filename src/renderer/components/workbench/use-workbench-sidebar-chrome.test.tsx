import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { WORKBENCH_SIDEBAR_PEEK_OPEN_DELAY_MS } from "@/lib/workbench-sidebar-peek";
import { useWorkbenchSidebarChrome } from "./use-workbench-sidebar-chrome";

beforeEach(() => {
  document.body.innerHTML = `
    <nav data-app-navigation-rail>
      <button data-workbench-sidebar-peek-area="home">Home</button>
      <button data-workbench-sidebar-peek-area="space">Space</button>
    </nav>
  `;
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  document.body.innerHTML = "";
});

function renderChrome({ collapsed = true, onWidthChange = vi.fn() } = {}) {
  const root = document.createElement("div");
  return {
    onWidthChange,
    ...renderHook(() =>
      useWorkbenchSidebarChrome({
        persistedCollapsed: collapsed,
        persistedWidth: 300,
        reducedMotion: true,
        workbenchRootRef: { current: root },
        onWidthChange,
      }),
    ),
  };
}

async function hoverDestination(destination: "home" | "space") {
  const button = document.querySelector(`[data-workbench-sidebar-peek-area="${destination}"]`)!;
  await act(async () => {
    const event = new MouseEvent("pointerover", { bubbles: true, clientX: 26, clientY: 70 });
    Object.defineProperty(event, "pointerType", { value: "mouse" });
    button.dispatchEvent(event);
    vi.advanceTimersByTime(WORKBENCH_SIDEBAR_PEEK_OPEN_DELAY_MS);
    await Promise.resolve();
  });
}

describe("contextual sidebar peek", () => {
  test("a collapsed sidebar peeks the hovered destination and keeps it through exit", async () => {
    vi.useFakeTimers();
    const { result } = renderChrome();
    expect(result.current.peekArea).toBe(null);

    await hoverDestination("space");
    expect(result.current.peekArea).toBe("space");
    expect(result.current.peekDestination).toBe("space");

    await act(async () => {
      document.documentElement.dispatchEvent(new MouseEvent("pointerleave"));
      vi.runAllTimers();
      await Promise.resolve();
    });
    expect(result.current.peekArea).toBe(null);
    expect(result.current.peekDestination).toBe("space");
  });

  test("a pinned sidebar never peeks, and pinning closes an open peek", async () => {
    vi.useFakeTimers();
    const pinned = renderChrome({ collapsed: false });
    await hoverDestination("home");
    expect(pinned.result.current.peekArea).toBe(null);
    pinned.unmount();

    const { result } = renderChrome();
    await hoverDestination("home");
    expect(result.current.peekArea).toBe("home");
    await act(async () => {
      result.current.setSidebarCollapsed(false, { animate: false });
      await Promise.resolve();
    });
    expect(result.current.peekArea).toBe(null);
  });

  test("floating resize preserves the pinned right edge and the ordinary reset width", async () => {
    const { result, onWidthChange } = renderChrome();
    await act(async () => {
      result.current.applySidebarWidth(296, "end", "floating");
      result.current.applySidebarWidth(356, "end", "floating");
      result.current.applySidebarWidth(100, "end", "floating");
      result.current.applySidebarWidth(288, "reset", "floating");
      await Promise.resolve();
    });
    expect(onWidthChange.mock.calls.map(([width]) => width)).toEqual([300, 360, 240, 288]);
  });
});
