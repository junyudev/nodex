import { describe, expect, test } from "vite-plus/test";
import * as Y from "yjs";

import type {
  LibraryStructuralEditResult,
  LibraryStructuralHistoryToken,
} from "../../../../shared/library-module";
import { NfmHistoryLane, type NfmHistoryLaneOptions } from "./nfm-editor-history";
import { createUuidV7 } from "../../../../shared/uuid-v7";
import type { NfmHistoryCommand } from "./nfm-history-command";
import { createInteractionHistory } from "../../../lib/surface-history/owner";

const digest = "a".repeat(64);
const deferred = <T>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
};
const token = (recipeOperationId: string): LibraryStructuralHistoryToken => ({
  recipeOperationId,
  recipeHash: digest,
  storeEpoch: "epoch:test",
});
const structuralResult = (
  history: LibraryStructuralHistoryToken,
  supersededHistoryRecipeOperationIds: readonly string[] = [],
): LibraryStructuralEditResult => ({
  operationKind: "reverse_structural_edit",
  sourceRootBlockIds: [],
  resultRootBlockIds: [],
  copiedBlockIds: {},
  copiedDocumentIds: {},
  documentCommits: [],
  affectedPageIds: [],
  affectedDatabaseIds: [],
  clipboard: null,
  history,
  supersededHistoryRecipeOperationIds,
  resume: null,
});

class TestReplayFailure extends Error {
  constructor(
    readonly outcome: "uncertain" | "not_committed",
    message: string,
  ) {
    super(message);
  }
}
const seeds = new WeakMap<
  NfmHistoryCommand,
  { result: LibraryStructuralEditResult; ready?: Promise<void> }
>();
const createLane = (
  options: NfmHistoryLaneOptions & {
    reverseStructural?: (
      token: LibraryStructuralHistoryToken,
    ) => Promise<{ structuralEdit: LibraryStructuralEditResult }>;
  } = {},
) =>
  new NfmHistoryLane({
    ...options,
    prepareCommand: async (command) => {
      const seed = seeds.get(command);
      if (!seed) throw new Error("Preparation rejected");
      await seed.ready;
      return { kind: "complete", receipt: { kind: "structural", result: seed.result } };
    },
    prepareStructuralReverse: async (token) => ({
      kind: "library",
      accessContext: { kind: "library" },
      request: {
        operationId: createUuidV7(),
        storeEpoch: token.storeEpoch,
        operation: { kind: "reverse_structural_edit", token },
      },
      presentation: { focusRevision: 0 },
      replay: true,
    }),
    submit: async (request) => {
      if (
        request.kind !== "library" ||
        request.request.operation.kind !== "reverse_structural_edit" ||
        !options.reverseStructural
      )
        throw new Error("Missing reverse Adapter");
      try {
        const result = await options.reverseStructural(request.request.operation.token);
        return {
          kind: "committed",
          receipt: { kind: "structural", result: result.structuralEdit },
        };
      } catch (error) {
        if (!(error instanceof TestReplayFailure)) throw error;
        return error.outcome === "uncertain"
          ? { kind: "unknown", reason: error.message }
          : { kind: "rejected", reason: error.message, retryable: true };
      }
    },
  });
const admit = (
  lane: NfmHistoryLane,
  result: LibraryStructuralEditResult,
  ready?: Promise<void>,
) => {
  const command: NfmHistoryCommand = { kind: "delete", roots: [], direction: "backward" };
  seeds.set(command, { result, ready });
  return lane.execute(command);
};
const seed = async (lane: NfmHistoryLane, result: LibraryStructuralEditResult) => {
  expect((await admit(lane, result).result).status).toBe("committed");
};

