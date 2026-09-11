import { expect, test } from "vite-plus/test";
import { createUuidV7 } from "../../shared/uuid-v7";
import { createCoreLibraryModuleAdapter } from "./library-module-adapter";
import { withCoreScenario } from "../../../scripts/scenarios/harness/core-scenario-harness";
import {
  STRUCTURAL_INTERACTIONS_SCENARIO_ID,
  requireStructuralInteractionsFacts,
} from "../../../scripts/scenarios/scenarios/structural-interactions";

test("structural fixtures preserve Page-derived File access and read-only Page grants", async () => {
  await withCoreScenario({ scenarioId: STRUCTURAL_INTERACTIONS_SCENARIO_ID }, async (context) => {
    const facts = requireStructuralInteractionsFacts(context.facts);
    const client = context.runtime.clientForProject(context.manifest.projectId);
    for (const fileId of [facts.sharedFileId, facts.secondFileId]) {
      const bytes = await client.readFileBlob({
        fileId,
        source: { kind: "page", page_id: facts.sourcePageId },
      });
      expect(bytes.bytes.length).toBeGreaterThan(60);
      await expect(client.readFileBlob({ fileId, source: { kind: "direct" } })).rejects.toThrow();
    }
    const readOnlyPageId = context.manifest.pageIdsByKey.readOnly;
    if (!readOnlyPageId) throw new Error("Read-only fixture Page is missing");
    const root = createCoreLibraryModuleAdapter({
      client: context.runtime.rootClient,
      ...context.runtime.identity,
    });
    const readHead = async () => {
      const result = await context.runtime.rootClient.documentRead(createUuidV7(), {
        kind: "descriptor",
        owner_block_id: readOnlyPageId,
      });
      if (result.value.kind !== "descriptor") throw new Error("Read-only Document is missing");
      const head = result.value.descriptor;
      return {
        documentId: head.documentId,
        generation: head.generation,
        expectedHeadSeq: head.headSeq,
      };
    };
    const initialHead = await readHead();
    const childId = createUuidV7();
    const created = await root.apply({
      operationId: createUuidV7(),
      storeEpoch: context.runtime.identity.storeEpoch,
      operation: {
        kind: "create_page",
        pageId: childId,
        documentId: createUuidV7(),
        title: "Protected child",
        parent: {
          kind: "page",
          pageId: readOnlyPageId,
          expectedDocumentGeneration: initialHead.generation,
          expectedDocumentHeadSeq: initialHead.expectedHeadSeq,
          insertion: { kind: "append" },
        },
      },
    });
    expect(created.ok).toBe(true);
    const sourceHead = await readHead();
    const library = createCoreLibraryModuleAdapter({
      client,
      ...context.runtime.identity,
      editorHistoryOwnerId: createUuidV7(),
    });
    const before = await library.readProjectPageDetail(context.manifest.projectId, readOnlyPageId);
    if (!before.ok) throw new Error("Read-only fixture Page is not readable");
    const selection = {
      sourceDocumentId: sourceHead.documentId,
      sourceHead,
      rootBlockIds: [childId],
    };
    const captured = await library.apply({
      operationId: createUuidV7(),
      storeEpoch: context.runtime.identity.storeEpoch,
      operation: {
        kind: "apply_structural_edit",
        command: { kind: "capture_clipboard", selection },
      },
    });
    if (!captured.ok || !captured.value.structuralEdit?.clipboard)
      throw new Error("Read-only content could not be copied");
    const denied = await library.apply({
      operationId: createUuidV7(),
      storeEpoch: context.runtime.identity.storeEpoch,
      operation: {
        kind: "apply_structural_edit",
        command: {
          kind: "delete_selection",
          selection,
          direction: "forward",
          reason: { kind: "cut", bundle: captured.value.structuralEdit.clipboard },
        },
      },
    });
    expect(denied).toMatchObject({ ok: false, error: { code: "resource_not_found" } });
    const after = await library.readProjectPageDetail(context.manifest.projectId, readOnlyPageId);
    expect(after).toMatchObject({
      ok: true,
      value: {
        page: {
          lifecycle: "active",
          documentHeadSeq: sourceHead.expectedHeadSeq,
        },
      },
    });
  });
});
