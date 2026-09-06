import { describe, expect, test, vi } from "vite-plus/test";
import { createInteractionHistory } from "@/lib/surface-history/owner";
import {
  parseDatabaseViewId,
  parseDataSourceId,
  parseDataSourcePropertyId,
} from "../../../shared/database-identities";
import type {
  DatabaseDataEditUndoRecipeV2,
  DatabaseListMoveUndoRecipeV2,
} from "../../../shared/database-module-v2";
import {
  DatabaseViewMutationError,
  type commitDatabaseViewOperations,
  type DatabaseViewMutationReceipt,
} from "@/lib/database-view-row-mutations";
import {
  createDatabaseViewMutationHistory,
  databaseViewHistoryScopeKey,
} from "./database-view-mutation-history";
import {
  interpretDatabaseViewHistoryReceipt,
  type DatabaseViewOperationsCommand,
} from "./database-view-history-adapter";

const model: DatabaseViewOperationsCommand["model"] = {
  libraryId: "library",
  accessContext: { kind: "project", projectId: "project" },
  storeEpoch: "epoch",
  databaseViewId: parseDatabaseViewId("view"),
  readOnlyReason: null,
  viewName: "Tasks",
};
const scope = { accessContext: model.accessContext, storeEpoch: model.storeEpoch };
const address = {
  pageId: "page",
  dataSourceId: parseDataSourceId("source"),
  propertyId: parseDataSourcePropertyId("p_0123abcd"),
};
const recipe = (before = "old", after = "new"): DatabaseDataEditUndoRecipeV2 => ({
  propertyStates: [
    {
      address,
      propertyType: "text",
      beforeValue: { kind: "text", value: before },
      afterValue: { kind: "text", value: after },
    },
  ],
  positionStates: [],
});
const receipt = (
  undoRecipe: DatabaseDataEditUndoRecipeV2 | null = recipe(),
): DatabaseViewMutationReceipt => ({
  operationId: "operation",
  projectId: "project",
  libraryId: "library",
  storeEpoch: "epoch",
  duplicate: false,
  operationKinds: ["edit_property_values"],
  operationOutcomes: [{ kind: "data_edit", operationIndex: 0, operationCount: 1, undoRecipe }],
  affectedDatabaseIds: [],
  affectedDataSourceIds: [address.dataSourceId],
  affectedPageIds: ["page"],
  affectedViewIds: [],
  committedRevisions: {},
  commitSeq: 1,
  committedAt: "2026-09-05T00:00:00Z",
});
const operations: DatabaseViewOperationsCommand["operations"] = [
  {
    kind: "edit_property_values",
    edits: [
      {
        ...address,
        edit: { kind: "replace", expectedValueRevision: 0, value: { kind: "text", value: "new" } },
      },
    ],
  },
];
const fixture = () => {
  const history = createDatabaseViewMutationHistory(databaseViewHistoryScopeKey(model));
  const commit = vi.fn<typeof commitDatabaseViewOperations>(async () => receipt());
  const edit = () => history.executeOperations({ model, operations, commitOperations: commit });
  return { history, commit, edit };
};

