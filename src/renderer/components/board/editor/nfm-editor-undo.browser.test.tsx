import { BlockNoteEditor, getBlockInfo, getNodeById } from "@blocknote/core";
import { NodeSelection, TextSelection } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import { BlockNoteViewRaw, useCreateBlockNote } from "@blocknote/react";
import { act, render } from "@testing-library/react";
import { StrictMode } from "react";
import { describe, expect, test, vi } from "vite-plus/test";
import * as Y from "yjs";

import { pressProseMirrorShortcut } from "@/test/prosemirror-shortcut";
import { createPageDocumentGenesis } from "../../../../shared/block-documents/block-document-codec";
import type { BlockDocumentSurfaceRuntime } from "../../../lib/block-document-surface-runtime";
import type { applyLibraryModule } from "../../../lib/api";
import { EditorSurfaceLease } from "../../../lib/document-session-registry";
import { createNfmEditorModeOptions } from "./nfm-editor-source";
import { NfmStructuralEditingSession } from "./nfm-structural-editing-extension";
import { availableHistoryReconciliation } from "./testing/nfm-history-reconciliation";

const settleEditor = async () => {
  await new Promise<void>((resolve) => {
    requestAnimationFrame(() => resolve());
  });
  await Promise.resolve();
};

const requireMountedEditorView = (editor: {
  readonly prosemirrorView?: EditorView;
}): EditorView => {
  const view = editor.prosemirrorView;
  if (!view) throw new Error("Expected a mounted editor view");
  return view;
};

function simulateTextInput(editor: BlockNoteEditor, text: string): void {
  const view = requireMountedEditorView(editor);
  const { from, to } = view.state.selection;
  const defaultTransaction = () => view.state.tr.insertText(text, from, to);
  const handled = view.someProp("handleTextInput", (handler) =>
    handler(view, from, to, text, defaultTransaction),
  );
  if (!handled) view.dispatch(defaultTransaction());
}

function typeString(editor: BlockNoteEditor, text: string): void {
  for (const character of text) simulateTextInput(editor, character);
}

function ExternalEditorHookOwner({ editor }: { readonly editor: BlockNoteEditor }) {
  useCreateBlockNote({}, [], editor);
  return null;
}

