import { expect, test } from "vite-plus/test";
import * as Y from "yjs";
import {
  withCoreScenario,
  type CoreScenarioContext,
} from "../../../scripts/scenarios/harness/core-scenario-harness";
import { DOCUMENT_SYNC_RECOVERY_SCENARIO_ID } from "../../../scripts/scenarios/scenarios/document-sync-recovery";
import {
  LIBRARY_FILES_SCENARIO_ID,
  LIBRARY_FILES_PAGE_A_KEY,
  requireLibraryFilesScenarioFacts,
} from "../../../scripts/scenarios/scenarios/library-files";
import { materializePageDocument } from "../../shared/block-documents/block-document-codec";
import { createUuidV7 } from "../../shared/uuid-v7";
import { createCoreDocumentSyncAdapter } from "./document-sync-adapter";
import type { CoreClientPort } from "./types";
import type { components } from "@nodex/core-protocol";

type LibraryStructuralHistoryToken = components["schemas"]["LibraryStructuralHistoryToken"];

const promotionTarget = async (
  ctx: CoreScenarioContext,
  destination: "library" | "data_source",
): Promise<components["schemas"]["LibraryBlockTransferTarget"]> => {
  if (destination === "data_source") {
    const view = await ctx.runtime
      .clientForProject(ctx.manifest.projectId)
      .databaseRead({ kind: "view", view_id: ctx.manifest.databaseViewId! });
    if (view.value.kind !== "view") throw new Error("Missing destination View");
    return {
      kind: "data_source",
      data_source_id: view.value.value.data_source_id,
      placement: {
        kind: "direct",
        view_id: ctx.manifest.databaseViewId!,
        group_key: "build",
        before_page_id: null,
        sorted_property_values: [],
        preferences_override: {
          rules_override: { property_filters: null, advanced_filter: null, sorts: null },
          presentation_override: {
            group: null,
            subgroup: null,
            group_direction: null,
            completion: null,
            hierarchy: null,
            display: null,
          },
        },
      },
    };
  }
  const library = await ctx.runtime.rootClient.libraryRead({
    kind: "children",
    parent: { kind: "library" },
    cursor: null,
    limit: 100,
    force_include_target: null,
  });
  if (library.value.kind !== "children") throw new Error("Missing Library children");
  const first = library.value.items[0]!;
  if (first.kind === "view") throw new Error("A View cannot be a Library root");
  const before =
    first.kind === "page"
      ? first.page_id
      : first.kind === "canvas"
        ? first.canvas_id
        : first.database_id;
  return { kind: "library", library_id: ctx.runtime.identity.libraryId, before_block_id: before };
};

const readRow = async (client: CoreClientPort, pageId: string) => {
  const row = await client.databaseRead({ kind: "row_detail", page_id: pageId });
  if (row.value.kind !== "row_detail") throw new Error("Missing promoted row");
  return row.value.value.summary;
};

const readDocument = async (client: CoreClientPort, documentId: string) => {
  const document = new Y.Doc({ guid: documentId });
  const clientSessionId = createUuidV7();
  const stream = await client.openDocumentEventStream(
    { documentId, clientSessionId },
    () => undefined,
    () => undefined,
    () => undefined,
  );
  try {
    const result = await createCoreDocumentSyncAdapter(client).sync({
      documentId,
      clientSessionId,
      stateVector: Y.encodeStateVector(document),
    });
    if (!result.ok) throw new Error(result.error.message);
    Y.applyUpdate(document, result.value.update);
    return { ...result.value, materialization: materializePageDocument(document) };
  } finally {
    await stream.close();
    document.destroy();
  }
};

