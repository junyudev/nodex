import { expect, test } from "vite-plus/test";
import { withCoreScenario } from "../../../scripts/scenarios/harness/core-scenario-harness";
import { observeCoreScenarioTest } from "../../../scripts/scenarios/harness/core-scenario-test-observation";
import { DOCUMENT_SYNC_RECOVERY_SCENARIO_ID } from "../../../scripts/scenarios/scenarios/document-sync-recovery";
import { encodeRecoveryBundle } from "../../shared/block-documents/recovery-bundle";

// This payload-boundary fixture budgets debug encode/decode work explicitly.
test("large Canvas content uses binary commands and limited previews retain recovery capabilities", async (context) => {
  const requestBudget = { deadlineMs: 60_000 };
  const startedAt = performance.now();
  const phases: Array<{ phase: string; atMs: number }> = [];
  const markPhase = (phase: string) => {
    phases.push({ phase, atMs: Math.round(performance.now() - startedAt) });
    if (phases.length > 24) phases.shift();
  };
  context.onTestFailed(() => {
    const now = Math.round(performance.now() - startedAt);
    console.error(
      `Large Canvas operation phases: ${JSON.stringify(
        phases.map((entry, index) => ({
          ...entry,
          elapsedMs: (phases[index + 1]?.atMs ?? now) - entry.atMs,
        })),
      )}`,
    );
  });
  markPhase("scenario-setup");
  await withCoreScenario(
    observeCoreScenarioTest(context, DOCUMENT_SYNC_RECOVERY_SCENARIO_ID),
    async (ctx) => {
      const documentId = ctx.manifest.entityIdsByKey!.canvasDocumentId!;
      const clientSessionId = "canvas:bytes";
      markPhase("open-document-stream");
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
        markPhase("canvas-sync:initial");
        const initial = await sync();
        let head = initial.headSeq;
        // Each command is below 2 MiB; the complete scene exceeds the old metadata limit.
        for (let index = 0; index < 5; index += 1) {
          markPhase(`canvas-apply:${index}`);
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
        markPhase("canvas-sync:complete-scene");
        const current = await sync();
        if (current.kind !== "snapshot") throw new Error("Expected complete Canvas snapshot");
        markPhase("snapshot-size-assertion");
        expect(JSON.stringify(current.scene).length).toBeGreaterThan(8 * 1024 * 1024);
        const scene = current.scene;
        markPhase("recovery-bundle-encode");
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
        markPhase("recovery-capture");
        await ctx.client.documentCaptureRecovery(
          {
            operationId: "capture:large-canvas",
            clientSessionId,
            bundle,
          },
          requestBudget,
        );
        markPhase("recovery-inspect");
        const read = await ctx.client.documentRead(
          clientSessionId,
          {
            kind: "recovery",
            read: { kind: "inspect", draft_id: "draft:large-canvas" },
          },
          requestBudget,
        );
        markPhase("inspection-assertions");
        if (read.value.kind !== "recovery" || read.value.value.kind !== "inspect")
          throw new Error("Expected inspection");
        const inspection = read.value.value.inspection;
        expect(JSON.stringify(inspection).length).toBeLessThan(64 * 1024);
        expect(inspection.can_copy, inspection.explanation ?? undefined).toBe(true);
        markPhase("recovery-preview:retained");
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
        markPhase("preview-assertion");
        if (preview.value.kind !== "recovery" || preview.value.value.kind !== "preview")
          throw new Error("Expected preview result");
        expect(preview.value.value.result.kind).toBe("limited");
        markPhase("recovery-export");
        expect(
          (await ctx.client.documentExportRecovery(inspection.summary.draft_id, requestBudget))
            .length,
        ).toBeGreaterThan(bundle.bytes.length);
      } finally {
        markPhase("close-document-stream");
        await stream.close();
        markPhase("scenario-teardown");
      }
    },
  );
  markPhase("scenario-complete");
}, 120_000);
