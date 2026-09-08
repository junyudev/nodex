import { describe, expect, test, vi } from "vite-plus/test";
import type { CodexThreadHandoffSnapshot } from "../../shared/codex-thread-handoff";
import { buildThreadHandoffOperation } from "../test/thread-handoff-fixture";
import { createThreadHandoffStore, selectThreadHandoffOperation } from "./thread-handoff-runtime";

function deferred<A>() {
  let resolve!: (value: A) => void;
  const promise = new Promise<A>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

const scope = {
  operationId: "operation-1",
  requestThreadId: "thread-1",
  targetThreadId: "thread-target",
  destinationHostId: "local",
};

describe("Thread handoff observation", () => {
  test("shares one subscription, fences a delayed bootstrap, and releases the last consumer", async () => {
    const bootstrap = deferred<CodexThreadHandoffSnapshot>();
    let deliver: (snapshot: CodexThreadHandoffSnapshot) => void = () => undefined;
    const stop = vi.fn();
    const transport = {
      read: vi.fn(() => bootstrap.promise),
      subscribe: vi.fn((listener: typeof deliver) => {
        deliver = listener;
        return stop;
      }),
    };
    const store = createThreadHandoffStore(transport);
    const first = vi.fn();
    const second = vi.fn();
    const releaseFirst = store.subscribe(first);
    const releaseSecond = store.subscribe(second);
    const current = {
      revision: 3,
      operations: [buildThreadHandoffOperation({ status: "success" })],
    };
    deliver(current);
    bootstrap.resolve({ revision: 1, operations: [buildThreadHandoffOperation()] });
    await bootstrap.promise;
    await Promise.resolve();
    expect(transport.subscribe).toHaveBeenCalledTimes(1);
    expect(transport.read).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot()).toBe(current);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
    releaseFirst();
    expect(stop).not.toHaveBeenCalled();
    releaseSecond();
    expect(stop).toHaveBeenCalledOnce();
  });

  test("ignores bootstrap responses from a released observation generation", async () => {
    const stale = deferred<CodexThreadHandoffSnapshot>();
    const latest = deferred<CodexThreadHandoffSnapshot>();
    const read = vi.fn().mockReturnValueOnce(stale.promise).mockReturnValueOnce(latest.promise);
    const store = createThreadHandoffStore({ read, subscribe: () => () => undefined });
    store.subscribe(() => undefined)();
    const release = store.subscribe(() => undefined);
    stale.resolve({ revision: 100, operations: [buildThreadHandoffOperation()] });
    latest.resolve({ revision: 1, operations: [] });
    await Promise.all([stale.promise, latest.promise]);
    await Promise.resolve();
    expect(store.getSnapshot()).toEqual({ revision: 1, operations: [] });
    release();
  });

  test("selects only the operation belonging to the originating call and target scope", () => {
    const operation = buildThreadHandoffOperation();
    const snapshot = { revision: 1, operations: [operation] };
    expect(selectThreadHandoffOperation(snapshot, scope)).toBe(operation);
    expect(selectThreadHandoffOperation(snapshot, { ...scope, operationId: "other" })).toBeNull();
    expect(
      selectThreadHandoffOperation(snapshot, { ...scope, requestThreadId: "other" }),
    ).toBeNull();
    expect(
      selectThreadHandoffOperation(snapshot, { ...scope, targetThreadId: "other" }),
    ).toBeNull();
    expect(
      selectThreadHandoffOperation(snapshot, { ...scope, destinationHostId: "other" }),
    ).toBeNull();
  });
});