test.each([
  ["copy", "library"],
  ["move", "library"],
  ["copy", "data_source"],
  ["move", "data_source"],
] as const)(
  "%s promotion into %s preserves shared File identity through changing heads and history",
  async (mode, destination) => {
    await withCoreScenario({ scenarioId: LIBRARY_FILES_SCENARIO_ID }, async (ctx) => {
      const client = ctx.runtime.clientForProject(ctx.manifest.projectId);
      const facts = requireLibraryFilesScenarioFacts(ctx.facts);
      const pageId = ctx.manifest.pageIdsByKey[LIBRARY_FILES_PAGE_A_KEY]!;
      const descriptor = await createCoreDocumentSyncAdapter(client).readDescriptor({
        ownerBlockId: pageId,
        clientSessionId: createUuidV7(),
      });
      const source = await readDocument(client, descriptor.documentId);
      const promoted = await client.libraryApply({
        operationId: createUuidV7(),
        intent: {
          kind: "transfer_blocks",
          intent: {
            actor: { kind: "electron_host" },
            mode,
            root_block_ids: source.materialization.blockTree.map((block) => block.id),
            source: { kind: "document", document_id: descriptor.documentId },
            causal_dependencies: [
              {
                document_id: descriptor.documentId,
                generation: source.generation,
                expected_head_seq: source.headSeq,
              },
            ],
            target: await promotionTarget(ctx, destination),
            promotion_policy: "literal",
          },
        },
      });
      const transfer = promoted.outcome.block_transfer!;
      const promotedPageId = transfer.result_root_block_ids[0]!;
      let token = transfer.history!;
      expect(token).toBeDefined();
      const before = await ctx.seed.readPageFileInventory(ctx.manifest.projectId, promotedPageId);
      expect(before.files).toHaveLength(1);
      expect(before.files[0]).toMatchObject({
        file: { file_id: facts.sharedFileId, head_version: 1 },
        logical_path: null,
        body_count: 1,
      });
      const bytes = await client.readFileBlob({
        fileId: facts.sharedFileId,
        source: { kind: "direct" },
      });
      const advanceFile = async (version: number) => {
        const operationId = createUuidV7();
        const prepared = await client.prepareFileBlob({
          operationId,
          bytes: new Uint8Array([...bytes.bytes, version]),
        });
        await client.libraryApply({
          operationId,
          intent: {
            kind: "apply_file_change",
            turn_id: null,
            change: {
              kind: "replace_content",
              file_id: facts.sharedFileId,
              expected_revision: version - 1,
              expected_head_version: version - 1,
              mime_type: "image/png",
              prepared_blob_receipt_id: prepared.receipt_id,
            },
          },
        });
      };
      await advanceFile(2);
      let headVersion = 2;
      for (const direction of ["undo", "redo", "undo", "redo"] as const) {
        const reversed = await client.libraryApply({
          operationId: createUuidV7(),
          intent: { kind: "reverse_structural_edit", token },
        });
        token = reversed.outcome.structural_edit!.history!;
        expect(token).toBeDefined();
        if (direction === "undo" && headVersion === 2) {
          // Redo must follow a newer shared head, not guard or restore the
          // head that existed when the inverse capability was captured.
          await advanceFile(3);
          headVersion = 3;
        }
        const original = await ctx.seed.readPageFileInventory(ctx.manifest.projectId, pageId);
        expect(original.files[0]).toMatchObject({
          file: { file_id: facts.sharedFileId, head_version: headVersion, revision: headVersion },
          logical_path: facts.pageAPath,
        });
        if (direction !== "redo") continue;
        const restored = await ctx.seed.readPageFileInventory(
          ctx.manifest.projectId,
          promotedPageId,
        );
        expect(restored.files).toHaveLength(1);
        expect(restored.files[0]).toMatchObject({
          file: { file_id: facts.sharedFileId, head_version: headVersion, revision: headVersion },
          logical_path: null,
          body_count: 1,
        });
        expect(reversed.outcome.structural_edit!.result_root_block_ids).toEqual(
          transfer.result_root_block_ids,
        );
      }
    });
  },
);

