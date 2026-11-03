import * as Y from "yjs";
import { expect, test } from "vite-plus/test";
import { withCoreScenario } from "../../../scripts/scenarios/harness/core-scenario-harness";
import { DOCUMENT_SYNC_RECOVERY_SCENARIO_ID } from "../../../scripts/scenarios/scenarios/document-sync-recovery";
import { recoveryPayloadHash } from "../../shared/block-documents/recovery-bundle";
import { CoreModuleResponseError } from "./core-client";

test("Module byte reads and writes preserve live authorization, update identity and complete updates", async () => {
  await withCoreScenario({ scenarioId: DOCUMENT_SYNC_RECOVERY_SCENARIO_ID }, async (ctx) => {
    const documentId = ctx.manifest.entityIdsByKey!.sourceDocument!;
    const clientSessionId = "module:bytes";
    await expect(
      ctx.client.documentRead(clientSessionId, {
        kind: "sync_yjs",
        document_id: documentId,
        state_vector: [],
      }),
    ).rejects.toBeInstanceOf(CoreModuleResponseError);
    const stream = await ctx.client.openDocumentEventStream(
      { documentId, clientSessionId },
      () => {},
      () => {},
      () => {},
    );
    const document = new Y.Doc();
    try {
      const initial = await ctx.client.documentRead(clientSessionId, {
        kind: "sync_yjs",
        document_id: documentId,
        state_vector: [],
      });
      if (initial.value.kind !== "yjs_sync") throw new Error("Expected Yjs sync");
      Y.applyUpdate(document, Uint8Array.from(initial.value.update));
      const vector = Y.encodeStateVector(document);
      const text = [...document.getXmlFragment("body").createTreeWalker(() => true)].find(
        (node): node is Y.XmlText => node instanceof Y.XmlText,
      );
      if (!text) throw new Error("Expected a paragraph text node");
      text.insert(0, "大".repeat(24_000));
      const update = Y.encodeStateAsUpdate(document, vector);
      expect(update.length).toBeGreaterThan(70_000);
      const command = {
        operationId: "operation:module-bytes",
        clientSessionId,
        intent: {
          kind: "apply_yjs_update" as const,
          document_id: documentId,
          generation: initial.value.descriptor.generation,
          base_head_seq: initial.value.descriptor.headSeq,
          update_id: "operation:module-bytes",
          touched_block_ids: [],
          update: Array.from(update),
        },
      };
      const applied = await ctx.client.documentApply(command);
      const retry = await ctx.client.documentApply(command);
      expect(retry.receipt.duplicate).toBe(true);
      expect(retry.outcome.head_seq).toBe(applied.outcome.head_seq);
      const fetched = await ctx.client.documentRead(clientSessionId, {
        kind: "fetch_update",
        document_id: documentId,
        generation: applied.outcome.generation,
        update_id: command.intent.update_id,
        update_hash: await recoveryPayloadHash(update),
      });
      if (fetched.value.kind !== "update_resource")
        throw new Error("Expected the complete update resource");
      expect(Uint8Array.from(fetched.value.resource.update)).toEqual(update);
      const synced = await ctx.client.documentRead(clientSessionId, {
        kind: "sync_yjs",
        document_id: documentId,
        state_vector: [],
      });
      if (synced.value.kind !== "yjs_sync") throw new Error("Expected Yjs sync");
      const restored = new Y.Doc();
      try {
        Y.applyUpdate(restored, Uint8Array.from(synced.value.update));
        expect(restored.getXmlFragment("body").toString()).toBe(
          document.getXmlFragment("body").toString(),
        );
      } finally {
        restored.destroy();
      }
    } finally {
      document.destroy();
      await stream.close();
    }
  });
});
