import { BlockNoteEditor } from "@blocknote/core";
import type { YUndoExtension } from "@blocknote/core/yjs";
import { act } from "@testing-library/react";
import { expect, test } from "vite-plus/test";
import * as Y from "yjs";
import {
  createCanonicalEmptyParagraphBlock,
  createDetachedPageDocumentFromBlockTree,
} from "../../../../shared/block-documents/block-document-codec";
import { cloneXmlSubtree } from "../../../../shared/block-documents/xml-subtree-codec";
import type { LibraryStructuralEditResult } from "../../../../shared/library-module";
import type { applyLibraryModule } from "../../../lib/api";
import { publishDocumentHistoryFence } from "../../../lib/document-history-fence";
import {
  createInteractionHistory,
  type InteractionHistory,
} from "../../../lib/surface-history/owner";
import { createNfmEditorModeOptions } from "./nfm-editor-source";
import { prepareNfmEditorStructuralMutation } from "./nfm-editor-relocation";
import { NfmStructuralEditingSession } from "./nfm-structural-editing-extension";
import { nfmSchema } from "./nfm-schema";
import { availableHistoryReconciliation } from "./testing/nfm-history-reconciliation";

const content = (text: string) => [{ type: "text" as const, text, styles: {} }];
const settle = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
const receipt = (
  request: Parameters<typeof applyLibraryModule>[1],
  structuralEdit: LibraryStructuralEditResult | null = null,
): Awaited<ReturnType<typeof applyLibraryModule>> => ({
  ok: true,
  localCommit: { status: "no_op", observed: { store_epoch: "epoch:realm", commit_head: 1 } },
  value: {
    operationId: request.operationId,
    profileId: "profile:realm",
    storeEpoch: "epoch:realm",
    libraryId: "library:realm",
    operationKind: "apply_structural_edit",
    duplicate: false,
    didMutate: true,
    createdTarget: null,
    canvasMutation: null,
    structuralEdit,
    affectedParentKeys: [],
    affectedPageIds: [],
    affectedDatabaseIds: [],
    affectedViewIds: [],
    committedRevisions: {},
    commitSeq: 1,
    committedAt: "2026-09-06T00:00:00.000Z",
  },
});

function surface(history: InteractionHistory, name: string, apply?: typeof applyLibraryModule) {
  const { document: doc } = createDetachedPageDocumentFromBlockTree({
    documentId: `document:realm-${name}`,
    blockTree: [{ ...createCanonicalEmptyParagraphBlock("edited"), content: content("Seed") }],
  });
  const host = document.createElement("div");
  host.className = "nfm-editor";
  document.body.append(host);
  const editor = BlockNoteEditor.create(
    createNfmEditorModeOptions(
      {
        kind: "collaborative-document",
        documentId: doc.guid,
        storeEpoch: "epoch:realm",
        generation: 1,
        clientSessionId: `surface:${name}`,
        transactionOrigin: { surface: name },
        fragment: doc.getXmlFragment("body"),
        user: { name, color: "#2563eb" },
      },
      { schema: nfmSchema },
    ),
  );
  // Keep all three edits inside one native capture window. No test callback
  // invokes the history lane's pre-capture hook: YUndo must do that itself.
  editor.getExtension<typeof YUndoExtension>("yUndo")!.undoManager.captureTimeout = 60_000;
  const errors: string[] = [];
  let mounted = true;
  let fences = 0;
  const session = new NfmStructuralEditingSession({
    editor,
    interactionHistory: history,
    apply: apply ?? (async (_scope, request) => receipt(request)),
    historyReconciliation: availableHistoryReconciliation,
    runtime: {
      accessContext: { kind: "library" },
      libraryId: "library:realm",
      source: { documentId: doc.guid, storeEpoch: "epoch:realm", generation: 1 },
      participant: {
        prepareAndFence: (options) =>
          prepareNfmEditorStructuralMutation(
            editor,
            mounted ? host : null,
            {
              flushAndFence: async () => {
                fences++;
                return {
                  documentId: doc.guid,
                  storeEpoch: "epoch:realm",
                  generation: 1,
                  expectedHeadSeq: 1,
                };
              },
            },
            options,
          ),
      },
      getContainer: () => (mounted ? host : null),
      onError: (error) => errors.push(error),
    },
  });
  return {
    doc,
    host,
    editor,
    session,
    errors,
    get fences() {
      return fences;
    },
    hide() {
      mounted = false;
      editor.unmount();
      host.remove();
    },
    async close() {
      await session.close();
      editor._tiptapEditor.destroy();
      doc.destroy();
      host.remove();
    },
  };
}

