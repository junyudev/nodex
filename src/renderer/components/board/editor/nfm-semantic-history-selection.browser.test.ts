import { BlockNoteEditor } from "@blocknote/core";
import type { YUndoExtension } from "@blocknote/core/yjs";
import { TextSelection } from "@tiptap/pm/state";
import { act } from "@testing-library/react";
import { expect, test } from "vite-plus/test";
import * as Y from "yjs";

import { createPageDocumentGenesis } from "../../../../shared/block-documents/block-document-codec";
import { cloneXmlSubtree } from "../../../../shared/block-documents/xml-subtree-codec";
import type { LibraryStructuralEditResult } from "../../../../shared/library-module";
import type { applyLibraryModule } from "../../../lib/api";
import { publishDocumentHistoryFence } from "../../../lib/document-history-fence";
import { createNfmEditorModeOptions } from "./nfm-editor-source";
import { prepareNfmEditorForMutation } from "./nfm-editor-relocation";
import { NfmStructuralEditingSession } from "./nfm-structural-editing-extension";
import { availableHistoryReconciliation } from "./testing/nfm-history-reconciliation";

const settle = async () =>
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

test("semantic Undo and Redo restore the original inline selections after address replacement and remount", async () => {
  const { document: doc } = createPageDocumentGenesis({
    documentId: "selection-history",
    nfm: "abcdef",
    allocateBlockId: () => "paragraph",
  });
  const body = doc.getXmlFragment("body");
  const group = body.get(0) as Y.XmlElement;
  const editor = BlockNoteEditor.create(
    createNfmEditorModeOptions({
      kind: "collaborative-document",
      documentId: doc.guid,
      storeEpoch: "epoch:history",
      generation: 1,
      clientSessionId: "surface:selection",
      fragment: body,
      user: { name: "History", color: "#2563eb" },
    }),
  );
  const host = document.createElement("div");
  const otherControl = document.createElement("button");
  otherControl.textContent = "Other surface";
  document.body.append(host, otherControl);
  const errors: string[] = [];
  let calls = 0;
  let moveFocusDuringCommit = false;
  const apply: typeof applyLibraryModule = async (_scope, request) => {
    const releasing =
      request.operation.kind === "apply_structural_edit" &&
      (request.operation.command.kind === "release_history" ||
        request.operation.command.kind === "set_local_history_retention");
    if (!releasing) {
      calls++;
      const text = ((group.get(0) as Y.XmlElement).get(0) as Y.XmlElement).get(0) as Y.XmlText;
      doc.transact(() => {
        text.delete(0, text.length);
        text.insert(0, calls % 2 === 1 ? "abcdef" : "abcXdef");
      }, "canonical-core");
      if (moveFocusDuringCommit) {
        otherControl.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
        otherControl.focus();
      }
    }
    const result: LibraryStructuralEditResult = {
      operationKind: "restore_editor_history",
      sourceRootBlockIds: ["paragraph"],
      resultRootBlockIds: ["paragraph"],
      copiedBlockIds: {},
      copiedDocumentIds: {},
      documentCommits: [],
      affectedPageIds: [],
      affectedDatabaseIds: [],
      clipboard: null,
      history: releasing
        ? null
        : {
            recipeOperationId: `recipe:${calls}`,
            recipeHash: "a".repeat(64),
            storeEpoch: "epoch:history",
          },
      supersededHistoryRecipeOperationIds: [],
      resume: null,
    };
    return {
      ok: true,
      localCommit: {
        status: "no_op",
        observed: { store_epoch: "epoch:history", commit_head: calls },
      },
      value: {
        operationId: request.operationId,
        profileId: "profile:history",
        storeEpoch: "epoch:history",
        libraryId: "library:history",
        operationKind: "apply_structural_edit",
        duplicate: false,
        didMutate: !releasing,
        createdTarget: null,
        canvasMutation: null,
        structuralEdit: result,
        affectedParentKeys: [],
        affectedPageIds: [],
        affectedDatabaseIds: [],
        affectedViewIds: [],
        committedRevisions: {},
        commitSeq: calls,
        committedAt: "2026-09-04T00:00:00.000Z",
      },
    };
  };
  const session = new NfmStructuralEditingSession({
    historyReconciliation: availableHistoryReconciliation,
    editor,
    apply,
    runtime: {
      accessContext: { kind: "library" },
      libraryId: "library:history",
      source: { documentId: doc.guid, generation: 1, storeEpoch: "epoch:history" },
      participant: {
        prepareAndFence: async () => {
          await prepareNfmEditorForMutation(editor, host);
          return {
            documentId: doc.guid,
            generation: 1,
            storeEpoch: "epoch:history",
            expectedHeadSeq: 1,
          };
        },
      },
      getContainer: () => host,
      onError: (error) => errors.push(error),
    },
  });
  try {
    await act(async () => {
      editor.mount(host);
      await settle();
      editor.setTextCursorPosition("paragraph", "start");
      const view = editor.prosemirrorView!;
      view.dispatch(
        view.state.tr.setSelection(
          TextSelection.create(view.state.doc, view.state.selection.from + 3),
        ),
      );
      view.dispatch(view.state.tr.insertText("X"));
      editor.getExtension<typeof YUndoExtension>("yUndo")!.undoManager.stopCapturing();
      const restored = cloneXmlSubtree(group.get(0) as Y.XmlElement);
      publishDocumentHistoryFence(doc, {
        headSeq: 1,
        blockIds: ["paragraph"],
        documentWide: false,
      });
      doc.transact(() => {
        group.delete(0, 1);
        group.insert(0, [restored]);
      }, "canonical-core");
      editor.unmount();
      editor.mount(host);
      await settle();
      editor.setTextCursorPosition("paragraph", "end");
      editor.focus();
      editor.undo();
      await session.whenIdle();
      await settle();
    });
    expect(errors).toEqual([]);
    expect(editor.getBlock("paragraph")?.content).toEqual([
      { type: "text", text: "abcdef", styles: {} },
    ]);
    expect(editor.prosemirrorView!.state.selection.$head.parentOffset).toBe(3);
    expect(editor.prosemirrorView!.hasFocus()).toBe(true);
    await act(async () => {
      editor.redo();
      await session.whenIdle();
      await settle();
    });
    expect(errors).toEqual([]);
    expect(editor.getBlock("paragraph")?.content).toEqual([
      { type: "text", text: "abcXdef", styles: {} },
    ]);
    expect(editor.prosemirrorView!.state.selection.$head.parentOffset).toBe(4);
    expect(editor.prosemirrorView!.hasFocus()).toBe(true);
    await act(async () => {
      moveFocusDuringCommit = true;
      editor.undo();
      await session.whenIdle();
      await settle();
    });
    expect(errors).toEqual([]);
    expect(editor.getBlock("paragraph")?.content).toEqual([
      { type: "text", text: "abcdef", styles: {} },
    ]);
    expect(document.activeElement).toBe(otherControl);
  } finally {
    await act(async () => {
      await session.close();
      editor.unmount();
      editor._tiptapEditor.destroy();
      await settle();
    });
    host.remove();
    otherControl.remove();
    doc.destroy();
  }
});
