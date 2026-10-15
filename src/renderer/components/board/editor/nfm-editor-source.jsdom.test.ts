import { describe, expect, test } from "vite-plus/test";
import { BlockNoteEditor } from "@blocknote/core";
import * as Y from "yjs";

import {
  createPageDocumentGenesis,
  materializePageDocument,
} from "../../../../shared/block-documents/block-document-codec";
import { scanBlockDocument } from "../../../../shared/block-documents/block-structure";
import {
  createNfmEditorCollaborationOptions,
  createNfmEditorModeOptions,
  getNfmEditorInstanceKey,
  resolveNfmEditorBlockActionCapabilities,
  type NfmEditorCollaborativeDocumentSource,
} from "./nfm-editor-source";
import { createPageCreateDescriptionDraft } from "@/lib/page-create-draft";
import { projectContentRoute } from "../../../../shared/content-routing-context";

function createCollaborativeSource(
  fragment: Y.XmlFragment,
  onDocumentChange?: () => void,
): NfmEditorCollaborativeDocumentSource {
  return {
    kind: "collaborative-document",
    documentId: fragment.doc?.guid ?? "document-1",
    storeEpoch: "store-1",
    generation: 1,
    clientSessionId: "surface-1",
    fragment,
    user: { name: "Local editor", color: "#2563eb" },
    onDocumentChange,
  };
}

