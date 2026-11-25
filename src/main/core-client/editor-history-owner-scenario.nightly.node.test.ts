import { expect, test } from "vite-plus/test";
import { withCoreScenario } from "../../../scripts/scenarios/harness/core-scenario-harness";
import { DOCUMENT_SYNC_RECOVERY_SCENARIO_ID } from "../../../scripts/scenarios/scenarios/document-sync-recovery";
import { createUuidV7 } from "../../shared/uuid-v7";
import type { LibraryApplyOperation, LibraryModuleApplyRequest } from "../../shared/library-module";
import { createCoreLibraryModuleAdapter } from "./library-module-adapter";
import { CoreClient } from "./core-client";
import * as Y from "yjs";
import { createCoreDocumentSyncAdapter } from "./document-sync-adapter";
import { materializePageDocument } from "../../shared/block-documents/block-document-codec";
import { createCoreBlockTransferAdapter } from "./block-transfer-adapter";

test("closing a promotion owner invalidates its inverse without changing the promoted Page", async () => {
  await withCoreScenario({ scenarioId: DOCUMENT_SYNC_RECOVERY_SCENARIO_ID }, async (ctx) => {
    const client = ctx.runtime.clientForProject(ctx.manifest.projectId);
    const owner = createUuidV7();
    const documentId = ctx.manifest.entityIdsByKey!.sourceDocument!;
    const clientSessionId = createUuidV7();
    const document = new Y.Doc({ guid: documentId });
    const stream = await client.openDocumentEventStream(
      { documentId, clientSessionId },
      () => undefined,
      () => undefined,
      () => undefined,
    );
    try {
      const sync = await createCoreDocumentSyncAdapter(client).sync({
        documentId,
        clientSessionId,
        stateVector: Y.encodeStateVector(document),
      });
      if (!sync.ok) throw new Error(sync.error.message);
      Y.applyUpdate(document, sync.value.update);
      const rootId = materializePageDocument(document).blockTree[0]!.id;
      const adapter = createCoreBlockTransferAdapter({
        client,
        ...ctx.runtime.identity,
        projectId: ctx.manifest.projectId,
        editorHistoryOwnerId: owner,
      });
      const request = {
        operationId: createUuidV7(),
        projectId: ctx.manifest.projectId,
        storeEpoch: ctx.runtime.identity.storeEpoch,
        actor: { kind: "electron_host" },
        mode: "move" as const,
        rootBlockIds: [rootId],
        causalDependencies: [
          { documentId, generation: sync.value.generation, expectedHeadSeq: sync.value.headSeq },
        ],
        source: { kind: "document" as const, documentId },
        target: { kind: "library" as const, libraryId: ctx.runtime.identity.libraryId },
        promotionPolicy: "literal" as const,
      };
      const promoted = await adapter.commit(request);
      const token = promoted.ok ? promoted.value.undoToken : null;
      if (!token) throw new Error("Promotion omitted its inverse");
      await ctx.runtime.rootClient.libraryApply(
        { operationId: createUuidV7(), intent: { kind: "close_editor_history_owner" } },
        { editorHistoryOwnerId: owner },
      );
      const replay = await adapter.commit(request);
      expect(replay.ok && replay.value.duplicate).toBe(true);
      await expect(
        client.libraryApply(
          {
            operationId: createUuidV7(),
            intent: {
              kind: "undo_block_transfer",
              token: {
                transfer_operation_id: token.transferOperationId,
                recipe_hash: token.recipeHash,
                store_epoch: token.storeEpoch,
              },
            },
          },
          { editorHistoryOwnerId: createUuidV7() },
        ),
      ).rejects.toMatchObject({
        coreError: { code: "revision_conflict" },
      });
      const descriptor = await client.documentRead(createUuidV7(), {
        kind: "descriptor",
        owner_block_id: rootId,
      });
      expect(descriptor.value.kind).toBe("descriptor");
    } finally {
      await stream.close();
      document.destroy();
    }
  });
});

