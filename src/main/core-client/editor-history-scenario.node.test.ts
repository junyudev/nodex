import { expect, test } from "vite-plus/test";
import * as Y from "yjs";

import { withCoreScenario } from "../../../scripts/scenarios/harness/core-scenario-harness";
import { DOCUMENT_SYNC_RECOVERY_SCENARIO_ID } from "../../../scripts/scenarios/scenarios/document-sync-recovery";
import { NfmHistoryLane } from "../../renderer/components/board/editor/nfm-editor-history";
import {
  canRetryNfmHistory,
  type NfmHistoryRequest,
} from "../../renderer/components/board/editor/nfm-history-command";
import { NfmTextHistoryJournal } from "../../renderer/components/board/editor/nfm-text-history-journal";
import { NfmLocalHistoryRetention } from "../../renderer/components/board/editor/nfm-local-history-retention";
import { publishDocumentHistoryFence } from "../../renderer/lib/document-history-fence";
import type {
  LibraryApplyOperation,
  LibraryStructuralEditResult,
} from "../../shared/library-module";
import { createUuidV7 } from "../../shared/uuid-v7";
import { materializePageDocument } from "../../shared/block-documents/block-document-codec";
import { cloneXmlSubtree } from "../../shared/block-documents/xml-subtree-codec";
import { createCoreDocumentSyncAdapter } from "./document-sync-adapter";
import { createCoreLibraryModuleAdapter } from "./library-module-adapter";

const block = (body: Y.XmlFragment, id: string): Y.XmlElement => {
  for (const node of body.createTreeWalker((candidate) => candidate instanceof Y.XmlElement)) {
    if (
      node instanceof Y.XmlElement &&
      node.nodeName === "blockContainer" &&
      node.getAttribute("id") === id
    )
      return node;
  }
  throw new Error(`Missing active Block ${id}`);
};

const firstText = (container: Y.XmlElement): Y.XmlText => {
  for (const node of container.createTreeWalker((candidate) => candidate instanceof Y.XmlText)) {
    if (node instanceof Y.XmlText) return node;
  }
  throw new Error("Expected a paragraph text node");
};

const cases = [
  ...(
    [
      "text",
      "format",
      "property",
      "split",
      "merge",
      "nest",
      "delete",
      "create_then_delete",
    ] as const
  ).map((edit) => ({
    edit,
    structure: "cut" as const,
  })),
  ...(["move", "cross_document_move", "turn_into", "backward_merge"] as const).map((structure) => ({
    edit: "text" as const,
    structure,
  })),
];

