import { BlockNoteEditor } from "@blocknote/core";
import { act } from "@testing-library/react";
import { expect, test } from "vite-plus/test";
import * as Y from "yjs";

import {
  createCanonicalEmptyParagraphBlock,
  createDetachedPageDocumentFromBlockTree,
  createPageDocumentGenesis,
} from "../../../../shared/block-documents/block-document-codec";
import { cloneXmlSubtree } from "../../../../shared/block-documents/xml-subtree-codec";
import type {
  LibraryStructuralEditResult,
  LibraryModuleApplyResult,
} from "../../../../shared/library-module";
import type { applyLibraryModule } from "../../../lib/api";
import { createNfmEditorModeOptions } from "./nfm-editor-source";
import { NfmStructuralEditingSession } from "./nfm-structural-editing-extension";
import { availableHistoryReconciliation } from "./testing/nfm-history-reconciliation";
import { ownsNfmEditorEvent } from "./nfm-editor-event-owner";
import { publishDocumentHistoryFence } from "../../../lib/document-history-fence";
import { nfmSchema } from "./nfm-schema";

const structuralResult = (id: string): LibraryStructuralEditResult => ({
  operationKind: "reverse_structural_edit",
  sourceRootBlockIds: [],
  resultRootBlockIds: [],
  copiedBlockIds: {},
  copiedDocumentIds: {},
  documentCommits: [],
  affectedPageIds: [],
  affectedDatabaseIds: [],
  clipboard: null,
  history: { recipeOperationId: id, recipeHash: "a".repeat(64), storeEpoch: "epoch:history" },
  supersededHistoryRecipeOperationIds: [],
  resume: null,
});
const libraryReceipt = (
  request: Parameters<typeof applyLibraryModule>[1],
  structuralEdit: LibraryStructuralEditResult | null,
): LibraryModuleApplyResult => {
  return {
    ok: true,
    localCommit: { status: "no_op", observed: { store_epoch: "epoch:history", commit_head: 1 } },
    value: {
      operationId: request.operationId,
      profileId: "profile:history",
      storeEpoch: "epoch:history",
      libraryId: "library:history",
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
      committedAt: "2026-09-04T00:00:00.000Z",
    },
  };
};

const settle = async () => {
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
};