test("closing a desktop history lifetime cannot revive it or release another window's inverse", async () => {
  await withCoreScenario({ scenarioId: DOCUMENT_SYNC_RECOVERY_SCENARIO_ID }, async (ctx) => {
    const host = ctx.runtime.rootClient;
    const client = ctx.runtime.clientForProject(ctx.manifest.projectId);
    const firstOwner = createUuidV7();
    const secondOwner = createUuidV7();
    const first = createCoreLibraryModuleAdapter({
      client,
      ...ctx.runtime.identity,
      editorHistoryOwnerId: firstOwner,
    });
    const second = createCoreLibraryModuleAdapter({
      client,
      ...ctx.runtime.identity,
      editorHistoryOwnerId: secondOwner,
    });
    const descriptor = await client.documentRead(createUuidV7(), {
      kind: "descriptor",
      owner_block_id: ctx.manifest.pageIdsByKey.source!,
    });
    if (descriptor.value.kind !== "descriptor") throw new Error("Missing source descriptor");
    const source = descriptor.value.descriptor;
    const cutRequest: LibraryModuleApplyRequest = {
      operationId: createUuidV7(),
      storeEpoch: ctx.runtime.identity.storeEpoch,
      operation: {
        kind: "apply_structural_edit",
        command: {
          kind: "delete_selection",
          reason: { kind: "delete" },
          direction: "forward",
          selection: {
            sourceDocumentId: source.documentId,
            rootBlockIds: [ctx.manifest.pageIdsByKey.child!],
            sourceHead: {
              documentId: source.documentId,
              generation: source.generation,
              expectedHeadSeq: source.headSeq,
            },
          },
        },
      },
    };
    const cut = await first.apply(cutRequest);
    if (!cut.ok || !cut.value.structuralEdit?.history) throw new Error(JSON.stringify(cut));
    const originalToken = cut.value.structuralEdit.history;
    const reverse = await second.apply({
      operationId: createUuidV7(),
      storeEpoch: source.storeEpoch,
      operation: { kind: "reverse_structural_edit", token: originalToken },
    });
    if (!reverse.ok || !reverse.value.structuralEdit?.history)
      throw new Error(JSON.stringify(reverse));
    const inverseToken = reverse.value.structuralEdit.history;
    const closeRequest = {
      operationId: createUuidV7(),
      intent: { kind: "close_editor_history_owner" as const },
    };
    await host.libraryApply(closeRequest, { editorHistoryOwnerId: firstOwner });
    expect(
      (await host.libraryApply(closeRequest, { editorHistoryOwnerId: firstOwner })).receipt
        .duplicate,
    ).toBe(true);
    const replay = await first.apply(cutRequest);
    expect(replay.ok && replay.value.duplicate).toBe(true);
    const late = await first.apply({
      operationId: createUuidV7(),
      storeEpoch: source.storeEpoch,
      operation: { kind: "reverse_structural_edit", token: inverseToken },
    });
    expect(late.ok).toBe(false);
    if (!late.ok) expect(late.error.message).toContain("lifetime has ended");
    const read = await second.read({
      read: { mode: "structural_history_states", tokens: [originalToken, inverseToken] },
    });
    if (!read.ok || read.value.value.kind !== "structural_history_states")
      throw new Error("Missing lifecycle states");
    expect(read.value.value.items.map((item) => item.state)).toEqual(["consumed", "available"]);
    await host.libraryApply(
      { operationId: createUuidV7(), intent: { kind: "close_editor_history_owner" } },
      { editorHistoryOwnerId: secondOwner },
    );
    const after = await second.read({
      read: { mode: "structural_history_states", tokens: [inverseToken] },
    });
    if (!after.ok || after.value.value.kind !== "structural_history_states")
      throw new Error("Missing closed state");
    expect(after.value.value.items[0]?.state).toBe("consumed");
    const third = createCoreLibraryModuleAdapter({
      client,
      ...ctx.runtime.identity,
      editorHistoryOwnerId: createUuidV7(),
    });
    const closedInverse = await third.apply({
      operationId: createUuidV7(),
      storeEpoch: source.storeEpoch,
      operation: { kind: "reverse_structural_edit", token: inverseToken },
    });
    expect(closedInverse).toMatchObject({ ok: false, error: { code: "revision_conflict" } });
    const untrusted = await CoreClient.connect({
      nodexHome: ctx.profile.nodexHome,
      clientKind: "test",
      buildId: "history-untrusted",
    });
    await expect(
      untrusted.libraryApply(
        { operationId: createUuidV7(), intent: { kind: "close_editor_history_owner" } },
        { editorHistoryOwnerId: firstOwner },
      ),
    ).rejects.toThrow("authenticated desktop Host");
  });
});

