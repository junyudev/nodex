import { describe, expect, test, vi } from "vite-plus/test";
import { fireEvent, waitFor, within } from "@testing-library/react";
import { act, useEffect, type ComponentProps } from "react";
import { NodexTooltipProvider, dismissNodexTooltips } from "@/components/ui/tooltip";
import { render, openNodexMenu } from "@/test/dom";
import type { NfmEditorCommands, NfmInsertItem } from "../editor/nfm-editor-commands";
import type { PageStageMenuActions } from "./page-menu";
import { PageStageToolbar } from "./toolbar";

// The Page's hold has its own tests; here it would only reach for a query client.
vi.mock("@/components/workbench/execution-hold-controls", () => ({
  PageExecutionHoldItem: () => null,
}));

const menuActions = (overrides: Partial<PageStageMenuActions> = {}): PageStageMenuActions => ({
  pageId: "page-1",
  copyActions: [{ id: "copy-title", label: "Copy title", keywords: [], disabled: false }],
  onCopy: () => undefined,
  fullWidth: false,
  onToggleFullWidth: () => undefined,
  showMarkdownSource: false,
  onToggleMarkdownSource: () => undefined,
  ...overrides,
});

const insertItem = (key: string, title: string, group: string): NfmInsertItem => ({
  key,
  title,
  group,
  description: `${title} description`,
  icon: null,
  hint: null,
});

const editorCommands = (overrides: Partial<NfmEditorCommands> = {}): NfmEditorCommands => ({
  focus: () => undefined,
  openInsertMenu: () => true,
  listInsertItems: () => [],
  insert: () => true,
  readTurnIntoKey: () => null,
  turnInto: () => true,
  isEmpty: () => false,
  fillEmptyBody: () => true,
  subscribe: () => () => undefined,
  ...overrides,
});

const renderToolbar = (props: Partial<ComponentProps<typeof PageStageToolbar>> = {}) =>
  render(
    <NodexTooltipProvider>
      <PageStageToolbar saving={false} menu={menuActions()} editorCommands={null} {...props} />
    </NodexTooltipProvider>,
  );