test("actual YUndo delegates keep rapid interleaved Page edits in shared interaction order", async () => {
  const history = createInteractionHistory({ scopeKey: "realm" });
  const a = surface(history, "a");
  const b = surface(history, "b");
  try {
    await act(async () => {
      a.editor.mount(a.host);
      b.editor.mount(b.host);
      await settle();
      a.editor.setTextCursorPosition("edited", "end");
      a.editor.insertInlineContent(" A");
      b.editor.setTextCursorPosition("edited", "end");
      b.editor.insertInlineContent(" B");
      a.editor.setTextCursorPosition("edited", "end");
      a.editor.insertInlineContent(" C");
      await settle();
    });
    const undo = async () =>
      act(async () => {
        expect(b.editor.undo()).toBe(true);
        await history.whenIdle();
        await settle();
      });
    await undo();
    expect(a.editor.getBlock("edited")?.content).toEqual(content("Seed A"));
    expect(b.editor.getBlock("edited")?.content).toEqual(content("Seed B"));
    await undo();
    expect(b.editor.getBlock("edited")?.content).toEqual(content("Seed"));
    await undo();
    expect(a.editor.getBlock("edited")?.content).toEqual(content("Seed"));
    await act(async () => {
      const group = a.doc.getXmlFragment("body").get(0) as Y.XmlElement;
      const text = ((group.get(0) as Y.XmlElement).get(0) as Y.XmlElement).get(0) as Y.XmlText;
      a.doc.transact(() => text.insert(text.length, " remote"), { remote: true });
      expect(b.editor.undo()).toBe(true);
      await history.whenIdle();
      await settle();
    });
    expect(a.editor.getBlock("edited")?.content).toEqual(content("Seed remote"));
    expect(a.errors).toEqual([]);
    expect(b.errors).toEqual([]);
  } finally {
    await act(async () => {
      await a.close();
      await b.close();
    });
    history.close();
  }
});

