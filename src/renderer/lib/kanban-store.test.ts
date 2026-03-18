import { describe, expect, test } from "bun:test";
import {
  buildCreateCardTransform,
  buildDeleteCardTransform,
  buildMoveCardTransform,
  buildPatchCardTransform,
  conflictKeysForCreate,
  conflictKeysForDelete,
  conflictKeysForMove,
  conflictKeysForPatch,
  createOptimisticCard,
} from "./kanban-optimistic-ops";
import type {
  Board,
  CardCreateInput,
} from "./types";
import { createKanbanStoreRegistry } from "./kanban-store";

function createBoard(title = "Initial title"): Board {
  return {
    columns: [
      {
        id: "draft",
        name: "Ideas",
        cards: [
          {
            id: "card-1",
            status: "draft",
            archived: false,
            title,
            description: "Initial description",
            priority: "p2-medium",
            estimate: "m",
            tags: [],
            agentBlocked: false,
            revision: 1,
            created: new Date("2026-02-16T00:00:00.000Z"),
            order: 0,
          },
        ],
      },
      {
        id: "done",
        name: "Done",
        cards: [],
      },
    ],
  };
}

function cloneBoard(board: Board): Board {
  return {
    ...board,
    columns: board.columns.map((column) => ({
      ...column,
      cards: column.cards.map((card) => ({ ...card })),
    })),
  };
}

function waitForMicrotasks(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(() => resolve(), 0);
  });
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolveFn, rejectFn) => {
    resolve = resolveFn;
    reject = rejectFn;
  });
  return {
    promise,
    resolve,
    reject,
  };
}