test("a closed Cut owner cannot grant identity-moving Paste while its cleanup is pending", async () => {
  await withCoreScenario({ scenarioId: DOCUMENT_SYNC_RECOVERY_SCENARIO_ID }, async (ctx) => {
    const client = ctx.runtime.clientForProject(ctx.manifest.projectId);
    const owner = createUuidV7();
    const source = createCoreLibraryModuleAdapter({
      client,
      ...ctx.runtime.identity,
      editorHistoryOwnerId: owner,
    });
    const target = createCoreLibraryModuleAdapter({
      client,
      ...ctx.runtime.identity,
      editorHistoryOwnerId: createUuidV7(),
    });
    const apply = async (adapter: typeof source, operation: LibraryApplyOperation) => {
      const result = await adapter.apply({
        operationId: createUuidV7(),
        storeEpoch: ctx.runtime.identity.storeEpoch,
        operation,
      });
      if (!result.ok || !result.value.structuralEdit) throw new Error(JSON.stringify(result));
      return result.value.structuralEdit;
    };
    const head = async (pageId: string) => {
      const result = await client.documentRead(createUuidV7(), {
        kind: "descriptor",
        owner_block_id: pageId,
      });
      if (result.value.kind !== "descriptor") throw new Error("Missing Document");
      const value = result.value.descriptor;
      return {
        documentId: value.documentId,
        generation: value.generation,
        expectedHeadSeq: value.headSeq,
      };
    };
    const sourceHead = await head(ctx.manifest.pageIdsByKey.source!);
    const childId = ctx.manifest.pageIdsByKey.child!;
    const selection = {
      sourceDocumentId: sourceHead.documentId,
      sourceHead,
      rootBlockIds: [childId],
    };
    const captured = await apply(source, {
      kind: "apply_structural_edit",
      command: { kind: "capture_clipboard", selection },
    });
    if (!captured.clipboard) throw new Error("Missing clipboard");
    await apply(source, {
      kind: "apply_structural_edit",
      command: {
        kind: "delete_selection",
        selection,
        direction: "forward",
        reason: { kind: "cut", bundle: captured.clipboard },
      },
    });
    await ctx.runtime.rootClient.libraryApply(
      { operationId: createUuidV7(), intent: { kind: "close_editor_history_owner" } },
      { editorHistoryOwnerId: owner },
    );
    const targetHead = await head(ctx.manifest.pageIdsByKey.other!);
    const pasted = await apply(target, {
      kind: "apply_structural_edit",
      command: {
        kind: "paste_clipboard",
        bundle: captured.clipboard,
        target: {
          targetDocumentId: targetHead.documentId,
          targetHead,
          parentBlockId: null,
          beforeBlockId: null,
        },
      },
    });
    const copiedId = pasted.copiedBlockIds[childId];
    expect(copiedId).toBeDefined();
    expect(copiedId).not.toBe(childId);
    expect(pasted.resultRootBlockIds).toEqual([copiedId]);
  });
});
