import { expect, test } from "vite-plus/test";
import { withCoreScenario } from "../../../scripts/scenarios/harness/core-scenario-harness";
import { DOCUMENT_SYNC_RECOVERY_SCENARIO_ID } from "../../../scripts/scenarios/scenarios/document-sync-recovery";
import type {
  LibraryApplyOperation,
  LibraryStructuralHistoryToken,
} from "../../shared/library-module";
import { createUuidV7 } from "../../shared/uuid-v7";
import { createCoreLibraryModuleAdapter } from "./library-module-adapter";

test("Library history uses real Library authority while Project history stays scoped", async () => {
  await withCoreScenario({ scenarioId: DOCUMENT_SYNC_RECOVERY_SCENARIO_ID }, async (ctx) => {
    const other = await ctx.seed.createProject({
      name: "Independent history authority",
      sources: [ctx.profile.initialProjectsDirectory],
    });
    const pageId = createUuidV7();
    const childId = createUuidV7();
    const childDocumentId = createUuidV7();
    await ctx.seed.createPage({
      key: "foreign-source",
      projectId: other.id,
      pageId,
      operationId: createUuidV7(),
      status: "build",
      title: "Other Project",
      nfm: "Other content",
    });
    await ctx.seed.createStandalonePage({
      projectId: other.id,
      pageId: childId,
      documentId: childDocumentId,
      parentPageId: pageId,
      operationId: createUuidV7(),
      title: "Retained child",
    });
    const adapter = (projectId?: string) =>
      createCoreLibraryModuleAdapter({
        client: projectId ? ctx.runtime.clientForProject(projectId) : ctx.runtime.rootClient,
        ...ctx.runtime.identity,
        editorHistoryOwnerId: createUuidV7(),
      });
    const library = adapter();
    const project = adapter(ctx.manifest.projectId);
    const source = adapter(other.id);
    const head = async (ownerBlockId: string) => {
      const result = await ctx.runtime.rootClient.documentRead(createUuidV7(), {
        kind: "descriptor",
        owner_block_id: ownerBlockId,
      });
      if (result.value.kind !== "descriptor") throw new Error("Missing descriptor");
      return {
        documentId: result.value.descriptor.documentId,
        generation: result.value.descriptor.generation,
        expectedHeadSeq: result.value.descriptor.headSeq,
      };
    };
    const request = (operation: LibraryApplyOperation) => ({
      operationId: createUuidV7(),
      storeEpoch: ctx.runtime.identity.storeEpoch,
      operation,
    });
    const apply = async (owner: ReturnType<typeof adapter>, operation: LibraryApplyOperation) => {
      const result = await owner.apply(request(operation));
      if (!result.ok || !result.value.structuralEdit) throw new Error(JSON.stringify(result));
      return result.value.structuralEdit;
    };
    const state = async (
      owner: ReturnType<typeof adapter>,
      token: LibraryStructuralHistoryToken,
    ) => {
      const result = await owner.read({
        read: { mode: "structural_history_states", tokens: [token] },
      });
      if (!result.ok || result.value.value.kind !== "structural_history_states")
        throw new Error(JSON.stringify(result));
      return result.value.value.items[0]?.state;
    };
    const selection = async () => {
      const sourceHead = await head(pageId);
      return { sourceDocumentId: sourceHead.documentId, rootBlockIds: [childId], sourceHead };
    };
    const denied = await project.apply(
      request({
        kind: "apply_structural_edit",
        command: {
          kind: "delete_selection",
          selection: await selection(),
          reason: { kind: "delete" },
          direction: "forward",
        },
      }),
    );
    expect(denied.ok).toBe(false);
    const deleted = await apply(source, {
      kind: "apply_structural_edit",
      command: {
        kind: "delete_selection",
        selection: await selection(),
        reason: { kind: "delete" },
        direction: "forward",
      },
    });
    if (!deleted.history) throw new Error("Missing delete history");
    expect(await state(project, deleted.history)).toBe("unavailable");
    expect(await state(library, deleted.history)).toBe("available");
    expect(
      (await project.apply(request({ kind: "reverse_structural_edit", token: deleted.history })))
        .ok,
    ).toBe(false);
    const restored = await apply(library, {
      kind: "reverse_structural_edit",
      token: deleted.history,
    });
    expect(restored.resultRootBlockIds).toContain(childId);
    expect((await head(childId)).documentId).toBe(childDocumentId);
    expect(await state(source, deleted.history)).toBe("consumed");

    const selected = await selection();
    const captured = await apply(source, {
      kind: "apply_structural_edit",
      command: {
        kind: "capture_clipboard",
        selection: selected,
      },
    });
    if (!captured.clipboard) throw new Error("Missing clipboard");
    const cut = await apply(source, {
      kind: "apply_structural_edit",
      command: {
        kind: "delete_selection",
        selection: selected,
        reason: { kind: "cut", bundle: captured.clipboard },
        direction: "forward",
      },
    });
    if (!cut.history) throw new Error("Missing Cut history");
    const targetHead = await head(ctx.manifest.pageIdsByKey.other!);
    const pasted = await apply(library, {
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
    if (!pasted.history) throw new Error("Missing Paste history");
    expect(pasted.resultRootBlockIds).toContain(childId);
    expect(await state(source, cut.history)).toBe("superseded");
    const returned = await apply(library, {
      kind: "reverse_structural_edit",
      token: pasted.history,
    });
    expect(returned.resultRootBlockIds).toContain(childId);
    expect((await head(childId)).documentId).toBe(childDocumentId);
    if (!returned.history || !restored.history) throw new Error("Missing inverse history");
    await apply(library, {
      kind: "apply_structural_edit",
      command: {
        kind: "release_history",
        tokens: [cut.history, returned.history, restored.history],
      },
    });
    expect(await state(library, returned.history)).toBe("consumed");
  });
});
