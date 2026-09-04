import { expect, test } from "vite-plus/test";
import { withCoreScenario } from "../../../scripts/scenarios/harness/core-scenario-harness";
import { DOCUMENT_SYNC_RECOVERY_SCENARIO_ID } from "../../../scripts/scenarios/scenarios/document-sync-recovery";
import type {
  LibraryApplyOperation,
  LibraryStructuralHistoryToken,
} from "../../shared/library-module";
import { createUuidV7 } from "../../shared/uuid-v7";
import { createCoreLibraryModuleAdapter } from "./library-module-adapter";
import { CoreClient } from "./core-client";
import type { CoreEventEnvelope } from "./types";

test("Cut supersession and release reach independent Core recipients without exposing inverse contents", async () => {
  await withCoreScenario({ scenarioId: DOCUMENT_SYNC_RECOVERY_SCENARIO_ID }, async (ctx) => {
    const client = ctx.runtime.clientForProject(ctx.manifest.projectId);
    const broker = ctx.runtime.rootClient;
    const otherBroker = await CoreClient.connect({
      nodexHome: ctx.profile.nodexHome,
      clientKind: "electron_host",
      buildId: "history-lifecycle-recipient",
    });
    const library = createCoreLibraryModuleAdapter({ client, ...ctx.runtime.identity });
    const scope = {
      kind: "project" as const,
      projectId: ctx.manifest.projectId,
      libraryId: ctx.runtime.identity.libraryId,
    };
    const first: CoreEventEnvelope[] = [];
    const second: CoreEventEnvelope[] = [];
    const repairs: unknown[] = [];
    const left = await broker.openProjectionEventStream(
      [scope],
      (event) => first.push(event),
      (repair) => repairs.push(repair),
    );
    let right: Awaited<ReturnType<typeof broker.openProjectionEventStream>> | undefined;
    const apply = async (operation: LibraryApplyOperation) => {
      const result = await library.apply({
        operationId: createUuidV7(),
        storeEpoch: ctx.runtime.identity.storeEpoch,
        operation,
      });
      if (!result.ok) throw new Error(result.error.message);
      if (!result.value.structuralEdit) throw new Error("Missing structural receipt");
      return { ...result.value.structuralEdit, commitSeq: result.value.commitSeq };
    };
    const read = async (tokens: readonly LibraryStructuralHistoryToken[]) => {
      const result = await library.read({ read: { mode: "structural_history_states", tokens } });
      if (!result.ok) throw new Error(result.error.message);
      if (result.value.value.kind !== "structural_history_states")
        throw new Error("Missing history states");
      return result.value.value.items;
    };
    const head = async (pageId: string) => {
      const result = await client.documentRead(createUuidV7(), {
        kind: "descriptor",
        owner_block_id: pageId,
      });
      if (result.value.kind !== "descriptor") throw new Error("Missing document descriptor");
      const descriptor = result.value.descriptor;
      return {
        documentId: descriptor.documentId,
        generation: descriptor.generation,
        expectedHeadSeq: descriptor.headSeq,
      };
    };
    try {
      right = await otherBroker.openProjectionEventStream(
        [scope],
        (event) => second.push(event),
        (repair) => repairs.push(repair),
      );
      const sourceHead = await head(ctx.manifest.pageIdsByKey.source!);
      const selection = {
        sourceDocumentId: sourceHead.documentId,
        rootBlockIds: [ctx.manifest.pageIdsByKey.child!],
        sourceHead,
      };
      const captured = await apply({
        kind: "apply_structural_edit",
        command: { kind: "capture_clipboard", selection },
      });
      if (!captured.clipboard) throw new Error("Missing clipboard capability");
      const cut = await apply({
        kind: "apply_structural_edit",
        command: {
          kind: "delete_selection",
          selection,
          reason: { kind: "cut", bundle: captured.clipboard },
          direction: "forward",
        },
      });
      if (!cut.history) throw new Error("Missing Cut history");
      expect(await read([cut.history])).toEqual([{ token: cut.history, state: "available" }]);
      expect(await read([{ ...cut.history, recipeHash: "0".repeat(64) }])).toEqual([
        { token: { ...cut.history, recipeHash: "0".repeat(64) }, state: "unavailable" },
      ]);
      const targetHead = await head(ctx.manifest.pageIdsByKey.other!);
      const pasted = await apply({
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
      expect(await read([cut.history, pasted.history])).toEqual([
        { token: cut.history, state: "superseded" },
        { token: pasted.history, state: "available" },
      ]);
      const restored = await apply({ kind: "reverse_structural_edit", token: pasted.history });
      if (!restored.history) throw new Error("Missing destination Redo history");
      const sourceChildren = await library.read({
        read: {
          mode: "children",
          parent: { kind: "page", pageId: ctx.manifest.pageIdsByKey.source! },
          limit: 100,
        },
      });
      if (!sourceChildren.ok || sourceChildren.value.value.kind !== "children")
        throw new Error("Missing source children");
      expect(
        sourceChildren.value.value.items.some(
          (item) => item.kind === "page" && item.pageId === ctx.manifest.pageIdsByKey.child,
        ),
      ).toBe(true);
      expect(await read([cut.history, pasted.history, restored.history])).toEqual([
        { token: cut.history, state: "superseded" },
        { token: pasted.history, state: "consumed" },
        { token: restored.history, state: "available" },
      ]);
      const redone = await apply({ kind: "reverse_structural_edit", token: restored.history });
      if (!redone.history) throw new Error("Missing redone Paste history");
      const released = await apply({
        kind: "apply_structural_edit",
        command: { kind: "release_history", tokens: [redone.history] },
      });
      expect(await read([redone.history])).toEqual([{ token: redone.history, state: "consumed" }]);
      const repeatedRelease = await library.apply({
        operationId: createUuidV7(),
        storeEpoch: ctx.runtime.identity.storeEpoch,
        operation: {
          kind: "apply_structural_edit",
          command: { kind: "release_history", tokens: [redone.history] },
        },
      });
      expect(repeatedRelease).toMatchObject({ ok: true, localCommit: { status: "no_op" } });
      for (const events of [first, second]) {
        await expect
          .poll(
            () =>
              events.some(
                (event) => event.packet.manifest.identity.commit_seq === released.commitSeq,
              ),
            { timeout: 15_000 },
          )
          .toBe(true);
        for (const commitSeq of [
          cut.commitSeq,
          pasted.commitSeq,
          restored.commitSeq,
          redone.commitSeq,
          released.commitSeq,
        ]) {
          const packet = events.find(
            (event) => event.packet.manifest.identity.commit_seq === commitSeq,
          )?.packet;
          const effect = packet?.projection_effects.find(
            (effect) => effect.scope.scope.kind === "structural_history",
          );
          expect(effect).toMatchObject({
            scope: { scope: { kind: "structural_history", project_id: ctx.manifest.projectId } },
            patch: null,
            requires_read_at_least: true,
          });
        }
      }
      expect(repairs).toEqual([]);
      const oversized = await library.read({
        read: {
          mode: "structural_history_states",
          tokens: Array.from({ length: 201 }, (_, index) => ({
            ...cut.history!,
            recipeOperationId: `recipe:${index}`,
          })),
        },
      });
      expect(oversized.ok).toBe(false);
      const stale = await library.read({
        read: {
          mode: "structural_history_states",
          tokens: [{ ...cut.history, storeEpoch: "other-epoch" }],
        },
      });
      expect(stale).toMatchObject({ ok: false, error: { code: "store_epoch_mismatch" } });
    } finally {
      await Promise.all([left.close(), right?.close()]);
    }
  });
});
