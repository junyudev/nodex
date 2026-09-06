import { describe, expect, test, vi } from "vite-plus/test";
import { createUuidV7 } from "../../../shared/uuid-v7";
import {
  createInteractionHistory,
  createSurfaceHistory,
  type HistoryCommandOutcome,
  type InteractionHistory,
} from "./owner";

interface Edit {
  readonly value: number;
  readonly label: string;
}
interface Change {
  readonly before: number;
  readonly after: number;
}
interface Request extends Change {
  readonly operationId: string;
}

const participant = (
  realm: InteractionHistory,
  label: string,
  abandon?: (request: Request) => Promise<void>,
) => {
  let value = 0;
  const committed = vi.fn();
  const release = vi.fn();
  const breakCapture = vi.fn();
  const submit = vi.fn(async (request: Request): Promise<HistoryCommandOutcome<Change>> => {
    value = request.after;
    return { kind: "committed", receipt: { before: request.before, after: request.after } };
  });
  const binding = realm.bind<number, Request, Change, Change>({
    scopeKey: label,
    breakCapture,
    onCommitted: committed,
    adapter: {
      describe: () => label,
      prepare: async (next) => ({
        kind: "submit",
        request: { operationId: createUuidV7(), before: value, after: next },
      }),
      prepareInverse: async (inverse) => ({
        kind: "submit",
        request: { operationId: createUuidV7(), before: inverse.after, after: inverse.before },
      }),
      submit,
      interpret: (receipt) => ({ kind: "reversible", inverse: receipt }),
      release,
      abandon,
    },
  });
  return { binding, committed, release, breakCapture, submit, value: () => value };
};

