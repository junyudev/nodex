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
import { act, fireEvent, render as renderForNfmEditorOwner, waitFor } from "@testing-library/react";
import { describe, expect, test, vi } from "vite-plus/test";
import "../../../globals.css";
import { renderWithQuery as render } from "@/test/query";
import { installCommandKeymapFixture } from "@/test/command-keymap";
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
import { Activity, Component, StrictMode, Suspense, useLayoutEffect, type ReactNode } from "react";
import * as Y from "yjs";
import { applyAwarenessUpdate, Awareness, encodeAwarenessUpdate } from "y-protocols/awareness";
import { memberIdentity } from "@/lib/member-identity";
import { createPageDocumentGenesis } from "../../../../shared/block-documents/block-document-codec";
import type { OwnedDocumentDescriptor } from "../../../../shared/block-documents";
import type { BlockDocumentSurfaceRuntime } from "@/lib/block-document-surface-runtime";
import { EditorSurfaceLease } from "@/lib/document-session-registry";
import { NodexYProvider, type DocumentSyncAdapter } from "@/lib/nodex-y-provider";
import { libraryContentRoute } from "../../../../shared/content-routing-context";
import { pressProseMirrorShortcut } from "@/test/prosemirror-shortcut";
import { getNfmEditorInstanceKey } from "./nfm-editor-source";
import {
  NfmEditorOwner,
  NfmEditorOwnerBoundary,
  type NfmEditorOwnerInput,
} from "./nfm-editor-owner";

describe("blocknote view lifecycle", () => {
  installCommandKeymapFixture();

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
          const closingPopover = document.body.querySelector<HTMLElement>(
            ".notion-text-action-menu",
          );
          if (!closingPopover) break;
          // The controller opts into an inert HTML snapshot; its positioned root
          // stays mounted while the child DOM preserves the committed appearance.
          expect(closingPopover).toBe(openPopover);
          expect(view.getByTestId("formatting-toolbar-exit-probe").outerHTML).toBe(
            openProbe.outerHTML,
          );
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
});