test("two surfaces sharing one Y.Doc preserve independent text history after structural restoration", async () => {
  const textContent = (text: string) => [{ type: "text", text, styles: {} }];
  const { document: doc } = createDetachedPageDocumentFromBlockTree({
    documentId: "document:shared-surface-history",
    blockTree: [
      {
        ...createCanonicalEmptyParagraphBlock("edited"),
        content: textContent("Before"),
        children: [{ id: "owned-page", type: "page", props: {}, children: [] }],
      },
      { ...createCanonicalEmptyParagraphBlock("independent"), content: textContent("Independent") },
    ],
  });
  // These editors share this exact in-memory fragment, not synchronized replicas.
  const fragment = doc.getXmlFragment("body");
  const group = fragment.get(0) as Y.XmlElement;
  const canonicalOrigin = Object.freeze({ kind: "canonical-core-delivery" });
  let deletedSubtree: ReturnType<typeof cloneXmlSubtree> | undefined;
  let commitHead = 0;
  let semanticUndos = 0;
  const errors: string[] = [];
  const setEditedText = (value: string) => {
    const container = group.get(0) as Y.XmlElement;
    const text = (container.get(0) as Y.XmlElement).get(0) as Y.XmlText;
    doc.transact(() => {
      text.delete(0, text.length);
      text.insert(0, value);
    }, canonicalOrigin);
  };
  // Only the Core transport is a fixture. Both sessions, history owners, Yjs
  // managers, journals and semantic-address recovery remain production code.
  const apply: typeof applyLibraryModule = async (_scope, request) => {
    const operation = request.operation;
    if (operation.kind === "apply_structural_edit") {
      const command = operation.command;
      if (command.kind === "release_history" || command.kind === "set_local_history_retention")
        return libraryReceipt(request, null);
      if (command.kind === "delete_selection") {
        expect(command.selection.rootBlockIds).toEqual(["edited"]);
        deletedSubtree = cloneXmlSubtree(group.get(0));
        publishDocumentHistoryFence(doc, {
          headSeq: ++commitHead,
          blockIds: ["edited", "owned-page"],
          documentWide: false,
        });
        doc.transact(() => group.delete(0, 1), canonicalOrigin);
        return libraryReceipt(request, structuralResult("restore-shared-subtree"));
      }
      if (command.kind === "restore_editor_history") {
        expect(command.documentId).toBe(doc.guid);
        expect(
          command.patch.changes.map(({ blockId, before, after }) => ({
            blockId,
            before: before?.content,
            after: after?.content,
          })),
        ).toEqual([
          { blockId: "edited", before: textContent("Before"), after: textContent("Before A") },
        ]);
        semanticUndos++;
        setEditedText("Before");
        return libraryReceipt(request, structuralResult("redo-shared-text"));
      }
    }
    if (operation.kind === "reverse_structural_edit") {
      if (operation.token.recipeOperationId === "restore-shared-subtree") {
        if (!deletedSubtree) throw new Error("The structural deletion was not captured.");
        publishDocumentHistoryFence(doc, {
          headSeq: ++commitHead,
          blockIds: ["edited", "owned-page"],
          documentWide: false,
        });
        doc.transact(() => group.insert(0, [deletedSubtree!]), canonicalOrigin);
        return libraryReceipt(request, structuralResult("delete-shared-subtree"));
      }
      if (operation.token.recipeOperationId === "redo-shared-text") {
        setEditedText("Before A");
        return libraryReceipt(request, structuralResult("undo-shared-text"));
      }
    }
    throw new Error(`Unexpected history request: ${JSON.stringify(operation)}`);
  };
  const surfaces = ["A", "B"].map((name) => {
    const host = document.createElement("div");
    host.className = "nfm-editor";
    document.body.append(host);
    const editor = BlockNoteEditor.create(
      createNfmEditorModeOptions(
        {
          kind: "collaborative-document",
          documentId: doc.guid,
          storeEpoch: "epoch:history",
          generation: 1,
          clientSessionId: `surface:shared-${name}`,
          transactionOrigin: Object.freeze({ surface: name }),
          fragment,
          user: { name, color: "#2563eb" },
        },
        { schema: nfmSchema },
      ),
    );
    const session = new NfmStructuralEditingSession({
      editor,
      apply,
      historyReconciliation: availableHistoryReconciliation,
      runtime: {
        accessContext: { kind: "library" },
        libraryId: "library:history",
        source: { documentId: doc.guid, storeEpoch: "epoch:history", generation: 1 },
        participant: {
          prepareAndFence: async () => ({
            documentId: doc.guid,
            storeEpoch: "epoch:history",
            generation: 1,
            expectedHeadSeq: commitHead,
          }),
        },
        getContainer: () => host,
        onError: (error) => errors.push(error),
      },
    });
    return { host, editor, session };
  });
  const [a, b] = surfaces;
  try {
    await act(async () => {
      for (const surface of surfaces) surface.editor.mount(surface.host);
      await settle();
      a.editor.updateBlock("edited", { content: "Before A" });
      a.session.stopCapturing();
      b.editor.updateBlock("independent", { content: "Independent B" });
      b.session.stopCapturing();
      await settle();
    });
    expect(a.editor.getBlock("independent")?.content).toEqual(textContent("Independent B"));
    expect(b.editor.getBlock("edited")?.content).toEqual(textContent("Before A"));
    await act(async () => {
      expect(b.session.deleteBlocks(["edited"], "backward")).toBe(true);
      await b.session.whenIdle();
      await settle();
    });
    for (const { editor } of surfaces) {
      expect(editor.getBlock("edited")).toBeUndefined();
      expect(editor.getBlock("owned-page")).toBeUndefined();
    }
    await act(async () => {
      expect(b.editor.undo()).toBe(true);
      await b.session.whenIdle();
      await settle();
    });
    for (const { editor } of surfaces) {
      expect(editor.getBlock("edited")?.content).toEqual(textContent("Before A"));
      expect(editor.getBlock("owned-page")?.type).toBe("page");
    }
    await act(async () => {
      expect(a.editor.undo()).toBe(true);
      await a.session.whenIdle();
      await settle();
    });
    expect(semanticUndos).toBe(1);
    for (const { editor } of surfaces) {
      expect(editor.getBlock("edited")?.content).toEqual(textContent("Before"));
      expect(editor.getBlock("independent")?.content).toEqual(textContent("Independent B"));
    }
    await act(async () => {
      expect(a.session.historyControls.snapshot().undo.acceptsIntent).toBe(false);
      expect(a.editor.redo()).toBe(true);
      await a.session.whenIdle();
      await settle();
      expect(b.editor.undo()).toBe(true);
      await b.session.whenIdle();
      await settle();
    });
    for (const { editor } of surfaces) {
      expect(editor.getBlock("edited")?.content).toEqual(textContent("Before A"));
      expect(editor.getBlock("independent")?.content).toEqual(textContent("Independent"));
      expect(editor.getBlock("owned-page")?.type).toBe("page");
    }
    expect(errors).toEqual([]);
  } finally {
    await act(async () => {
      for (const { session, editor } of surfaces) {
        await session.close();
        editor.unmount();
        editor._tiptapEditor.destroy();
      }
      await settle();
    });
    for (const { host } of surfaces) host.remove();
    doc.destroy();
  }
});

