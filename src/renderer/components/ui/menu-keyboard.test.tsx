import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, test, vi } from "vite-plus/test";
import {
  NodexDropdownPortal,
  NodexDropdownRoot,
  NodexDropdownTrigger,
  NodexDropdownContent,
  NodexDropdownItem,
  NodexDropdownFlyoutSubmenuItem,
  NodexDropdownSearchInput,
} from "./dropdown";
import { settleAsyncRender } from "@/test/dom";

describe("menu editable keyboard ownership", () => {
  test.each([false, true])("preserves native editing in a nested=%s menu", async (nested) => {
    vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame"] });
    try {
      const localKey = vi.fn();
      const editor = <input aria-label="Search destinations" onKeyDown={localKey} />;
      render(
        <NodexDropdownRoot defaultOpen>
          <NodexDropdownTrigger>
            <button>Open</button>
          </NodexDropdownTrigger>
          <NodexDropdownPortal>
            <NodexDropdownContent>
              <NodexDropdownItem>Alpha</NodexDropdownItem>
              {nested ? (
                <NodexDropdownFlyoutSubmenuItem label="Pages" open>
                  {editor}
                </NodexDropdownFlyoutSubmenuItem>
              ) : (
                editor
              )}
            </NodexDropdownContent>
          </NodexDropdownPortal>
        </NodexDropdownRoot>,
      );
      await settleAsyncRender();
      const input = screen.getByRole("textbox");
      await act(async () => {
        input.focus();
        await Promise.resolve();
      });
      await act(async () => {
        vi.advanceTimersToNextFrame();
      });
      expect(document.activeElement, "opening focus must not replace the editor's focus").toBe(
        input,
      );
      for (const key of [
        "a",
        " ",
        "ArrowLeft",
        "ArrowRight",
        "Home",
        "End",
        "Backspace",
        "Delete",
      ]) {
        let allowed = false;
        await act(async () => {
          allowed = fireEvent.keyDown(input, { key });
          await Promise.resolve();
        });
        expect(allowed, `${key} must retain its native default`).toBe(true);
        expect(document.activeElement, key).toBe(input);
      }
      expect(localKey).toHaveBeenCalledTimes(8);
    } finally {
      vi.useRealTimers();
    }
  });
});

test.each(["textarea", "search"])(
  "menu items retain typeahead and unhandled %s Escape dismisses",
  async (inputKind) => {
    const onOpenChange = vi.fn();
    render(
      <NodexDropdownRoot defaultOpen onOpenChange={onOpenChange}>
        <NodexDropdownTrigger>
          <button>Open</button>
        </NodexDropdownTrigger>
        <NodexDropdownPortal>
          <NodexDropdownContent>
            <NodexDropdownItem>Alpha</NodexDropdownItem>
            <NodexDropdownItem>Beta</NodexDropdownItem>
            {inputKind === "search" ? (
              <NodexDropdownSearchInput aria-label="Search" />
            ) : (
              <textarea aria-label="Notes" />
            )}
          </NodexDropdownContent>
        </NodexDropdownPortal>
      </NodexDropdownRoot>,
    );
    await settleAsyncRender();
    await act(async () => {
      const alpha = screen.getByRole("menuitem", { name: "Alpha" });
      alpha.focus();
      fireEvent.keyDown(alpha, { key: "b" });
      await Promise.resolve();
    });
    expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "Beta" }));
    await act(async () => {
      const input = screen.getByRole("textbox");
      input.focus();
      expect(fireEvent.keyDown(input, { key: "n" })).toBe(true);
      fireEvent.keyDown(input, { key: "Escape" });
      await Promise.resolve();
    });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  },
);
