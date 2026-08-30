import { describe, expect, test } from "vite-plus/test";

import { withCoreScenario } from "../../../scripts/scenarios/harness/core-scenario-harness";
import { createUuidV7 } from "../../shared/uuid-v7";
import { createCoreLibraryModuleAdapter } from "./library-module-adapter";
import {
  PAGE_RELOCATION_SCENARIO_ID,
  requirePageRelocationScenarioFacts,
} from "../../../scripts/scenarios/scenarios/page-relocation";

describe("library/page-relocation authoritative scenario", () => {
  test("moves one Page between primary Databases and restores it through typed Undo", async () => {
    await withCoreScenario({ scenarioId: PAGE_RELOCATION_SCENARIO_ID }, async (ctx) => {
      const facts = requirePageRelocationScenarioFacts(ctx.facts);
      const library = createCoreLibraryModuleAdapter({
        client: ctx.client,
        ...ctx.runtime.identity,
      });

      expect(facts.sourceProjectId).not.toBe(facts.targetProjectId);
      expect(facts.sourceViewId).not.toBe(facts.targetViewId);
      expect(facts.sourcePageId).not.toBe(facts.targetPageId);
      expect(facts.sourceRowCount).toBe(1);
      expect(facts.targetRowCount).toBe(1);

      const readViewWindow = (projectId: string, viewId: string) =>
        ctx.runtime.clientForProject(projectId).databaseRead({
          kind: "view_window",
          target: { kind: "view", view_id: viewId },
          window: { first: 100 },
        });
      const sourceBeforeMove = await readViewWindow(facts.sourceProjectId, facts.sourceViewId);
      if (sourceBeforeMove.value.kind !== "view_window") {
        throw new Error(`Unexpected Database read: ${sourceBeforeMove.value.kind}`);
      }
      expect(sourceBeforeMove.value.value.rows.items).toHaveLength(1);
      expect(sourceBeforeMove.value.value.rows.items[0]?.database_values.status).toBe("build");

      const [destinations, pageDestinations] = await Promise.all([
        library.read({
          read: {
            mode: "page_relocation_destinations",
            pageId: facts.sourcePageId,
            scope: { kind: "databases", query: "relocation beta" },
            limit: 100,
          },
        }),
        library.read({
          read: {
            mode: "page_relocation_destinations",
            pageId: facts.sourcePageId,
            scope: { kind: "page_search", query: "relocation beta" },
            limit: 100,
          },
        }),
      ]);
      if (!destinations.ok) {
        throw new Error(
          `Could not read Page relocation destinations: ${destinations.error.message}`,
        );
      }
      if (destinations.value.value.kind !== "page_relocation_destinations") {
        throw new Error(`Unexpected Library read: ${destinations.value.value.kind}`);
      }
      if (!pageDestinations.ok) {
        throw new Error(
          `Could not search Page relocation destinations: ${pageDestinations.error.message}`,
        );
      }
      const target = destinations.value.value.items.find((item) =>
        item.path.includes("Relocation Beta"),
      );
      if (!target) throw new Error("Target primary Database destination is missing");
      const moved = await library.apply({
        operationId: createUuidV7(),
        storeEpoch: ctx.runtime.identity.storeEpoch,
        operation: {
          kind: "move_page",
          pageId: facts.sourcePageId,
          destination: target.destination,
          expectedEtag: target.expectedMoveEtag,
        },
      });
      if (!moved.ok) throw new Error(`Page relocation failed: ${moved.error.message}`);
      const undoToken = moved.value.pageRelocation?.undoToken;
      if (!undoToken) throw new Error("Database Page relocation did not return Undo authority");

      const [sourceAfterMove, targetAfterMove] = await Promise.all([
        ctx.seed.readBoard(facts.sourceProjectId, facts.sourceViewId),
        ctx.seed.readBoard(facts.targetProjectId, facts.targetViewId),
      ]);
      expect(sourceAfterMove.totalRows).toBe(0);
      expect(targetAfterMove.totalRows).toBe(2);
      const targetWindowAfterMove = await readViewWindow(facts.targetProjectId, facts.targetViewId);
      if (targetWindowAfterMove.value.kind !== "view_window") {
        throw new Error(`Unexpected Database read: ${targetWindowAfterMove.value.kind}`);
      }
      expect(
        targetWindowAfterMove.value.value.rows.items.find(
          (row) => row.page_id === facts.sourcePageId,
        )?.database_values.status,
      ).toBe("triage");
      await expect(
        ctx.seed.readPage(facts.targetProjectId, facts.sourcePageId),
      ).resolves.toMatchObject({
        pageId: facts.sourcePageId,
        title: "Move this Page",
        documentReadiness: "ready",
      });

      const undone = await library.apply({
        operationId: createUuidV7(),
        storeEpoch: ctx.runtime.identity.storeEpoch,
        operation: { kind: "undo_page_relocation", token: undoToken },
      });
      if (!undone.ok) throw new Error(`Page relocation Undo failed: ${undone.error.message}`);
      expect(undone.value.pageRelocationUndo).toMatchObject({
        pageId: facts.sourcePageId,
        transferOperationId: undoToken.transferOperationId,
      });
      expect(undone.value.affectedViewIds).toEqual(
        expect.arrayContaining([facts.sourceViewId, facts.targetViewId]),
      );
      const [sourceAfterUndo, targetAfterUndo] = await Promise.all([
        ctx.seed.readBoard(facts.sourceProjectId, facts.sourceViewId),
        ctx.seed.readBoard(facts.targetProjectId, facts.targetViewId),
      ]);
      expect(sourceAfterUndo.totalRows).toBe(1);
      expect(targetAfterUndo.totalRows).toBe(1);
      const sourceWindowAfterUndo = await readViewWindow(facts.sourceProjectId, facts.sourceViewId);
      if (sourceWindowAfterUndo.value.kind !== "view_window") {
        throw new Error(`Unexpected Database read: ${sourceWindowAfterUndo.value.kind}`);
      }
      expect(sourceWindowAfterUndo.value.value.rows.items).toHaveLength(1);
      expect(sourceWindowAfterUndo.value.value.rows.items[0]?.database_values.status).toBe("build");

      const standaloneDestinations = await library.read({
        read: {
          mode: "page_relocation_destinations",
          pageId: facts.standalonePageId,
          scope: { kind: "databases", query: "relocation beta" },
          limit: 20,
        },
      });
      if (!standaloneDestinations.ok) {
        throw new Error(
          `Could not read standalone Page destinations: ${standaloneDestinations.error.message}`,
        );
      }
      if (standaloneDestinations.value.value.kind !== "page_relocation_destinations") {
        throw new Error(`Unexpected Library read: ${standaloneDestinations.value.value.kind}`);
      }
      const standaloneTarget = standaloneDestinations.value.value.items.find((item) =>
        item.path.includes("Relocation Beta"),
      );
      if (!standaloneTarget) throw new Error("Standalone Page Database target is missing");
      const standaloneMoved = await library.apply({
        operationId: createUuidV7(),
        storeEpoch: ctx.runtime.identity.storeEpoch,
        operation: {
          kind: "move_page",
          pageId: facts.standalonePageId,
          destination: standaloneTarget.destination,
          expectedEtag: standaloneTarget.expectedMoveEtag,
        },
      });
      if (!standaloneMoved.ok) {
        throw new Error(`Standalone Page relocation failed: ${standaloneMoved.error.message}`);
      }
      const standaloneUndoToken = standaloneMoved.value.pageRelocation?.undoToken;
      if (!standaloneUndoToken) throw new Error("Standalone Page relocation did not mint Undo");
      const rootsAfterMove = await library.read({
        read: { mode: "standalone_roots", limit: 100 },
      });
      if (!rootsAfterMove.ok || rootsAfterMove.value.value.kind !== "standalone_roots") {
        throw new Error("Could not inspect standalone roots after relocation");
      }
      expect(
        rootsAfterMove.value.value.items.some(
          (item) => item.kind === "page" && item.pageId === facts.standalonePageId,
        ),
      ).toBe(false);
      const standaloneUndone = await library.apply({
        operationId: createUuidV7(),
        storeEpoch: ctx.runtime.identity.storeEpoch,
        operation: { kind: "undo_page_relocation", token: standaloneUndoToken },
      });
      if (!standaloneUndone.ok) {
        throw new Error(`Standalone Page Undo failed: ${standaloneUndone.error.message}`);
      }
      const rootsAfterUndo = await library.read({
        read: { mode: "standalone_roots", limit: 100 },
      });
      if (!rootsAfterUndo.ok || rootsAfterUndo.value.value.kind !== "standalone_roots") {
        throw new Error("Could not inspect standalone roots after Undo");
      }
      expect(
        rootsAfterUndo.value.value.items.some(
          (item) => item.kind === "page" && item.pageId === facts.standalonePageId,
        ),
      ).toBe(true);
    });
  });
});