test("a surface created before mount undoes later text before structure through DOM and editor commands", async () => {
  const { document: doc } = createPageDocumentGenesis({
    documentId: "document:surface-history",
    title: "History",
    nfm: "",
    allocateBlockId: () => "block:paragraph",
  });
  const editor = BlockNoteEditor.create(
    createNfmEditorModeOptions({
      kind: "collaborative-document",
      documentId: doc.guid,
      storeEpoch: "epoch:history",
      generation: 1,
      clientSessionId: "surface:history",
      fragment: doc.getXmlFragment("body"),
      user: { name: "History", color: "#2563eb" },
    }),
  );
  const host = document.createElement("div");
  host.className = "nfm-editor";
  document.body.append(host);
  const reversed: string[] = [];
  const apply: typeof applyLibraryModule = async (_context, request) => {
    if (request.operation.kind === "reverse_structural_edit") {
      reversed.push(request.operation.token.recipeOperationId);
    }
    return libraryReceipt(
      request,
      structuralResult(
        request.operation.kind === "reverse_structural_edit"
          ? `inverse:${reversed.at(-1)}`
          : "cut:A",
      ),
    );
  };
  // Production attaches the retained session during render, before EditorView exists.
  const session = new NfmStructuralEditingSession({
    historyReconciliation: availableHistoryReconciliation,
    editor,
    apply,
    runtime: {
      accessContext: { kind: "library" },
      libraryId: "library:history",
      source: { documentId: doc.guid, storeEpoch: "epoch:history", generation: 1 },
      participant: {
        prepareAndFence: async () => ({
          documentId: doc.guid,
          storeEpoch: "epoch:history",
          generation: 1,
          expectedHeadSeq: 1,
        }),
      },
      getContainer: () => host,
    },
  });
  host.addEventListener(
    "keydown",
    (event) => {
      if (!ownsNfmEditorEvent(host, event.target)) return;
      if (!session.handleKeyDown(event)) return;
      event.preventDefault();
      event.stopPropagation();
    },
    true,
  );
  try {
    await act(async () => {
      editor.mount(host);
      await settle();
    });
    await act(async () => {
      const head = {
        documentId: doc.guid,
        storeEpoch: "epoch:history",
        generation: 1,
        expectedHeadSeq: 1,
      };
      await session.transferBlocks({
        mode: "move",
        rootBlockIds: ["block:paragraph"],
        prepareHeads: async () => ({ sourceHead: head, targetHead: head }),
        target: { parentBlockId: null, beforeBlockId: null },
      });
      editor.updateBlock("block:paragraph", { content: "B" });
      await settle();
      editor.unmount();
      editor.mount(host);
      await settle();
    });
    await act(async () => {
      editor.prosemirrorView!.dom.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "z",
          metaKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
      await settle();
    });
    expect(reversed).toEqual([]);
    expect(editor.getBlock("block:paragraph")?.content).toEqual([]);
    await act(async () => {
      expect(editor.undo()).toBe(true);
      await settle();
    });
    expect(reversed).toEqual(["cut:A"]);
    await act(async () => {
      expect(editor.redo()).toBe(true);
      await settle();
    });
    expect(reversed).toEqual(["cut:A", "inverse:cut:A"]);
    await act(async () => {
      expect(editor.redo()).toBe(true);
      await settle();
    });
    expect(editor.getBlock("block:paragraph")?.content).toEqual([
      { type: "text", text: "B", styles: {} },
    ]);
  } finally {
    await act(async () => {
      session.dispose();
      editor.unmount();
      editor._tiptapEditor.destroy();
      await settle();
    });
    host.remove();
    doc.destroy();
  }
});

