import { expect, test } from "vite-plus/test";
import * as Y from "yjs";
import { withCoreScenario } from "../../../scripts/scenarios/harness/core-scenario-harness";
import { DOCUMENT_SYNC_RECOVERY_SCENARIO_ID } from "../../../scripts/scenarios/scenarios/document-sync-recovery";
import { createUuidV7 } from "../../shared/uuid-v7";
import type {
  LibraryLocalHistoryRetention,
  LibraryModuleApplyRequest,
} from "../../shared/library-module";
import { materializePageDocument } from "../../shared/block-documents/block-document-codec";
import { createCoreDocumentSyncAdapter } from "./document-sync-adapter";
import { createCoreLibraryModuleAdapter } from "./library-module-adapter";

test("local history pins are scoped, revision fenced and closed independently of another window", async () => {
  await withCoreScenario({ scenarioId: DOCUMENT_SYNC_RECOVERY_SCENARIO_ID }, async (ctx) => {
    const client = ctx.runtime.clientForProject(ctx.manifest.projectId);
    const ownerId = createUuidV7();
    const first = createCoreLibraryModuleAdapter({
      client,
      ...ctx.runtime.identity,
      editorHistoryOwnerId: ownerId,
    });
    const libraryOwnerId = createUuidV7();
    const libraryAccess = createCoreLibraryModuleAdapter({
      client: ctx.runtime.rootClient,
      ...ctx.runtime.identity,
      editorHistoryOwnerId: libraryOwnerId,
    });
    const unowned = createCoreLibraryModuleAdapter({ client, ...ctx.runtime.identity });
    const documents = createCoreDocumentSyncAdapter(client);
    const documentId = ctx.manifest.entityIdsByKey!.sourceDocument!;
    const document = new Y.Doc({ guid: documentId });
    const clientSessionId = createUuidV7();
    const stream = await client.openDocumentEventStream(
      { documentId, clientSessionId },
      () => undefined,
      () => undefined,
      () => undefined,
    );
    try {
      const initial = await documents.sync({
        documentId,
        clientSessionId,
        stateVector: Y.encodeStateVector(document),
      });
      if (!initial.ok) throw new Error(initial.error.message);
      Y.applyUpdate(document, initial.value.update);
      const blockId = materializePageDocument(document).blockTree[0]!.id;
      const retention: LibraryLocalHistoryRetention = {
        surfaceId: createUuidV7(),
        documentId,
        generation: initial.value.generation,
        revision: 1,
        blockIds: [blockId],
        retainDocument: true,
        closed: false,
      };
      const request = (value = retention): LibraryModuleApplyRequest => ({
        operationId: createUuidV7(),
        storeEpoch: ctx.runtime.identity.storeEpoch,
        operation: {
          kind: "apply_structural_edit",
          command: { kind: "set_local_history_retention", retention: value },
        },
      });
      const original = request();
      const admitted = await first.apply(original);
      expect(admitted.ok && admitted.value.didMutate).toBe(true);
      expect((await first.apply(original)).ok).toBe(true);
      const sameMembership = await first.apply(request({ ...retention, revision: 2 }));
      expect(sameMembership.ok && sameMembership.value.didMutate).toBe(false);
      const reused = await first.apply(
        request({ ...retention, revision: 2, blockIds: [], retainDocument: false }),
      );
      expect(reused.ok).toBe(false);
      if (!reused.ok) expect(reused.error.message).toContain("revision was reused");
      const changedAuthority = await first.apply(
        request({ ...retention, revision: 3, generation: initial.value.generation + 1 }),
      );
      expect(changedAuthority.ok).toBe(false);
      const foreign = await first.apply(
        request({
          ...retention,
          surfaceId: createUuidV7(),
          blockIds: [ctx.manifest.pageIdsByKey.other!],
        }),
      );
      expect(foreign.ok).toBe(false);
      if (!foreign.ok) expect(foreign.error.message).toContain("another Document placement");
      const missingOwner = await unowned.apply(
        request({ ...retention, surfaceId: createUuidV7() }),
      );
      expect(missingOwner.ok).toBe(false);
      const otherWindow = await libraryAccess.apply(request());
      expect(otherWindow.ok && otherWindow.value.didMutate).toBe(true);
      const rebound = createCoreLibraryModuleAdapter({
        client,
        ...ctx.runtime.identity,
        editorHistoryOwnerId: libraryOwnerId,
      });
      const changedAccess = await rebound.apply(request({ ...retention, revision: 2 }));
      expect(changedAccess.ok).toBe(false);
      if (!changedAccess.ok) expect(changedAccess.error.message).toContain("Document authority");
      const closed = await first.apply(
        request({ ...retention, revision: 3, blockIds: [], retainDocument: false, closed: true }),
      );
      expect(closed.ok && closed.value.didMutate).toBe(false);
      const late = await first.apply(request());
      expect(late.ok && late.value.didMutate).toBe(false);
      const reopened = await first.apply(request({ ...retention, revision: 4 }));
      expect(reopened.ok).toBe(false);
      if (!reopened.ok) expect(reopened.error.message).toContain("already closed");
      await ctx.runtime.rootClient.libraryApply(
        { operationId: createUuidV7(), intent: { kind: "close_editor_history_owner" } },
        { editorHistoryOwnerId: ownerId },
      );
      const remaining = await libraryAccess.apply(request({ ...retention, revision: 2 }));
      expect(remaining.ok && remaining.value.didMutate).toBe(false);
      const head = await documents.sync({
        documentId,
        clientSessionId,
        stateVector: Y.encodeStateVector(document),
      });
      expect(head.ok && head.value.headSeq).toBe(initial.value.headSeq);
    } finally {
      document.destroy();
      await stream.close();
    }
  });
});