test.each(["copy", "move"] as const)(
  "%s promotion Undo and Redo preserve the Page, Document and body identities",
  async (mode) => {
    await withCoreScenario({ scenarioId: DOCUMENT_SYNC_RECOVERY_SCENARIO_ID }, async (ctx) => {
      const client = ctx.runtime.clientForProject(ctx.manifest.projectId);
      const documentId = ctx.manifest.entityIdsByKey!.sourceDocument!;
      const source = await readDocument(client, documentId);
      const promoted = await client.libraryApply({
        operationId: createUuidV7(),
        intent: {
          kind: "transfer_blocks",
          intent: {
            actor: { kind: "electron_host" },
            mode,
            root_block_ids: [source.materialization.blockTree[0]!.id],
            causal_dependencies: [
              {
                document_id: documentId,
                generation: source.generation,
                expected_head_seq: source.headSeq,
              },
            ],
            source: { kind: "document", document_id: documentId },
            target: {
              kind: "library",
              library_id: ctx.runtime.identity.libraryId,
              before_block_id: null,
            },
            promotion_policy: "literal",
          },
        },
      });
      const transfer = promoted.outcome.block_transfer!;
      const token = transfer.undo_token!;
      const targetDocumentId = transfer.document_commits.find(
        (commit) => commit.document_id !== documentId,
      )!.document_id;
      const before = await readDocument(client, targetDocumentId);
      const sourceAfterPromotion = await readDocument(client, documentId);
      const undone = await client.libraryApply({
        operationId: createUuidV7(),
        intent: { kind: "undo_block_transfer", token },
      });
      for (const pageId of transfer.result_root_block_ids) {
        expect(undone.receipt.committed_revisions[`blockMetadata:${pageId}`]).toBeGreaterThan(1);
        expect(undone.receipt.committed_revisions[`blockLocation:${pageId}`]).toBeGreaterThan(1);
      }
      const history = undone.outcome.block_transfer_undo?.history;
      expect(history, "Undo must return the inverse of its committed result").toBeDefined();
      if (!history) throw new Error("Promotion Undo omitted Redo");
      const redone = await client.libraryApply({
        operationId: createUuidV7(),
        intent: { kind: "reverse_structural_edit", token: history },
      });
      expect(redone.outcome.structural_edit?.result_root_block_ids).toEqual(
        transfer.result_root_block_ids,
      );
      const after = await readDocument(client, targetDocumentId);
      expect(after.generation).toBe(before.generation);
      if (mode === "copy") expect(after.headSeq).toBe(before.headSeq);
      expect(after.materialization).toEqual(before.materialization);
      expect((await readDocument(client, documentId)).materialization).toEqual(
        sourceAfterPromotion.materialization,
      );
      const nextUndo = redone.outcome.structural_edit?.history;
      expect(nextUndo).toBeDefined();
      if (!nextUndo) throw new Error("Redo omitted its inverse");
      const undoneAgain = await client.libraryApply({
        operationId: createUuidV7(),
        intent: { kind: "reverse_structural_edit", token: nextUndo },
      });
      expect(undoneAgain.outcome.structural_edit?.history).toBeDefined();
      expect((await readDocument(client, documentId)).materialization).toEqual(
        source.materialization,
      );
    });
  },
);