describe("collaborative NFM undo in Chromium", () => {
  test("undoes automatic inline formatting separately from its literal input", async () => {
    const genesis = createPageDocumentGenesis({
      documentId: "document:automatic-format-history",
      title: "Automatic format history",
      nfm: "",
      allocateBlockId: () => "block-automatic-format",
    });
    const document = genesis.document;
    const editor = BlockNoteEditor.create(
      createNfmEditorModeOptions({
        kind: "collaborative-document",
        documentId: document.guid,
        storeEpoch: "epoch:automatic-format-history",
        generation: 1,
        clientSessionId: "surface:automatic-format-history",
        fragment: document.getXmlFragment("body"),
        user: { name: "Formatting", color: "#2563eb" },
      }),
    );
    const host = globalThis.document.createElement("div");
    globalThis.document.body.append(host);
    editor.mount(host);

    try {
      await act(settleEditor);
      const blockId = editor.document[0]?.id;
      if (!blockId) throw new Error("Expected an initial paragraph");
      editor.setTextCursorPosition(blockId, "start");

      await act(async () => {
        typeString(editor, "**ABC**");
        await settleEditor();
      });
      expect(editor.document[0].content).toEqual([
        { type: "text", text: "ABC", styles: { bold: true } },
      ]);

      await act(async () => {
        expect(pressProseMirrorShortcut(editor, { key: "z", modKey: true })).toBe(true);
        await settleEditor();
      });
      expect(editor.document[0].content).toEqual([{ type: "text", text: "**ABC**", styles: {} }]);

      await act(async () => {
        expect(pressProseMirrorShortcut(editor, { key: "z", modKey: true })).toBe(true);
        await settleEditor();
      });
      expect(editor.document[0].content).toEqual([]);

      await act(async () => {
        expect(pressProseMirrorShortcut(editor, { key: "z", modKey: true, shiftKey: true })).toBe(
          true,
        );
        await settleEditor();
      });
      expect(editor.document[0].content).toEqual([{ type: "text", text: "**ABC**", styles: {} }]);

      await act(async () => {
        expect(pressProseMirrorShortcut(editor, { key: "z", modKey: true, shiftKey: true })).toBe(
          true,
        );
        await settleEditor();
      });
      expect(editor.document[0].content).toEqual([
        { type: "text", text: "ABC", styles: { bold: true } },
      ]);
    } finally {
      editor.unmount();
      host.remove();
      editor._tiptapEditor.destroy();
      document.destroy();
    }
  });

  test("keeps another surface's edit outside automatic-format history", async () => {
    const genesis = createPageDocumentGenesis({
      documentId: "document:automatic-format-surface-isolation",
      title: "Automatic format surface isolation",
      nfm: "",
      allocateBlockId: () => "block-automatic-format-isolation",
    });
    const document = genesis.document;
    const createSurfaceEditor = (clientSessionId: string, name: string) =>
      BlockNoteEditor.create(
        createNfmEditorModeOptions({
          kind: "collaborative-document",
          documentId: document.guid,
          storeEpoch: "epoch:automatic-format-surface-isolation",
          generation: 1,
          clientSessionId,
          fragment: document.getXmlFragment("body"),
          user: { name, color: name === "Left" ? "#2563eb" : "#16a34a" },
        }),
      );
    const left = createSurfaceEditor("surface:automatic-format-left", "Left");
    const right = createSurfaceEditor("surface:automatic-format-right", "Right");
    const leftHost = globalThis.document.createElement("div");
    const rightHost = globalThis.document.createElement("div");
    globalThis.document.body.append(leftHost, rightHost);
    left.mount(leftHost);
    right.mount(rightHost);

    try {
      await act(settleEditor);
      const blockId = left.document[0]?.id;
      if (!blockId) throw new Error("Expected a shared initial paragraph");
      left.setTextCursorPosition(blockId, "start");

      await act(async () => {
        typeString(left, "**ABC**");
        await settleEditor();
      });
      right.setTextCursorPosition(blockId, "end");
      await act(async () => {
        typeString(right, "R");
        await settleEditor();
      });
      expect(left.prosemirrorState.doc.textContent).toBe("ABCR");

      await act(async () => {
        expect(pressProseMirrorShortcut(left, { key: "z", modKey: true })).toBe(true);
        await settleEditor();
      });
      expect(left.prosemirrorState.doc.textContent).toBe("**ABC**R");
      expect(right.prosemirrorState.doc.textContent).toBe("**ABC**R");

      await act(async () => {
        expect(pressProseMirrorShortcut(left, { key: "z", modKey: true })).toBe(true);
        await settleEditor();
      });
      expect(left.prosemirrorState.doc.textContent).toBe("R");
      expect(right.prosemirrorState.doc.textContent).toBe("R");
    } finally {
      left.unmount();
      right.unmount();
      leftHost.remove();
      rightHost.remove();
      left._tiptapEditor.destroy();
      right._tiptapEditor.destroy();
      document.destroy();
    }
  });

  test("merges a paragraph across an atomic Block and restores the caret at the join", async () => {
    const genesis = createPageDocumentGenesis({
      documentId: "document:backward-merge",
      title: "Backward merge",
      nfm: "ABC\n\n123",
      allocateBlockId: (() => {
        const ids = ["block-target", "block-source"];
        return () => ids.shift() ?? "block-extra";
      })(),
    });
    const document = genesis.document;
    const editor = BlockNoteEditor.create(
      createNfmEditorModeOptions({
        kind: "collaborative-document",
        documentId: document.guid,
        storeEpoch: "epoch:backward-merge",
        generation: 1,
        clientSessionId: "surface:backward-merge",
        fragment: document.getXmlFragment("body"),
        user: { name: "Merge", color: "#2563eb" },
      }),
    );
    const host = globalThis.document.createElement("div");
    globalThis.document.body.append(host);
    editor.mount(host);
    editor.insertBlocks(
      [
        {
          id: "block-image",
          type: "image",
          props: { url: "https://example.test/image.png", name: "", caption: "" },
        },
      ],
      "block-source",
      "before",
    );
    const commands: unknown[] = [];
    const apply: typeof applyLibraryModule = async (_access, request) => {
      if (
        request.operation.kind === "apply_structural_edit" &&
        request.operation.command.kind === "set_local_history_retention"
      ) {
        return {
          ok: true,
          localCommit: {
            status: "no_op",
            observed: { store_epoch: "epoch:backward-merge", commit_head: 2 },
          },
          value: {
            operationId: request.operationId,
            profileId: "profile:test",
            storeEpoch: "epoch:backward-merge",
            libraryId: "library:test",
            operationKind: "apply_structural_edit",
            duplicate: false,
            didMutate: false,
            createdTarget: null,
            canvasMutation: null,
            structuralEdit: null,
            affectedParentKeys: [],
            affectedPageIds: [],
            affectedDatabaseIds: [],
            affectedViewIds: [],
            committedRevisions: {},
            commitSeq: 2,
            committedAt: "2026-08-25T00:00:00.000Z",
          },
        };
      }
      commands.push(request.operation);
      const target = editor.getBlock("block-target");
      const source = editor.getBlock("block-source");
      if (!target || !source || !Array.isArray(target.content) || !Array.isArray(source.content)) {
        throw new Error("Expected merge Blocks");
      }
      editor.updateBlock(target, { content: [...target.content, ...source.content] });
      editor.removeBlocks([source.id]);
      return {
        ok: true,
        localCommit: {
          status: "no_op",
          observed: { store_epoch: "epoch:backward-merge", commit_head: 2 },
        },
        value: {
          operationId: "operation:backward-merge",
          profileId: "profile:test",
          storeEpoch: "epoch:backward-merge",
          libraryId: "library:test",
          operationKind: "apply_structural_edit",
          duplicate: false,
          didMutate: true,
          createdTarget: null,
          canvasMutation: null,
          structuralEdit: {
            operationKind: "merge_block_backward",
            sourceRootBlockIds: ["block-source"],
            resultRootBlockIds: ["block-target"],
            copiedBlockIds: {},
            copiedDocumentIds: {},
            documentCommits: [],
            affectedPageIds: [],
            affectedDatabaseIds: [],
            clipboard: null,
            history: {
              recipeOperationId: "operation:backward-merge",
              recipeHash: "c".repeat(64),
              storeEpoch: "epoch:backward-merge",
            },
            supersededHistoryRecipeOperationIds: [],
            resume: {
              blockId: "block-target",
              edge: "end",
              fallbackBeforeBlockId: null,
              fallbackAfterBlockId: null,
            },
          },
          affectedParentKeys: [],
          affectedPageIds: [],
          affectedDatabaseIds: [],
          affectedViewIds: [],
          committedRevisions: {},
          commitSeq: 2,
          committedAt: "2026-08-25T00:00:00.000Z",
        },
      };
    };
    const session = new NfmStructuralEditingSession({
      historyReconciliation: availableHistoryReconciliation,
      editor,
      apply,
      runtime: {
        accessContext: { kind: "project", projectId: "project:test" },
        libraryId: "library:test",
        source: {
          documentId: document.guid,
          storeEpoch: "epoch:backward-merge",
          generation: 1,
        },
        participant: {
          prepareAndFence: async () => ({
            documentId: document.guid,
            storeEpoch: "epoch:backward-merge",
            generation: 1,
            expectedHeadSeq: 1,
          }),
        },
        getContainer: () => host,
      },
    });

    try {
      await act(settleEditor);
      editor.setTextCursorPosition("block-source", "start");
      await act(async () => {
        expect(session.handleKeyDown(new KeyboardEvent("keydown", { key: "Backspace" }))).toBe(
          true,
        );
        await session.whenIdle();
        await settleEditor();
      });
      expect(commands).toMatchObject([
        {
          command: {
            kind: "merge_block_backward",
            selection: { rootBlockIds: ["block-source"] },
            targetBlockId: "block-target",
          },
        },
      ]);
      expect(editor.getBlock("block-source")).toBeUndefined();
      expect(editor.getBlock("block-image")).toBeDefined();
      const mergedTarget = editor.getBlock("block-target");
      if (!mergedTarget || !Array.isArray(mergedTarget.content)) {
        throw new Error("Expected merged target inline content");
      }
      expect(
        mergedTarget.content.map((item) => (item.type === "text" ? item.text : "")).join(""),
      ).toBe("ABC123");
      const view = requireMountedEditorView(editor);
      const position = getNodeById("block-target", view.state.doc);
      if (!position) throw new Error("Expected target position");
      const info = getBlockInfo(position);
      if (!info.isBlockContainer) throw new Error("Expected target Block container");
      expect(view.state.selection.from).toBe(info.blockContent.beforePos + 1 + 3);
    } finally {
      session.dispose();
      editor.unmount();
      host.remove();
      editor._tiptapEditor.destroy();
      document.destroy();
    }
  });

  test("keeps a valid selection when a remote structural update removes the selected Block", async () => {
    let nextBlockId = 0;
    const genesis = createPageDocumentGenesis({
      documentId: "document:remote-selected-block-deletion",
      title: "Remote selected Block deletion",
      nfm: "Before\n\nMiddle\n\nDragged last Block",
      allocateBlockId: () => `block-${++nextBlockId}`,
    });
    const localDocument = genesis.document;
    const remoteDocument = new Y.Doc({ guid: localDocument.guid });
    Y.applyUpdate(remoteDocument, Y.encodeStateAsUpdate(localDocument));
    const remoteBaseVector = Y.encodeStateVector(remoteDocument);
    const createEditor = (document: Y.Doc, clientSessionId: string, name: string) =>
      BlockNoteEditor.create(
        createNfmEditorModeOptions({
          kind: "collaborative-document",
          documentId: document.guid,
          storeEpoch: "epoch:remote-selected-block-deletion",
          generation: 1,
          clientSessionId,
          fragment: document.getXmlFragment("body"),
          user: { name, color: name === "Local" ? "#2563eb" : "#16a34a" },
        }),
      );
    const localEditor = createEditor(localDocument, "surface:local", "Local");
    const remoteEditor = createEditor(remoteDocument, "surface:remote", "Remote");
    const localHost = globalThis.document.createElement("div");
    const remoteHost = globalThis.document.createElement("div");
    globalThis.document.body.append(localHost, remoteHost);
    localEditor.mount(localHost);
    remoteEditor.mount(remoteHost);

    try {
      await act(settleEditor);
      const localView = requireMountedEditorView(localEditor);
      const draggedBlockId = localEditor.document.at(-1)?.id;
      if (!draggedBlockId) {
        throw new Error("Expected a final Block to drag");
      }
      let draggedBlockPosition: number | null = null;
      localEditor.prosemirrorState.doc.descendants((node, position) => {
        if (node.type.name !== "blockContainer") return true;
        if (node.attrs.id !== draggedBlockId) return false;
        draggedBlockPosition = position;
        return false;
      });
      if (draggedBlockPosition === null) {
        throw new Error("Expected the dragged Block in ProseMirror");
      }
      const selectedBlockPosition = draggedBlockPosition;
      await act(async () => {
        localView.dispatch(
          localEditor.prosemirrorState.tr.setSelection(
            NodeSelection.create(localEditor.prosemirrorState.doc, selectedBlockPosition),
          ),
        );
        await settleEditor();
      });

      let remoteUpdate: Uint8Array | undefined;
      await act(async () => {
        remoteEditor.removeBlocks([draggedBlockId]);
        remoteUpdate = Y.encodeStateAsUpdate(remoteDocument, remoteBaseVector);
        await settleEditor();
      });
      if (!remoteUpdate) {
        throw new Error("Expected the remote structural update");
      }
      const appliedRemoteUpdate = remoteUpdate;

      await act(async () => {
        Y.applyUpdate(localDocument, appliedRemoteUpdate);
        await settleEditor();
      });
      expect(localEditor.getBlock(draggedBlockId)).toBeUndefined();
      expect(localEditor.prosemirrorState.selection).not.toBeInstanceOf(NodeSelection);
      expect(localEditor.prosemirrorState.selection.$head.parent).toBeDefined();
      const survivingBlock = localEditor.document.at(-1);
      if (!survivingBlock) {
        throw new Error("Expected a surviving Block after the remote deletion");
      }
      await act(async () => {
        localEditor.updateBlock(survivingBlock, { content: "Still editable" });
        await settleEditor();
      });
      expect(localEditor.getBlock(survivingBlock.id)?.content).not.toEqual(survivingBlock.content);
    } finally {
      localEditor.unmount();
      remoteEditor.unmount();
      localHost.remove();
      remoteHost.remove();
      localEditor._tiptapEditor.destroy();
      remoteEditor._tiptapEditor.destroy();
      localDocument.destroy();
      remoteDocument.destroy();
    }
  });

  test("leaves an externally owned editor alive after its React owner unmounts", async () => {
    const editor = BlockNoteEditor.create();
    const destroy = vi.spyOn(editor._tiptapEditor, "destroy");
    const view = render(
      <StrictMode>
        <ExternalEditorHookOwner editor={editor} />
      </StrictMode>,
    );

    try {
      view.unmount();
      await act(async () => {
        await Promise.resolve();
      });
      expect(destroy).not.toHaveBeenCalled();
    } finally {
      editor._tiptapEditor.destroy();
    }

    expect(destroy).toHaveBeenCalledTimes(1);
  });

  test("keeps undo local to each surface sharing one Y.Doc", async () => {
    const genesis = createPageDocumentGenesis({
      documentId: "document:two-surface-undo",
      title: "Two surfaces",
      nfm: "Base paragraph",
      allocateBlockId: () => "block-base",
    });
    const document = genesis.document;
    const createSurfaceEditor = (clientSessionId: string, name: string) =>
      BlockNoteEditor.create(
        createNfmEditorModeOptions({
          kind: "collaborative-document",
          documentId: document.guid,
          storeEpoch: "epoch:two-surface-undo",
          generation: 1,
          clientSessionId,
          fragment: document.getXmlFragment("body"),
          user: { name, color: name === "Left" ? "#2563eb" : "#16a34a" },
        }),
      );
    const left = createSurfaceEditor("surface:left", "Left");
    const right = createSurfaceEditor("surface:right", "Right");
    const leftHost = globalThis.document.createElement("div");
    const rightHost = globalThis.document.createElement("div");
    globalThis.document.body.append(leftHost, rightHost);
    left.mount(leftHost);
    right.mount(rightHost);

    try {
      await act(settleEditor);
      const mountedView = requireMountedEditorView(left);
      const mountedDom = mountedView.dom;
      const leftBase = left.getBlock("block-base");
      const rightBase = right.getBlock("block-base");
      if (!leftBase || !rightBase) throw new Error("Expected the shared base Block");

      await act(async () => {
        left.updateBlock(leftBase, { content: "Left edit" });
        right.insertBlocks(
          [
            {
              id: "block-right",
              type: "paragraph",
              content: "Right edit",
            },
          ],
          rightBase,
          "after",
        );
        await settleEditor();
      });
      expect(left.getBlock("block-base")?.content).not.toEqual(leftBase.content);
      expect(left.getBlock("block-right")).toBeDefined();
      expect(left.prosemirrorView).toBe(mountedView);
      expect(requireMountedEditorView(left).dom).toBe(mountedDom);

      await act(async () => {
        expect(left.undo()).toBe(true);
        await settleEditor();
      });

      expect(left.getBlock("block-base")?.content).toEqual(leftBase.content);
      expect(left.getBlock("block-right")).toBeDefined();
      expect(right.getBlock("block-right")).toBeDefined();
    } finally {
      left.unmount();
      right.unmount();
      leftHost.remove();
      rightHost.remove();
      left._tiptapEditor.destroy();
      right._tiptapEditor.destroy();
      document.destroy();
    }
  });

  test("restores the inline cursor and editor focus after remote edits while the EditorView is unmounted", async () => {
    const genesis = createPageDocumentGenesis({
      documentId: "document:relative-cursor-browser",
      title: "Relative cursor",
      nfm: "alpha omega",
      allocateBlockId: () => "block-relative-cursor",
    });
    const document = genesis.document;
    const localEditor = BlockNoteEditor.create(
      createNfmEditorModeOptions({
        kind: "collaborative-document",
        documentId: document.guid,
        storeEpoch: "epoch-relative-cursor",
        generation: 1,
        clientSessionId: "local-relative-cursor",
        fragment: document.getXmlFragment("body"),
        user: { name: "Local", color: "#2563eb" },
      }),
    );
    const remoteEditor = BlockNoteEditor.create(
      createNfmEditorModeOptions({
        kind: "collaborative-document",
        documentId: document.guid,
        storeEpoch: "epoch-relative-cursor",
        generation: 1,
        clientSessionId: "remote-relative-cursor",
        fragment: document.getXmlFragment("body"),
        user: { name: "Remote", color: "#16a34a" },
      }),
    );
    const remoteHost = globalThis.document.createElement("div");
    globalThis.document.body.append(remoteHost);
    remoteEditor.mount(remoteHost);
    const editorSession = new EditorSurfaceLease({
      key: "session-browser\u0000tab-relative-cursor",
      descriptor: {
        libraryId: "library-browser",
        accessContext: { kind: "project", projectId: "project-browser" },
        ownerBlockId: "page-relative-cursor",
        ownerType: "page",
        ownerLifecycle: "active",
        documentId: document.guid,
        authorization: null,
        storeEpoch: "epoch-relative-cursor",
        generation: 1,
        headSeq: 1,
        schemaKey: "nodex.page",
        schemaVersion: 1,
        readiness: "ready",
        sync: { kind: "yjs", stateVector: new Uint8Array() },
      },
      runtime: {} as BlockDocumentSurfaceRuntime,
    });
    editorSession.getOrCreateEditor("editor-relative-cursor", () => localEditor);
    const viewProps = {
      editor: localEditor,
      formattingToolbar: false as const,
      linkToolbar: false as const,
      slashMenu: false as const,
      sideMenu: false as const,
      tableHandles: false as const,
      onEditorViewMount: () => {
        editorSession.restoreSelection(localEditor);
      },
      onEditorViewUnmount: () => {
        editorSession.captureSelection(localEditor);
      },
    };
    const firstView = render(<BlockNoteViewRaw {...viewProps} />);

    try {
      await act(settleEditor);
      const firstLocalView = requireMountedEditorView(localEditor);
      let omegaPosition: number | null = null;
      localEditor.prosemirrorState.doc.descendants((node, position) => {
        if (omegaPosition !== null || !node.isText || !node.text) return;
        const offset = node.text.indexOf("omega");
        if (offset >= 0) omegaPosition = position + offset;
      });
      if (omegaPosition === null) throw new Error("Expected omega text");
      const initialCursor = omegaPosition;
      await act(async () => {
        firstLocalView.dispatch(
          localEditor.prosemirrorState.tr.setSelection(
            TextSelection.create(localEditor.prosemirrorState.doc, initialCursor),
          ),
        );
        editorSession.setShouldRestoreEditorFocus(true);
        localEditor.focus();
      });
      expect(globalThis.document.activeElement).toBe(firstLocalView.dom);
      firstView.unmount();

      let alphaPosition: number | null = null;
      remoteEditor.prosemirrorState.doc.descendants((node, position) => {
        if (alphaPosition !== null || !node.isText || !node.text) return;
        const offset = node.text.indexOf("alpha");
        if (offset >= 0) alphaPosition = position + offset;
      });
      if (alphaPosition === null) throw new Error("Expected alpha text");
      const remoteInsertPosition = alphaPosition;
      const remoteView = requireMountedEditorView(remoteEditor);
      await act(async () => {
        remoteView.dispatch(
          remoteEditor.prosemirrorState.tr.insertText("REMOTE ", remoteInsertPosition),
        );
        await settleEditor();
      });

      const secondView = render(<BlockNoteViewRaw {...viewProps} />);
      try {
        await act(settleEditor);
        expect(localEditor.prosemirrorState.selection.head).toBe(initialCursor + "REMOTE ".length);
        expect(globalThis.document.activeElement).toBe(requireMountedEditorView(localEditor).dom);
      } finally {
        secondView.unmount();
      }

      const otherPageControl = globalThis.document.createElement("button");
      globalThis.document.body.append(otherPageControl);
      otherPageControl.focus();
      editorSession.setShouldRestoreEditorFocus(false);
      const thirdView = render(<BlockNoteViewRaw {...viewProps} />);
      try {
        await act(settleEditor);
        expect(localEditor.prosemirrorState.selection.head).toBe(initialCursor + "REMOTE ".length);
        expect(globalThis.document.activeElement).toBe(otherPageControl);
      } finally {
        thirdView.unmount();
        otherPageControl.remove();
      }
    } finally {
      remoteEditor.unmount();
      remoteHost.remove();
      localEditor._tiptapEditor.destroy();
      remoteEditor._tiptapEditor.destroy();
      document.destroy();
    }
  });

  test("survives the StrictMode EditorView remount and leaves remote Blocks intact", async () => {
    const genesis = createPageDocumentGenesis({
      documentId: "document:strict-undo-browser",
      title: "Strict undo",
      nfm: "Base paragraph",
      allocateBlockId: () => "block-base",
    });
    const localDocument = genesis.document;
    const remoteDocument = new Y.Doc({ guid: localDocument.guid });
    Y.applyUpdate(remoteDocument, Y.encodeStateAsUpdate(localDocument));
    const remoteBaseVector = Y.encodeStateVector(remoteDocument);

    const localEditor = BlockNoteEditor.create(
      createNfmEditorModeOptions({
        kind: "collaborative-document",
        documentId: localDocument.guid,
        storeEpoch: "epoch-strict-undo",
        generation: 1,
        clientSessionId: "local-browser",
        fragment: localDocument.getXmlFragment("body"),
        user: { name: "Local", color: "#2563eb" },
      }),
    );
    const remoteEditor = BlockNoteEditor.create(
      createNfmEditorModeOptions({
        kind: "collaborative-document",
        documentId: remoteDocument.guid,
        storeEpoch: "epoch-strict-undo",
        generation: 1,
        clientSessionId: "remote-browser",
        fragment: remoteDocument.getXmlFragment("body"),
        user: { name: "Remote", color: "#16a34a" },
      }),
    );
    const remoteHost = document.createElement("div");
    document.body.append(remoteHost);
    remoteEditor.mount(remoteHost);

    const view = render(
      <StrictMode>
        <BlockNoteViewRaw
          editor={localEditor}
          formattingToolbar={false}
          linkToolbar={false}
          slashMenu={false}
          sideMenu={false}
          tableHandles={false}
        />
      </StrictMode>,
    );

    try {
      await act(settleEditor);
      const localBase = localEditor.getBlock("block-base");
      const remoteBase = remoteEditor.getBlock("block-base");
      if (!localBase || !remoteBase) {
        throw new Error("Expected the collaborative genesis Block");
      }

      await act(async () => {
        localEditor.updateBlock(localBase, { content: "Local paragraph" });
        remoteEditor.insertBlocks(
          [
            {
              id: "block-remote",
              type: "paragraph",
              content: "Remote paragraph",
            },
          ],
          remoteBase,
          "after",
        );
        Y.applyUpdate(
          localDocument,
          Y.encodeStateAsUpdate(remoteDocument, remoteBaseVector),
          "remote-provider",
        );
        await settleEditor();
      });

      expect(localEditor.getBlock("block-base")?.content).not.toEqual(remoteBase.content);
      expect(localEditor.getBlock("block-remote")).toBeDefined();

      let handled = false;
      await act(async () => {
        handled = localEditor.undo();
        await settleEditor();
      });

      expect(handled).toBe(true);
      expect(localEditor.getBlock("block-base")?.content).toEqual(remoteBase.content);
      expect(localEditor.getBlock("block-remote")).toBeDefined();

      const undoPlugin = localEditor.prosemirrorState.plugins.find((plugin) =>
        (plugin as unknown as { readonly key: string }).key.startsWith("y-undo$"),
      );
      const undoState = undoPlugin?.getState(localEditor.prosemirrorState) as
        | { readonly undoManager: Y.UndoManager }
        | undefined;
      if (!undoState) throw new Error("Expected the collaborative undo plugin");
      const stackLengthBeforeUnregister = undoState.undoManager.undoStack.length;

      await act(async () => {
        localEditor.unregisterExtension("yUndo");
        const baseAfterUndo = localEditor.getBlock("block-base");
        if (!baseAfterUndo) throw new Error("Expected the local base Block");
        localEditor.updateBlock(baseAfterUndo, {
          content: "Edit after undo extension removal",
        });
        await settleEditor();
      });
      expect(undoState.undoManager.undoStack).toHaveLength(stackLengthBeforeUnregister);
    } finally {
      view.unmount();
      remoteEditor.unmount();
      remoteHost.remove();
      localEditor._tiptapEditor.destroy();
      remoteEditor._tiptapEditor.destroy();
      localDocument.destroy();
      remoteDocument.destroy();
    }
  });
});
