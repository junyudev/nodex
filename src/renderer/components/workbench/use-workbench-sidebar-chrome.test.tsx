import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { useWorkbenchSidebarChrome } from "./use-workbench-sidebar-chrome";

afterEach(cleanup);

async function movePointer(x: number, y: number) {
  await act(async () => {
    window.dispatchEvent(new MouseEvent("pointermove", { clientX: x, clientY: y }));
    await Promise.resolve();
  });
}

function renderChrome(zoom = 1, onWidthChange = vi.fn()) {
  const root = document.createElement("div");
  root.style.setProperty("--codex-window-zoom", String(zoom));
  return {
    onWidthChange,
    ...renderHook(() =>
      useWorkbenchSidebarChrome({
        persistedCollapsed: true,
        persistedWidth: 300,
        reducedMotion: true,
        workbenchRootRef: { current: root },
        onWidthChange,
      }),
    ),
  };
}

describe("contextual sidebar peek", () => {
  test.each([1, 2])(
    "opens from navigation and stays below the titlebar at zoom %s",
    async (zoom) => {
      const { result } = renderChrome(zoom);
      await movePointer(64 * zoom, 80 * zoom);
      expect(result.current.floatingSidebarVisible).toBe(false);

      await act(async () => {
        result.current.setSidebarNavigationHovered(true);
        await Promise.resolve();
      });
      expect(result.current.floatingSidebarVisible).toBe(true);

      await movePointer(150 * zoom, 80 * zoom);
      await act(async () => {
        result.current.setSidebarNavigationHovered(false);
        await Promise.resolve();
      });
      expect(result.current.floatingSidebarVisible).toBe(true);

      await movePointer(150 * zoom, 20 * zoom);
      expect(result.current.floatingSidebarVisible).toBe(false);
    },
  );

  test("a collapse click stays suppressed until the navigation trigger is left", async () => {
    const { result } = renderChrome();
    await act(async () => {
      result.current.setSidebarNavigationHovered(true);
      await Promise.resolve();
    });
    expect(result.current.floatingSidebarVisible).toBe(true);

    await act(async () => {
      result.current.setSidebarCollapsed(true, { animate: false });
      await Promise.resolve();
    });
    expect(result.current.floatingSidebarVisible).toBe(false);

    await act(async () => {
      result.current.setSidebarNavigationHovered(false);
      await Promise.resolve();
    });
    await act(async () => {
      result.current.setSidebarNavigationHovered(true);
      await Promise.resolve();
    });
    expect(result.current.floatingSidebarVisible).toBe(true);
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