describe("nfm editor owner", () => {
  const settle = async () => {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  };

  function fixture(retained: boolean, markdown = "") {
    let blockIndex = 0;
    const { document } = createPageDocumentGenesis({
      documentId: `document:editor-owner-${retained}`,
      title: "Editor lifecycle",
      markdown,
      allocateBlockId: () =>
        blockIndex++ === 0 ? "block:editor-owner" : `block:editor-owner-${blockIndex}`,
    });
    const source = {
      kind: "collaborative-document" as const,
      documentId: document.guid,
      storeEpoch: "epoch:editor-owner",
      generation: 1,
      clientSessionId: "surface:editor-owner",
      fragment: document.getXmlFragment("body"),
      user: { name: "Test", color: "#2563eb" },
    };
    const descriptor: OwnedDocumentDescriptor = {
      libraryId: "library:editor-owner",
      routingContext: libraryContentRoute,
      ownerBlockId: "page:editor-owner",
      ownerType: "page",
      ownerLifecycle: "active",
      documentId: document.guid,
      storeEpoch: source.storeEpoch,
      generation: 1,
      headSeq: 1,
      schemaKey: "nodex.page",
      schemaVersion: 1,
      readiness: "ready",
      sync: { kind: "yjs", stateVector: new Uint8Array() },
    };
    const editorSession = retained
      ? new EditorSurfaceLease({
          key: "editor-owner-test",
          descriptor,
          runtime: {
            clearLocalAwareness: () => undefined,
          } as unknown as BlockDocumentSurfaceRuntime,
          releaseRuntime: async () => undefined,
        })
      : undefined;
    const input: NfmEditorOwnerInput = {
      source,
      routingContext: libraryContentRoute,
      editorInstanceKey: getNfmEditorInstanceKey({ source, routingContext: libraryContentRoute }),
      editorSession,
    };
    return { document, input, editorSession };
  }

  function EditorView({
    owner,
    onBind,
    resolveFileUrl,
  }: {
    readonly owner: NfmEditorOwner;
    readonly onBind: (owner: NfmEditorOwner) => void;
    readonly resolveFileUrl?: (url: string) => Promise<string>;
  }) {
    useLayoutEffect(() => {
      expect(owner.closed).toBe(false);
      expect(owner.editor._tiptapEditor.isDestroyed).toBe(false);
      onBind(owner);
      return owner.bindCallbacks({
        uploadFile: async () => "",
        resolveFileUrl: resolveFileUrl ?? (async (url) => url),
        resolveCopiedFileReferences: () => null,
      });
    }, [owner, onBind, resolveFileUrl]);
    return <BlockNoteViewRaw editor={owner.editor} />;
  }

  for (const withImage of [false, true]) {
    test(`opening a Page with ${withImage ? "text and an image" : "text"} sends no document update`, async () => {
      const imageUrl = "data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=";
      const { document: canonical, input } = fixture(
        false,
        `A message to read${withImage ? `\n\n![Image](${imageUrl})` : ""}`,
      );
      const document = new Y.Doc({ guid: canonical.guid });
      let headSeq = 1;
      const applyUpdate = vi.fn<DocumentSyncAdapter["applyUpdate"]>(async (request) => {
        Y.applyUpdate(canonical, request.update);
        headSeq += 1;
        return {
          ok: true,
          value: {
            documentId: canonical.guid,
            storeEpoch: input.source.storeEpoch,
            generation: 1,
            updateId: request.updateId,
            committedSeq: headSeq,
            headSeq,
            stateVector: Y.encodeStateVector(canonical),
            duplicate: false,
            status: "committed",
            commit: {
              store_epoch: input.source.storeEpoch,
              commit_seq: headSeq,
              manifest_hash: "f".repeat(64),
            },
          },
        };
      });
      const provider = new NodexYProvider({
        documentId: document.guid,
        document,
        clientSessionId: input.source.clientSessionId,
        localCheckpointStore: null,
        autoConnect: false,
        adapter: {
          sync: async (request) => ({
            ok: true,
            value: {
              documentId: canonical.guid,
              storeEpoch: input.source.storeEpoch,
              generation: 1,
              headSeq,
              stateVector: Y.encodeStateVector(canonical),
              update: Y.encodeStateAsUpdate(canonical, request.stateVector),
            },
          }),
          applyUpdate,
          subscribe: () => () => undefined,
          publishAwareness: async () => ({ ok: true, value: { accepted: true } }),
        },
      });
      await provider.connect();
      const before = Y.encodeStateAsUpdate(document);
      const updates: Uint8Array[] = [];
      document.on("update", (update: Uint8Array) => updates.push(update));
      const source = { ...input.source, fragment: document.getXmlFragment("body") };
      let current: NfmEditorOwner | null = null;
      const result = renderForNfmEditorOwner(
        <StrictMode>
          <NfmEditorOwnerBoundary
            input={{
              ...input,
              source,
              editorInstanceKey: getNfmEditorInstanceKey({
                source,
                routingContext: input.routingContext,
              }),
            }}
          >
            {(owner) => (
              <EditorView
                owner={owner}
                onBind={(value) => {
                  current = value;
                }}
              />
            )}
          </NfmEditorOwnerBoundary>
        </StrictMode>,
      );
      try {
        await waitFor(() => expect(result.container.querySelector(".ProseMirror")).not.toBeNull());
        if (withImage) {
          await waitFor(() => {
            const image = result.container.querySelector("img");
            expect(image?.complete).toBe(true);
            expect(image?.naturalWidth).toBe(1);
          });
        }
        await act(settle);
        expect(updates).toHaveLength(0);
        await provider.flush();
        expect(applyUpdate).not.toHaveBeenCalled();
        expect(Y.encodeStateAsUpdate(document)).toEqual(before);

        await act(async () => {
          document.getText("title").insert(0, "An intentional edit: ");
          await provider.flush();
        });
        expect(applyUpdate).toHaveBeenCalledTimes(1);
        expect(provider.getStatus().headSeq).toBe(2);
      } finally {
        await act(async () => {
          result.unmount();
          await current?.dispose();
        });
        provider.destroy();
        document.destroy();
        canonical.destroy();
      }
    });
  }

  for (const retained of [false, true]) {
    test(`${retained ? "retained" : "temporary"} editor survives StrictMode, rerender, and Activity with live history`, async () => {
      const { document, input, editorSession } = fixture(retained);
      let current: NfmEditorOwner | null = null;
      const onBind = (owner: NfmEditorOwner) => {
        current = owner;
      };
      const requireOwner = (): NfmEditorOwner => {
        if (!current) throw new Error("Editor did not mount");
        return current;
      };
      const content = (visible: boolean) => (
        <StrictMode>
          <Activity mode={visible ? "visible" : "hidden"}>
            <NfmEditorOwnerBoundary input={{ ...input, routingContext: { kind: "library" } }}>
              {(owner) => <EditorView owner={owner} onBind={onBind} />}
            </NfmEditorOwnerBoundary>
          </Activity>
        </StrictMode>
      );

      const result = renderForNfmEditorOwner(content(true));
      try {
        await act(settle);
        const first = requireOwner();
        await act(async () => {
          first.editor.updateBlock("block:editor-owner", { content: "local edit" });
          await settle();
        });
        await act(async () => {
          result.rerender(content(true));
          await settle();
        });
        expect(requireOwner()).toBe(first);
        expect(first.controller.attachEditor(first.editor, editorSession?.descriptor)).toBe(
          first.structuralSession,
        );
        await act(async () => {
          expect(pressProseMirrorShortcut(first.editor, { key: "z", modKey: true })).toBe(true);
          await first.structuralSession.whenIdle();
          await settle();
        });
        expect(first.editor.document[0]?.content).toEqual([]);
        await act(async () => {
          result.rerender(content(false));
          await settle();
        });
        expect(first.closed).toBe(!retained);
        await act(async () => {
          result.rerender(content(true));
          await settle();
        });
        const restored = requireOwner();
        expect(restored.closed).toBe(false);
        if (retained) expect(restored).toBe(first);
        else expect(restored).not.toBe(first);
        await act(async () => {
          restored.editor.updateBlock("block:editor-owner", { content: "after reveal" });
          expect(pressProseMirrorShortcut(restored.editor, { key: "z", modKey: true })).toBe(true);
          await restored.structuralSession.whenIdle();
          await settle();
        });
        expect(restored.editor.document[0]?.content).toEqual([]);
      } finally {
        await act(async () => {
          result.unmount();
          await editorSession?.dispose();
          await current?.dispose();
        });
        document.destroy();
      }
    });
  }

  for (const retained of [false, true])
    test(`waits for structural cleanup before destroying a ${retained ? "retained" : "temporary"} editor`, async () => {
      const { document, input, editorSession } = fixture(retained);
      const owner =
        editorSession?.getOrCreateRetainedResource(
          "nfm-editor-owner",
          () => new NfmEditorOwner(input),
        ) ?? new NfmEditorOwner(input);
      let finish = () => {};
      const pending = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const close = owner.structuralSession.close.bind(owner.structuralSession);
      vi.spyOn(owner.structuralSession, "close").mockImplementation(async () => {
        await pending;
        await close();
      });
      const destroy = vi.spyOn(owner.editor._tiptapEditor, "destroy");
      const ownerClosing = owner.dispose();
      const closing = editorSession?.dispose() ?? ownerClosing;
      expect(owner.closed).toBe(true);
      expect(owner.dispose()).toBe(ownerClosing);
      expect(destroy).not.toHaveBeenCalled();
      finish();
      await closing;
      expect(destroy).toHaveBeenCalledTimes(1);
      document.destroy();
    });

  test("shows the remote Member's name and selection and refreshes their mounted cursor after a rename", async () => {
    const { document, input } = fixture(false, "Shared text");
    const awareness = new Awareness(document);
    const remoteDoc = new Y.Doc();
    Y.applyUpdate(remoteDoc, Y.encodeStateAsUpdate(document));
    const remote = new Awareness(remoteDoc);
    const local = memberIdentity({ id: "member:ada", display_name: "Ada Lovelace" });
    const teammate = memberIdentity({ id: "member:grace", display_name: "Grace Hopper" });
    const paragraph = remoteDoc.getXmlFragment("body").querySelector("paragraph");
    const text = paragraph instanceof Y.XmlElement ? paragraph.get(0) : null;
    if (!(text instanceof Y.XmlText)) throw new Error("The fixture requires a text selection");
    const cursor = {
      anchor: Y.createRelativePositionFromTypeIndex(text, 0),
      head: Y.createRelativePositionFromTypeIndex(text, "Shared".length),
    };
    const source = { ...input.source, user: undefined, provider: { awareness } };
    awareness.setLocalState({ user: local, cursor });
    const view = renderForNfmEditorOwner(
      <NfmEditorOwnerBoundary input={{ ...input, source }}>
        {(owner) => <EditorView owner={owner} onBind={() => {}} />}
      </NfmEditorOwnerBoundary>,
    );

    try {
      await view.findByText("Shared text");
      expect(awareness.getLocalState()?.user).toEqual(local);
      const publish = async (user: { name: string; color: string }) => {
        await act(async () => {
          remote.setLocalState({ user, cursor });
          applyAwarenessUpdate(awareness, encodeAwarenessUpdate(remote, [remote.clientID]), remote);
        });
      };
      await publish(teammate);
      const label = await view.findByText("Grace Hopper", { exact: true });
      const selection = view.container.querySelector<HTMLElement>(".ProseMirror-yjs-selection");
      expect(selection?.textContent).toBe("Shared");
      expect(selection?.style.backgroundColor).toBeTruthy();
      expect(view.queryByText("Ada Lovelace", { exact: true })).toBeNull();

      await publish({ ...teammate, name: "Grace Murray Hopper" });
      expect(await view.findByText("Grace Murray Hopper", { exact: true })).toBe(label);
    } finally {
      view.unmount();
      remoteDoc.destroy();
      document.destroy();
    }
  });

  test("initial image resolution sees the committed view callback port", async () => {
    const { document, input } = fixture(
      false,
      "An image\n\n![Image](https://example.test/image.png)",
    );
    const resolveFileUrl = vi.fn(
      async () => "data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=",
    );
    let owner: NfmEditorOwner | null = null;
    const result = renderForNfmEditorOwner(
      <StrictMode>
        <NfmEditorOwnerBoundary input={input}>
          {(current) => (
            <EditorView
              owner={current}
              onBind={(value) => {
                owner = value;
              }}
              resolveFileUrl={resolveFileUrl}
            />
          )}
        </NfmEditorOwnerBoundary>
      </StrictMode>,
    );
    try {
      await waitFor(() =>
        expect(resolveFileUrl).toHaveBeenCalledWith("https://example.test/image.png"),
      );
      await act(settle);
    } finally {
      await act(async () => {
        result.unmount();
        await owner?.dispose();
      });
      document.destroy();
    }
  });

  test("draft document retirement before view cleanup is safe", async () => {
    const { document, input } = fixture(false);
    const owner = new NfmEditorOwner(input);
    document.destroy();
    await owner.dispose();
    expect(owner.editor._tiptapEditor.isDestroyed).toBe(true);
  });

  test("failed retirement destroys the old editor without poisoning its replacement", async () => {
    const { document, input } = fixture(false);
    let current: NfmEditorOwner | null = null;
    const onBind = (owner: NfmEditorOwner) => {
      current = owner;
    };
    const requireOwner = (): NfmEditorOwner => {
      if (!current) throw new Error("Editor did not mount");
      return current;
    };
    const content = (visible: boolean) => (
      <Activity mode={visible ? "visible" : "hidden"}>
        <NfmEditorOwnerBoundary input={input}>
          {(owner) => <EditorView owner={owner} onBind={onBind} />}
        </NfmEditorOwnerBoundary>
      </Activity>
    );

    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    let finish = () => {};
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const failure = new Error("History retirement failed");
    const result = renderForNfmEditorOwner(content(true));
    try {
      await act(settle);
      const first = requireOwner();
      const close = first.structuralSession.close.bind(first.structuralSession);
      vi.spyOn(first.structuralSession, "close").mockImplementation(async () => {
        await pending;
        await close();
        throw failure;
      });
      await act(async () => {
        result.rerender(content(false));
        await settle();
      });
      await act(async () => {
        result.rerender(content(true));
        await settle();
      });
      const replacement = requireOwner();
      expect(replacement).not.toBe(first);
      await act(async () => {
        finish();
        await expect(first.dispose()).rejects.toBe(failure);
        await settle();
      });
      expect(first.editor._tiptapEditor.isDestroyed).toBe(true);
      expect(replacement.closed).toBe(false);
      expect(log).toHaveBeenCalledExactlyOnceWith("[nfm-editor:close]", failure);
    } finally {
      finish();
      await act(async () => {
        result.unmount();
        await current?.dispose();
      });
      log.mockRestore();
      document.destroy();
    }
  });

  test("authority replacement creates a new owner before rendering its view", async () => {
    const { document, input } = fixture(false);
    let current: NfmEditorOwner | null = null;
    const onBind = (owner: NfmEditorOwner) => {
      current = owner;
    };
    const requireOwner = (): NfmEditorOwner => {
      if (!current) throw new Error("Editor did not mount");
      return current;
    };
    const content = (value: NfmEditorOwnerInput) => (
      <NfmEditorOwnerBoundary input={value}>
        {(owner) => <EditorView owner={owner} onBind={onBind} />}
      </NfmEditorOwnerBoundary>
    );

    const result = renderForNfmEditorOwner(content(input));
    try {
      await act(settle);
      const before = requireOwner();
      await act(async () => {
        result.rerender(
          content({
            ...input,
            libraryId: "library:replacement",
            source: { ...input.source, storeEpoch: "epoch:replacement" },
          }),
        );
        await settle();
      });
      expect(before.closed).toBe(true);
      expect(requireOwner()).not.toBe(before);
      expect(requireOwner().closed).toBe(false);
    } finally {
      await act(async () => {
        result.unmount();
        await current?.dispose();
      });
      document.destroy();
    }
  });

  test("a retained lease rejects another authority before editor allocation", async () => {
    const { document, input, editorSession } = fixture(true);
    const create = vi.spyOn(BlockNoteEditor, "create");
    try {
      expect(
        () =>
          new NfmEditorOwner({
            ...input,
            source: { ...input.source, storeEpoch: "epoch:another" },
          }),
      ).toThrow("cannot change its Document or history authority");
      expect(create).not.toHaveBeenCalled();
    } finally {
      create.mockRestore();
      await editorSession?.dispose();
      document.destroy();
    }
  });

  test("lease replacement never binds the previous editor to the new surface", async () => {
    const { document, input, editorSession } = fixture(true);
    if (!editorSession) throw new Error("Expected a retained surface");
    const replacement = new EditorSurfaceLease({
      key: "replacement-surface",
      descriptor: editorSession.descriptor,
      runtime: editorSession.runtime,
      releaseRuntime: async () => undefined,
    });
    const bindings: { owner: NfmEditorOwner; lease: EditorSurfaceLease }[] = [];
    const content = (lease: EditorSurfaceLease) => (
      <NfmEditorOwnerBoundary input={{ ...input, editorSession: lease }}>
        {(owner) => (
          <EditorView
            owner={owner}
            onBind={(value) => {
              bindings.push({ owner: value, lease });
            }}
          />
        )}
      </NfmEditorOwnerBoundary>
    );

    const result = renderForNfmEditorOwner(content(editorSession));
    try {
      await act(settle);
      const original = bindings[0]?.owner;
      expect(original).toBeDefined();
      await act(async () => {
        result.rerender(content(replacement));
        await settle();
      });
      const replacements = bindings.filter(({ lease }) => lease === replacement);
      expect(replacements.length).toBeGreaterThan(0);
      expect(replacements.every(({ owner }) => owner !== original)).toBe(true);
    } finally {
      await act(async () => {
        result.unmount();
        await editorSession.dispose();
        await replacement.dispose();
      });
      document.destroy();
    }
  });

  class OwnerFailureBoundary extends Component<
    { readonly children: ReactNode },
    { readonly failed: boolean }
  > {
    state = { failed: false };
    static getDerivedStateFromError() {
      return { failed: true };
    }
    render() {
      return this.state.failed ? (
        <div role="alert">Editor authority changed</div>
      ) : (
        this.props.children
      );
    }
  }

  for (const replacement of ["scope", "epoch", "fragment"] as const)
    test(`a retained boundary rejects a cached owner after ${replacement} replacement`, async () => {
      const { document, input, editorSession } = fixture(true);
      const alternative = fixture(false);
      let first: NfmEditorOwner | null = null;
      const binds: NfmEditorOwner[] = [];
      const onBind = (owner: NfmEditorOwner) => {
        first ??= owner;
        binds.push(owner);
      };
      const caught: unknown[] = [];
      const content = (value: NfmEditorOwnerInput) => (
        <OwnerFailureBoundary>
          <NfmEditorOwnerBoundary input={value}>
            {(owner) => <EditorView owner={owner} onBind={onBind} />}
          </NfmEditorOwnerBoundary>
        </OwnerFailureBoundary>
      );

      const result = renderForNfmEditorOwner(content(input), {
        onCaughtError: (error) => {
          caught.push(error);
        },
      });
      try {
        await act(settle);
        const changed: NfmEditorOwnerInput = {
          ...input,
          ...(replacement === "scope"
            ? { routingContext: { kind: "project", projectId: "project:another" } }
            : {}),
          source: {
            ...input.source,
            ...(replacement === "epoch" ? { storeEpoch: "epoch:another" } : {}),
            ...(replacement === "fragment" ? { fragment: alternative.input.source.fragment } : {}),
          },
        };
        await act(async () => {
          result.rerender(content(changed));
          await settle();
        });
        expect(result.getByRole("alert")).toBeTruthy();
        expect(caught).toHaveLength(1);
        expect(String(caught[0])).toContain("cannot change its Document or history authority");
        expect(binds.every((owner) => owner === first)).toBe(true);
      } finally {
        await act(async () => {
          result.unmount();
          await editorSession?.dispose();
        });
        document.destroy();
        alternative.document.destroy();
      }
    });

  test("a suspended, uncommitted editor boundary allocates no editor", async () => {
    const { document, input } = fixture(false);
    const acquire = vi.spyOn(BlockNoteEditor, "create");
    const never = new Promise<void>(() => {});
    function Suspend(): never {
      throw never;
    }
    const result = renderForNfmEditorOwner(
      <Suspense fallback={null}>
        <NfmEditorOwnerBoundary input={input}>
          {(owner) => <EditorView owner={owner} onBind={() => undefined} />}
        </NfmEditorOwnerBoundary>
        <Suspend />
      </Suspense>,
    );
    try {
      await act(settle);
      expect(acquire).not.toHaveBeenCalled();
    } finally {
      result.unmount();
      acquire.mockRestore();
      document.destroy();
    }
  });
});
