import { expect, test } from "vite-plus/test";
import { createUuidV7 } from "../../shared/uuid-v7";
import { createCoreLibraryModuleAdapter } from "./library-module-adapter";
import { withCoreScenario } from "../../../scripts/scenarios/harness/core-scenario-harness";
import {
  STRUCTURAL_INTERACTIONS_PRESSURE_SCENARIO_ID,
  STRUCTURAL_INTERACTIONS_SCENARIO_ID,
  requireStructuralInteractionsFacts,
} from "../../../scripts/scenarios/scenarios/structural-interactions";

test("the pressure scenario creates its complete nested body with stable root identities", async () => {
  await withCoreScenario(
    { scenarioId: STRUCTURAL_INTERACTIONS_PRESSURE_SCENARIO_ID },
    async (context) => {
      const facts = requireStructuralInteractionsFacts(context.facts);
      const roots = await context.seed.readPageBlockTree(
        context.manifest.projectId,
        facts.sourcePageId,
      );
      expect(roots.map((root) => root.type)).toEqual([
        "paragraph",
        "paragraph",
        "image",
        "paragraph",
        "page",
      ]);
      expect(roots[4]?.id).toBe(facts.embeddedPageId);
      expect(roots[1]).toMatchObject({ id: facts.paragraphRootId, type: "paragraph" });
      expect(roots[1]?.children).toHaveLength(273);
      expect(roots[2]).toMatchObject({ id: facts.imageRootId, type: "image" });
    },
  );
});

test("structural edits and File reads work across Project routing with exact Document heads", async () => {
  await withCoreScenario({ scenarioId: STRUCTURAL_INTERACTIONS_SCENARIO_ID }, async (context) => {
    const facts = requireStructuralInteractionsFacts(context.facts);
    const client = context.runtime.clientForProject(context.manifest.projectId);
    for (const fileId of [facts.sharedFileId, facts.secondFileId]) {
      const bytes = await client.readFileBlob({
        fileId,
        source: { kind: "page", page_id: facts.sourcePageId },
      });
      expect(bytes.bytes.length).toBeGreaterThan(60);
      const direct = await client.readFileBlob({ fileId, source: { kind: "direct" } });
      expect(direct.bytes).toEqual(bytes.bytes);
    }
    const targetPageId = context.manifest.pageIdsByKey.readOnly;
    if (!targetPageId) throw new Error("Target Page is missing");
    const root = createCoreLibraryModuleAdapter({
      client: context.runtime.rootClient,
      ...context.runtime.identity,
    });
    const readHead = async () => {
      const result = await context.runtime.rootClient.documentRead(createUuidV7(), {
        kind: "descriptor",
        owner_block_id: targetPageId,
      });
      if (result.value.kind !== "descriptor") throw new Error("Target Document is missing");
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
          pageId: targetPageId,
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
    const before = await library.readProjectPageDetail(context.manifest.projectId, targetPageId);
    if (!before.ok) throw new Error("Target Page is not readable");
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
      throw new Error("Target content could not be copied");
    const cut = await library.apply({
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
    expect(cut).toMatchObject({
      ok: true,
      value: { structuralEdit: { sourceRootBlockIds: [childId] } },
    });
    const after = await library.readProjectPageDetail(context.manifest.projectId, targetPageId);
    if (!after.ok) throw new Error(after.error.message);
    expect(after.value.page.documentHeadSeq).toBeGreaterThan(sourceHead.expectedHeadSeq);
    expect(after).toMatchObject({
      ok: true,
      value: {
        page: {
          lifecycle: "active",
          documentHeadSeq: expect.any(Number),
        },
      },
    });
  });
});