describe("NfmEditor source boundary", () => {
  test("builds extension-backed collaboration options with stable surface identity", () => {
    const document = new Y.Doc({ guid: "document-1" });
    const fragment = document.getXmlFragment("body");
    const source = createCollaborativeSource(fragment);
    const collaboration = createNfmEditorCollaborationOptions(source);
    const modeOptions = createNfmEditorModeOptions(source);

    expect(collaboration.fragment).toBe(fragment);
    expect(collaboration.user.name).toBe("Local editor");
    expect(modeOptions.disableExtensions).toContain("history");
    expect(modeOptions.initialContent).toEqual([{ type: "paragraph", id: "initialBlockId" }]);
    expect(createNfmEditorCollaborationOptions(source).transactionOrigin).toBe(
      collaboration.transactionOrigin,
    );
    expect(
      createNfmEditorCollaborationOptions({
        ...source,
        clientSessionId: "surface-2",
      }).transactionOrigin,
    ).not.toBe(collaboration.transactionOrigin);

    document.destroy();
  });

  test("enables stable-ID Move To for collaborative Page documents", () => {
    const document = new Y.Doc();
    const collaborative = resolveNfmEditorBlockActionCapabilities(true, "project-1");
    const withoutCardContext = resolveNfmEditorBlockActionCapabilities(false, "project-1");
    const withoutProjectAuthority = resolveNfmEditorBlockActionCapabilities(true, null);

    expect(collaborative.canMoveBlocks).toBe(true);
    expect(collaborative.canSendBlocksToThread).toBe(true);
    expect(withoutCardContext.canMoveBlocks).toBe(false);
    expect(withoutCardContext.canSendBlocksToThread).toBe(false);
    expect(withoutProjectAuthority.canMoveBlocks).toBe(false);
    expect(withoutProjectAuthority.canSendBlocksToThread).toBe(false);
    document.destroy();
  });

  test("uses source identity keys so document switches recreate instead of rehydrating", () => {
    const firstDocument = new Y.Doc({ guid: "document-1" });
    const secondDocument = new Y.Doc({ guid: "document-2" });
    const firstSource = createCollaborativeSource(firstDocument.getXmlFragment("body"));
    const sameSourceKey = getNfmEditorInstanceKey({
      routingContext: projectContentRoute("project-1"),
      source: firstSource,
    });
    const repeatedSourceKey = getNfmEditorInstanceKey({
      routingContext: projectContentRoute("project-1"),
      source: firstSource,
    });
    const switchedSourceKey = getNfmEditorInstanceKey({
      routingContext: projectContentRoute("project-1"),
      source: createCollaborativeSource(secondDocument.getXmlFragment("body")),
    });

    expect(repeatedSourceKey).toBe(sameSourceKey);
    expect(switchedSourceKey === sameSourceKey).toBe(false);

    firstDocument.destroy();
    secondDocument.destroy();
  });

  test("does not replace blocks for a remote collaborative update", async () => {
    const document = new Y.Doc({ guid: "document-1" });
    const genesis = createPageDocumentGenesis({
      documentId: "document-1-genesis",
      title: "Collaborative Card",
      nfm: "",
      allocateBlockId: () => "block-collaborative-root",
    });
    Y.applyUpdate(document, genesis.update);
    genesis.document.destroy();
    const fragment = document.getXmlFragment("body");
    let hintCount = 0;
    let replaceBlocksCount = 0;
    const source = createCollaborativeSource(fragment, () => {
      hintCount += 1;
    });
    const localOptions = createNfmEditorModeOptions(source);
    const remoteOptions = createNfmEditorModeOptions({
      ...source,
      user: { name: "Remote editor", color: "#dc2626" },
    });
    const localEditor = BlockNoteEditor.create(localOptions);
    const remoteEditor = BlockNoteEditor.create(remoteOptions);
    const localElement = globalThis.document.createElement("div");
    const remoteElement = globalThis.document.createElement("div");

    localEditor.mount(localElement);
    remoteEditor.mount(remoteElement);

    const replaceBlocks = localEditor.replaceBlocks.bind(localEditor);
    localEditor.replaceBlocks = ((...args: Parameters<typeof localEditor.replaceBlocks>) => {
      replaceBlocksCount += 1;
      return replaceBlocks(...args);
    }) as typeof localEditor.replaceBlocks;
    const unsubscribe = localEditor.onChange(() => {
      source.onDocumentChange?.();
    });

    const remoteBlock = remoteEditor.document[0];
    if (!remoteBlock) throw new Error("Expected the collaborative genesis block");
    remoteEditor.updateBlock(remoteBlock, { content: "Remote update" });
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(hintCount > 0).toBe(true);
    expect(replaceBlocksCount).toBe(0);

    unsubscribe();
    localEditor.unmount();
    remoteEditor.unmount();
    document.destroy();
  });

  test("mounts a title-only Card without inventing a placeholder identity", () => {
    const genesis = createPageDocumentGenesis({
      documentId: "document-title-only",
      title: "Title only",
      nfm: "",
      allocateBlockId: () => "block-title-only-root",
    });
    const source = createCollaborativeSource(genesis.document.getXmlFragment("body"));
    const editor = BlockNoteEditor.create(createNfmEditorModeOptions(source));
    const element = globalThis.document.createElement("div");

    editor.mount(element);

    expect(editor.document).toMatchObject([{ id: "block-title-only-root", type: "paragraph" }]);
    expect(materializePageDocument(genesis.document).blockTree).toMatchObject([
      { id: "block-title-only-root", type: "paragraph" },
    ]);
    expect(
      materializePageDocument(genesis.document).blockTree.some(
        (block) => block.id === "initialBlockId",
      ),
    ).toBe(false);

    editor.unmount();
    genesis.document.destroy();
  });

  test("mounts a blank Page-create draft without inventing a placeholder identity", () => {
    const draft = createPageCreateDescriptionDraft("request-editor-empty");
    const editor = BlockNoteEditor.create(
      createNfmEditorModeOptions(createCollaborativeSource(draft.body)),
    );
    const element = globalThis.document.createElement("div");

    editor.mount(element);

    expect(editor.document).toHaveLength(1);
    expect(editor.document[0]?.id).not.toBe("initialBlockId");
    expect(() => editor.focus()).not.toThrow();
    expect(scanBlockDocument(draft.body).issues).toEqual([]);
    expect(() => materializePageDocument(draft.document)).not.toThrow();

    editor.unmount();
    draft.document.destroy();
  });

  test("preserves long-Card identities across collaboration-origin rerenders", async () => {
    let nextBlockId = 0;
    const genesis = createPageDocumentGenesis({
      documentId: "document-long-collaborative",
      title: "Long collaborative Card",
      nfm: Array.from(
        { length: 96 },
        (_, index) =>
          `Paragraph ${index + 1} has enough content to exercise a full collaborative render.`,
      ).join("\n\n"),
      allocateBlockId: () => `block-long-${++nextBlockId}`,
    });
    const before = materializePageDocument(genesis.document).blockTree.map((block) => block.id);
    const localEditor = BlockNoteEditor.create(
      createNfmEditorModeOptions(
        createCollaborativeSource(genesis.document.getXmlFragment("body")),
      ),
    );
    localEditor.mount(globalThis.document.createElement("div"));
    await new Promise((resolve) => setTimeout(resolve, 10));

    const updates: Uint8Array[] = [];
    const collectUpdate = (update: Uint8Array) => updates.push(update);
    genesis.document.on("update", collectUpdate);
    const ySyncPlugin = localEditor.prosemirrorState.plugins.find((plugin) =>
      (plugin as unknown as { readonly key: string }).key.startsWith("y-sync$"),
    );
    if (!ySyncPlugin) throw new Error("Expected the Yjs sync plugin");
    const ySyncPluginKey = ySyncPlugin.spec.key;
    if (!ySyncPluginKey) throw new Error("Expected the Yjs sync plugin key");
    let middleBlockPosition: number | undefined;
    localEditor.prosemirrorState.doc.descendants((node, position) => {
      if (middleBlockPosition !== undefined) return false;
      if (node.type.name !== "blockContainer") return true;
      if (node.attrs.id !== before[48]) return false;
      middleBlockPosition = position;
      return false;
    });
    if (middleBlockPosition === undefined) {
      throw new Error("Expected a middle ProseMirror block");
    }
    const stableMiddleBlockPosition = middleBlockPosition;
    const middleBlock = localEditor.prosemirrorState.doc.nodeAt(stableMiddleBlockPosition);
    if (!middleBlock) throw new Error("Expected a middle ProseMirror node");
    const syncState = ySyncPlugin.getState(localEditor.prosemirrorState) as {
      readonly binding: {
        readonly mux: (operation: () => void) => void;
        readonly _forceRerender: () => void;
      };
    };
    syncState.binding.mux(() => {
      const view = localEditor.prosemirrorView;
      if (!view) throw new Error("Expected a mounted editor view");
      view.dispatch(
        localEditor.prosemirrorState.tr
          .setNodeMarkup(stableMiddleBlockPosition, undefined, {
            ...middleBlock.attrs,
            id: null,
          })
          .setMeta(ySyncPluginKey, { isChangeOrigin: true }),
      );
    });
    expect(localEditor.prosemirrorState.doc.nodeAt(stableMiddleBlockPosition)?.attrs.id).toBeNull();
    syncState.binding._forceRerender();
    await new Promise((resolve) => setTimeout(resolve, 10));

    const after = materializePageDocument(genesis.document).blockTree.map((block) => block.id);
    expect(after).toEqual(before);
    expect(updates).toHaveLength(0);

    localEditor.unmount();
    genesis.document.off("update", collectUpdate);
    genesis.document.destroy();
  });
});
