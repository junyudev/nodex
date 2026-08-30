import { BlockNoteEditor } from "@blocknote/core";
import {
  DropCursorExtension,
  FilePanelExtension,
  FormattingToolbarExtension,
  SideMenuExtension,
  SuggestionMenu,
  TableHandlesExtension,
} from "@blocknote/core/extensions";
import { BlockNoteViewRaw, TableHandlesController } from "@blocknote/react";
import { TextSelection } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import { act, fireEvent, render } from "@testing-library/react";
import { describe, expect, test, vi } from "vite-plus/test";
import "../../../globals.css";
import {
  NodexDropdownContent,
  NodexDropdownItem,
  NodexDropdownPortal,
  NodexDropdownRoot,
  NodexDropdownTrigger,
} from "@/components/ui/dropdown";
import { NodexPopover, NodexPopoverAnchor, NodexPopoverContent } from "@/components/ui/popover";
import { NfmFormattingToolbarController } from "./nfm-formatting-toolbar-controller";
import { NfmSideMenuOpenProvider } from "./nfm-side-menu";

const settleEditor = async (): Promise<void> => {
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  await Promise.resolve();
};

const requireMountedEditorView = (editor: {
  readonly prosemirrorView?: EditorView;
}): EditorView => {
  const view = editor.prosemirrorView;
  if (!view) throw new Error("Expected a mounted editor view");
  return view;
};

const selectBlockText = (
  editor: BlockNoteEditor,
  view: EditorView,
  blockId: string,
  length: number,
): void => {
  editor.setTextCursorPosition(blockId, "start");
  const from = editor.prosemirrorState.selection.from;
  view.dispatch(
    editor.prosemirrorState.tr.setSelection(
      TextSelection.create(editor.prosemirrorState.doc, from, from + length),
    ),
  );
};