test("shared Undo replays a hidden retained Page through its semantic Document fence", async () => {
  const history = createInteractionHistory({ scopeKey: "hidden-realm" });
  let semanticReplays = 0;
  const a = surface(history, "hidden", async (_scope, request) => {
    const operation = request.operation;
    if (
      operation.kind !== "apply_structural_edit" ||
      operation.command.kind !== "restore_editor_history"
    )
      return receipt(request);
    semanticReplays++;
    expect(operation.command.patch.changes).toHaveLength(1);
    const group = a.doc.getXmlFragment("body").get(0) as Y.XmlElement;
    const text = ((group.get(0) as Y.XmlElement).get(0) as Y.XmlElement).get(0) as Y.XmlText;
    a.doc.transact(
      () => {
        text.delete(0, text.length);
        text.insert(0, "Seed");
      },
      { core: true },
    );
    return receipt(request, {
      operationKind: "reverse_structural_edit",
      sourceRootBlockIds: [],
      resultRootBlockIds: [],
      copiedBlockIds: {},
      copiedDocumentIds: {},
      documentCommits: [],
      affectedPageIds: [],
      affectedDatabaseIds: [],
      clipboard: null,
      history: {
        recipeOperationId: "redo-hidden",
        recipeHash: "a".repeat(64),
        storeEpoch: "epoch:realm",
      },
      supersededHistoryRecipeOperationIds: [],
      resume: null,
    });
  });
  const b = surface(history, "visible");
  try {
    await act(async () => {
      a.editor.mount(a.host);
      b.editor.mount(b.host);
      await settle();
      a.editor.updateBlock("edited", { content: "Seed A" });
      const group = a.doc.getXmlFragment("body").get(0) as Y.XmlElement;
      const replacement = cloneXmlSubtree(group.get(0));
      publishDocumentHistoryFence(a.doc, { headSeq: 1, blockIds: ["edited"], documentWide: false });
      a.doc.transact(
        () => {
          group.delete(0, 1);
          group.insert(0, [replacement]);
        },
        { core: true },
      );
      await settle();
      a.hide();
      b.editor.focus();
      expect(b.editor.undo()).toBe(true);
      await history.whenIdle();
      await settle();
    });
    expect(semanticReplays).toBe(1);
    expect(a.fences).toBe(1);
    const group = a.doc.getXmlFragment("body").get(0) as Y.XmlElement;
    const restoredText = ((group.get(0) as Y.XmlElement).get(0) as Y.XmlElement).get(
      0,
    ) as Y.XmlText;
    expect(restoredText.toString()).toBe("Seed");
    expect(document.activeElement).toBe(b.editor.prosemirrorView!.dom);
    expect(a.errors).toEqual([]);
    expect(b.errors).toEqual([]);
  } finally {
    await act(async () => {
      await a.close();
      await b.close();
    });
    history.close();
  }
});

test("foreign history fences preserve the invoking editor focus without overriding a later choice", async () => {
  const history = createInteractionHistory({ scopeKey: "foreign-focus" });
  const source = surface(history, "foreign-focus-source");
  const other = document.createElement("button");
  other.textContent = "Another action";
  document.body.append(other);
  let value = true;
  let pause: Promise<void> | undefined;
  let enteredFence: (() => void) | undefined;
  const foreign = history.bind<"move", never, boolean, boolean>({
    adapter: {
      describe: () => "Move Blocks",
      prepare: async () => {
        throw new Error("This fixture records an already committed move.");
      },
      prepareInverse: async (next) => {
        await prepareNfmEditorStructuralMutation(source.editor, source.host, {
          flushAndFence: async () => {
            enteredFence?.();
            await pause;
            return {
              documentId: source.doc.guid,
              storeEpoch: "epoch:realm",
              generation: 1,
              expectedHeadSeq: 1,
            };
          },
        });
        value = next;
        return { kind: "complete", receipt: next };
      },
      submit: async () => {
        throw new Error("The fixture has no remote request.");
      },
      interpret: (current) => ({ kind: "reversible", inverse: !current }),
    },
  });
  try {
    await act(async () => {
      source.editor.mount(source.host);
      await settle();
      foreign.capture("move", true);
      source.editor.focus();
      source.editor.prosemirrorView!.dom.blur();
      expect(document.activeElement).toBe(document.body);
      expect(source.editor.undo()).toBe(true);
      await history.whenIdle();
      await settle();
    });
    expect(value).toBe(false);
    expect(document.activeElement).toBe(source.editor.prosemirrorView!.dom);
    await act(async () => {
      expect(source.editor.redo()).toBe(true);
      await history.whenIdle();
      await settle();
    });
    expect(value).toBe(true);
    expect(document.activeElement).toBe(source.editor.prosemirrorView!.dom);

    let releaseFence: () => void = () => undefined;
    pause = new Promise<void>((resolve) => {
      releaseFence = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      enteredFence = resolve;
    });
    await act(async () => {
      try {
        expect(source.editor.undo()).toBe(true);
        await entered;
        other.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
        other.focus();
      } finally {
        releaseFence();
      }
      await history.whenIdle();
      await settle();
    });
    expect(value).toBe(false);
    expect(document.activeElement).toBe(other);
    expect(source.errors).toEqual([]);
  } finally {
    foreign.close();
    await act(async () => {
      await source.close();
    });
    history.close();
    other.remove();
  }
});