test.each(cases.flatMap((entry) => ["project", "library"].map((access) => ({ ...entry, access }))))(
  "$access $edit history survives real Core $structure and restoration",
  async ({ edit, structure, access }) => {
    await withCoreScenario({ scenarioId: DOCUMENT_SYNC_RECOVERY_SCENARIO_ID }, async (ctx) => {
      const client =
        access === "library"
          ? ctx.runtime.rootClient
          : ctx.runtime.clientForProject(ctx.manifest.projectId);
      const documents = createCoreDocumentSyncAdapter(client);
      const library = createCoreLibraryModuleAdapter({
        client,
        ...ctx.runtime.identity,
        editorHistoryOwnerId: createUuidV7(),
      });
      const documentId = ctx.manifest.entityIdsByKey!.sourceDocument!;
      const childPageId = ctx.manifest.pageIdsByKey.child!;
      const clientSessionId = createUuidV7();
      const document = new Y.Doc({ guid: documentId });
      const stream = await client.openDocumentEventStream(
        { documentId, clientSessionId },
        () => undefined,
        () => undefined,
        () => undefined,
      );
      const body = document.getXmlFragment("body");
      let historyHead = 0;
      const sync = async () => {
        const result = await documents.sync({
          documentId,
          clientSessionId,
          stateVector: Y.encodeStateVector(document),
          historyAfterHeadSeq: historyHead,
        });
        if (!result.ok) throw new Error(result.error.message);
        expect(result.value.historyFence?.headSeq).toBe(result.value.headSeq);
        publishDocumentHistoryFence(document, result.value.historyFence);
        Y.applyUpdate(document, result.value.update, "canonical-core");
        historyHead = result.value.headSeq;
        return result.value;
      };
      const apply = async (
        operation: LibraryApplyOperation,
      ): Promise<LibraryStructuralEditResult> => {
        const result = await library.apply({
          operationId: createUuidV7(),
          storeEpoch: ctx.runtime.identity.storeEpoch,
          operation,
        });
        if (!result.ok) throw new Error(result.error.message);
        if (!result.value.structuralEdit) throw new Error("Core omitted its structural result");
        await sync();
        return result.value.structuralEdit;
      };
      const request = (operation: LibraryApplyOperation, replay: boolean): NfmHistoryRequest => ({
        kind: "library",
        accessContext:
          access === "library"
            ? { kind: "library" }
            : { kind: "project", projectId: ctx.manifest.projectId },
        request: {
          operationId: createUuidV7(),
          storeEpoch: ctx.runtime.identity.storeEpoch,
          operation,
        },
        presentation: { focusRevision: 0 },
        replay,
      });
      let history: NfmHistoryLane | undefined;
      let retention: NfmLocalHistoryRetention | undefined;
      let manager: Y.UndoManager | undefined;
      try {
        const initial = await sync();
        const root = body.get(0);
        if (!(root instanceof Y.XmlElement)) throw new Error("Missing canonical root group");
        const paragraph = root.get(structure === "backward_merge" ? 1 : 0);
        if (!(paragraph instanceof Y.XmlElement)) throw new Error("Missing first paragraph");
        const paragraphId = paragraph.getAttribute("id")!;
        const text = firstText(paragraph);
        let before = materializePageDocument(document).blockTree;
        const replayErrors: unknown[] = [];
        manager = new Y.UndoManager(body, { trackedOrigins: new Set(["surface-local"]) });
        const journal = new NfmTextHistoryJournal(body, manager);
        retention = new NfmLocalHistoryRetention(document, journal, {
          scope: () => ({
            accessContext:
              access === "library"
                ? { kind: "library" }
                : { kind: "project", projectId: ctx.manifest.projectId },
            source: { documentId, generation: initial.generation, storeEpoch: initial.storeEpoch },
          }),
          apply: async (_access, request) => await library.apply(request),
          release: async (_access, request) => {
            const result = await library.apply(request);
            if (!result.ok) throw new Error(result.error.message);
          },
          onError: (error) => replayErrors.push(error),
        });
        history = new NfmHistoryLane({
          undoManager: manager,
          onError: (error) => replayErrors.push(error),
          textHistory: journal,
          prepareCommand: async () => ({
            kind: "submit",
            request: request(await prepareStructure(), false),
          }),
          prepareTextReverse: async (patch) =>
            request(
              {
                kind: "apply_structural_edit",
                command: {
                  kind: "restore_editor_history",
                  documentId,
                  generation: initial.generation,
                  patch,
                },
              },
              true,
            ),
          prepareStructuralReverse: async (token) =>
            request({ kind: "reverse_structural_edit", token }, true),
          submit: async (prepared) => {
            if (prepared.kind !== "library") throw new Error("Unexpected transfer request");
            const result = await library.apply(prepared.request);
            if (!result.ok)
              return {
                kind: "rejected",
                reason: result.error.message,
                retryable: canRetryNfmHistory(result.error),
              };
            if (!result.value.structuralEdit) throw new Error("Core omitted its structural result");
            await sync();
            return {
              kind: "committed",
              receipt: {
                kind: "structural",
                result: result.value.structuralEdit,
                replay: prepared.replay,
              },
            };
          },
        });
        const stateVector = Y.encodeStateVector(document);
        const extraCutRoots: string[] = [];
        if (edit === "create_then_delete") {
          document.transact(() => {
            const child = cloneXmlSubtree(paragraph) as Y.XmlElement;
            child.setAttribute("id", createUuidV7());
            const children = new Y.XmlElement("blockGroup");
            paragraph.insert(1, [children]);
            children.insert(0, [child]);
          }, "surface-local");
          manager.stopCapturing();
          before = materializePageDocument(document).blockTree;
        }
        document.transact(() => {
          if (edit === "create_then_delete") {
            (paragraph.get(1) as Y.XmlElement).delete(0, 1);
            return;
          }
          if (edit === "text") {
            text.insert(text.length, " C");
            return;
          }
          if (edit === "format") {
            text.format(0, 5, { bold: {} });
            return;
          }
          if (edit === "property") {
            (paragraph.get(0) as Y.XmlElement).setAttribute("textAlignment", "right");
            return;
          }
          if (edit === "split") {
            const clone = cloneXmlSubtree(paragraph) as Y.XmlElement;
            const id = createUuidV7();
            clone.setAttribute("id", id);
            text.delete(5, text.length - 5);
            root.insert(1, [clone]);
            const rest = firstText(clone);
            rest.delete(0, 5);
            extraCutRoots.push(id);
            return;
          }
          const second = root.get(1) as Y.XmlElement;
          if (edit === "merge") {
            text.insert(text.length, firstText(second).toString());
            root.delete(1, 1);
            return;
          }
          if (edit === "delete") {
            root.delete(1, 1);
            return;
          }
          const moved = cloneXmlSubtree(second);
          root.delete(1, 1);
          const children = new Y.XmlElement("blockGroup");
          paragraph.insert(1, [children]);
          children.insert(0, [moved]);
        }, "surface-local");
        const localItem = manager.undoStack.at(-1)!;
        if (edit === "create_then_delete") expect(journal.patch(localItem).changes).not.toEqual([]);
        const after = materializePageDocument(document).blockTree;
        const ids = (blocks: typeof before): string[] =>
          blocks.flatMap((block) => [block.id, ...ids(block.children)]);
        await retention.flush();
        const written = await documents.applyUpdate({
          documentId,
          clientSessionId,
          storeEpoch: initial.storeEpoch,
          generation: initial.generation,
          baseHeadSeq: initial.headSeq,
          updateId: createUuidV7(),
          touchedBlockIds: [...new Set([...ids(before), ...ids(after)])],
          update: Y.encodeStateAsUpdate(document, stateVector),
        });
        if (!written.ok) throw new Error(written.error.message);
        const head = await sync();
        const selection = {
          sourceDocumentId: documentId,
          rootBlockIds: [paragraphId, ...extraCutRoots, childPageId],
          sourceHead: { documentId, generation: head.generation, expectedHeadSeq: head.headSeq },
        };
        const prepareStructure = async (): Promise<LibraryApplyOperation> => {
          if (structure === "turn_into")
            return {
              kind: "apply_structural_edit",
              command: {
                kind: "turn_selection_into",
                selection,
                target: { kind: "heading", level: "two", toggleable: false },
              },
            };
          if (structure === "backward_merge")
            return {
              kind: "apply_structural_edit",
              command: {
                kind: "merge_block_backward",
                selection: {
                  ...selection,
                  rootBlockIds: [after.at(-1)!.id],
                },
                targetBlockId: paragraphId,
              },
            };
          if (structure === "move" || structure === "cross_document_move") {
            const destination =
              structure === "move" ? documentId : ctx.manifest.entityIdsByKey!.otherDocument!;
            let targetHead = selection.sourceHead;
            if (structure === "cross_document_move") {
              const read = await client.documentRead(clientSessionId, {
                kind: "descriptor",
                owner_block_id: ctx.manifest.pageIdsByKey.other!,
              });
              if (read.value.kind !== "descriptor") throw new Error("Missing target descriptor");
              targetHead = {
                documentId: destination,
                generation: read.value.descriptor.generation,
                expectedHeadSeq: read.value.descriptor.headSeq,
              };
            }
            return {
              kind: "apply_structural_edit",
              command: {
                kind: "move_selection",
                selection,
                target: {
                  targetDocumentId: destination,
                  parentBlockId: null,
                  beforeBlockId: null,
                  targetHead,
                },
              },
            };
          }
          const captured = await apply({
            kind: "apply_structural_edit",
            command: { kind: "capture_clipboard", selection },
          });
          if (!captured.clipboard) throw new Error("Core omitted its clipboard capability");
          return {
            kind: "apply_structural_edit",
            command: {
              kind: "delete_selection",
              selection,
              reason: { kind: "cut", bundle: captured.clipboard },
              direction: "forward",
            },
          };
        };
        if (structure === "cross_document_move") {
          // Another surface owns A; source C must block while its resource is away.
          const moved = await apply(await prepareStructure());
          if (!moved.history) throw new Error("Move omitted its inverse");
          const whileAway = materializePageDocument(document).blockTree;
          history.requestUndo();
          await history.whenIdle();
          expect(replayErrors).toHaveLength(1);
          expect(history.snapshot().undo.status).toBe("blocked");
          expect(materializePageDocument(document).blockTree).toEqual(whileAway);
          replayErrors.length = 0;
          await apply({ kind: "reverse_structural_edit", token: moved.history });
        } else {
          history.execute({ kind: "delete", roots: selection.rootBlockIds, direction: "forward" });
          await history.whenIdle();
          history.requestUndo();
          await history.whenIdle();
        }
        expect(replayErrors).toEqual([]);
        expect(block(body, childPageId).getAttribute("id")).toBe(childPageId);
        if (structure === "cut") expect(block(body, paragraphId)).not.toBe(paragraph);
        expect(materializePageDocument(document).blockTree).toEqual(after);
        if (edit === "create_then_delete") expect(journal.requiresBridge(localItem)).toBe(true);
        if (structure === "cross_document_move") history.recover();
        else history.requestUndo();
        await history.whenIdle();
        expect(replayErrors).toEqual([]);
        expect(materializePageDocument(document).blockTree).toEqual(before);
        history.requestRedo();
        await history.whenIdle();
        expect(replayErrors).toEqual([]);
        expect(materializePageDocument(document).blockTree).toEqual(after);
      } finally {
        await retention?.close();
        await history?.close();
        manager?.destroy();
        document.destroy();
        await stream.close();
      }
    });
  },
);