test.each([
  { mode: "copy", destination: "library" },
  { mode: "move", destination: "library" },
  { mode: "copy", destination: "data_source" },
  { mode: "move", destination: "data_source" },
] as const)(
  "$mode promotion into $destination round-trips a whole rich forest with a wrapped root",
  async ({ mode, destination }) => {
    await withCoreScenario({ scenarioId: DOCUMENT_SYNC_RECOVERY_SCENARIO_ID }, async (ctx) => {
      const client = ctx.runtime.clientForProject(ctx.manifest.projectId);
      const documentId = ctx.manifest.entityIdsByKey!.otherDocument!;
      await ctx.seed.replaceOwnedDocument({
        projectId: ctx.manifest.projectId,
        pageId: ctx.manifest.pageIdsByKey.other!,
        operationId: createUuidV7(),
        mutationId: createUuidV7(),
        clientSessionId: createUuidV7(),
        nfm: "▶ **Promoted title**\n\tA rich **body**\n\t▶ Nested content\n\t\tDeep body\n- [x] Wrapped task\n\tWrapped child",
      });
      const source = await readDocument(client, documentId);
      expect(source.materialization.blockTree).toHaveLength(2);
      const target = await promotionTarget(ctx, destination);
      const promoted = await client.libraryApply({
        operationId: createUuidV7(),
        intent: {
          kind: "transfer_blocks",
          intent: {
            actor: { kind: "electron_host" },
            mode,
            root_block_ids: source.materialization.blockTree.map((block) => block.id),
            source: { kind: "document", document_id: documentId },
            causal_dependencies: [
              {
                document_id: documentId,
                generation: source.generation,
                expected_head_seq: source.headSeq,
              },
            ],
            target,
            promotion_policy: "literal",
          },
        },
      });
      const transfer = promoted.outcome.block_transfer!;
      const targetDocumentIds = transfer.document_commits
        .filter((commit) => commit.document_id !== documentId)
        .map((commit) => commit.document_id);
      expect(targetDocumentIds).toHaveLength(2);
      const before = await Promise.all(targetDocumentIds.map((id) => readDocument(client, id)));
      const sourcePost = await readDocument(client, documentId);
      const rowsBefore =
        destination === "data_source"
          ? await Promise.all(transfer.result_root_block_ids.map((id) => readRow(client, id)))
          : [];
      const forwardHistory = transfer.history;
      if (!forwardHistory) throw new Error("Promotion omitted its symmetric history capability");
      let history: LibraryStructuralHistoryToken = forwardHistory;
      for (const direction of ["undo", "redo", "undo", "redo"] as const) {
        const result = await client
          .libraryApply({
            operationId: createUuidV7(),
            intent: { kind: "reverse_structural_edit", token: history },
          })
          .catch((error: unknown) => {
            throw new Error(`${direction} failed: ${String(error)}`, { cause: error });
          });
        expect(
          result.outcome.structural_edit?.history,
          `${direction} must return the next inverse`,
        ).toBeDefined();
        expect(result.outcome.structural_edit?.result_root_block_ids).toEqual(
          direction === "redo"
            ? transfer.result_root_block_ids
            : mode === "move"
              ? source.materialization.blockTree.map((block) => block.id)
              : [],
        );
        expect(result.outcome.structural_edit?.source_root_block_ids).toEqual(
          direction === "undo"
            ? transfer.result_root_block_ids
            : source.materialization.blockTree.map((block) => block.id),
        );
        const inverse = result.outcome.structural_edit?.history;
        if (!inverse) throw new Error(`${direction} omitted the committed opposite inverse`);
        history = inverse;
        const currentSource = await readDocument(client, documentId);
        expect(currentSource.materialization).toEqual(
          direction === "undo" ? source.materialization : sourcePost.materialization,
        );
        if (direction !== "redo") {
          for (const row of rowsBefore) {
            await expect(readRow(client, row.page_id)).rejects.toMatchObject({
              coreError: { code: "not_found" },
            });
          }
          continue;
        }
        const restored = await Promise.all(targetDocumentIds.map((id) => readDocument(client, id)));
        expect(restored.map((doc) => doc.materialization)).toEqual(
          before.map((doc) => doc.materialization),
        );
        expect(restored.map((doc) => doc.generation)).toEqual(before.map((doc) => doc.generation));
        if (mode === "move") expect(restored[0]!.headSeq).toBeGreaterThan(before[0]!.headSeq);
        for (const row of rowsBefore) {
          const current = await readRow(client, row.page_id);
          expect(current).toMatchObject({
            page_id: row.page_id,
            page_key: row.page_key,
            membership_id: row.membership_id,
            database_values: row.database_values,
            intrinsic_properties: row.intrinsic_properties,
          });
          expect(current.membership_revision).toBeGreaterThan(row.membership_revision);
          if (target.kind === "data_source") {
            expect(
              result.receipt.committed_revisions[
                `membership:${target.data_source_id}:${current.membership_id}`
              ],
            ).toBe(current.membership_revision);
          }
        }
      }
      if (mode !== "move") return;
      const undone = await client.libraryApply({
        operationId: createUuidV7(),
        intent: { kind: "reverse_structural_edit", token: history },
      });
      const oldRedo = undone.outcome.structural_edit!.history!;
      const newSource = await readDocument(client, documentId);
      const newPromotion = await client.libraryApply({
        operationId: createUuidV7(),
        intent: {
          kind: "transfer_blocks",
          intent: {
            actor: { kind: "electron_host" },
            mode,
            root_block_ids: source.materialization.blockTree.map((block) => block.id),
            source: { kind: "document", document_id: documentId },
            causal_dependencies: [
              {
                document_id: documentId,
                generation: newSource.generation,
                expected_head_seq: newSource.headSeq,
              },
            ],
            target,
            promotion_policy: "literal",
          },
        },
      });
      const newTransfer = newPromotion.outcome.block_transfer!;
      expect(newTransfer.result_root_block_ids[0]).toBe(transfer.result_root_block_ids[0]);
      const newDocumentIds = newTransfer.document_commits
        .filter((commit) => commit.document_id !== documentId)
        .map((commit) => commit.document_id);
      expect(newDocumentIds.every((id) => !targetDocumentIds.includes(id))).toBe(true);
      for (const id of newDocumentIds) await readDocument(client, id);
      if (destination === "data_source") {
        const row = await readRow(client, newTransfer.result_root_block_ids[0]!);
        expect(row.membership_id).toBe(rowsBefore[0]!.membership_id);
        expect(row.page_key).toBe(rowsBefore[0]!.page_key);
        if (target.kind === "data_source") {
          expect(
            newPromotion.receipt.committed_revisions[
              `membership:${target.data_source_id}:${row.membership_id}`
            ],
          ).toBe(row.membership_revision);
        }
      }
      await expect(
        client.libraryApply({
          operationId: createUuidV7(),
          intent: { kind: "reverse_structural_edit", token: oldRedo },
        }),
      ).rejects.toMatchObject({ coreError: { code: "revision_conflict" } });
    });
  },
);