describe("interaction history bindings", () => {
  test("closed participants release late native captures without changing peer history", async () => {
    const realm = createInteractionHistory({ scopeKey: "scene" });
    const detached = participant(realm, "Detached");
    const live = participant(realm, "Live");
    detached.binding.close();
    await live.binding.execute(1).result;
    const before = realm.snapshot();
    const lateReceipt = { before: 2, after: 3 };
    expect(detached.binding.capture(3, lateReceipt)).toMatchObject({ status: "rejected" });
    await realm.whenIdle();
    expect(detached.release).toHaveBeenCalledExactlyOnceWith(lateReceipt, "discarded");
    expect(detached.committed).not.toHaveBeenCalled();
    expect(realm.snapshot()).toBe(before);
    expect((await detached.binding.request("undo").result).status).toBe("rejected");
    expect(live.value()).toBe(1);
    expect(realm.snapshot()).toBe(before);
    expect((await live.binding.request("undo").result).status).toBe("committed");
    expect(live.value()).toBe(0);
    realm.close();
  });

  test("closed participants cannot recover an uncertain peer action", async () => {
    const realm = createInteractionHistory({ scopeKey: "scene" });
    const detached = participant(realm, "Detached");
    const live = participant(realm, "Live");
    detached.binding.close();
    live.submit.mockResolvedValueOnce({ kind: "unknown", reason: "Reply lost" });
    expect((await live.binding.execute(1).result).status).toBe("recovering");
    const before = realm.snapshot();
    expect((await detached.binding.recover().result).status).toBe("rejected");
    expect(live.submit).toHaveBeenCalledOnce();
    expect(realm.snapshot()).toBe(before);
    expect((await live.binding.recover().result).status).toBe("committed");
    expect(live.value()).toBe(1);
    realm.close();
  });

  test("originating participants report presentation and resource failures even when another participant requests replay", async () => {
    const realmError = vi.fn();
    const originError = vi.fn();
    const realm = createInteractionHistory({ scopeKey: "scene", onError: realmError });
    const foreign = participant(realm, "Foreign");
    const presentationFailure = new Error("Presentation failed");
    const releaseFailure = new Error("Release failed");
    const binding = realm.bind<string, string, string, string>({
      onError: originError,
      onCommitted: () => {
        throw presentationFailure;
      },
      adapter: {
        describe: () => "Edit",
        prepare: async (receipt) => ({ kind: "complete", receipt }),
        prepareInverse: async (receipt) => ({ kind: "complete", receipt }),
        submit: async (receipt) => ({ kind: "committed", receipt }),
        interpret: (inverse) => ({ kind: "reversible", inverse }),
        release: async () => {
          throw releaseFailure;
        },
      },
    });
    await binding.execute("content").result;
    originError.mockClear();
    expect((await foreign.binding.request("undo").result).status).toBe("committed");
    await realm.whenIdle();
    expect(originError).toHaveBeenCalledWith(presentationFailure);
    expect(originError).toHaveBeenCalledWith(releaseFailure);
    expect(realmError).not.toHaveBeenCalled();
    realm.close();
    await realm.whenIdle();
  });
  test("heterogeneous bindings share chronology and present through the originating adapter", async () => {
    const realm = createInteractionHistory({ scopeKey: "scene" });
    const database = participant(realm, "Move Pages");
    const presentText = vi.fn();
    const text = realm.bind<string, string, string, string>({
      onCommitted: presentText,
      adapter: {
        describe: () => "Edit Text",
        prepare: async (value) => ({ kind: "complete", receipt: value }),
        prepareInverse: async (value) => ({ kind: "complete", receipt: value.toUpperCase() }),
        submit: async (value) => ({ kind: "committed", receipt: value }),
        interpret: (value) => ({ kind: "reversible", inverse: value }),
      },
    });
    await text.execute("hello").result;
    await database.binding.execute(5).result;
    expect(text.snapshot().ownerId).toBe(database.binding.snapshot().ownerId);
    expect(text.retained()).toHaveLength(1);
    expect(database.binding.retained()).toHaveLength(1);
    presentText.mockClear();
    database.committed.mockClear();
    const result = await text.request("undo").result;
    expect(result).toEqual({ status: "committed", entryId: 2 });
    expect(database.value()).toBe(0);
    expect(database.committed).toHaveBeenCalledExactlyOnceWith({ before: 5, after: 0 });
    expect(presentText).not.toHaveBeenCalled();
    await database.binding.request("undo").result;
    expect(presentText).toHaveBeenCalledExactlyOnceWith("HELLO");
    realm.close();
  });

  test("capture ownership switches before native grouping and durable admission cuts the active group", async () => {
    const realm = createInteractionHistory({ scopeKey: "scene" });
    const a = participant(realm, "A");
    const b = participant(realm, "B");
    a.binding.beginLocalCapture();
    a.breakCapture.mockClear();
    a.binding.beginLocalCapture();
    expect(a.breakCapture).not.toHaveBeenCalled();
    b.binding.beginLocalCapture();
    expect(a.breakCapture).toHaveBeenCalledTimes(1);
    expect(b.breakCapture).toHaveBeenCalledTimes(1);
    await a.binding.execute(1).result;
    expect(b.breakCapture).toHaveBeenCalledTimes(2);
    realm.close();
  });

  test("reconciliation is binding-scoped and preserves exact inverse identity", async () => {
    const realm = createInteractionHistory({ scopeKey: "scene" });
    const a = participant(realm, "A");
    const b = participant(realm, "B");
    await a.binding.execute(1).result;
    const entry = a.binding.retained()[0]!;
    expect(
      b.binding.reconcile({
        entryId: entry.entryId,
        expectedInverse: entry.inverse!,
        state: "superseded",
      }),
    ).toBe(false);
    expect(
      a.binding.reconcile({
        entryId: entry.entryId,
        expectedInverse: { ...entry.inverse! },
        state: "superseded",
      }),
    ).toBe(false);
    expect(
      a.binding.reconcile({
        entryId: entry.entryId,
        expectedInverse: entry.inverse!,
        state: "superseded",
      }),
    ).toBe(true);
    expect(realm.snapshot().undo.status).toBe("empty");
    realm.close();
  });

  test("closing a participant retires the dependent prefix and redo but preserves newer foreign actions", async () => {
    const realm = createInteractionHistory({ scopeKey: "scene" });
    const a = participant(realm, "A");
    const b = participant(realm, "B");
    await b.binding.execute(1).result;
    await a.binding.execute(1).result;
    await b.binding.execute(2).result;
    await b.binding.execute(3).result;
    await realm.request("undo").result;
    a.binding.close();
    expect(b.binding.retained().map((entry) => entry.entryId)).toEqual([3]);
    expect(realm.snapshot().redo.status).toBe("empty");
    await realm.request("undo").result;
    expect(b.value()).toBe(1);
    expect(realm.snapshot().undo.status).toBe("empty");
    expect(a.release).toHaveBeenCalledTimes(1);
    realm.close();
  });

  test("detached uncertain attempts retain a global barrier and recover the exact frozen request", async () => {
    const realm = createInteractionHistory({ scopeKey: "scene" });
    const a = participant(realm, "A");
    const b = participant(realm, "B");
    a.submit.mockResolvedValueOnce({ kind: "unknown", reason: "Reply lost" });
    expect((await a.binding.execute(7).result).status).toBe("recovering");
    const request = a.submit.mock.calls[0]![0];
    a.binding.close();
    expect(realm.snapshot().undo.status).toBe("waiting");
    expect((await b.binding.execute(1).result).status).toBe("rejected");
    expect((await b.binding.recover().result).status).toBe("committed");
    expect(a.submit.mock.calls[1]![0]).toBe(request);
    expect(realm.snapshot().undo.status).toBe("empty");
    expect(a.committed).not.toHaveBeenCalled();
    expect(a.release).toHaveBeenCalledExactlyOnceWith({ before: 0, after: 7 }, "discarded");
    realm.close();
  });

  test("changing one binding scope never resets newer foreign history", async () => {
    const realm = createInteractionHistory({ scopeKey: "scene" });
    const a = participant(realm, "A");
    const b = participant(realm, "B");
    await a.binding.execute(1).result;
    await b.binding.execute(1).result;
    a.binding.setScope("A2");
    expect(b.binding.retained()).toHaveLength(1);
    expect(a.binding.retained()).toHaveLength(0);
    await a.binding.execute(2).result;
    expect(a.binding.retained()).toHaveLength(1);
    realm.close();
  });

  test.each(["unknown", "submitting"] as const)(
    "closing a %s attempt hands its frozen request to Main and keeps a nonretryable barrier",
    async (phase) => {
      const realm = createInteractionHistory({ scopeKey: "scene" });
      const abandon = vi.fn(async () => {});
      const a = participant(realm, "A", abandon);
      const response = deferred<HistoryCommandOutcome<Change>>();
      a.submit.mockImplementationOnce(() => response.promise);
      const command = a.binding.execute(4);
      await vi.waitFor(() => expect(a.submit).toHaveBeenCalledOnce());
      if (phase === "unknown") {
        response.resolve({ kind: "unknown", reason: "Response lost" });
        expect((await command.result).status).toBe("recovering");
      }
      a.binding.close();
      expect(abandon).toHaveBeenCalledExactlyOnceWith(a.submit.mock.calls[0]![0], undefined);
      if (phase === "submitting") {
        response.resolve({ kind: "unknown", reason: "Response lost" });
        expect((await command.result).status).toBe("blocked");
      }
      expect(realm.snapshot().undo).toMatchObject({
        status: "blocked",
        recoveryActions: ["reset"],
      });
      expect((await realm.recover().result).status).toBe("blocked");
      expect(a.submit).toHaveBeenCalledOnce();
      realm.close();
      await realm.whenIdle();
      expect(abandon).toHaveBeenCalledOnce();
    },
  );

  test("closing during preparation never submits or hands off an unsent request", async () => {
    const realm = createInteractionHistory({ scopeKey: "scene" });
    const prepared = deferred<{ kind: "submit"; request: string }>();
    const submit = vi.fn(async (request: string) => ({
      kind: "committed" as const,
      receipt: request,
    }));
    const abandon = vi.fn(async () => {});
    const binding = realm.bind<string, string, string, string>({
      adapter: {
        describe: () => "Pending",
        prepare: () => prepared.promise,
        prepareInverse: async (request) => ({ kind: "submit", request }),
        submit,
        abandon,
        interpret: (inverse) => ({ kind: "reversible", inverse }),
      },
    });
    const command = binding.execute("start");
    binding.close();
    prepared.resolve({ kind: "submit", request: "frozen" });
    expect((await command.result).status).toBe("rejected");
    expect(submit).not.toHaveBeenCalled();
    expect(abandon).not.toHaveBeenCalled();
    expect(realm.snapshot().undo.status).toBe("empty");
    realm.close();
  });
});

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
};