describe("Database View semantic command history", () => {
  test("another View replays the originating View's edit and refreshes only its presentation", async () => {
    const realm = createInteractionHistory({ scopeKey: "content" });
    const first = createDatabaseViewMutationHistory(databaseViewHistoryScopeKey(model), realm);
    const secondModel = { ...model, databaseViewId: parseDatabaseViewId("second-view") };
    const second = createDatabaseViewMutationHistory(
      databaseViewHistoryScopeKey(secondModel),
      realm,
    );
    const refreshedFirst = vi.fn();
    const refreshedSecond = vi.fn();
    first.subscribeReplayCommitted(refreshedFirst);
    second.subscribeReplayCommitted(refreshedSecond);
    const commit = vi.fn<typeof commitDatabaseViewOperations>(async () => receipt());
    await first.executeOperations({ model, operations, commitOperations: commit });
    expect(refreshedFirst).not.toHaveBeenCalled();
    expect(second.snapshot().undo.label).toBe("Change Properties");
    const resolution = await second.request("undo").result;
    expect(resolution).toEqual({ status: "committed", entryId: expect.any(Number) });
    expect(commit.mock.calls[1]?.[0].operations).toEqual([
      { kind: "reverse_data_edit", recipe: recipe() },
    ]);
    expect(refreshedFirst).toHaveBeenCalledOnce();
    expect(refreshedSecond).not.toHaveBeenCalled();
    realm.close();
  });

  test("explicit content reset clears the shared interval without replaying another View's edits", async () => {
    const realm = createInteractionHistory({ scopeKey: "content" });
    const first = createDatabaseViewMutationHistory(databaseViewHistoryScopeKey(model), realm);
    const second = createDatabaseViewMutationHistory("second-view", realm);
    const commit = vi.fn<typeof commitDatabaseViewOperations>(async () => receipt());
    await first.executeOperations({ model, operations, commitOperations: commit });
    second.reset();
    expect(first.snapshot().undo.status).toBe("empty");
    expect(first.snapshot().redo.status).toBe("empty");
    expect(await first.undoLast()).toBe(false);
    expect(commit).toHaveBeenCalledOnce();
    realm.close();
  });

  test("List replay installs each authoritative inverse so Undo and Redo remain symmetric", async () => {
    const { history, commit } = fixture();
    const listRecipe: DatabaseListMoveUndoRecipeV2 = {
      viewId: model.databaseViewId,
      dataSourceId: address.dataSourceId,
      propertyStates: [],
      postParentGuards: [{ pageId: "page", parentPageId: null }],
      postOrderRuns: [{ pageIds: ["page"], parentPageId: null, beforePageId: "after" }],
      restoreRuns: [{ pageIds: ["page"], parentPageId: null, beforePageId: "before" }],
    };
    const inverse = {
      ...listRecipe,
      postOrderRuns: listRecipe.restoreRuns,
      restoreRuns: listRecipe.postOrderRuns,
    };
    commit.mockResolvedValueOnce({
      ...receipt(),
      operationKinds: ["undo_list_occurrence_move"],
      operationOutcomes: [
        {
          kind: "list_occurrence_move_undo",
          operationIndex: 0,
          restoredPageIds: ["page"],
          undoRecipe: listRecipe,
        },
      ],
    });
    await history.executeOperations({
      model,
      operations: [{ kind: "undo_list_occurrence_move", recipe: inverse }],
      commitOperations: commit,
    });
    commit.mockResolvedValueOnce({
      ...receipt(),
      operationKinds: ["undo_list_occurrence_move"],
      operationOutcomes: [
        {
          kind: "list_occurrence_move_undo",
          operationIndex: 0,
          restoredPageIds: ["page"],
          undoRecipe: inverse,
        },
      ],
    });
    expect(await history.undoLast()).toBe(true);
    expect(history.snapshot().redo.status).toBe("ready");
    commit.mockResolvedValueOnce({
      ...receipt(),
      operationKinds: ["undo_list_occurrence_move"],
      operationOutcomes: [
        {
          kind: "list_occurrence_move_undo",
          operationIndex: 0,
          restoredPageIds: ["page"],
          undoRecipe: listRecipe,
        },
      ],
    });
    expect((await history.request("redo").result).status).toBe("committed");
    expect(commit.mock.calls.slice(1).map(([request]) => request.operations)).toEqual([
      [{ kind: "undo_list_occurrence_move", recipe: listRecipe }],
      [{ kind: "undo_list_occurrence_move", recipe: inverse }],
    ]);
    expect(history.snapshot().undo.status).toBe("ready");
  });

  test("uncertain forward and inverse responses retain the exact request without exposing older history", async () => {
    const { history, commit, edit } = fixture();
    await edit();
    commit.mockRejectedValueOnce(new Error("Reply lost"));
    await expect(edit()).rejects.toMatchObject({ status: "recovering" });
    expect(await history.undoLast()).toBe(false);
    expect(commit).toHaveBeenCalledTimes(2);
    await history.recover().result;
    expect(commit.mock.calls[2]?.[0]).toEqual(commit.mock.calls[1]?.[0]);
    commit.mockRejectedValueOnce(new Error("Inverse reply lost"));
    expect(await history.undoLast()).toBe(false);
    expect(history.snapshot().undo.status).toBe("waiting");
    commit.mockResolvedValueOnce({
      ...receipt(recipe("new", "old")),
      operationKinds: ["reverse_data_edit"],
    });
    await history.recover().result;
    expect(commit.mock.calls[4]?.[0]).toEqual(commit.mock.calls[3]?.[0]);
    expect(commit.mock.calls[4]?.[0].operations).toEqual([
      { kind: "reverse_data_edit", recipe: recipe() },
    ]);
    expect(history.snapshot().redo.status).toBe("ready");
  });

  test("a known forward rejection and no-op leave the older entry reachable", async () => {
    const { history, commit, edit } = fixture();
    await edit();
    commit.mockRejectedValueOnce(
      new DatabaseViewMutationError({
        code: "revision_conflict",
        message: "Changed",
        retryable: true,
      }),
    );
    await expect(edit()).rejects.toMatchObject({ status: "rejected" });
    commit.mockResolvedValueOnce(receipt(null));
    expect(await edit()).toBeNull();
    expect(await history.undoLast()).toBe(true);
    expect(commit.mock.calls[3]?.[0].operations[0]?.kind).toBe("reverse_data_edit");
    expect(history.snapshot().undo.status).toBe("empty");
  });

  test("scope changes reject stale commands and retire previous inverses", async () => {
    const { history, commit, edit } = fixture();
    await edit();
    history.setScope("another-view");
    await expect(edit()).rejects.toMatchObject({ status: "rejected" });
    expect(await history.undoLast()).toBe(false);
    expect(commit).toHaveBeenCalledOnce();
  });

  test("expired receipt recovery becomes a permanent barrier and cannot retry under a new identity", async () => {
    const { history, commit, edit } = fixture();
    await edit();
    commit.mockRejectedValueOnce(new Error("Reply lost"));
    await expect(edit()).rejects.toMatchObject({ status: "recovering" });
    commit.mockRejectedValueOnce(
      new DatabaseViewMutationError({
        code: "recovery_required",
        message: "The receipt window ended",
        retryable: false,
      }),
    );
    expect((await history.recover().result).status).toBe("blocked");
    expect(history.snapshot().undo.recoveryActions).toEqual(["reset"]);
    expect(await history.undoLast()).toBe(false);
    expect((await history.recover().result).status).toBe("blocked");
    expect(commit).toHaveBeenCalledTimes(3);
    history.reset();
    expect(history.snapshot().undo.status).toBe("empty");
  });

  test("forward, Undo and Redo share the captured typed presentation port", async () => {
    const { history, commit } = fixture();
    commit.mockResolvedValueOnce(receipt(recipe("a", "b")));
    await history.executeOperations({
      model,
      operations,
      commitOperations: commit,
    });
    expect(commit.mock.calls[0]?.[0].operations).toEqual(operations);
    expect(await history.undoLast()).toBe(true);
    expect(commit.mock.calls[1]?.[0].operations).toEqual([
      { kind: "reverse_data_edit", recipe: recipe("a", "b") },
    ]);
    expect((await history.request("redo").result).status).toBe("committed");
    expect(commit.mock.calls[2]?.[0].operations).toEqual([
      { kind: "reverse_data_edit", recipe: recipe() },
    ]);
    expect(commit).toHaveBeenCalledTimes(3);
  });

  test("a recipe covers the entire gesture or establishes a permanent barrier", () => {
    const full = {
      ...receipt(),
      operationKinds: ["edit_property_values", "position_pages"] as const,
      operationOutcomes: [
        { kind: "data_edit" as const, operationIndex: 0, operationCount: 2, undoRecipe: recipe() },
      ],
    };
    expect(interpretDatabaseViewHistoryReceipt({ kind: "data", scope, receipt: full }).kind).toBe(
      "reversible",
    );
    expect(
      interpretDatabaseViewHistoryReceipt({
        kind: "data",
        scope,
        receipt: { ...full, operationOutcomes: receipt().operationOutcomes },
      }).kind,
    ).toBe("barrier");
    expect(
      interpretDatabaseViewHistoryReceipt({ kind: "data", scope, receipt: receipt(null) }).kind,
    ).toBe("noop");
  });
});
