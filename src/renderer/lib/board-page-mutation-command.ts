import type { DatabaseApplyReceiptV2 } from "../../shared/database-module-v2";
import type { PageLifecycleExecutionResultV2 } from "../../shared/page-lifecycle-v2-runtime";
import type { MovePageInput, MovePagesInput } from "./types";
import {
  boardContainsPageIds,
  buildDeletePageTransform,
  buildMovePageTransform,
  buildMovePagesTransform,
  conflictKeysForDelete,
  conflictKeysForMove,
  conflictKeysForMoveMany,
  BOARD_PLACEMENT_REMOTE_LANE,
} from "./board-optimistic-ops";
import { getBoardProjectStore } from "./board-store";
import {
  commitDatabasePageDrag,
  commitDatabasePagesDrag,
  databaseViewRenderModelToDragSnapshot,
} from "./database-page-drag-runtime";
import { commitPageLifecycleIntent } from "./page-lifecycle-runtime";

type BoardStore = ReturnType<typeof getBoardProjectStore>;

export async function deleteBoardPage(input: {
  readonly store: BoardStore;
  readonly projectId: string;
  readonly clientSessionId?: string;
  readonly columnId?: string;
  readonly pageId: string;
  readonly operationId: string;
}): Promise<boolean> {
  const outcome = await input.store.runOptimisticMutation<PageLifecycleExecutionResultV2>({
    kind: "page:delete",
    operationIdentity: input.operationId,
    conflictKeys: conflictKeysForDelete(input.pageId),
    apply: buildDeletePageTransform(input.columnId, input.pageId),
    remoteLane: BOARD_PLACEMENT_REMOTE_LANE,
    runRemote: async () => {
      const committed = await commitPageLifecycleIntent({
        kind: "delete",
        projectId: input.projectId,
        operationId: input.operationId,
        clientSessionId: input.clientSessionId,
        pageId: input.pageId,
      });
      if (committed.receipt.lifecycle !== "deleted") {
        throw new Error("Failed to delete Page");
      }
      return committed;
    },
    getCommitCursor: (committed) => ({
      storeEpoch: committed.receipt.storeEpoch,
      commitSeq: committed.receipt.commitSeq,
    }),
    isCommitMaterialized: (canonicalBoard) => !boardContainsPageIds(canonicalBoard, [input.pageId]),
  });
  return outcome.ok && outcome.result?.receipt.lifecycle === "deleted";
}

export async function moveBoardPage(input: {
  readonly store: BoardStore;
  readonly projectId: string;
  readonly move: MovePageInput;
  readonly operationId: string;
}): Promise<boolean> {
  const databaseView = input.store.getSnapshot().databaseView;
  if (!databaseView) {
    input.store.setError("The Database View is not loaded");
    return false;
  }
  const fallbackCards =
    input.store
      .getSnapshot()
      .board?.columns.flatMap((column) => column.cards)
      .filter((card) => card.id === input.move.pageId) ?? [];
  const outcome = await input.store.runOptimisticMutation<DatabaseApplyReceiptV2>({
    kind: "database:position",
    operationIdentity: input.operationId,
    conflictKeys: conflictKeysForMove(input.move),
    apply: buildMovePageTransform(input.move, fallbackCards),
    remoteLane: BOARD_PLACEMENT_REMOTE_LANE,
    runRemote: async () => {
      const currentView = input.store.getSnapshot().databaseView;
      if (!currentView) throw new Error("The Database View is not loaded");
      return await commitDatabasePageDrag({
        projectId: input.projectId,
        operationId: input.operationId,
        move: input.move,
        snapshot: databaseViewRenderModelToDragSnapshot(currentView),
      });
    },
    getCommitCursor: (receipt) => ({
      storeEpoch: receipt.storeEpoch,
      commitSeq: receipt.commitSeq,
    }),
    isCommitMaterialized: (canonicalBoard) =>
      boardContainsPageIds(canonicalBoard, [input.move.pageId]),
  });
  return outcome.ok && outcome.result !== undefined;
}

export async function moveBoardPages(input: {
  readonly store: BoardStore;
  readonly projectId: string;
  readonly move: MovePagesInput;
  readonly operationId: string;
}): Promise<boolean> {
  const databaseView = input.store.getSnapshot().databaseView;
  if (!databaseView) {
    input.store.setError("The Database View is not loaded");
    return false;
  }
  const movingPageIds = new Set(input.move.pageIds);
  const fallbackCards =
    input.store
      .getSnapshot()
      .board?.columns.flatMap((column) => column.cards)
      .filter((card) => movingPageIds.has(card.id)) ?? [];
  const outcome = await input.store.runOptimisticMutation<DatabaseApplyReceiptV2>({
    kind: "database:position-many",
    operationIdentity: input.operationId,
    conflictKeys: conflictKeysForMoveMany(input.move),
    apply: buildMovePagesTransform(input.move, fallbackCards),
    remoteLane: BOARD_PLACEMENT_REMOTE_LANE,
    runRemote: async () => {
      const currentView = input.store.getSnapshot().databaseView;
      if (!currentView) throw new Error("The Database View is not loaded");
      return await commitDatabasePagesDrag({
        projectId: input.projectId,
        operationId: input.operationId,
        move: input.move,
        snapshot: databaseViewRenderModelToDragSnapshot(currentView),
      });
    },
    getCommitCursor: (receipt) => ({
      storeEpoch: receipt.storeEpoch,
      commitSeq: receipt.commitSeq,
    }),
    isCommitMaterialized: (canonicalBoard) =>
      boardContainsPageIds(canonicalBoard, input.move.pageIds),
  });
  return outcome.ok && outcome.result !== undefined;
}
