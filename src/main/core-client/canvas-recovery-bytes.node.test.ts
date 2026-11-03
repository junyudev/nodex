import { expect, test } from "vite-plus/test";
import { withCoreScenario } from "../../../scripts/scenarios/harness/core-scenario-harness";
import { DOCUMENT_SYNC_RECOVERY_SCENARIO_ID } from "../../../scripts/scenarios/scenarios/document-sync-recovery";
import { encodeRecoveryBundle } from "../../shared/block-documents/recovery-bundle";

// This payload-boundary fixture budgets debug encode/decode work explicitly.
test("large Canvas content uses binary commands and limited previews retain recovery capabilities", async () => {
  const requestBudget = { deadlineMs: 60_000 };
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
        ctx.client.documentCanvasSync(
          {
            documentId,
            clientSessionId,
            syncRequestId: crypto.randomUUID(),
            routingContext: { kind: "library" },
          },
          requestBudget,
        );
      const initial = await sync();
      let head = initial.headSeq;
      // Each command is below 2 MiB; the complete scene exceeds the old metadata limit.
      for (let index = 0; index < 5; index += 1) {
        const result = await ctx.client.documentApply(
          {
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
          },
          requestBudget,
        );
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
      await ctx.client.documentCaptureRecovery(
        {
          operationId: "capture:large-canvas",
          clientSessionId,
          bundle,
        },
        requestBudget,
      );
      const read = await ctx.client.documentRead(
        clientSessionId,
        {
          kind: "recovery",
          read: { kind: "inspect", draft_id: "draft:large-canvas" },
        },
        requestBudget,
      );
      if (read.value.kind !== "recovery" || read.value.value.kind !== "inspect")
        throw new Error("Expected inspection");
      const inspection = read.value.value.inspection;
      expect(JSON.stringify(inspection).length).toBeLessThan(64 * 1024);
      expect(inspection.can_copy, inspection.explanation ?? undefined).toBe(true);
      const preview = await ctx.client.documentRead(
        clientSessionId,
        {
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
        },
        requestBudget,
      );
      if (preview.value.kind !== "recovery" || preview.value.value.kind !== "preview")
        throw new Error("Expected preview result");
      expect(preview.value.value.result.kind).toBe("limited");
      expect(
        (await ctx.client.documentExportRecovery(inspection.summary.draft_id, requestBudget))
          .length,
      ).toBeGreaterThan(bundle.bytes.length);
    } finally {
      await stream.close();
    }
  });
}, 120_000);