describe("kanban store", () => {
  test("registers a single board-change subscription for multiple listeners", async () => {
    const board = createBoard();
    let subscribeCalls = 0;
    let unsubscribeCalls = 0;

    const registry = createKanbanStoreRegistry({
      invoke: async () => board,
      subscribeBoardChanges: () => {
        subscribeCalls += 1;
        return () => {
          unsubscribeCalls += 1;
        };
      },
    });

    const store = registry.getStore("default");
    const unsubscribeFirst = store.subscribe(() => {});
    const unsubscribeSecond = store.subscribe(() => {});
    await waitForMicrotasks();

    expect(subscribeCalls).toBe(1);

    unsubscribeFirst();
    expect(unsubscribeCalls).toBe(0);

    unsubscribeSecond();
    expect(unsubscribeCalls).toBe(1);
  });

  test("dedupes in-flight board fetches", async () => {
    const board = createBoard();
    const gate: { release?: () => void } = {};
    let invokeCalls = 0;

    const registry = createKanbanStoreRegistry({
      invoke: async () => {
        invokeCalls += 1;
        await new Promise<void>((resolve) => {
          gate.release = () => resolve();
        });
        return board;
      },
      subscribeBoardChanges: () => () => {},
    });

    const store = registry.getStore("default");
    const firstFetch = store.fetchBoard();
    const secondFetch = store.fetchBoard();

    expect(invokeCalls).toBe(1);

    gate.release?.();
    await Promise.all([firstFetch, secondFetch]);
    expect(invokeCalls).toBe(1);
  });

  test("refreshBoard fetches again after an in-flight fetch settles", async () => {
    const initialBoard = createBoard("Initial");
    const refreshedBoard = createBoard("Refreshed");
    const gate: { release?: () => void } = {};
    let invokeCalls = 0;

    const registry = createKanbanStoreRegistry({
      invoke: async () => {
        invokeCalls += 1;
        if (invokeCalls === 1) {
          await new Promise<void>((resolve) => {
            gate.release = () => resolve();
          });
          return initialBoard;
        }
        return refreshedBoard;
      },
      subscribeBoardChanges: () => () => {},
    });

    const store = registry.getStore("default");
    const firstFetch = store.fetchBoard();
    const refreshPromise = store.refreshBoard();

    gate.release?.();
    await Promise.all([firstFetch, refreshPromise]);

    expect(invokeCalls).toBe(2);
    expect(store.getSnapshot().cardIndex.get("card-1")?.title).toBe("Refreshed");
  });

  test("applies local optimistic overlays to board and card index", async () => {
    const board = createBoard();
    const registry = createKanbanStoreRegistry({
      invoke: async () => board,
      subscribeBoardChanges: () => () => {},
    });

    const store = registry.getStore("default");
    await store.fetchBoard();

    let notifications = 0;
    const unsubscribe = store.subscribe(() => {
      notifications += 1;
    });
    await waitForMicrotasks();
    notifications = 0;

    store.applyLocalPatch("draft", "card-1", {
      title: "Updated title",
    });

    const snapshot = store.getSnapshot();
    expect(snapshot.board?.columns[0]?.cards[0]?.title).toBe("Updated title");
    expect(snapshot.cardIndex.get("card-1")?.title).toBe("Updated title");
    expect(notifications).toBe(1);

    unsubscribe();
  });

  test("local draft overlays do not bump card revision", async () => {
    const board = createBoard();
    const registry = createKanbanStoreRegistry({
      invoke: async () => board,
      subscribeBoardChanges: () => () => {},
    });

    const store = registry.getStore("default");
    await store.fetchBoard();

    store.applyLocalPatch("draft", "card-1", {
      title: "Updated title",
    });

    expect(store.getSnapshot().cardIndex.get("card-1")?.revision).toBe(1);
  });

  test("remote optimistic updates bump card revision", async () => {
    const board = createBoard();
    const deferred = createDeferred<{ ok: true }>();
    const registry = createKanbanStoreRegistry({
      invoke: async () => cloneBoard(board),
      subscribeBoardChanges: () => () => {},
    });

    const store = registry.getStore("default");
    await store.fetchBoard();

    const pendingMutation = store.runOptimisticMutation({
      kind: "card:update",
      conflictKeys: conflictKeysForPatch("card-1", { title: "Updated title" }),
      apply: buildPatchCardTransform("draft", "card-1", { title: "Updated title" }, { bumpRevision: true }),
      runRemote: async () => deferred.promise,
    });

    expect(store.getSnapshot().cardIndex.get("card-1")?.revision).toBe(2);

    deferred.resolve({ ok: true });
    await pendingMutation;
  });

  test("ignores no-op local overlays", async () => {
    const board = createBoard();
    const registry = createKanbanStoreRegistry({
      invoke: async () => board,
      subscribeBoardChanges: () => () => {},
    });

    const store = registry.getStore("default");
    await store.fetchBoard();
    const before = store.getSnapshot();

    const changed = store.applyLocalPatch("draft", "card-1", {
      title: "Initial title",
    });
    const after = store.getSnapshot();

    expect(changed).toBeFalse();
    expect(after.board).toBe(before.board);
    expect(after.cardIndex).toBe(before.cardIndex);
  });

  test("LWW: out-of-order update acknowledgements keep latest local value", async () => {
    let serverBoard = createBoard();
    const deferredA = createDeferred<{ ok: true }>();
    const deferredB = createDeferred<{ ok: true }>();
    const deferredC = createDeferred<{ ok: true }>();

    const registry = createKanbanStoreRegistry({
      invoke: async () => cloneBoard(serverBoard),
      subscribeBoardChanges: () => () => {},
    });
    const store = registry.getStore("default");
    await store.fetchBoard();

    const mutationA = store.runOptimisticMutation({
      kind: "card:update",
      conflictKeys: conflictKeysForPatch("card-1", { title: "A" }),
      apply: buildPatchCardTransform("draft", "card-1", { title: "A" }),
      runRemote: async () => {
        const result = await deferredA.promise;
        serverBoard = buildPatchCardTransform("draft", "card-1", { title: "A" })(serverBoard);
        return result;
      },
    });
    const mutationB = store.runOptimisticMutation({
      kind: "card:update",
      conflictKeys: conflictKeysForPatch("card-1", { title: "B" }),
      apply: buildPatchCardTransform("draft", "card-1", { title: "B" }),
      runRemote: async () => {
        const result = await deferredB.promise;
        serverBoard = buildPatchCardTransform("draft", "card-1", { title: "B" })(serverBoard);
        return result;
      },
    });
    const mutationC = store.runOptimisticMutation({
      kind: "card:update",
      conflictKeys: conflictKeysForPatch("card-1", { title: "C" }),
      apply: buildPatchCardTransform("draft", "card-1", { title: "C" }),
      runRemote: async () => {
        const result = await deferredC.promise;
        serverBoard = buildPatchCardTransform("draft", "card-1", { title: "C" })(serverBoard);
        return result;
      },
    });

    expect(store.getSnapshot().cardIndex.get("card-1")?.title).toBe("C");

    deferredA.resolve({ ok: true });
    await mutationA;
    expect(store.getSnapshot().cardIndex.get("card-1")?.title).toBe("C");

    deferredB.resolve({ ok: true });
    await mutationB;
    expect(store.getSnapshot().cardIndex.get("card-1")?.title).toBe("C");

    deferredC.resolve({ ok: true });
    await mutationC;
    expect(store.getSnapshot().cardIndex.get("card-1")?.title).toBe("C");
  });

  test("create -> edit -> move remains stable across acknowledgements", async () => {
    const createInput: CardCreateInput = {
      title: "Created",
      id: "018f0f85-6d56-7625-bdea-000000000000",
    };
    let serverBoard = createBoard();

    const createRemoteDeferred = createDeferred<{ id: string }>();
    const updateRemoteDeferred = createDeferred<{ ok: true }>();
    const moveRemoteDeferred = createDeferred<{ ok: true }>();

    const registry = createKanbanStoreRegistry({
      invoke: async () => cloneBoard(serverBoard),
      subscribeBoardChanges: () => () => {},
    });
    const store = registry.getStore("default");
    await store.fetchBoard();

    const optimisticCard = createOptimisticCard(createInput);

    const createMutation = store.runOptimisticMutation({
      kind: "card:create",
      conflictKeys: conflictKeysForCreate("draft", optimisticCard.id),
      apply: buildCreateCardTransform("draft", optimisticCard, "bottom"),
      runRemote: async () => {
        const result = await createRemoteDeferred.promise;
        serverBoard = buildCreateCardTransform("draft", optimisticCard, "bottom")(serverBoard);
        return result;
      },
    });
    expect(store.getSnapshot().cardIndex.get("018f0f85-6d56-7625-bdea-000000000000")?.title).toBe("Created");

    const updateMutation = store.runOptimisticMutation({
      kind: "card:update",
      conflictKeys: conflictKeysForPatch("018f0f85-6d56-7625-bdea-000000000000", { title: "Created edited" }),
      apply: buildPatchCardTransform("draft", "018f0f85-6d56-7625-bdea-000000000000", { title: "Created edited" }),
      runRemote: async () => {
        const result = await updateRemoteDeferred.promise;
        serverBoard = buildPatchCardTransform("draft", "018f0f85-6d56-7625-bdea-000000000000", { title: "Created edited" })(serverBoard);
        return result;
      },
    });
    expect(store.getSnapshot().cardIndex.get("018f0f85-6d56-7625-bdea-000000000000")?.title).toBe("Created edited");

    const moveMutation = store.runOptimisticMutation({
      kind: "card:move",
      conflictKeys: conflictKeysForMove({
        cardId: "018f0f85-6d56-7625-bdea-000000000000",
        fromStatus: "draft",
        toStatus: "done",
      }),
      apply: buildMoveCardTransform({
        cardId: "018f0f85-6d56-7625-bdea-000000000000",
        fromStatus: "draft",
        toStatus: "done",
      }),
      runRemote: async () => {
        const result = await moveRemoteDeferred.promise;
        serverBoard = buildMoveCardTransform({
          cardId: "018f0f85-6d56-7625-bdea-000000000000",
          fromStatus: "draft",
          toStatus: "done",
        })(serverBoard);
        return result;
      },
    });

    expect(store.getSnapshot().cardIndex.get("018f0f85-6d56-7625-bdea-000000000000")?.columnId).toBe("done");

    createRemoteDeferred.resolve({ id: "018f0f85-6d56-7625-bdea-000000000000" });
    await createMutation;
    expect(store.getSnapshot().cardIndex.get("018f0f85-6d56-7625-bdea-000000000000")?.columnId).toBe("done");
    expect(store.getSnapshot().cardIndex.get("018f0f85-6d56-7625-bdea-000000000000")?.title).toBe("Created edited");

    updateRemoteDeferred.resolve({ ok: true });
    await updateMutation;
    expect(store.getSnapshot().cardIndex.get("018f0f85-6d56-7625-bdea-000000000000")?.columnId).toBe("done");
    expect(store.getSnapshot().cardIndex.get("018f0f85-6d56-7625-bdea-000000000000")?.title).toBe("Created edited");

    moveRemoteDeferred.resolve({ ok: true });
    await moveMutation;
    expect(store.getSnapshot().cardIndex.get("018f0f85-6d56-7625-bdea-000000000000")?.columnId).toBe("done");
    expect(store.getSnapshot().cardIndex.get("018f0f85-6d56-7625-bdea-000000000000")?.title).toBe("Created edited");
  });

  test("failed delete rolls back automatically", async () => {
    const board = createBoard();
    const registry = createKanbanStoreRegistry({
      invoke: async () => cloneBoard(board),
      subscribeBoardChanges: () => () => {},
    });
    const store = registry.getStore("default");
    await store.fetchBoard();

    const mutation = store.runOptimisticMutation({
      kind: "card:delete",
      conflictKeys: conflictKeysForDelete("card-1"),
      apply: buildDeleteCardTransform("draft", "card-1"),
      runRemote: async () => {
        throw new Error("delete failed");
      },
    });

    expect(store.getSnapshot().cardIndex.has("card-1")).toBeFalse();
    const result = await mutation;
    expect(result.ok).toBeFalse();
    expect(store.getSnapshot().cardIndex.has("card-1")).toBeTrue();
  });

  test("mutation cooldown suppresses immediate board-change refreshes", async () => {
    const board = createBoard();
    let currentTime = 1_000;
    const callbacks: { onBoardChange?: () => void } = {};
    let boardFetchCount = 0;

    const registry = createKanbanStoreRegistry({
      invoke: async () => {
        boardFetchCount += 1;
        return board;
      },
      subscribeBoardChanges: (_projectId, callback) => {
        callbacks.onBoardChange = callback;
        return () => {};
      },
      now: () => currentTime,
    });

    const store = registry.getStore("default");
    const unsubscribe = store.subscribe(() => {});
    await waitForMicrotasks();

    expect(boardFetchCount).toBe(1);

    store.markMutation();
    callbacks.onBoardChange?.();
    await waitForMicrotasks();
    expect(boardFetchCount).toBe(1);

    currentTime = 1_700;
    callbacks.onBoardChange?.();
    await waitForMicrotasks();
    expect(boardFetchCount).toBe(2);

    unsubscribe();
  });

  test("keeps per-project store instance across unsubscribe/resubscribe", async () => {
    const registry = createKanbanStoreRegistry({
      invoke: async () => createBoard(),
      subscribeBoardChanges: () => () => {},
    });

    const first = registry.getStore("default");
    const unsubscribe = first.subscribe(() => {});
    await waitForMicrotasks();
    unsubscribe();

    const second = registry.getStore("default");
    expect(second).toBe(first);
  });

  test("queues local overlay before first fetch and applies after board load", async () => {
    const deferredBoard = createDeferred<Board>();
    const registry = createKanbanStoreRegistry({
      invoke: async () => deferredBoard.promise,
      subscribeBoardChanges: () => () => {},
    });

    const store = registry.getStore("default");
    const unsubscribe = store.subscribe(() => {});
    await waitForMicrotasks();

    const queued = store.applyLocalPatch("draft", "card-1", { title: "Queued title" });
    expect(queued).toBeTrue();
    expect(store.getSnapshot().board).toBe(null);

    deferredBoard.resolve(createBoard());
    await waitForMicrotasks();
    await waitForMicrotasks();

    expect(store.getSnapshot().cardIndex.get("card-1")?.title).toBe("Queued title");
    unsubscribe();
  });

  test("auto-collects local overlay after server converges", async () => {
    let serverBoard = createBoard();
    const registry = createKanbanStoreRegistry({
      invoke: async () => cloneBoard(serverBoard),
      subscribeBoardChanges: () => () => {},
    });
    const store = registry.getStore("default");
    await store.fetchBoard();

    store.applyLocalPatch("draft", "card-1", { title: "Local title" });
    expect(store.getSnapshot().cardIndex.get("card-1")?.title).toBe("Local title");

    serverBoard = buildPatchCardTransform("draft", "card-1", { title: "Local title" })(serverBoard);
    await store.refreshBoard();
    expect(store.getSnapshot().cardIndex.get("card-1")?.title).toBe("Local title");

    // If local overlay was not collected, this server update would be masked.
    serverBoard = buildPatchCardTransform("draft", "card-1", { title: "Server next" })(serverBoard);
    await store.refreshBoard();
    expect(store.getSnapshot().cardIndex.get("card-1")?.title).toBe("Server next");
  });

  test("does not auto-collect local overlay that depends on pending create", async () => {
    let serverBoard = createBoard();
    const createRemoteDeferred = createDeferred<{ id: string }>();
    const createInput: CardCreateInput = {
      title: "Created",
      id: "018f0f85-6d56-7625-bdea-000000000001",
    };
    const optimisticCard = createOptimisticCard(createInput);

    const registry = createKanbanStoreRegistry({
      invoke: async () => cloneBoard(serverBoard),
      subscribeBoardChanges: () => () => {},
    });
    const store = registry.getStore("default");
    await store.fetchBoard();

    const createMutation = store.runOptimisticMutation({
      kind: "card:create",
      conflictKeys: conflictKeysForCreate("draft", optimisticCard.id),
      apply: buildCreateCardTransform("draft", optimisticCard, "bottom"),
      runRemote: async () => {
        const result = await createRemoteDeferred.promise;
        serverBoard = buildCreateCardTransform("draft", optimisticCard, "bottom")(serverBoard);
        return result;
      },
    });

    store.applyLocalPatch("draft", "018f0f85-6d56-7625-bdea-000000000001", { title: "Edited while pending" });
    expect(store.getSnapshot().cardIndex.get("018f0f85-6d56-7625-bdea-000000000001")?.title).toBe("Edited while pending");

    // Re-fetch while create is still pending: patch must not be dropped.
    await store.refreshBoard();
    expect(store.getSnapshot().cardIndex.get("018f0f85-6d56-7625-bdea-000000000001")?.title).toBe("Edited while pending");

    createRemoteDeferred.resolve({ id: "018f0f85-6d56-7625-bdea-000000000001" });
    await createMutation;
    expect(store.getSnapshot().cardIndex.get("018f0f85-6d56-7625-bdea-000000000001")?.title).toBe("Edited while pending");
  });
});
