import {
  NodexContextMenuRoot,
  NodexContextMenuTrigger,
  NodexContextMenuPortal,
  NodexContextMenuContent,
  NodexContextMenuSubmenu,
  NodexContextMenuSubmenuTrigger,
} from "./context-menu";
import { act, render } from "@testing-library/react";
import { expect, test, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import {
  NodexDropdownRoot,
  NodexDropdownTrigger,
  NodexDropdownPortal,
  NodexDropdownContent,
  NodexDropdownFlyoutSubmenuItem,
  NodexDropdownItem,
} from "./dropdown";
import { PanelDestinationPickerSurface } from "../workbench/panel-destination-picker";

test("Page flyout accepts native typing, caret editing, and IME without losing focus", async () => {
  const close = vi.fn();
  const view = render(
    <NodexDropdownRoot defaultOpen>
      <NodexDropdownTrigger>
        <button>Open side panel tab</button>
      </NodexDropdownTrigger>
      <NodexDropdownPortal>
        <NodexDropdownContent>
          <NodexDropdownItem>Review</NodexDropdownItem>
          <NodexDropdownFlyoutSubmenuItem label="Page" open>
            <PanelDestinationPickerSurface
              projects={[]}
              boardMap={new Map()}
              databaseDescriptorMap={new Map()}
              loading={false}
              scope="page-only"
              onAccept={vi.fn()}
              onClose={close}
            />
          </NodexDropdownFlyoutSubmenuItem>
        </NodexDropdownContent>
      </NodexDropdownPortal>
    </NodexDropdownRoot>,
  );
  const input = await view.findByRole("combobox");
  await act(async () => {
    await userEvent.click(input);
    await userEvent.type(input, "review page");
  });
  expect((input as HTMLInputElement).value).toBe("review page");
  expect(document.activeElement).toBe(input);
  await act(async () => {
    await userEvent.keyboard("{ArrowLeft}{Backspace}");
  });
  expect((input as HTMLInputElement).value).toBe("review pae");
  await act(async () => {
    input.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", isComposing: true, bubbles: true }),
    );
  });
  expect(close).not.toHaveBeenCalled();
  await act(async () => {
    await userEvent.keyboard("{Escape}");
  });
  expect(close).toHaveBeenCalledOnce();
});

test("context menu editors keep typing and textarea newlines in root and submenu", async () => {
  const view = render(
    <NodexContextMenuRoot>
      <NodexContextMenuTrigger>
        <div>Context target</div>
      </NodexContextMenuTrigger>
      <NodexContextMenuPortal>
        <NodexContextMenuContent>
          <input aria-label="Root search" />
          <NodexContextMenuSubmenu
            trigger={<NodexContextMenuSubmenuTrigger>More</NodexContextMenuSubmenuTrigger>}
            renderContent={() => <textarea aria-label="Nested notes" />}
          />
        </NodexContextMenuContent>
      </NodexContextMenuPortal>
    </NodexContextMenuRoot>,
  );
  await act(async () => {
    await userEvent.click(view.getByText("Context target"), { button: "right" });
  });
  const rootInput = await view.findByRole("textbox", { name: "Root search" });
  await act(async () => {
    await userEvent.type(rootInput, "hello");
  });
  expect((rootInput as HTMLInputElement).value).toBe("hello");
  await act(async () => {
    await userEvent.hover(view.getByRole("menuitem", { name: "More" }));
  });
  const notes = await view.findByRole("textbox", { name: "Nested notes" });
  await act(async () => {
    await userEvent.type(notes, "first{Enter}second");
  });
  expect((notes as HTMLTextAreaElement).value).toBe("first\nsecond");
  expect(document.activeElement).toBe(notes);
});
