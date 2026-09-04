import { expect, test } from "vite-plus/test";
import type { BlockNoteEditor } from "@blocknote/core";
import * as Y from "yjs";

import { withCoreScenario } from "../../../scripts/scenarios/harness/core-scenario-harness";
import { DOCUMENT_SYNC_RECOVERY_SCENARIO_ID } from "../../../scripts/scenarios/scenarios/document-sync-recovery";
import { NfmStructuralEditingSession } from "../../renderer/components/board/editor/nfm-structural-editing-extension";
import { publishDocumentHistoryFence } from "../../renderer/lib/document-history-fence";
import type { LibraryModuleApplyReceipt } from "../../shared/library-module";
import { materializePageDocument } from "../../shared/block-documents/block-document-codec";
import { createUuidV7 } from "../../shared/uuid-v7";
import { createCoreDocumentSyncAdapter } from "./document-sync-adapter";
import { createCoreLibraryModuleAdapter } from "./library-module-adapter";

test.each(["response", "admission"] as const)(
  "recovers one real Core inverse after %s loss without a second commit",
  async (failure) => {
    await withCoreScenario({ scenarioId: DOCUMENT_SYNC_RECOVERY_SCENARIO_ID }, async (ctx) => {
      const client = ctx.runtime.clientForProject(ctx.manifest.projectId);
      const library = createCoreLibraryModuleAdapter({ client, ...ctx.runtime.identity });
      const documents = createCoreDocumentSyncAdapter(client);
      const documentId = ctx.manifest.entityIdsByKey!.sourceDocument!;
      const childPageId = ctx.manifest.pageIdsByKey.child!;
      const clientSessionId = createUuidV7();
      const document = new Y.Doc({ guid: documentId });
      const body = document.getXmlFragment("body");
      const stream = await client.openDocumentEventStream(
        { documentId, clientSessionId },
        () => undefined,
        () => undefined,
        () => undefined,
      );
      let headSeq = 0;
      const sync = async () => {
        const result = await documents.sync({
          documentId,
          clientSessionId,
          stateVector: Y.encodeStateVector(document),
          historyAfterHeadSeq: headSeq,
        });
        if (!result.ok) throw new Error(result.error.message);
        publishDocumentHistoryFence(document, result.value.historyFence);
        Y.applyUpdate(document, result.value.update, "core");
        headSeq = result.value.headSeq;
        return result.value;
      };
      let session: NfmStructuralEditingSession | undefined;
      const manager = new Y.UndoManager(body, { trackedOrigins: new Set(["surface"]) });
      try {
        const initial = await sync();
        const before = materializePageDocument(document).blockTree;
        const receipts: LibraryModuleApplyReceipt[] = [];
        const errors: string[] = [];
        const editor = {
          getExtension: () => ({
            undoManager: manager,
            fragment: body,
            bindHistory: () => () => undefined,
            getSemanticSelection: () => undefined,
            restoreSemanticSelection: () => false,
          }),
          getBlock: (id: string) =>
            materializePageDocument(document).blockTree.find((block) => block.id === id),
          setTextCursorPosition: () => undefined,
        } as unknown as BlockNoteEditor<any, any, any>;
        session = new NfmStructuralEditingSession({
          beginClipboard: async () => ({ ok: true }),
          publishClipboard: async () => ({ ok: true }),
          settleClipboard: async () => ({ ok: true }),
          historyReconciliation: {
            read: async (_scope, tokens) => {
              const result = await library.read({
                read: { mode: "structural_history_states", tokens },
              });
              if (!result.ok) throw new Error(result.error.message);
              if (result.value.value.kind !== "structural_history_states")
                throw new Error("Missing history states");
              return { commitSeq: result.value.commitSeq, items: result.value.value.items };
            },
            subscribe: () => () => undefined,
          },
          editor,
          runtime: {
            accessContext: { kind: "project", projectId: ctx.manifest.projectId },
            libraryId: ctx.runtime.identity.libraryId,
            source: { documentId, storeEpoch: initial.storeEpoch, generation: initial.generation },
            getContainer: () => null,
            onError: (message) => errors.push(message),
            participant: {
              prepareAndFence: async () => {
                if (receipts.length > 0)
                  throw new Error("Receipt recovery must not require another fence");
                const head = await sync();
                return {
                  documentId,
                  storeEpoch: head.storeEpoch,
                  generation: head.generation,
                  expectedHeadSeq: head.headSeq,
                };
              },
            },
          },
          apply: async (_access, request) => {
            const result = await library.apply(request);
            if (!result.ok) return result;
            if (request.operation.kind === "reverse_structural_edit") {
              receipts.push(result.value);
              if (receipts.length === 1) {
                if (failure === "admission") {
                  await sync();
                  throw new Error("Lost admission acknowledgment");
                }
                return {
                  ok: false,
                  error: { code: "unknown", message: "Lost inverse response", retryable: true },
                };
              }
            }
            await sync();
            return result;
          },
        });
        expect(
          session.handleClipboard(
            "cut",
            [childPageId],
            { html: "<p>Child</p>", text: "Child" },
            createUuidV7(),
          ),
        ).toBe(true);
        await session.whenIdle();
        expect(
          materializePageDocument(document).blockTree.some((block) => block.id === childPageId),
        ).toBe(false);
        session.handleKeyDown({ key: "z", metaKey: true } as KeyboardEvent);
        await session.whenIdle();
        expect(errors).toHaveLength(1);
        const committedHead = (await sync()).headSeq;
        expect(materializePageDocument(document).blockTree).toEqual(before);
        await session.recoverHistory();
        expect(errors).toHaveLength(1);
        expect(receipts).toHaveLength(2);
        expect(receipts[0]!.duplicate).toBe(false);
        expect(receipts[1]).toEqual({ ...receipts[0], duplicate: true });
        expect((await sync()).headSeq).toBe(committedHead);
        expect(materializePageDocument(document).blockTree).toEqual(before);
      } finally {
        await session?.close();
        manager.destroy();
        document.destroy();
        await stream.close();
      }
    });
  },
);