describe("page stage toolbar", () => {
  test("history and Page actions survive capture-phase tooltip dismissal", async () => {
    const onToggleHistory = vi.fn();
    const onDelete = vi.fn();

    function ToolbarHarness() {
      useEffect(() => {
        const dismissOnPointerDown = () => {
          dismissNodexTooltips();
        };

        document.addEventListener("pointerdown", dismissOnPointerDown, true);
        return () => {
          document.removeEventListener("pointerdown", dismissOnPointerDown, true);
        };
      }, []);

      return (
        <NodexTooltipProvider>
          <PageStageToolbar
            saving={false}
            menu={menuActions({ onDelete })}
            editorCommands={null}
            history={{ active: false, onToggle: onToggleHistory }}
          />
        </NodexTooltipProvider>
      );
    }

    const view = render(<ToolbarHarness />);
    const historyButton = view.getByRole("button", { name: "History" });

    await act(async () => {
      fireEvent.pointerDown(historyButton);
      fireEvent.click(historyButton);
      await Promise.resolve();
    });
    await openNodexMenu(view.getByRole("button", { name: "Page actions" }));
    await act(async () => {
      fireEvent.click(view.getByRole("menuitem", { name: "Delete" }));
      await Promise.resolve();
    });

    expect(onToggleHistory).toHaveBeenCalledOnce();
    expect(onDelete).toHaveBeenCalledOnce();
  });

  test("the Page menu offers only what the Page can do and reports its view state", async () => {
    const onToggleFullWidth = vi.fn();
    const view = renderToolbar({
      menu: menuActions({
        fullWidth: true,
        onToggleFullWidth,
        onOpenInNewWindow: () => undefined,
      }),
    });

    await openNodexMenu(view.getByRole("button", { name: "Page actions" }));

    expect(view.getByRole("menuitem", { name: "Open in new window" })).toBeTruthy();
    for (const absent of ["Rename", "Download as Markdown", "Open on right", "Delete"]) {
      expect(view.queryByRole("menuitem", { name: absent })).toBeNull();
    }
    const fullWidth = view.getByRole("menuitemcheckbox", { name: "Full width" });
    expect(fullWidth.getAttribute("aria-checked")).toBe("true");
    expect(
      view
        .getByRole("menuitemcheckbox", { name: "Show Markdown source" })
        .getAttribute("aria-checked"),
    ).toBe("false");

    await act(async () => {
      fireEvent.click(fullWidth);
      await Promise.resolve();
    });
    expect(onToggleFullWidth).toHaveBeenCalledOnce();
  });

  test("an opening Page holds its controls in place without acting", () => {
    const view = renderToolbar({ menu: null, pending: true });

    for (const name of ["Page actions", "Text style", "Image", "Table", "Insert"]) {
      expect(view.getByRole("button", { name }).hasAttribute("disabled")).toBe(true);
    }
  });

  test("the editing tools dim while the body editor is not showing", () => {
    const view = renderToolbar({ editorCommands: null });

    expect(view.getByRole("button", { name: "Page actions" }).hasAttribute("disabled")).toBe(false);
    expect(view.getByRole("button", { name: "Insert" }).hasAttribute("disabled")).toBe(true);
  });

  test("Image and Table insert at the caret without taking the body's focus", async () => {
    const insert = vi.fn(() => true);
    const view = renderToolbar({ editorCommands: editorCommands({ insert }) });
    const image = view.getByRole("button", { name: "Image" });

    // A prevented mousedown is what leaves focus, and so the caret, in the body.
    expect(fireEvent.mouseDown(image)).toBe(false);
    await act(async () => {
      fireEvent.click(image);
      fireEvent.click(view.getByRole("button", { name: "Table" }));
      await Promise.resolve();
    });

    expect(insert.mock.calls).toEqual([["image"], ["table"]]);
  });

  test("a text style applies once its menu has closed", async () => {
    const turnInto = vi.fn(() => true);
    const view = renderToolbar({
      editorCommands: editorCommands({ turnInto }),
    });

    await openNodexMenu(view.getByRole("button", { name: "Text style" }));
    await act(async () => {
      fireEvent.click(view.getByRole("menuitem", { name: "Bulleted list" }));
      await Promise.resolve();
    });

    await waitFor(() => expect(turnInto).toHaveBeenCalledWith("bullet-list"));
  });

  test("the Insert menu lists the body's catalog by section, without line styles", async () => {
    const insert = vi.fn(() => true);
    const view = renderToolbar({
      editorCommands: editorCommands({
        insert,
        listInsertItems: () => [
          insertItem("heading", "Heading 1", "Text"),
          insertItem("emoji", "Emoji", "Text"),
          insertItem("bullet_list", "Bulleted list", "Lists"),
          insertItem("divider", "Divider", "Blocks"),
          insertItem("subpage", "Subpage", "Pages"),
          insertItem("prompt", "Prompt", "Agent"),
        ],
      }),
    });

    await openNodexMenu(view.getByRole("button", { name: "Insert" }));

    expect(view.getAllByRole("group").map((group) => group.getAttribute("aria-label"))).toEqual([
      "Page editing tools",
      "Agent",
      "Pages",
      "Blocks",
      "Inline",
    ]);
    expect(view.queryByRole("menuitem", { name: "Heading 1" })).toBeNull();
    expect(view.queryByRole("menuitem", { name: "Bulleted list" })).toBeNull();
    const divider = view.getByRole("menuitem", { name: "Divider" });
    expect(within(divider).getByText("Divider description")).toBeTruthy();

    await act(async () => {
      fireEvent.click(divider);
      await Promise.resolve();
    });
    await waitFor(() => expect(insert).toHaveBeenCalledWith("divider"));
  });

  test("copying the link confirms in place", async () => {
    const view = renderToolbar({ onCopyLink: async () => true });
    const button = view.getByRole("button", { name: "Copy link" });

    expect(button.textContent).toBe("Copy link");
    await act(async () => {
      fireEvent.click(button);
      await Promise.resolve();
    });
    await waitFor(() => expect(button.textContent).toBe("Copied"));
  });

  test("renders the Page's ancestors as navigation", async () => {
    const openedPages: Array<{ pageId: string; index: number }> = [];
    const view = renderToolbar({
      breadcrumb: {
        ancestors: [
          { projectId: "alpha", pageId: "root", title: "Root page" },
          { projectId: "alpha", pageId: "child", title: "Child page" },
        ],
        onOpenAncestor: (ancestor, index) => {
          openedPages.push({ pageId: ancestor.pageId, index });
        },
      },
    });

    const breadcrumb = view.getByRole("navigation", { name: "Page hierarchy" });
    await act(async () => {
      fireEvent.click(within(breadcrumb).getByRole("button", { name: "Child page" }));
      await Promise.resolve();
    });

    expect(openedPages).toEqual([{ pageId: "child", index: 1 }]);
  });

  test("keeps overflowed middle ancestors navigable", async () => {
    const openedPages: string[] = [];
    const view = renderToolbar({
      breadcrumb: {
        ancestors: [
          { projectId: "alpha", pageId: "root", title: "Root" },
          { projectId: "alpha", pageId: "middle", title: "Middle" },
          { projectId: "alpha", pageId: "child", title: "Child" },
          { projectId: "alpha", pageId: "parent", title: "Parent" },
        ],
        onOpenAncestor: (ancestor) => openedPages.push(ancestor.pageId),
      },
    });

    await openNodexMenu(view.getByRole("button", { name: "More ancestor pages" }));
    await act(async () => {
      fireEvent.click(view.getByRole("menuitem", { name: "Middle" }));
      await Promise.resolve();
    });

    expect(openedPages).toEqual(["middle"]);
  });
});
