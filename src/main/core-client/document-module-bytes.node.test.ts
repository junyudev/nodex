import * as Y from "yjs";
import { expect, test } from "vite-plus/test";
import { withCoreScenario } from "../../../scripts/scenarios/harness/core-scenario-harness";
import { DOCUMENT_SYNC_RECOVERY_SCENARIO_ID } from "../../../scripts/scenarios/scenarios/document-sync-recovery";
import {
  recoveryPayloadHash,
  encodeRecoveryBundle,
} from "../../shared/block-documents/recovery-bundle";
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

test("large Canvas content uses binary commands and limited previews retain recovery capabilities", async () => {
  await withCoreScenario({ scenarioId: DOCUMENT_SYNC_RECOVERY_SCENARIO_ID }, async (ctx) => {
    const documentId = ctx.manifest.entityIdsByKey!.canvasDocumentId!;
    const clientSessionId = "canvas:bytes";
    const stream = await ctx.client.openDocumentEventStream(
      { documentId, clientSessionId },
      () => {},
      () => {},
      () => {},
    );
    try {
      const sync = () =>
        ctx.client.documentCanvasSync({
          documentId,
          clientSessionId,
          syncRequestId: crypto.randomUUID(),
          accessContext: { kind: "library" },
        });
      const initial = await sync();
      let head = initial.headSeq;
      // Each command is below 2 MiB; the complete scene exceeds the old metadata limit.
      for (let index = 0; index < 5; index += 1) {
        const result = await ctx.client.documentApply({
          operationId: `canvas:large:${index}`,
          clientSessionId,
          intent: {
            kind: "apply_canvas_mutation",
            document_id: documentId,
            generation: initial.generation,
            expected_head_seq: head,
            mutation: {
              elementCandidates: [
                {
                  id: `rectangle:${index}`,
                  type: "rectangle",
                  index: `a${index}`,
                  version: 1,
                  versionNonce: 10,
                  isDeleted: false,
                  customData: { first: "x".repeat(900_000), second: "y".repeat(900_000) },
                },
              ],
              appStateIntents: {},
              fileAdditions: {},
            },
          },
        });
        head = result.outcome.head_seq;
      }
      const current = await sync();
      if (current.kind !== "snapshot") throw new Error("Expected complete Canvas snapshot");
      expect(JSON.stringify(current.scene).length).toBeGreaterThan(8 * 1024 * 1024);
      const scene = current.scene;
      const bundle = await encodeRecoveryBundle(
        {
          draft_id: "draft:large-canvas",
          document_id: documentId,
          source_store_epoch: ctx.runtime.identity.storeEpoch,
          generation: current.generation,
          base_head_seq: current.headSeq,
          created_at: new Date().toISOString(),
          schema_key: "nodex.canvas",
          schema_version: 2,
          content: {
            kind: "canvas",
            scene,
            mutations: [
              {
                elementCandidates: [
                  {
                    id: "unsaved",
                    type: "rectangle",
                    index: "a9",
                    version: 1,
                    versionNonce: 99,
                    isDeleted: false,
                  },
                ],
                appStateIntents: {},
                fileAdditions: {},
              },
            ],
          },
          source: { scene, source: "retained-canvas" },
        },
        "source:canvas",
      );
      await ctx.client.documentCaptureRecovery({
        operationId: "capture:large-canvas",
        clientSessionId,
        bundle,
      });
      const read = await ctx.client.documentRead(clientSessionId, {
        kind: "recovery",
        read: { kind: "inspect", draft_id: "draft:large-canvas" },
      });
      if (read.value.kind !== "recovery" || read.value.value.kind !== "inspect")
        throw new Error("Expected inspection");
      const inspection = read.value.value.inspection;
      expect(JSON.stringify(inspection).length).toBeLessThan(64 * 1024);
      expect(inspection.can_copy, inspection.explanation ?? undefined).toBe(true);
      const preview = await ctx.client.documentRead(clientSessionId, {
        kind: "recovery",
        read: {
          kind: "preview",
          request: {
            draft_id: inspection.summary.draft_id,
            revision: inspection.summary.revision,
            expected_generation: inspection.current_generation,
            expected_head_seq: inspection.current_head_seq,
            view: "retained",
          },
        },
      });
      if (preview.value.kind !== "recovery" || preview.value.value.kind !== "preview")
        throw new Error("Expected preview result");
      expect(preview.value.value.result.kind).toBe("limited");
      expect(
        (await ctx.client.documentExportRecovery(inspection.summary.draft_id)).length,
      ).toBeGreaterThan(bundle.bytes.length);
    } finally {
      await stream.close();
    }
  });
});
