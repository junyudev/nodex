import { BlockNoteEditor } from "@blocknote/core";
import { NodeSelection, TextSelection } from "@tiptap/pm/state";
import { act, fireEvent } from "@testing-library/react";
import { describe, expect, test } from "vite-plus/test";
import * as Y from "yjs";

import { createPageDocumentGenesis } from "../../../../shared/block-documents/block-document-codec";
import {
  resolveTypedOwnerDocumentChanges,
  type TypedOwnerDocumentChangeDecision,
} from "../../../lib/typed-owner-blocks";
import { createNfmEditorModeOptions } from "./nfm-editor-source";
import {
  prepareNfmEditorForMutation,
  runNfmEditorFocusPreservingMutation,
} from "./nfm-editor-relocation";
import { nfmSchema } from "./nfm-schema";
import { splitBlockTr } from "../../../../../third_party/blocknote/packages/core/src/api/blockManipulation/commands/splitBlock/splitBlock.js";

const settleEditor = async () => {
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  await Promise.resolve();
};

type BlockedDecision = Exclude<TypedOwnerDocumentChangeDecision, { readonly kind: "allow" }>;

describe("typed owner transaction guard in Chromium", () => {
  test("allows Enter to split rich inline text without treating a later owner as crossed", async () => {
    const editor = BlockNoteEditor.create({
      schema: nfmSchema,
      headless: true,
      initialContent: [
        {
          id: "text",
          type: "paragraph",
          content: [
            "Review ",
            { type: "pageMention", props: { targetPageId: "mentioned-page" } },
            " tomorrow",
          ],
        },
        { id: "page-after", type: "page" },
      ],
    });
    const text = editor.getBlock("text");
    if (!text) throw new Error("Expected the fixture paragraph");
    const blocked: BlockedDecision[] = [];
    const releaseGuard = editor.onBeforeChange(({ getChanges }) => {
      const changes = getChanges();
      const decision = resolveTypedOwnerDocumentChanges(changes);
      if (decision.kind === "allow") return;
      blocked.push(decision);
      return false;
    });

    try {
      const split = editor.transact((transaction) => {
        let paragraphEnd: number | undefined;
        transaction.doc.descendants((node, position) => {
          if (paragraphEnd !== undefined || node.type.name !== "paragraph") return true;
          paragraphEnd = position + 1 + node.content.size;
          return false;
        });
        if (paragraphEnd === undefined) throw new Error("Expected paragraph content");
        transaction.setSelection(TextSelection.create(transaction.doc, paragraphEnd));
        return splitBlockTr(transaction, paragraphEnd);
      });
      await act(settleEditor);

      expect(blocked).toEqual([]);
      expect(split).toBe(true);
      expect(editor.document.map(({ type }) => type)).toEqual(["paragraph", "paragraph", "page"]);
    } finally {
      releaseGuard();
      editor._tiptapEditor.destroy();
    }
  });

  test("intercepts every local Page deletion shape while accepting lifecycle delivery", async () => {
    const genesis = createPageDocumentGenesis({
      documentId: "document:typed-owner-guard",
      title: "Typed owner guard",
      markdown: "Editable paragraph",
      allocateBlockId: () => "text",
    });
    const localDocument = genesis.document;
    const remoteDocument = new Y.Doc({ guid: localDocument.guid });
    Y.applyUpdate(remoteDocument, Y.encodeStateAsUpdate(localDocument));
    const createEditor = (document: Y.Doc, clientSessionId: string) =>
      BlockNoteEditor.create({
        schema: nfmSchema,
        ...createNfmEditorModeOptions({
          kind: "collaborative-document",
          documentId: document.guid,
          storeEpoch: "epoch:typed-owner-guard",
          generation: 1,
          clientSessionId,
          fragment: document.getXmlFragment("body"),
          user: { name: clientSessionId, color: "#2563eb" },
        }),
      });
    const local = createEditor(localDocument, "surface:local");
    const remote = createEditor(remoteDocument, "surface:core-delivery");
    const localHost = document.createElement("div");
    const remoteHost = document.createElement("div");
    document.body.append(localHost, remoteHost);
    local.mount(localHost);
    remote.mount(remoteHost);
    const localView = local.prosemirrorView;
    if (!localView) throw new Error("Expected a mounted local editor view");
    const blocked: BlockedDecision[] = [];
    const releaseGuard = local.onBeforeChange(({ getChanges }) => {
      const decision = resolveTypedOwnerDocumentChanges(getChanges());
      if (decision.kind === "allow") return;
      blocked.push(decision);
      return false;
    });
    const relayRemoteUpdate = (update: Uint8Array) => Y.applyUpdate(localDocument, update);
    remoteDocument.on("update", relayRemoteUpdate);

    try {
      await act(settleEditor);
      const remoteText = remote.getBlock("text");
      if (!remoteText) throw new Error("Expected the fixture paragraph");
      await act(async () => {
        remote.insertBlocks([{ id: "page-before", type: "page" }], remoteText, "before");
        await settleEditor();
      });
      expect(local.getBlock("page-before")?.type).toBe("page");

      await act(async () => {
        local.setTextCursorPosition("text", "start");
        fireEvent.keyDown(localView.dom, { key: "Tab", code: "Tab" });
        await settleEditor();
      });
      expect(local.getParentBlock("text")).toBeUndefined();
      expect(blocked).toHaveLength(0);

      await act(async () => {
        const blockedBeforeBackspace = blocked.length;
        local.setTextCursorPosition("text", "start");
        fireEvent.keyDown(localView.dom, { key: "Backspace", code: "Backspace" });
        await settleEditor();
        expect(blocked).toHaveLength(blockedBeforeBackspace);
      });
      expect(local.getBlock("page-before")?.type).toBe("page");

      await act(async () => {
        local.setTextCursorPosition("text", "start");
        local.moveBlocksUp();
        await settleEditor();
      });
      expect(local.document.map(({ id }) => id)).toEqual(["page-before", "text"]);
      expect(blocked.at(-1)).toEqual({
        kind: "forbidden",
        reason: "generic_typed_owner_mutation",
      });

      await act(async () => {
        local.setTextCursorPosition("page-before");
        local.focus();
        expect(local.prosemirrorState.selection).toBeInstanceOf(NodeSelection);
        expect(localView.hasFocus()).toBe(true);
        fireEvent.keyDown(localView.dom, { key: "Backspace", code: "Backspace" });
        await settleEditor();
      });
      expect(local.getBlock("page-before")?.type).toBe("page");

      await act(async () => {
        local.removeBlocks(["page-before"]);
        await settleEditor();
      });
      expect(local.getBlock("page-before")?.type).toBe("page");

      await act(async () => {
        await runNfmEditorFocusPreservingMutation(local, localHost, async () => {
          await prepareNfmEditorForMutation(local, localHost);
          expect(localView.hasFocus()).toBe(false);
          remote.removeBlocks(["page-before"]);
          await settleEditor();
        });
      });
      expect(local.getBlock("page-before")).toBeUndefined();
      expect(local.prosemirrorState.selection).not.toBeInstanceOf(NodeSelection);
      expect(local.getTextCursorPosition().block.id).toBe("text");
      expect(localView.hasFocus()).toBe(true);

      const currentRemoteText = remote.getBlock("text");
      if (!currentRemoteText) throw new Error("Expected the surviving fixture paragraph");
      await act(async () => {
        remote.insertBlocks([{ id: "page-after", type: "page" }], currentRemoteText, "after");
        await settleEditor();
        local.setTextCursorPosition("text", "start");
        local.moveBlocksDown();
        await settleEditor();
      });
      expect(local.document.map(({ id }) => id)).toEqual(["text", "page-after"]);
      expect(blocked.at(-1)).toEqual({
        kind: "forbidden",
        reason: "generic_typed_owner_mutation",
      });

      await act(async () => {
        local.setTextCursorPosition("text", "end");
        fireEvent.keyDown(localView.dom, { key: "Delete", code: "Delete" });
        await settleEditor();
      });
      expect(local.getBlock("page-after")?.type).toBe("page");
      expect(blocked.every((decision) => decision.kind === "forbidden")).toBe(true);
    } finally {
      remoteDocument.off("update", relayRemoteUpdate);
      releaseGuard();
      local.unmount();
      remote.unmount();
      localHost.remove();
      remoteHost.remove();
      local._tiptapEditor.destroy();
      remote._tiptapEditor.destroy();
      localDocument.destroy();
      remoteDocument.destroy();
    }
  });
});