const fixture = (limits?: {
  maxEntries?: number;
  maxBytes?: number;
  maxPending?: number;
  maxRequestBytes?: number;
}) => {
  let value = 0;
  let lostReplies = 0;
  const receipts = new Map<string, Change>();
  const prepare = vi.fn(async (edit: Edit): Promise<Request> => ({
    operationId: createUuidV7(),
    before: value,
    after: edit.value,
  }));
  const submit = vi.fn(async (request: Request): Promise<HistoryCommandOutcome<Change>> => {
    const duplicate = receipts.get(request.operationId);
    if (duplicate) return { kind: "committed", receipt: duplicate };
    if (request.before !== value)
      return { kind: "rejected", reason: "Content changed", retryable: true };
    value = request.after;
    const receipt = { before: request.before, after: request.after };
    receipts.set(request.operationId, receipt);
    if (lostReplies > 0) {
      lostReplies--;
      return { kind: "unknown", reason: "Response unavailable" };
    }
    return { kind: "committed", receipt };
  });
  const release = vi.fn(async (_inverse: Change) => {});
  const history = createSurfaceHistory<Edit, Request, Change, Change>({
    scopeKey: "scope:a",
    limits,
    adapter: {
      describe: (edit) => edit.label,
      prepare: async (edit) => ({ kind: "submit", request: await prepare(edit) }),
      prepareInverse: async (inverse) => ({
        kind: "submit",
        request: {
          operationId: createUuidV7(),
          before: inverse.after,
          after: inverse.before,
        },
      }),
      submit,
      interpret: (receipt) =>
        receipt.before === receipt.after
          ? { kind: "noop" }
          : { kind: "reversible", inverse: receipt },
      release,
    },
  });
  return {
    history,
    prepare,
    submit,
    release,
    value: () => value,
    loseReply: () => {
      lostReplies++;
    },
    edit: (value: number) => history.execute({ value, label: `Set ${value}` }),
    capture: (next: number) => {
      const before = value;
      value = next;
      return history.capture({ value: next, label: `Type ${next}` }, { before, after: next });
    },
  };
};

