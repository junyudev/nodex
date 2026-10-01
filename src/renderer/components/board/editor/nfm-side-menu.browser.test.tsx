import { BlockNoteEditor } from "@blocknote/core";
import { BlockNoteViewRaw } from "@blocknote/react";
import { act, fireEvent, render, waitFor } from "@testing-library/react";
import { describe, expect, test, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import "../../../globals.css";
import { NodexTooltipProvider } from "@/components/ui/tooltip";
import { NfmSideMenuOpenProvider, useNfmSideMenuOpenController } from "./nfm-side-menu";
import { NfmSideMenuRuntimeProvider } from "./nfm-side-menu-runtime";

const settleFloatingSurface = async (): Promise<void> => {
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  await Promise.resolve();
};

function SideMenuTrigger({
  editor,
  left,
  top,
}: {
  readonly editor: BlockNoteEditor;
  readonly left: number;
  readonly top: number;
}) {
  const controller = useNfmSideMenuOpenController();
  return (
    <button
      type="button"
      style={{ position: "fixed", left, top, width: 24, height: 24 }}
      onClick={(event) => {
        const block = editor.getBlock("block-1");
        if (!block) throw new Error("Expected the side menu's block.");
        controller.openForBlock({
          block,
          reference: { element: event.currentTarget },
          returnFocusElement: event.currentTarget,
          outsidePressIgnoreElement: event.currentTarget,
        });
      }}
    >
      Block actions
    </button>
  );
}

async function openSideMenu({
  width = 800,
  height = 700,
  left,
  top = 200,
}: {
  readonly width?: number;
  readonly height?: number;
  readonly left: number;
  readonly top?: number;
}) {
  await page.viewport(width, height);
  const editor = BlockNoteEditor.create({
    initialContent: [{ id: "block-1", type: "paragraph", content: "A block" }],
  });
  const deleteBlocks = vi.fn(() => true);
  const view = render(
    <NodexTooltipProvider>
      <NfmSideMenuRuntimeProvider
        value={{
          getSnapshot: () => ({
            canSendBlocks: false,
            hasConvertDividerToThreadSection: false,
            sourceProjectId: null,
            sourcePageId: null,
            onMoveBlocksToDestination: () => undefined,
            onConvertDividerToThreadSection: () => undefined,
            onBlockDragStart: () => undefined,
            onBlockDragEnd: () => undefined,
            onDuplicateBlocks: () => false,
            onDeleteBlocks: deleteBlocks,
            onTurnBlocksInto: () => false,
          }),
        }}
      >
        <BlockNoteViewRaw
          editor={editor}
          formattingToolbar={false}
          linkToolbar={false}
          slashMenu={false}
          sideMenu={false}
          tableHandles={false}
        >
          <NfmSideMenuOpenProvider>
            <SideMenuTrigger editor={editor} left={left} top={top} />
          </NfmSideMenuOpenProvider>
        </BlockNoteViewRaw>
      </NfmSideMenuRuntimeProvider>
    </NodexTooltipProvider>,
  );
  try {
    await act(settleFloatingSurface);
    const trigger = view.getByRole("button", { name: "Block actions" });
    await act(async () => {
      await userEvent.click(trigger);
      await settleFloatingSurface();
    });
    const dialog = await view.findByRole("dialog", { name: "Block actions" });
    const popup = dialog.closest<HTMLElement>("[data-nfm-side-menu-popup]");
    if (!popup) throw new Error("Expected the floating side menu.");
    await waitFor(() => {
      expect(popup.dataset.state).toBe("open");
      expect(["none", "matrix(1, 0, 0, 1, 0, 0)"]).toContain(getComputedStyle(popup).transform);
    });
    return {
      view,
      trigger,
      dialog,
      popup,
      deleteBlocks,
      close: () => {
        view.unmount();
        editor._tiptapEditor.destroy();
      },
    };
  } catch (error) {
    view.unmount();
    editor._tiptapEditor.destroy();
    throw error;
  }
}

function expectInsideViewport(element: HTMLElement, margin = 12) {
  const rect = element.getBoundingClientRect();
  expect(rect.width).toBeGreaterThan(0);
  expect(rect.height).toBeGreaterThan(0);
  expect(rect.left).toBeGreaterThanOrEqual(margin - 1);
  expect(rect.top).toBeGreaterThanOrEqual(margin - 1);
  expect(rect.right).toBeLessThanOrEqual(window.innerWidth - margin + 1);
  expect(rect.bottom).toBeLessThanOrEqual(window.innerHeight - margin + 1);
}

function requireScrollContainer(element: HTMLElement): HTMLElement {
  let parent = element.parentElement;
  while (parent) {
    if (getComputedStyle(parent).overflowY === "auto" && parent.scrollHeight > parent.clientHeight)
      return parent;
    parent = parent.parentElement;
  }
  throw new Error("Expected a scroll container for overflowing menu actions.");
}

describe("NFM side menu viewport collisions in Chromium", () => {
  test("keeps the menu on the preferred left side when it fits", async () => {
    const fixture = await openSideMenu({ left: 600 });
    try {
      await waitFor(() => {
        expectInsideViewport(fixture.dialog);
        expect(fixture.dialog.getBoundingClientRect().right).toBeLessThan(
          fixture.trigger.getBoundingClientRect().left,
        );
      });
    } finally {
      fixture.close();
    }
  });

  test("opens to the right when the trigger is near the left viewport edge", async () => {
    const fixture = await openSideMenu({ left: 12 });
    try {
      await waitFor(() => {
        expectInsideViewport(fixture.dialog);
        expect(fixture.dialog.getBoundingClientRect().left).toBeGreaterThan(
          fixture.trigger.getBoundingClientRect().right,
        );
      });
    } finally {
      fixture.close();
    }
  });

  test.each([
    { width: 480, left: 228 },
    { width: 240, left: 108 },
  ])("keeps every action inside a $width px viewport when neither side fits", async (position) => {
    const fixture = await openSideMenu(position);
    try {
      await waitFor(() => {
        expectInsideViewport(fixture.popup);
        expectInsideViewport(fixture.dialog);
      });
      expect(fixture.dialog.getBoundingClientRect().width).toBeLessThanOrEqual(position.width - 24);
      if (position.width !== 240) return;

      const narrowWidth = fixture.dialog.getBoundingClientRect().width;
      await act(async () => {
        await page.viewport(800, 700);
        await settleFloatingSurface();
      });
      await waitFor(() => {
        expectInsideViewport(fixture.popup);
        expectInsideViewport(fixture.dialog);
        expect(fixture.dialog.getBoundingClientRect().width).toBeGreaterThan(narrowWidth);
        expect(fixture.dialog.getBoundingClientRect().left).toBeGreaterThan(
          fixture.trigger.getBoundingClientRect().right,
        );
      });
    } finally {
      fixture.close();
    }
  });

  test("keeps the search visible and lets a short viewport scroll to Delete", async () => {
    const fixture = await openSideMenu({ left: 600, height: 180, top: 140 });
    try {
      await waitFor(() => expectInsideViewport(fixture.dialog));
      const search = fixture.view.getByRole("combobox");
      const deleteAction = fixture.view.getByRole("option", { name: /^Delete/ });
      const scroller = requireScrollContainer(deleteAction);
      await act(async () => {
        scroller.scrollTop +=
          deleteAction.getBoundingClientRect().bottom - scroller.getBoundingClientRect().bottom;
        fireEvent.scroll(scroller);
        await settleFloatingSurface();
      });
      await waitFor(() => {
        const actionRect = deleteAction.getBoundingClientRect();
        const scrollerRect = scroller.getBoundingClientRect();
        expect(actionRect.top).toBeGreaterThanOrEqual(scrollerRect.top);
        expect(actionRect.bottom).toBeLessThanOrEqual(scrollerRect.bottom);
      });
      expectInsideViewport(search);
      await act(async () => {
        await userEvent.click(deleteAction);
        await settleFloatingSurface();
      });
      expect(fixture.deleteBlocks).toHaveBeenCalledExactlyOnceWith(["block-1"]);
    } finally {
      fixture.close();
    }
  });

  test("keeps the color submenu visible at the right and bottom viewport edges", async () => {
    const fixture = await openSideMenu({ left: 760, height: 360, top: 320 });
    try {
      const colorAction = fixture.view.getByRole("option", { name: /^Color/ });
      await act(async () => {
        await userEvent.click(colorAction);
        await settleFloatingSurface();
      });
      const menu = await fixture.view.findByRole("menu", { name: "Color" });
      const submenu = menu.closest<HTMLElement>("[data-nfm-side-menu-submenu]");
      if (!submenu) throw new Error("Expected the floating color submenu.");
      await waitFor(() => expectInsideViewport(submenu, 6));
      expect(submenu.getBoundingClientRect().right).toBeLessThan(
        colorAction.getBoundingClientRect().left,
      );
      const lastColor = fixture.view.getAllByRole("menuitem").at(-1);
      if (!lastColor) throw new Error("Expected color choices.");
      const scroller = requireScrollContainer(lastColor);
      await act(async () => {
        scroller.scrollTop = scroller.scrollHeight;
        fireEvent.scroll(scroller);
        await settleFloatingSurface();
      });
      const lastRect = lastColor.getBoundingClientRect();
      const scrollerRect = scroller.getBoundingClientRect();
      expect(lastRect.top).toBeGreaterThanOrEqual(scrollerRect.top);
      expect(lastRect.bottom).toBeLessThanOrEqual(scrollerRect.bottom);
    } finally {
      fixture.close();
    }
  });
});