test("portable fallback fills the reserved paste gesture even when Undo was queued before readiness", async () => {
  const { document: doc } = createPageDocumentGenesis({
    documentId: "portable-history",
    nfm: "",
    allocateBlockId: () => "paragraph",
  });
  const editor = BlockNoteEditor.create(
    createNfmEditorModeOptions({
      kind: "collaborative-document",
      documentId: doc.guid,
      storeEpoch: "epoch:history",
      generation: 1,
      clientSessionId: "surface:portable",
      fragment: doc.getXmlFragment("body"),
      user: { name: "History", color: "#2563eb" },
    }),
  );
  const host = document.createElement("div");
  document.body.append(host);
  let ready!: () => void;
  const readiness = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const mutations: unknown[] = [];
  const session = new NfmStructuralEditingSession({
    editor,
    historyReconciliation: availableHistoryReconciliation,
    runtime: {
      accessContext: { kind: "library" },
      libraryId: "library:history",
      source: { documentId: doc.guid, storeEpoch: "epoch:history", generation: 1 },
      participant: {
        prepareAndFence: async () => ({
          documentId: doc.guid,
          storeEpoch: "epoch:history",
          generation: 1,
          expectedHeadSeq: 1,
        }),
      },
      getContainer: () => host,
    },
    awaitClipboard: async () => {
      await readiness;
      return { kind: "portable_fallback", reason: "source_closed" };
    },
    apply: async (_scope, request) => {
      const operation = request.operation;
      if (
        operation.kind !== "apply_structural_edit" ||
        !["release_history", "set_local_history_retention"].includes(operation.command.kind)
      )
        mutations.push(operation);
      return libraryReceipt(request, null);
    },
  });
  try {
    await act(async () => {
      editor.mount(host);
      editor.updateBlock("paragraph", { content: "Earlier" });
      editor.setTextCursorPosition("paragraph", "end");
      await settle();
    });
    await act(async () => {
      expect(
        session.handleStructuralClaimPaste(
          {
            version: 1,
            phase: "preparing",
            writeClaim: "0199134e-cbb0-7000-8000-000000000001",
            actionHint: "copy",
          },
          [
            {
              id: "portable",
              type: "paragraph",
              props: {},
              content: [{ type: "text", text: "Pasted", styles: {} }],
              children: [],
            },
          ],
        ),
      ).toBe(true);
      expect(editor.undo()).toBe(true);
      ready();
      await session.whenIdle();
      await settle();
    });
    expect(editor.document).toHaveLength(1);
    expect(editor.getBlock("paragraph")?.content).toEqual([
      { type: "text", text: "Earlier", styles: {} },
    ]);
    await act(async () => {
      expect(editor.redo()).toBe(true);
      await session.whenIdle();
      await settle();
    });
    expect(editor.document).toHaveLength(2);
    expect(editor.document[1]?.content).toEqual([{ type: "text", text: "Pasted", styles: {} }]);
    await act(async () => {
      editor.undo();
      await session.whenIdle();
      editor.undo();
      await session.whenIdle();
      await settle();
    });
    expect(editor.document).toHaveLength(1);
    expect(editor.getBlock("paragraph")?.content).toEqual([]);
    expect(mutations).toEqual([]);
  } finally {
    ready();
    await act(async () => {
      await session.close();
      editor.unmount();
      editor._tiptapEditor.destroy();
      await settle();
    });
    host.remove();
    doc.destroy();
  }
});