describe("NFM chronological history lane", () => {
  test("different editors replay one chronology without merging across a semantic action", async () => {
    const history = createInteractionHistory({ scopeKey: "content" });
    const document = new Y.Doc();
    const first = document.getText("first");
    const second = document.getText("second");
    const firstOrigin = {};
    const secondOrigin = {};
    let firstLane: NfmHistoryLane | undefined;
    let secondLane: NfmHistoryLane | undefined;
    const firstManager = new Y.UndoManager(first, {
      trackedOrigins: new Set([firstOrigin]),
      captureTimeout: 60_000,
      captureTransaction: (transaction) => {
        if (transaction.origin === firstOrigin) firstLane?.beforeLocalCapture();
        return true;
      },
    });
    const secondManager = new Y.UndoManager(second, {
      trackedOrigins: new Set([secondOrigin]),
      captureTimeout: 60_000,
      captureTransaction: (transaction) => {
        if (transaction.origin === secondOrigin) secondLane?.beforeLocalCapture();
        return true;
      },
    });
    const presented: string[] = [];
    firstLane = createLane({
      interactionHistory: history,
      undoManager: firstManager,
      onCommitted: () => {
        presented.push("first");
      },
    });
    secondLane = createLane({
      interactionHistory: history,
      undoManager: secondManager,
      onCommitted: () => {
        presented.push("second");
      },
    });
    const semantic = createLane({
      interactionHistory: history,
      reverseStructural: async () => ({ structuralEdit: structuralResult(token("redo")) }),
      onCommitted: () => {
        presented.push("semantic");
      },
    });
    try {
      document.transact(() => first.insert(0, "A"), firstOrigin);
      await seed(semantic, structuralResult(token("move")));
      document.transact(() => first.insert(1, "B"), firstOrigin);
      document.transact(() => second.insert(0, "X"), secondOrigin);
      document.transact(() => first.insert(2, "C"), firstOrigin);
      firstLane.requestUndo();
      await history.whenIdle();
      expect(first.toString()).toBe("AB");
      expect(second.toString()).toBe("X");
      firstLane.requestUndo();
      await history.whenIdle();
      expect(second.toString()).toBe("");
      expect(presented.at(-1)).toBe("second");
      firstLane.requestUndo();
      await history.whenIdle();
      expect(first.toString()).toBe("A");
      firstLane.requestUndo();
      await history.whenIdle();
      expect(presented.at(-1)).toBe("semantic");
      expect(first.toString()).toBe("A");
      secondLane.requestUndo();
      await history.whenIdle();
      expect(first.toString()).toBe("");
      secondLane.requestRedo();
      await history.whenIdle();
      expect(first.toString()).toBe("A");
      expect(presented.at(-1)).toBe("first");
    } finally {
      await firstLane.close();
      await secondLane.close();
      await semantic.close();
      history.close();
      firstManager.destroy();
      secondManager.destroy();
      document.destroy();
    }
  });

  test("trimming Redo keeps its next prerequisite instead of a disconnected future", async () => {
    const document = new Y.Doc();
    const text = document.getText("body");
    const manager = new Y.UndoManager(text);
    for (const value of ["A", "B", "C"]) {
      text.insert(text.length, value);
      manager.stopCapturing();
    }
    manager.undo();
    manager.undo();
    const lane = createLane({ undoManager: manager, limits: { maxEntries: 1 } });
    try {
      lane.requestRedo();
      await lane.whenIdle();
      expect(text.toString()).toBe("AB");
      lane.requestRedo();
      await lane.whenIdle();
      expect(text.toString()).toBe("AB");
      expect(manager.redoStack).toHaveLength(0);
    } finally {
      await lane.close();
      manager.destroy();
      document.destroy();
    }
  });

  test("queue capacity rejects a semantic command before its preparation starts", async () => {
    const active = deferred<void>();
    const lane = createLane({ limits: { maxQueued: 1 } });
    const first = admit(lane, structuralResult(token("first")), active.promise);
    const second = admit(lane, structuralResult(token("second")));
    const excess = admit(lane, structuralResult(token("excess")));
    try {
      expect(excess.accepted).toBe(false);
      expect((await excess.result).status).toBe("rejected");
      active.resolve();
      await first.result;
      await second.result;
      expect(lane.snapshot().undo.label).toBe("Delete Blocks");
    } finally {
      active.resolve();
      await lane.close();
    }
  });

  test("bounded history retires the oldest mixed prefix in both backends", async () => {
    const document = new Y.Doc();
    const text = document.getText("body");
    const manager = new Y.UndoManager(text);
    const released: string[] = [];
    const lane = createLane({
      undoManager: manager,
      limits: { maxEntries: 2 },
      releaseStructural: async (tokens) => {
        released.push(...tokens.map((token) => token.recipeOperationId));
      },
    });
    try {
      await seed(lane, structuralResult(token("old")));
      text.insert(0, "A");
      manager.stopCapturing();
      text.insert(1, "B");
      manager.stopCapturing();
      text.insert(2, "C");
      lane.requestUndo();
      await lane.whenIdle();
      lane.requestUndo();
      await lane.whenIdle();
      lane.requestUndo();
      await lane.whenIdle();
      expect(text.toString()).toBe("A");
      expect(released).toEqual(["old"]);
      expect(manager.undoStack).toHaveLength(0);
    } finally {
      await lane.close();
      manager.destroy();
      document.destroy();
    }
  });

  test("an oversized newest edit retires older Undo instead of exposing an earlier structure action", async () => {
    const document = new Y.Doc();
    const text = document.getText("body");
    const manager = new Y.UndoManager(text);
    const errors: unknown[] = [];
    let reversed = false;
    const lane = createLane({
      undoManager: manager,
      limits: { maxBytes: 1024 },
      onError: (error) => errors.push(error),
      reverseStructural: async () => {
        reversed = true;
        return { structuralEdit: structuralResult(token("inverse")) };
      },
    });
    try {
      await seed(lane, structuralResult(token("A")));
      text.insert(0, "b".repeat(2048));
      lane.requestUndo();
      await lane.whenIdle();
      expect(text.length).toBe(2048);
      expect(reversed).toBe(false);
      expect(manager.undoStack).toHaveLength(0);
      expect(errors).toHaveLength(1);
      text.insert(text.length, "C");
      lane.requestUndo();
      await lane.whenIdle();
      expect(text.length).toBe(2048);
    } finally {
      await lane.close();
      manager.destroy();
      document.destroy();
    }
  });

  test("evicting an in-flight inverse hands off recovery without releasing its input early", async () => {
    const document = new Y.Doc();
    const text = document.getText("body");
    const manager = new Y.UndoManager(text);
    const response = deferred<{ structuralEdit: LibraryStructuralEditResult }>();
    const started = deferred<void>();
    const abandoned: unknown[] = [];
    const released: string[] = [];
    const lane = createLane({
      undoManager: manager,
      limits: { maxEntries: 1 },
      reverseStructural: async () => {
        started.resolve();
        return response.promise;
      },
      abandonCommand: async (request) => {
        abandoned.push(request);
      },
      releaseStructural: async (tokens) => {
        released.push(...tokens.map((item) => item.recipeOperationId));
      },
    });
    try {
      const original = token("A");
      await seed(lane, structuralResult(original));
      lane.requestUndo();
      await started.promise;
      text.insert(0, "B");
      expect(abandoned).toMatchObject([
        { request: { operation: { kind: "reverse_structural_edit", token: original } } },
      ]);
      expect(released).toEqual([]);
      response.resolve({ structuralEdit: structuralResult(token("late inverse")) });
      await lane.whenIdle();
      expect(lane.canRedo()).toBe(false);
      expect(released).toContain("late inverse");
    } finally {
      response.resolve({ structuralEdit: structuralResult(token("late inverse")) });
      await lane.close();
      manager.destroy();
      document.destroy();
    }
  });

  test.each(["superseded", "consumed", "unavailable"] as const)(
    "Core %s state only skips a Cut when supersession is authoritative",
    async (state) => {
      const document = new Y.Doc();
      const text = document.getText("body");
      const undoManager = new Y.UndoManager(text);
      const errors: unknown[] = [];
      let reversed = 0;
      const lane = createLane({
        undoManager,
        reconcileStructural: async (tokens) => ({
          commitSeq: 12,
          items: tokens.map((token) => ({ token, state })),
        }),
        reverseStructural: async () => {
          reversed++;
          return { structuralEdit: structuralResult(token("unexpected")) };
        },
        onError: (error) => errors.push(error),
      });
      try {
        text.insert(0, "C");
        await seed(lane, structuralResult(token("Cut in another window")));
        lane.requestUndo();
        await lane.whenIdle();
        expect(reversed).toBe(0);
        expect(text.toString()).toBe(state === "superseded" ? "" : "C");
        expect(errors).toHaveLength(state === "superseded" ? 0 : 1);
        expect(lane.snapshot().undo.status).toBe(state === "superseded" ? "empty" : "blocked");
      } finally {
        await lane.close();
        undoManager.destroy();
        document.destroy();
      }
    },
  );

  test("stale reconciliation cannot make a consumed recipe available again", async () => {
    const stale = deferred<{
      commitSeq: number;
      items: Array<{ token: LibraryStructuralHistoryToken; state: "available" }>;
    }>();
    let reads = 0;
    let reverses = 0;
    const history = token("A");
    const errors: unknown[] = [];
    const lane = createLane({
      reconcileStructural: async (tokens) => {
        if (++reads === 1) return stale.promise;
        return { commitSeq: 12, items: tokens.map((token) => ({ token, state: "consumed" })) };
      },
      reverseStructural: async () => {
        reverses++;
        return { structuralEdit: structuralResult(token("unexpected")) };
      },
      onError: (error) => errors.push(error),
    });
    try {
      await seed(lane, structuralResult(history));
      const pending = lane.reconcile();
      await lane.reconcile();
      stale.resolve({ commitSeq: 11, items: [{ token: history, state: "available" }] });
      await pending;
      lane.requestUndo();
      await lane.whenIdle();
      expect(reverses).toBe(0);
      expect(errors).toHaveLength(1);
      expect(lane.snapshot().undo.status).toBe("blocked");
    } finally {
      await lane.close();
    }
  });

  test("reconciliation rejects capabilities outside the exact requested batch", async () => {
    const lane = createLane({
      reconcileStructural: async () => ({
        commitSeq: 1,
        items: [{ token: token("foreign"), state: "superseded" }],
      }),
    });
    try {
      await seed(lane, structuralResult(token("local")));
      await expect(lane.reconcile()).rejects.toThrow("requested capabilities");
      expect(lane.canUndo()).toBe(true);
    } finally {
      await lane.close();
    }
  });

  test.each(["discard", "clear", "destroy"] as const)(
    "%s of one surface history cannot garbage-collect another surface's retained parent",
    (mode) => {
      const document = new Y.Doc();
      const root = document.getArray<Y.Map<Y.Text>>("body");
      const parent = new Y.Map<Y.Text>();
      const text = new Y.Text("abcdef");
      root.insert(0, [parent]);
      parent.set("text", text);
      const first = new Y.UndoManager(root, { trackedOrigins: new Set(["first"]) });
      const second = new Y.UndoManager(root, { trackedOrigins: new Set(["second"]) });
      try {
        document.transact(() => text.delete(0, 2), "first");
        document.transact(() => root.delete(0, 1), "second");
        if (mode === "discard") first.discardStackItems(first.undoStack.slice());
        if (mode === "clear") first.clear();
        if (mode === "destroy") first.destroy();
        Y.tryGc(Y.createDeleteSetFromStructStore(document.store), document.store, () => true);
        second.undo();
        expect(root.get(0)?.get("text")?.toString()).toBe("cdef");
      } finally {
        first.destroy();
        second.destroy();
        document.destroy();
      }
    },
  );

  test("exact engine disposal releases an older entry without damaging reachable deletion history", () => {
    const document = new Y.Doc();
    const text = document.getText("body");
    text.insert(0, "abcdef");
    const manager = new Y.UndoManager(text);
    try {
      text.delete(0, 2);
      const obsolete = manager.undoStack[0]!;
      manager.stopCapturing();
      text.delete(0, 2);
      expect(manager.discardStackItems([obsolete])).toBe(true);
      expect(manager.discardStackItems([obsolete])).toBe(false);
      Y.tryGc(Y.createDeleteSetFromStructStore(document.store), document.store, () => true);
      manager.undo();
      expect(text.toString()).toBe("cdef");
      manager.redo();
      expect(text.toString()).toBe("ef");
    } finally {
      manager.destroy();
      document.destroy();
    }
  });

  test("queued Undo never waits for a later forward gesture behind it", async () => {
    const response = deferred<void>();
    const reversed: string[] = [];
    const lane = createLane({
      reverseStructural: async (history) => {
        reversed.push(history.recipeOperationId);
        return { structuralEdit: structuralResult(token(`inverse:${history.recipeOperationId}`)) };
      },
    });
    const forward = admit(lane, structuralResult(token("A")), response.promise).result;
    lane.requestUndo();
    const nextForward = admit(lane, structuralResult(token("B"))).result;
    response.resolve();
    try {
      await forward;
      await nextForward;
      await lane.whenIdle();
      expect(reversed).toEqual(["A"]);
      lane.requestUndo();
      await lane.whenIdle();
      expect(reversed).toEqual(["A", "B"]);
    } finally {
      lane.dispose();
    }
  });

  test("a failed structural preparation does not destroy an existing redo branch", async () => {
    const document = new Y.Doc();
    const text = document.getText("body");
    const undoManager = new Y.UndoManager(text);
    const lane = createLane({ undoManager });
    try {
      text.insert(0, "restorable");
      lane.requestUndo();
      await lane.whenIdle();
      const failed = lane.execute({ kind: "delete", roots: [], direction: "backward" });
      expect((await failed.result).status).toBe("rejected");
      lane.requestRedo();
      await lane.whenIdle();
      expect(text.toString()).toBe("restorable");
    } finally {
      lane.dispose();
      undoManager.destroy();
      document.destroy();
    }
  });

  test("can undo later independent text while an earlier structural command awaits Core", async () => {
    const document = new Y.Doc();
    const text = document.getText("body");
    const undoManager = new Y.UndoManager(text);
    const response = deferred<void>();
    const lane = createLane({ undoManager });
    const forward = admit(lane, structuralResult(token("A")), response.promise).result;
    try {
      text.insert(0, "B");
      lane.requestUndo();
      expect(text.toString()).toBe("");
      response.resolve();
      await forward;
      await lane.whenIdle();
      expect(lane.canRedo()).toBe(true);
    } finally {
      response.resolve();
      await forward;
      lane.dispose();
      undoManager.destroy();
      document.destroy();
    }
  });

  test("keeps a late structural acknowledgement before subsequent typing", async () => {
    const document = new Y.Doc();
    const text = document.getText("body");
    const undoManager = new Y.UndoManager(text);
    const reversed: string[] = [];
    const lane = createLane({
      undoManager,
      reverseStructural: async (history) => {
        reversed.push(history.recipeOperationId);
        return { structuralEdit: structuralResult(token("inverse:A")) };
      },
    });
    try {
      const pending = deferred<void>();
      const action = admit(lane, structuralResult(token("A")), pending.promise);
      text.insert(0, "B");
      pending.resolve();
      await action.result;
      lane.requestUndo();
      await lane.whenIdle();
      expect(text.toString()).toBe("");
      expect(reversed).toEqual([]);
      lane.requestUndo();
      await lane.whenIdle();
      expect(reversed).toEqual(["A"]);
    } finally {
      lane.dispose();
      undoManager.destroy();
      document.destroy();
    }
  });

  test("queues rapid undo and removes the completed entry by identity", async () => {
    const document = new Y.Doc();
    const text = document.getText("body");
    const undoManager = new Y.UndoManager(text);
    const response = deferred<{ structuralEdit: LibraryStructuralEditResult }>();
    const reversed: string[] = [];
    const lane = createLane({
      undoManager,
      reverseStructural: (history) => {
        reversed.push(history.recipeOperationId);
        return response.promise;
      },
    });
    try {
      text.insert(0, "older");
      await seed(lane, structuralResult(token("A")));
      expect(lane.requestUndo()).toBe(true);
      expect(lane.requestUndo()).toBe(true);
      expect(text.toString()).toBe("older");
      response.resolve({ structuralEdit: structuralResult(token("inverse:A")) });
      await lane.whenIdle();
      expect(text.toString()).toBe("");
      expect(reversed).toEqual(["A"]);
      expect(lane.canUndo()).toBe(false);
    } finally {
      lane.dispose();
      undoManager.destroy();
      document.destroy();
    }
  });

  test("clears both redo branches and reconciles an explicit backend clear", async () => {
    const document = new Y.Doc();
    const text = document.getText("body");
    const undoManager = new Y.UndoManager(text);
    const lane = createLane({ undoManager });
    try {
      text.insert(0, "obsolete");
      lane.requestUndo();
      await lane.whenIdle();
      await seed(lane, structuralResult(token("new-branch")));
      expect(lane.canRedo()).toBe(false);
      expect(undoManager.canRedo()).toBe(false);
      text.insert(0, "current");
      undoManager.clear();
      expect(lane.canUndo()).toBe(true); // The unrelated Core recipe remains reachable.
      expect(lane.requestRedo()).toBe(true); // Empty still owns the gesture.
      await lane.whenIdle();
      expect(text.toString()).toBe("current");
    } finally {
      lane.dispose();
      undoManager.destroy();
      document.destroy();
    }
  });

  test("does not let a no-effect text item skip over a structural action", async () => {
    const document = new Y.Doc();
    const text = document.getText("body");
    const undoManager = new Y.UndoManager(text, { captureTimeout: 0 });
    const reversed: string[] = [];
    const lane = createLane({
      undoManager,
      reverseStructural: async (history) => {
        reversed.push(history.recipeOperationId);
        return { structuralEdit: structuralResult(token("inverse:A")) };
      },
    });
    try {
      text.insert(0, "C");
      await seed(lane, structuralResult(token("A")));
      text.insert(1, "B");
      document.transact(() => text.delete(1, 1), "remote");
      lane.requestUndo();
      await lane.whenIdle();
      expect(text.toString()).toBe("C");
      expect(reversed).toEqual(["A"]);
      lane.requestUndo();
      await lane.whenIdle();
      expect(text.toString()).toBe("");
    } finally {
      lane.dispose();
      undoManager.destroy();
      document.destroy();
    }
  });

  test("keeps typing during an asynchronous inverse and discards the obsolete redo branch", async () => {
    const document = new Y.Doc();
    const text = document.getText("body");
    const undoManager = new Y.UndoManager(text);
    const response = deferred<{ structuralEdit: LibraryStructuralEditResult }>();
    const released: string[] = [];
    const lane = createLane({
      undoManager,
      reverseStructural: () => response.promise,
      releaseStructural: async (tokens) => {
        released.push(...tokens.map((item) => item.recipeOperationId));
      },
    });
    try {
      await seed(lane, structuralResult(token("A")));
      expect(lane.requestUndo()).toBe(true);
      text.insert(0, "B");
      response.resolve({ structuralEdit: structuralResult(token("inverse:A")) });
      await lane.whenIdle();
      expect(lane.canRedo()).toBe(false);
      expect(released).toEqual(["inverse:A"]);
      expect(lane.requestUndo()).toBe(true);
      await lane.whenIdle();
      expect(text.toString()).toBe("");
    } finally {
      lane.dispose();
      undoManager.destroy();
      document.destroy();
    }
  });

  test.each(["uncertain", "not_committed"] as const)(
    "explicit recovery of a %s inverse respects the branch where its attempt began",
    async (outcome) => {
      const document = new Y.Doc();
      const text = document.getText("body");
      const manager = new Y.UndoManager(text);
      const released: string[] = [];
      let attempts = 0;
      const lane = createLane({
        undoManager: manager,
        reverseStructural: async () => {
          if (++attempts === 1) throw new TestReplayFailure(outcome, "Response unavailable");
          return { structuralEdit: structuralResult(token("inverse:A")) };
        },
        releaseStructural: async (tokens) => {
          released.push(...tokens.map((item) => item.recipeOperationId));
        },
      });
      try {
        await seed(lane, structuralResult(token("A")));
        lane.requestUndo();
        await lane.whenIdle();
        text.insert(0, "B");
        lane.requestUndo();
        await lane.whenIdle();
        expect(attempts).toBe(1);
        expect(text.toString()).toBe(outcome === "uncertain" ? "B" : "");
        lane.recover();
        await lane.whenIdle();
        expect(attempts).toBe(2);
        expect(released).toEqual(outcome === "uncertain" ? ["inverse:A"] : []);
        if (outcome === "uncertain") {
          lane.requestUndo();
          await lane.whenIdle();
        }
        if (outcome === "not_committed") {
          lane.requestRedo();
          await lane.whenIdle();
        }
        lane.requestRedo();
        await lane.whenIdle();
        expect(text.toString()).toBe("B");
        expect(lane.canRedo()).toBe(false);
      } finally {
        await lane.close();
        manager.destroy();
        document.destroy();
      }
    },
  );

  test("retains structural undo when a surface has no local Yjs history", async () => {
    const reversed: string[] = [];
    const lane = createLane({
      reverseStructural: async (history) => {
        reversed.push(history.recipeOperationId);
        return {
          structuralEdit: structuralResult(token("redo-paste")),
        };
      },
    });

    try {
      await seed(lane, structuralResult(token("paste")));
      expect(lane.requestUndo()).toBe(true);
      await lane.whenIdle();
      expect(reversed).toEqual(["paste"]);
      expect(lane.canRedo()).toBe(true);
    } finally {
      lane.dispose();
    }
  });

  test("undoes and redoes Yjs and Core edits in user action order", async () => {
    const document = new Y.Doc();
    const values = document.getArray<string>("values");
    const undoManager = new Y.UndoManager(values, { captureTimeout: 0 });
    const reversed: string[] = [];
    const lane = createLane({
      undoManager,
      reverseStructural: async (history) => {
        reversed.push(history.recipeOperationId);
        return {
          structuralEdit: structuralResult(
            token(history.recipeOperationId === "delete" ? "redo-delete" : "undo-delete-again"),
          ),
        };
      },
    });

    try {
      values.push(["A"]);
      await seed(lane, structuralResult(token("delete")));
      values.push(["B"]);
      expect(values.toArray()).toEqual(["A", "B"]);

      expect(lane.requestUndo()).toBe(true);
      await lane.whenIdle();
      expect(values.toArray()).toEqual(["A"]);

      expect(lane.requestUndo()).toBe(true);
      await lane.whenIdle();
      expect(reversed).toEqual(["delete"]);

      expect(lane.requestUndo()).toBe(true);
      await lane.whenIdle();
      expect(values.toArray()).toEqual([]);

      expect(lane.requestRedo()).toBe(true);
      await lane.whenIdle();
      expect(values.toArray()).toEqual(["A"]);

      expect(lane.requestRedo()).toBe(true);
      await lane.whenIdle();
      expect(reversed).toEqual(["delete", "redo-delete"]);

      expect(lane.requestRedo()).toBe(true);
      await lane.whenIdle();
      expect(values.toArray()).toEqual(["A", "B"]);
    } finally {
      lane.dispose();
      undoManager.destroy();
      document.destroy();
    }
  });

  test("releases Core retention when a redo branch or surface becomes unreachable", async () => {
    const document = new Y.Doc();
    const values = document.getArray<string>("values");
    const undoManager = new Y.UndoManager(values, { captureTimeout: 0 });
    const released: string[][] = [];
    const lane = createLane({
      undoManager,
      reverseStructural: async () => ({
        structuralEdit: structuralResult(token("redo-delete")),
      }),
      releaseStructural: async (tokens) => {
        released.push(tokens.map((candidate) => candidate.recipeOperationId));
      },
    });

    await seed(lane, structuralResult(token("delete")));
    expect(lane.requestUndo()).toBe(true);
    await lane.whenIdle();
    values.push(["new branch"]);
    await lane.whenIdle();
    expect(released).toEqual([["redo-delete"]]);

    await seed(lane, structuralResult(token("still-undoable")));
    lane.dispose();
    await lane.whenIdle();
    expect(released.at(-1)).toEqual(["still-undoable"]);
    undoManager.destroy();
    document.destroy();
  });

  test("supersedes a cut entry retained by another editor surface", async () => {
    const sourceDocument = new Y.Doc();
    const targetDocument = new Y.Doc();
    const sourceUndo = new Y.UndoManager(sourceDocument.getArray("source"));
    const targetUndo = new Y.UndoManager(targetDocument.getArray("target"));
    const source = createLane({ undoManager: sourceUndo });
    const target = createLane({ undoManager: targetUndo });

    try {
      await seed(source, structuralResult(token("cut-source")));
      expect(source.canUndo()).toBe(true);

      await seed(target, structuralResult(token("move-target"), ["cut-source"]));
      expect(source.canUndo()).toBe(false);
      expect(target.canUndo()).toBe(true);
    } finally {
      source.dispose();
      target.dispose();
      sourceUndo.destroy();
      targetUndo.destroy();
      sourceDocument.destroy();
      targetDocument.destroy();
    }
  });
});
