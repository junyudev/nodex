import { act, fireEvent, waitFor } from "@testing-library/react";
import { describe, expect, test, vi } from "vite-plus/test";
import { render } from "@/test/dom";
import { CODEX_SIDEBAR_WIDTH_DEFAULT_PX } from "@/lib/codex-sidebar-auto-reveal";
import { WorkbenchSidebarFrame } from "./workbench-sidebar-frame";

describe("WorkbenchSidebarFrame", () => {
  test.each(["inline", "floating"] as const)(
    "%s resize reports zoom-normalized live and committed widths without stealing focus",
    async (surface) => {
      const onResizeWidth = vi.fn();
      const onResizeActiveChange = vi.fn();
      const view = render(
        <WorkbenchSidebarFrame
          floating={surface === "floating"}
          width={300}
          getWindowZoom={() => 2}
          onResizeWidth={onResizeWidth}
          onResizeActiveChange={onResizeActiveChange}
        >
          <input aria-label="Sidebar search" />
        </WorkbenchSidebarFrame>,
      );
      const input = view.getByRole("textbox", { name: "Sidebar search" });
      const handle = view.getByRole("separator");
      const capturePointer = vi.fn();
      handle.setPointerCapture = capturePointer;

      try {
        await act(async () => {
          input.focus();
          fireEvent.pointerDown(handle, { button: 0, pointerId: 1, clientX: 600 });
          fireEvent.pointerMove(window, { pointerId: 1, clientX: 720 });
          await Promise.resolve();
        });

        await waitFor(() => {
          expect(onResizeWidth).toHaveBeenLastCalledWith(360, "live", surface);
          expect(onResizeActiveChange).toHaveBeenLastCalledWith(true);
        });
        expect(document.activeElement).toBe(input);
        expect(capturePointer).toHaveBeenCalledExactlyOnceWith(1);

        await act(async () => {
          fireEvent.pointerUp(window, { pointerId: 1, clientX: 720 });
          await Promise.resolve();
        });

        await waitFor(() => {
          expect(onResizeWidth).toHaveBeenLastCalledWith(360, "end", surface);
          expect(onResizeActiveChange).toHaveBeenLastCalledWith(false);
        });
      } finally {
        await act(async () => {
          fireEvent.pointerUp(window, { pointerId: 1, clientX: 720 });
          await Promise.resolve();
        });
      }
    },
  );

  test("disabled resize ignores gestures and reset until enabled", async () => {
    const onResizeWidth = vi.fn();
    const onResizeActiveChange = vi.fn();
    const renderFrame = (resizeDisabled: boolean) => (
      <WorkbenchSidebarFrame
        width={420}
        resizeDisabled={resizeDisabled}
        onResizeWidth={onResizeWidth}
        onResizeActiveChange={onResizeActiveChange}
      >
        Home
      </WorkbenchSidebarFrame>
    );
    const view = render(renderFrame(true));
    const handle = view.getByRole("separator");

    await act(async () => {
      fireEvent.pointerDown(handle, { button: 0, pointerId: 2, clientX: 420 });
      fireEvent.pointerMove(window, { pointerId: 2, clientX: 500 });
      fireEvent.pointerUp(window, { pointerId: 2, clientX: 500 });
      fireEvent.click(handle, { detail: 2 });
      await Promise.resolve();
    });

    expect(handle.getAttribute("aria-disabled")).toBe("true");
    expect(onResizeWidth).not.toHaveBeenCalled();
    expect(onResizeActiveChange).not.toHaveBeenCalled();

    await act(async () => {
      view.rerender(renderFrame(false));
      await Promise.resolve();
    });
    await act(async () => {
      fireEvent.click(view.getByRole("separator"), { detail: 2 });
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(onResizeWidth).toHaveBeenCalledExactlyOnceWith(
        CODEX_SIDEBAR_WIDTH_DEFAULT_PX,
        "reset",
        "inline",
      );
    });
  });

  test("resize cancellation settles the last observed width and ignores unrelated pointers", async () => {
    const onResizeWidth = vi.fn();
    const onResizeActiveChange = vi.fn();
    const view = render(
      <WorkbenchSidebarFrame
        width={300}
        onResizeWidth={onResizeWidth}
        onResizeActiveChange={onResizeActiveChange}
      >
        Home
      </WorkbenchSidebarFrame>,
    );
    const handle = view.getByRole("separator");

    try {
      await act(async () => {
        fireEvent.pointerDown(handle, { button: 0, pointerId: 4, clientX: 352 });
        fireEvent.pointerMove(window, { pointerId: 5, clientX: 0 });
        fireEvent.pointerUp(window, { pointerId: 5, clientX: 0 });
        await Promise.resolve();
      });
      expect(onResizeWidth).not.toHaveBeenCalled();
      expect(onResizeActiveChange).toHaveBeenLastCalledWith(true);

      await act(async () => {
        fireEvent.pointerMove(window, { pointerId: 4, clientX: 412 });
        fireEvent.pointerCancel(window, { pointerId: 4, clientX: 0 });
        fireEvent.pointerMove(window, { pointerId: 4, clientX: 500 });
        await Promise.resolve();
      });

      expect(onResizeWidth.mock.calls).toEqual([
        [360, "live", "inline"],
        [360, "end", "inline"],
      ]);
      expect(onResizeActiveChange).toHaveBeenLastCalledWith(false);
    } finally {
      await act(async () => {
        fireEvent.pointerUp(window, { pointerId: 4, clientX: 412 });
        await Promise.resolve();
      });
    }
  });

  test("unmounting a destination releases the active gesture and its window listeners", async () => {
    const onResizeWidth = vi.fn();
    const onResizeActiveChange = vi.fn();
    const view = render(
      <WorkbenchSidebarFrame
        width={300}
        floating
        onResizeWidth={onResizeWidth}
        onResizeActiveChange={onResizeActiveChange}
      >
        Space
      </WorkbenchSidebarFrame>,
    );
    const handle = view.getByRole("separator");
    const aside = view.getByTestId("app-shell-floating-left-panel");
    expect(handle.parentElement).toBe(aside.parentElement);
    expect(aside.contains(handle)).toBe(false);

    try {
      await act(async () => {
        fireEvent.pointerDown(handle, { button: 0, pointerId: 3, clientX: 300 });
        fireEvent.pointerMove(window, { pointerId: 3, clientX: 360 });
        await Promise.resolve();
      });
      expect(onResizeWidth).toHaveBeenCalledExactlyOnceWith(360, "live", "floating");

      await act(async () => {
        view.unmount();
        fireEvent.pointerMove(window, { pointerId: 3, clientX: 400 });
        fireEvent.pointerUp(window, { pointerId: 3, clientX: 400 });
        await Promise.resolve();
      });

      expect(onResizeWidth).toHaveBeenCalledOnce();
      expect(onResizeActiveChange).toHaveBeenLastCalledWith(false);
    } finally {
      await act(async () => {
        fireEvent.pointerUp(window, { pointerId: 3, clientX: 400 });
        await Promise.resolve();
      });
    }
  });
});