describe("surface history command owner", () => {
  test.each(["undo", "redo"] as const)(
    "the opposite gesture waits for a submitted %s receipt",
    async (direction) => {
      const { history, edit, submit, value } = fixture();
      await edit(1).result;
      if (direction === "redo") await history.request("undo").result;
      const opposite = direction === "undo" ? "redo" : "undo";
      const initialValue = value();
      const deliverReceipt = deferred<void>();
      const canonicalSubmit = submit.getMockImplementation()!;
      submit.mockImplementationOnce(async (request) => {
        const outcome = await canonicalSubmit(request);
        await deliverReceipt.promise;
        return outcome;
      });
      const replay = history.request(direction);
      try {
        await vi.waitFor(() => expect(value()).not.toBe(initialValue));
        expect(history.snapshot()[opposite]).toMatchObject({
          status: "waiting",
          acceptsIntent: true,
        });
        const queued = history.request(opposite);
        expect(queued.accepted).toBe(true);
        deliverReceipt.resolve();
        expect((await replay.result).status).toBe("committed");
        expect((await queued.result).status).toBe("committed");
        expect(value()).toBe(initialValue);
      } finally {
        deliverReceipt.resolve();
        await history.whenIdle();
        history.close();
      }
    },
  );

  test("an opposite gesture stays fenced by unknown recovery and cannot revive a forked branch", async () => {
    const { history, edit, submit, capture, loseReply, value } = fixture();
    await edit(1).result;
    const deliverReceipt = deferred<void>();
    const canonicalSubmit = submit.getMockImplementation()!;
    loseReply();
    submit.mockImplementationOnce(async (request) => {
      const outcome = await canonicalSubmit(request);
      await deliverReceipt.promise;
      return outcome;
    });
    const undo = history.request("undo");
    try {
      await vi.waitFor(() => expect(value()).toBe(0));
      const redo = history.request("redo");
      expect(redo.accepted).toBe(true);
      deliverReceipt.resolve();
      expect((await undo.result).status).toBe("recovering");
      expect(history.snapshot().redo).toMatchObject({ status: "waiting", acceptsIntent: false });
      expect((await history.request("redo").result).status).toBe("blocked");
      capture(2);
      expect((await history.recover().result).status).toBe("committed");
      expect((await redo.result).status).toBe("noop");
      expect(value()).toBe(2);
      expect(history.snapshot().redo.status).toBe("empty");
      expect(history.snapshot().undo.label).toBe("Type 2");
      expect(submit.mock.calls[2]![0].operationId).toBe(submit.mock.calls[1]![0].operationId);
    } finally {
      deliverReceipt.resolve();
      history.close();
      await history.whenIdle();
    }
  });

  test("an irreversible committed receipt releases its resources without removing the barrier", async () => {
    const released: string[] = [];
    const cleanup = deferred<void>();
    const history = createSurfaceHistory<string, string, string, string>({
      scopeKey: "receipt-resources",
      adapter: {
        describe: (intent) => intent,
        prepare: async (request) => ({ kind: "submit", request }),
        prepareInverse: async (request) => ({ kind: "submit", request }),
        submit: async (receipt) => ({ kind: "committed", receipt }),
        interpret: () => ({ kind: "barrier", reason: "No complete inverse" }),
        discardReceipt: async (receipt) => {
          await cleanup.promise;
          released.push(receipt);
        },
      },
    });
    expect((await history.execute("partial-capability").result).status).toBe("committed");
    expect(history.snapshot().undo.status).toBe("blocked");
    expect((await history.request("undo").result).status).toBe("blocked");
    cleanup.resolve();
    await history.whenIdle();
    expect(released).toEqual(["partial-capability"]);
    expect(history.snapshot().undo.status).toBe("blocked");
  });
  test("a retired inverse releases its original resource after authoritative non-commit", async () => {
    const { history, edit, capture, submit, release } = fixture();
    await edit(1).result;
    await history.request("undo").result;
    const response = deferred<HistoryCommandOutcome<Change>>();
    submit.mockImplementationOnce(() => response.promise);
    const redo = history.request("redo");
    await vi.waitFor(() => expect(submit).toHaveBeenCalledTimes(3));
    capture(3);
    expect(release).not.toHaveBeenCalledWith({ before: 1, after: 0 }, "discarded");
    response.resolve({ kind: "rejected", reason: "Content changed", retryable: true });
    await redo.result;
    expect(release).toHaveBeenCalledWith({ before: 1, after: 0 }, "discarded");
    expect(history.snapshot().redo.status).toBe("empty");
  });

  test("shared identity pressure is remeasured after synchronous disposal and oversized replay retires its prefix", () => {
    interface Capture {
      keys: number[];
      oversized?: boolean;
    }
    const live = new Set<Capture>();
    const history = createSurfaceHistory<string, Capture, Capture, Capture>({
      scopeKey: "native-retention",
      limits: { maxRetainedIdentities: 2 },
      retainedIdentityCount: () => new Set([...live].flatMap((capture) => capture.keys)).size,
      adapter: {
        describe: (label) => label,
        prepare: async () => ({ kind: "complete", receipt: { keys: [] } }),
        prepareInverse: async (inverse) => ({ kind: "submit", request: inverse }),
        submit: async (receipt) => ({ kind: "committed", receipt }),
        interpret: (inverse) => {
          live.add(inverse);
          return { kind: "reversible", inverse };
        },
        exceedsReplayBounds: (inverse) => inverse.oversized ?? false,
        release: (inverse) => {
          live.delete(inverse);
        },
      },
    });
    const a = { keys: [1] };
    const b = { keys: [2] };
    const c = { keys: [2] };
    const d = { keys: [3] };
    for (const [index, capture] of [a, b, c, d].entries()) history.capture(String(index), capture);
    expect([...live]).toEqual([b, c, d]);
    expect(history.retained().map((entry) => entry.inverse)).toEqual([b, c, d]);
    history.capture("Too large to replay", { keys: [3], oversized: true });
    expect(live.size).toBe(0);
    expect(history.retained()).toEqual([]);
  });

  test("request-time reconciliation reselects beneath the original gesture ceiling", async () => {
    const gate = deferred<{ state: "superseded" }>();
    const submitted: number[] = [];
    const history = createSurfaceHistory<string, number, number, number>({
      scopeKey: "reconciled",
      adapter: {
        describe: (label) => label,
        prepare: async () => ({ kind: "complete", receipt: 0 }),
        prepareInverse: async (inverse) => ({ kind: "submit", request: inverse }),
        checkInverse: async (inverse) => (inverse === 2 ? gate.promise : { state: "ready" }),
        submit: async (inverse) => {
          submitted.push(inverse);
          return { kind: "committed", receipt: -inverse };
        },
        interpret: (inverse) =>
          inverse === 0 ? { kind: "noop" } : { kind: "reversible", inverse },
      },
    });
    history.capture("A", 1);
    history.capture("B", 2);
    const undo = history.request("undo");
    history.capture("C", 3);
    gate.resolve({ state: "superseded" });
    await undo.result;
    expect(submitted).toEqual([1]);
    expect(history.snapshot().undo.label).toBe("C");
    await history.request("undo").result;
    expect(submitted).toEqual([1, 3]);
  });

  test("a locally completed preparation fills its reserved gesture without a fake transport request", async () => {
    let value = 0;
    const ready = deferred<void>();
    const submit = vi.fn(async (request: Change): Promise<HistoryCommandOutcome<Change>> => {
      value = request.after;
      return { kind: "committed", receipt: request };
    });
    const history = createSurfaceHistory<string, Change, Change, Change>({
      scopeKey: "local-paste",
      adapter: {
        describe: (intent) => intent,
        prepare: async () => {
          await ready.promise;
          value = 1;
          return { kind: "complete", receipt: { before: 0, after: 1 } };
        },
        prepareInverse: async (inverse) => ({
          kind: "submit",
          request: { before: inverse.after, after: inverse.before },
        }),
        submit,
        interpret: (inverse) => ({ kind: "reversible", inverse }),
      },
    });
    const paste = history.execute("Paste");
    const undo = history.request("undo");
    ready.resolve();
    expect((await paste.result).status).toBe("committed");
    expect((await undo.result).status).toBe("committed");
    expect(value).toBe(0);
    expect(submit).toHaveBeenCalledExactlyOnceWith({ before: 1, after: 0 });
    expect(history.retained()).toHaveLength(1);
    expect(history.snapshot().redo.status).toBe("ready");
  });

  test("reconciliation cannot retire a pending or replaced inverse, and unavailable history stays a barrier", async () => {
    const { history, edit, submit, release } = fixture();
    await edit(1).result;
    const original = history.retained()[0]!;
    const response = deferred<HistoryCommandOutcome<Change>>();
    submit.mockImplementationOnce(() => response.promise);
    const undo = history.request("undo");
    expect(history.retained()[0]).toMatchObject({ state: "pending", inverse: original.inverse });
    expect(
      history.reconcile({
        entryId: original.entryId,
        expectedInverse: original.inverse!,
        state: "superseded",
      }),
    ).toBe(false);
    await vi.waitFor(() => expect(submit).toHaveBeenCalledTimes(2));
    response.resolve({ kind: "committed", receipt: { before: 1, after: 0 } });
    await undo.result;
    expect(
      history.reconcile({
        entryId: original.entryId,
        expectedInverse: original.inverse!,
        state: "superseded",
      }),
    ).toBe(false);
    const current = history.retained()[0]!;
    expect(
      history.reconcile({
        entryId: current.entryId,
        expectedInverse: current.inverse!,
        state: "unavailable",
      }),
    ).toBe(true);
    expect(history.snapshot().redo.status).toBe("blocked");
    expect((await history.request("redo").result).status).toBe("blocked");
    expect(submit).toHaveBeenCalledTimes(2);
    expect(
      history.reconcile({
        entryId: current.entryId,
        expectedInverse: current.inverse!,
        state: "superseded",
      }),
    ).toBe(true);
    expect(history.retained()).toEqual([]);
    expect(release).toHaveBeenLastCalledWith(current.inverse, "consumed");
  });

  test("unknown is quiescent even with dependent commands waiting, and recovery drains them", async () => {
    const { history, edit, loseReply, submit, value } = fixture();
    loseReply();
    const first = edit(1);
    const second = edit(2);
    await first.result;
    await history.whenIdle();
    expect(submit).toHaveBeenCalledTimes(1);
    await history.recover().result;
    await history.whenIdle();
    expect((await second.result).status).toBe("committed");
    expect(value()).toBe(2);
  });

  test("closing waits for resource handoff but not an already-sent response", async () => {
    const { history, edit, submit, release } = fixture();
    await edit(1).result;
    const response = deferred<HistoryCommandOutcome<Change>>();
    const cleanup = deferred<void>();
    release.mockImplementationOnce(() => cleanup.promise);
    submit.mockImplementationOnce(() => response.promise);
    const command = edit(2);
    await vi.waitFor(() => expect(submit).toHaveBeenCalledTimes(2));
    history.close();
    let idle = false;
    const waiting = history.whenIdle().then(() => {
      idle = true;
    });
    await Promise.resolve();
    expect(idle).toBe(false);
    cleanup.resolve();
    await waiting;
    expect(idle).toBe(true);
    response.resolve({ kind: "committed", receipt: { before: 1, after: 2 } });
    await command.result;
    expect(history.retained()).toEqual([]);
    expect(release).toHaveBeenLastCalledWith({ before: 1, after: 2 }, "discarded");
  });

  test("authoritative replay consumes the old inverse once and reset discards only the replacement", async () => {
    const { history, edit, release, loseReply } = fixture();
    await edit(1).result;
    loseReply();
    expect((await history.request("undo").result).status).toBe("recovering");
    expect(release).not.toHaveBeenCalled();
    await history.recover().result;
    expect(release).toHaveBeenCalledExactlyOnceWith({ before: 0, after: 1 }, "consumed");
    history.reset();
    expect(release).toHaveBeenCalledTimes(2);
    expect(release).toHaveBeenLastCalledWith({ before: 1, after: 0 }, "discarded");
  });

  test("native capture groups retain their identity, fork redo, and remeasure opaque content", async () => {
    interface Capture {
      bytes: number;
      self?: Capture;
    }
    const released: Capture[] = [];
    const history = createSurfaceHistory<string, Capture, Capture, Capture>({
      scopeKey: "native",
      limits: { maxBytes: 10 },
      adapter: {
        describe: (label) => label,
        prepare: async () => ({ kind: "submit", request: { bytes: 1 } }),
        prepareInverse: async (inverse) => ({ kind: "submit", request: inverse }),
        submit: async (request) => ({ kind: "committed", receipt: request }),
        interpret: (inverse) => ({ kind: "reversible", inverse }),
        inverseBytes: (inverse) => inverse.bytes,
        replayLocal: () => ({ kind: "committed", receipt: { bytes: 1 } }),
        release: async (inverse) => {
          released.push(inverse);
        },
      },
    });
    const first: Capture = { bytes: 2 };
    first.self = first;
    const captured = history.capture("first", first);
    expect(captured.status).toBe("committed");
    if (captured.status !== "committed") throw new Error("Missing capture");
    history.capture("second", { bytes: 2 });
    expect(history.refreshCapture(captured.entryId)).toBe(false);
    await history.request("undo").result;
    expect(history.snapshot().redo.status).toBe("ready");
    first.bytes = 9;
    expect(history.refreshCapture(captured.entryId)).toBe(true);
    expect(history.snapshot().redo.status).toBe("empty");
    expect(history.snapshot().undo.label).toBe("first");
    expect(released).not.toContain(first);
    first.bytes = 11;
    expect(history.refreshCapture(captured.entryId)).toBe(true);
    expect(history.snapshot().undo.status).toBe("empty");
    expect(released).toContain(first);
    first.bytes = 1;
    expect(history.refreshCapture(captured.entryId)).toBe(false);
    expect(history.snapshot().undo.status).toBe("empty");
  });

  test("independent native text replays synchronously while a previous forward awaits its receipt", async () => {
    type Field = "remote" | "text";
    type Patch = Change & { readonly field: Field };
    const content = { remote: 0, text: 0 };
    const response = deferred<HistoryCommandOutcome<Patch>>();
    const history = createSurfaceHistory<Field, Patch, Patch, Patch>({
      scopeKey: "editor",
      adapter: {
        describe: (field) => field,
        prepare: async (field) => ({ kind: "submit", request: { field, before: 0, after: 1 } }),
        prepareInverse: async (patch) => ({
          kind: "submit",
          request: {
            field: patch.field,
            before: patch.after,
            after: patch.before,
          },
        }),
        submit: () => response.promise,
        interpret: (receipt) => ({ kind: "reversible", inverse: receipt }),
        replayLocal: (inverse) => {
          if (inverse.field !== "text") return { kind: "defer" };
          content.text = inverse.before;
          return {
            kind: "committed",
            receipt: { field: "text", before: inverse.after, after: inverse.before },
          };
        },
      },
    });
    const forward = history.execute("remote");
    await Promise.resolve();
    content.text = 1;
    history.capture("text", { field: "text", before: 0, after: 1 });
    const undo = history.request("undo");
    expect(content.text).toBe(0);
    expect((await undo.result).status).toBe("committed");
    content.remote = 1;
    response.resolve({ kind: "committed", receipt: { field: "remote", before: 0, after: 1 } });
    await forward.result;
    const redo = history.request("redo");
    expect(content).toEqual({ remote: 1, text: 1 });
    expect((await redo.result).status).toBe("committed");
  });

  test("local input during an uncertain inverse forks history without reviving its late Redo", async () => {
    const { history, edit, capture, loseReply, value, release } = fixture();
    await edit(1).result;
    loseReply();
    expect((await history.request("undo").result).status).toBe("recovering");
    expect(value()).toBe(0);
    expect(capture(2).status).toBe("committed");
    expect(history.snapshot().undo.label).toBe("Type 2");
    expect((await history.request("undo").result).status).toBe("blocked");
    expect((await history.recover().result).status).toBe("committed");
    expect(history.snapshot().redo.status).toBe("empty");
    expect(release).toHaveBeenCalledWith({ before: 1, after: 0 }, "discarded");
    await history.request("undo").result;
    expect(value()).toBe(0);
    expect(history.snapshot().undo.status).toBe("empty");
    await history.request("redo").result;
    expect(value()).toBe(2);
  });

  test("admission pressure rejects before preparation and leaves no ghost entry", async () => {
    const { history, edit, prepare, submit } = fixture({ maxPending: 1 });
    const pending = deferred<Request>();
    prepare.mockImplementationOnce(() => pending.promise);
    const first = edit(1);
    expect((await edit(2).result).status).toBe("rejected");
    expect(prepare).toHaveBeenCalledOnce();
    pending.resolve({ operationId: createUuidV7(), before: 0, after: 1 });
    await first.result;
    await history.request("undo").result;
    expect(submit).toHaveBeenCalledTimes(2);
    expect(history.snapshot().undo.status).toBe("empty");
  });

  test("an oversized frozen request never reaches the transport or leaves a barrier", async () => {
    const { history, edit, submit } = fixture({ maxRequestBytes: 1 });
    expect((await edit(1).result).status).toBe("rejected");
    expect(submit).not.toHaveBeenCalled();
    expect(history.snapshot().undo.status).toBe("empty");
  });

  test("an unrecoverable forward cannot retain Redo from a possibly superseded branch", async () => {
    const { history, edit, submit } = fixture();
    await edit(1).result;
    await history.request("undo").result;
    submit.mockResolvedValueOnce({ kind: "unrecoverable", reason: "Receipt expired" });
    expect((await edit(2).result).status).toBe("blocked");
    expect(history.snapshot().redo.status).toBe("empty");
    expect(history.snapshot().undo.status).toBe("blocked");
    expect((await history.request("redo").result).status).toBe("noop");
    expect(submit).toHaveBeenCalledTimes(3);
  });

  test("entry pressure removes only the unreachable old prefix", async () => {
    const { history, edit, value, release } = fixture({ maxEntries: 2 });
    await edit(1).result;
    await edit(2).result;
    await edit(3).result;
    expect(release).toHaveBeenCalledWith({ before: 0, after: 1 }, "discarded");
    await history.request("undo").result;
    await history.request("undo").result;
    expect(value()).toBe(1);
    expect((await history.request("undo").result).status).toBe("noop");
    await history.request("redo").result;
    await history.request("redo").result;
    expect(value()).toBe(3);
  });
  test("unknown B blocks Undo of A, then exact recovery installs one symmetric history entry", async () => {
    const { history, edit, loseReply, value, submit, prepare } = fixture();
    await edit(1).result;
    loseReply();
    const second = edit(2);
    expect((await second.result).status).toBe("recovering");
    expect(value()).toBe(2);
    expect((await history.request("undo").result).status).toBe("blocked");
    expect(submit).toHaveBeenCalledTimes(2);
    expect(history.snapshot().undo.status).toBe("waiting");
    expect((await history.recover().result).status).toBe("committed");
    expect(prepare).toHaveBeenCalledTimes(2);
    expect(submit.mock.calls[2]?.[0]).toEqual(submit.mock.calls[1]?.[0]);
    await history.request("undo").result;
    expect(value()).toBe(1);
    await history.request("redo").result;
    expect(value()).toBe(2);
    await history.request("undo").result;
    await history.request("undo").result;
    expect(value()).toBe(0);
    expect(history.snapshot().undo.status).toBe("empty");
  });

  test("reserves order before preparation and captures the Undo gesture's sequence ceiling", async () => {
    const { history, edit, prepare, value } = fixture();
    await edit(1).result;
    const preparation = deferred<Request>();
    prepare.mockImplementationOnce(() => preparation.promise);
    const second = edit(2);
    expect(history.snapshot().undo).toMatchObject({ status: "waiting", label: "Set 2" });
    const undo = history.request("undo");
    const third = edit(3);
    preparation.resolve({ operationId: createUuidV7(), before: 1, after: 2 });
    await second.result;
    await undo.result;
    await third.result;
    await history.request("undo").result;
    expect(value()).toBe(1);
  });

  test("no-op and known non-commit preserve Redo; a new effective edit retires it", async () => {
    const { history, edit, submit, value } = fixture();
    await edit(1).result;
    await history.request("undo").result;
    expect((await edit(0).result).status).toBe("noop");
    expect(history.snapshot().redo.status).toBe("ready");
    submit.mockResolvedValueOnce({ kind: "rejected", reason: "Permission lost", retryable: false });
    expect((await edit(2).result).status).toBe("rejected");
    await history.request("redo").result;
    expect(value()).toBe(1);
    await history.request("undo").result;
    await edit(3).result;
    expect(history.snapshot().redo.status).toBe("empty");
  });

  test("an ordinary transport exception is uncertain, while a preparation failure was never sent", async () => {
    const { history, edit, prepare, submit } = fixture();
    await edit(1).result;
    prepare.mockRejectedValueOnce(new Error("Source editor disappeared"));
    expect((await edit(2).result).status).toBe("rejected");
    expect(submit).toHaveBeenCalledTimes(1);
    submit.mockRejectedValueOnce(new Error("IPC disconnected"));
    expect((await edit(2).result).status).toBe("recovering");
    expect((await history.request("undo").result).status).toBe("blocked");
    expect(submit).toHaveBeenCalledTimes(2);
  });

  test("reset retires the whole old interval without accepting a late inverse into the new branch", async () => {
    const { history, edit, submit, release } = fixture();
    await edit(1).result;
    const response = deferred<HistoryCommandOutcome<Change>>();
    submit.mockImplementationOnce(() => response.promise);
    const pending = edit(2);
    await vi.waitFor(() => expect(submit).toHaveBeenCalledTimes(2));
    history.reset();
    expect(history.snapshot().undo.status).toBe("empty");
    response.resolve({ kind: "committed", receipt: { before: 1, after: 2 } });
    await pending.result;
    expect(history.snapshot().undo.status).toBe("empty");
    await vi.waitFor(() =>
      expect(release).toHaveBeenCalledWith({ before: 1, after: 2 }, "discarded"),
    );
  });

  test("an unrepresentable committed receipt creates a barrier, not a rejection or a retry", async () => {
    const { history, edit, submit } = fixture();
    await edit(1).result;
    submit.mockResolvedValueOnce({ kind: "committed", receipt: null as unknown as Change });
    expect((await edit(2).result).status).toBe("committed");
    expect(history.snapshot().undo.status).toBe("blocked");
    await history.request("undo").result;
    expect(submit).toHaveBeenCalledTimes(2);
  });
});