test("promotion Undo authorizes every target before revealing an earlier target's changed content", async () => {
  await withCoreScenario({ scenarioId: DOCUMENT_SYNC_RECOVERY_SCENARIO_ID }, async (ctx) => {
    const client = ctx.runtime.clientForProject(ctx.manifest.projectId);
    const documentId = ctx.manifest.entityIdsByKey!.sourceDocument!;
    const source = await readDocument(client, documentId);
    const roots = source.materialization.blockTree.slice(0, 2).map((block) => block.id);
    const promoted = await client.libraryApply({
      operationId: createUuidV7(),
      intent: {
        kind: "transfer_blocks",
        intent: {
          actor: { kind: "electron_host" },
          mode: "move",
          root_block_ids: roots,
          causal_dependencies: [
            {
              document_id: documentId,
              generation: source.generation,
              expected_head_seq: source.headSeq,
            },
          ],
          source: { kind: "document", document_id: documentId },
          target: {
            kind: "library",
            library_id: ctx.runtime.identity.libraryId,
            before_block_id: null,
          },
          promotion_policy: "literal",
        },
      },
    });
    const token = promoted.outcome.block_transfer?.undo_token;
    if (!token) throw new Error("Promotion omitted its inverse");
    // The first target's head no longer matches the saved post-state.
    await ctx.seed.replaceOwnedDocument({
      projectId: ctx.manifest.projectId,
      pageId: roots[0]!,
      operationId: createUuidV7(),
      mutationId: createUuidV7(),
      clientSessionId: createUuidV7(),
      nfm: "A later edit that must remain private after access changes.",
    });
    // The second target is no longer authorized. This must dominate every
    // content comparison, regardless of the order of roots in the recipe.
    await ctx.runtime.rootClient.libraryApply({
      operationId: createUuidV7(),
      intent: {
        kind: "set_project_access",
        target: { kind: "page", page_id: roots[1]! },
        changes: [{ project_id: ctx.manifest.projectId, access: null, expected_revision: 1 }],
      },
    });
    await expect(
      client.libraryApply({
        operationId: createUuidV7(),
        intent: { kind: "undo_block_transfer", token },
      }),
    ).rejects.toMatchObject({ coreError: { code: "not_found" } });
  });
});