describe("BlockNote view lifecycle in Chromium", () => {
  test("clears floating UI state and remounts safely after a retained editor loses its DOM view", async () => {
    const editor = BlockNoteEditor.create({
      initialContent: [
        {
          id: "table-1",
          type: "table",
          content: {
            type: "tableContent",
            rows: [{ cells: ["Cell"] }],
          },
        },
      ],
    });
    const table = editor.getBlock("table-1");
    const tableHandles = editor.getExtension(TableHandlesExtension);
    const filePanel = editor.getExtension(FilePanelExtension);
    const formattingToolbar = editor.getExtension(FormattingToolbarExtension);
    const sideMenu = editor.getExtension(SideMenuExtension);
    const suggestionMenu = editor.getExtension(SuggestionMenu);
    if (
      !table ||
      table.type !== "table" ||
      !tableHandles ||
      !filePanel ||
      !formattingToolbar ||
      !sideMenu ||
      !suggestionMenu
    ) {
      throw new Error("Expected the floating UI lifecycle fixture");
    }
    const staleTableState = {
      show: true,
      showAddOrRemoveRowsButton: false,
      showAddOrRemoveColumnsButton: false,
      referencePosCell: undefined,
      referencePosTable: new DOMRect(),
      block: table,
      colIndex: undefined,
      rowIndex: undefined,
      draggingState: undefined,
      widgetContainer: undefined,
    };
    const mountedEditorRoots: HTMLElement[] = [];
    const renderEditor = () => (
      <BlockNoteViewRaw
        editor={editor}
        onEditorViewMount={(editorRoot) => mountedEditorRoots.push(editorRoot)}
        formattingToolbar={false}
        linkToolbar={false}
        slashMenu={false}
        sideMenu={false}
        tableHandles={false}
      >
        <TableHandlesController
          tableHandle={() => null}
          tableCellHandle={() => null}
          extendButton={() => null}
        />
      </BlockNoteViewRaw>
    );
    let view = render(renderEditor());

    try {
      await act(settleEditor);
      expect(editor.prosemirrorView).toBeDefined();
      expect(mountedEditorRoots.at(-1)).toBe(editor.prosemirrorView?.dom);

      await act(async () => {
        tableHandles.store.setState(staleTableState);
        filePanel.showMenu(table.id);
        formattingToolbar.store.setState(true);
        sideMenu.store.setState({
          show: true,
          referencePos: new DOMRect(),
          block: table,
        });
        suggestionMenu.store.setState({
          sessionId: "suggestion:lifecycle-test",
          show: true,
          referencePos: new DOMRect(),
          query: "",
          isComposing: false,
          acceptancePhase: "editing",
          triggerCharacter: "/",
        });
        await settleEditor();
      });
      expect(tableHandles.store.state).toEqual(staleTableState);
      expect(filePanel.store.state).toBe(table.id);
      expect(formattingToolbar.store.state).toBe(true);
      expect(sideMenu.store.state?.show).toBe(true);
      expect(suggestionMenu.store.state?.show).toBe(true);

      view.unmount();
      expect(editor.headless).toBe(true);
      expect(editor.prosemirrorView).toBeUndefined();
      expect(tableHandles.store.state).toBeUndefined();
      expect(filePanel.store.state).toBeUndefined();
      expect(formattingToolbar.store.state).toBe(false);
      expect(sideMenu.store.state).toBeUndefined();
      expect(suggestionMenu.store.state).toBeUndefined();
      expect(() => {
        tableHandles.freezeHandles();
        tableHandles.unfreezeHandles();
        tableHandles.hideHandlesIfNotFrozen();
        tableHandles.dragEnd();
        sideMenu.freezeMenu();
        sideMenu.unfreezeMenu();
        sideMenu.hideMenuIfNotFrozen();
        sideMenu.blockDragEnd();
      }).not.toThrow();

      // A delayed store delivery must also be harmless during React's render
      // before BlockNote's layout effect attaches the replacement EditorView.
      tableHandles.store.setState(staleTableState);
      view = render(renderEditor());
      await act(settleEditor);

      expect(editor.headless).toBe(false);
      expect(editor.prosemirrorView).toBeDefined();
      expect(mountedEditorRoots.at(-1)).toBe(editor.prosemirrorView?.dom);
    } finally {
      view.unmount();
      editor._tiptapEditor.destroy();
    }
  });

  test("mounts the NFM side-menu provider before the editor view is available", async () => {
    const editor = BlockNoteEditor.create({
      initialContent: [{ id: "block-1", type: "paragraph", content: "One" }],
    });
    expect(editor.headless).toBe(true);
    expect(editor.prosemirrorView).toBeUndefined();

    const view = render(
      <BlockNoteViewRaw
        editor={editor}
        formattingToolbar={false}
        linkToolbar={false}
        slashMenu={false}
        sideMenu={false}
        tableHandles={false}
      >
        <NfmSideMenuOpenProvider>
          <div data-testid="nfm-editor-child" />
        </NfmSideMenuOpenProvider>
      </BlockNoteViewRaw>,
    );

    try {
      await act(settleEditor);
      expect(view.getByTestId("nfm-editor-child")).not.toBeNull();
      expect(editor.headless).toBe(false);
    } finally {
      view.unmount();
      editor._tiptapEditor.destroy();
    }
  });

  test("changes editability without replacing the mounted EditorView or its NodeViews", async () => {
    const editor = BlockNoteEditor.create({
      initialContent: [{ id: "block-1", type: "paragraph", content: "One" }],
    });
    const renderView = (editable: boolean) => (
      <BlockNoteViewRaw
        editor={editor}
        editable={editable}
        formattingToolbar={false}
        linkToolbar={false}
        slashMenu={false}
        sideMenu={false}
        tableHandles={false}
      />
    );
    const view = render(renderView(true));

    try {
      await act(settleEditor);
      const mountedView = requireMountedEditorView(editor);
      const mountedDom = mountedView.dom;

      await act(async () => {
        view.rerender(renderView(false));
        await settleEditor();
      });

      expect(editor.prosemirrorView).toBe(mountedView);
      expect(requireMountedEditorView(editor).dom).toBe(mountedDom);
      expect(editor.isEditable).toBe(false);
      expect(mountedDom.getAttribute("tabindex")).toBe("0");

      await act(async () => {
        view.rerender(renderView(true));
        await settleEditor();
      });
      expect(editor.prosemirrorView).toBe(mountedView);
      expect(editor.isEditable).toBe(true);
    } finally {
      view.unmount();
      editor._tiptapEditor.destroy();
    }
  });

  test("lets an external drag owner suppress BlockNote's native drop cursor", async () => {
    const editor = BlockNoteEditor.create({
      initialContent: [{ id: "block-1", type: "paragraph", content: "One" }],
    });
    const resolveExternalOwnership = vi.fn(() => true);
    const dropCursorExtension = editor.getExtension(DropCursorExtension) as unknown as {
      setExternalDragOwnershipResolver: (resolver: (event: DragEvent) => boolean) => () => void;
    };
    const releaseOwnership =
      dropCursorExtension.setExternalDragOwnershipResolver(resolveExternalOwnership);
    const view = render(
      <BlockNoteViewRaw
        editor={editor}
        formattingToolbar={false}
        linkToolbar={false}
        slashMenu={false}
        sideMenu={false}
        tableHandles={false}
      />,
    );

    try {
      await act(settleEditor);
      const mountedView = requireMountedEditorView(editor);
      await act(async () => {
        mountedView.dom.dispatchEvent(
          new DragEvent("dragover", {
            bubbles: true,
            cancelable: true,
            clientX: 0,
            clientY: 0,
            dataTransfer: new DataTransfer(),
          }),
        );
        await Promise.resolve();
      });

      expect(resolveExternalOwnership).toHaveBeenCalledOnce();
      expect(document.querySelector(".prosemirror-dropcursor-block")).toBeNull();
    } finally {
      releaseOwnership();
      view.unmount();
      editor._tiptapEditor.destroy();
    }
  });

  test("portals the formatting toolbar outside the editor clipping container", async () => {
    const editor = BlockNoteEditor.create({
      initialContent: [{ id: "block-1", type: "paragraph", content: "Select me" }],
    });
    const view = render(
      <BlockNoteViewRaw
        editor={editor}
        formattingToolbar={false}
        linkToolbar={false}
        slashMenu={false}
        sideMenu={false}
        tableHandles={false}
      >
        <NfmSideMenuOpenProvider>
          <NfmFormattingToolbarController
            formattingToolbar={() => (
              <div data-testid="formatting-toolbar-portal-probe">
                <NodexPopover open>
                  <NodexPopoverAnchor>
                    <button type="button">Nested action</button>
                  </NodexPopoverAnchor>
                  <NodexPopoverContent data-testid="formatting-toolbar-nested-popover">
                    Nested floating content
                  </NodexPopoverContent>
                </NodexPopover>
                <NodexDropdownRoot open>
                  <NodexDropdownTrigger>
                    <button type="button">Nested menu</button>
                  </NodexDropdownTrigger>
                  <NodexDropdownPortal>
                    <NodexDropdownContent data-testid="formatting-toolbar-nested-dropdown">
                      <NodexDropdownItem>Nested menu content</NodexDropdownItem>
                    </NodexDropdownContent>
                  </NodexDropdownPortal>
                </NodexDropdownRoot>
              </div>
            )}
          />
        </NfmSideMenuOpenProvider>
      </BlockNoteViewRaw>,
    );

    try {
      await act(settleEditor);
      const mountedView = requireMountedEditorView(editor);
      await act(async () => {
        selectBlockText(editor, mountedView, "block-1", "Select".length);
        editor.focus();
        await settleEditor();
      });

      const toolbar = await view.findByTestId("formatting-toolbar-portal-probe");
      expect(document.body.contains(toolbar)).toBe(true);
      expect(view.container.contains(toolbar)).toBe(false);

      const toolbarLayer = toolbar.closest<HTMLElement>(".notion-text-action-menu");
      if (!toolbarLayer) throw new Error("Expected the editor-owned formatting toolbar layer.");
      const nestedPopover = await view.findByTestId("formatting-toolbar-nested-popover");
      expect(document.body.contains(nestedPopover)).toBe(true);
      expect(toolbarLayer.contains(nestedPopover)).toBe(false);
      expect(Number(getComputedStyle(nestedPopover).zIndex)).toBeGreaterThan(
        Number(getComputedStyle(toolbarLayer).zIndex),
      );
      const nestedDropdown = await view.findByTestId("formatting-toolbar-nested-dropdown");
      expect(document.body.contains(nestedDropdown)).toBe(true);
      expect(toolbarLayer.contains(nestedDropdown)).toBe(false);
      expect(Number(getComputedStyle(nestedDropdown).zIndex)).toBeGreaterThan(
        Number(getComputedStyle(toolbarLayer).zIndex),
      );
    } finally {
      view.unmount();
      editor._tiptapEditor.destroy();
    }
  });

  test("keeps the last selection anchor while the formatting toolbar exits", async () => {
    const editor = BlockNoteEditor.create({
      initialContent: [{ id: "block-1", type: "paragraph", content: "12345" }],
    });
    const view = render(
      <BlockNoteViewRaw
        editor={editor}
        formattingToolbar={false}
        linkToolbar={false}
        slashMenu={false}
        sideMenu={false}
        tableHandles={false}
      >
        <NfmSideMenuOpenProvider>
          <NfmFormattingToolbarController
            formattingToolbar={() => (
              <div
                data-testid="formatting-toolbar-exit-probe"
                style={{ width: 192, height: 220 }}
              />
            )}
          />
        </NfmSideMenuOpenProvider>
      </BlockNoteViewRaw>,
    );

    try {
      await act(settleEditor);
      const mountedView = requireMountedEditorView(editor);
      await act(async () => {
        selectBlockText(editor, mountedView, "block-1", "12345".length);
        editor.focus();
        await settleEditor();
      });

      expect(editor.prosemirrorState.selection).toBeInstanceOf(TextSelection);
      expect({
        from: editor.prosemirrorState.selection.from,
        to: editor.prosemirrorState.selection.to,
      }).toEqual({ from: 3, to: 8 });

      await view.findByTestId("formatting-toolbar-exit-probe");
      const openPopover = document.body.querySelector<HTMLElement>(".notion-text-action-menu");
      if (!openPopover) throw new Error("Expected an open formatting toolbar popover.");
      const openProbe = view.getByTestId("formatting-toolbar-exit-probe");
      const openPosition = {
        left: openPopover.style.left,
        top: openPopover.style.top,
      };
      const openRect = openPopover.getBoundingClientRect();

      await act(async () => {
        fireEvent.keyDown(mountedView.dom, {
          key: "Backspace",
          code: "Backspace",
        });
        await Promise.resolve();
      });
      expect(editor.prosemirrorState.doc.textContent).toBe("");

      const exitPositions: Array<{
        left: string;
        top: string;
        rectLeft: number;
        rectTop: number;
        opacity: string;
      }> = [];
      for (let frame = 0; frame < 10; frame += 1) {
        await act(async () => {
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        });
        const closingPopover = document.body.querySelector<HTMLElement>(".notion-text-action-menu");
        if (!closingPopover) break;
        expect(view.getByTestId("formatting-toolbar-exit-probe")).toBe(openProbe);
        expect(closingPopover.inert).toBe(true);
        expect(closingPopover.getAttribute("aria-hidden")).toBe("true");
        exitPositions.push({
          left: closingPopover.style.left,
          top: closingPopover.style.top,
          rectLeft: closingPopover.getBoundingClientRect().left,
          rectTop: closingPopover.getBoundingClientRect().top,
          opacity: getComputedStyle(closingPopover).opacity,
        });
      }

      expect(exitPositions.length).toBeGreaterThan(0);
      expect(exitPositions.some((position) => Number(position.opacity) < 1)).toBe(true);
      expect(exitPositions.every((position) => position.left === openPosition.left)).toBe(true);
      expect(exitPositions.every((position) => position.top === openPosition.top)).toBe(true);
      expect(
        exitPositions.every((position) => Math.abs(position.rectLeft - openRect.left) < 12),
      ).toBe(true);
      expect(
        exitPositions.every((position) => Math.abs(position.rectTop - openRect.top) < 12),
      ).toBe(true);
    } finally {
      view.unmount();
      editor._tiptapEditor.destroy();
    }
  });
});
