import { expect, test } from "vitest";
import {
  QueuedMessageCoordinator,
  type QueuedMessageCoordinatorClient,
  type QueuedMessageRole,
  type QueuedMessageState,
} from "./codex-queued-message-coordinator";
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
function fixture() {
  let state: QueuedMessageState<string> = { thread: ["persisted"] };
  let role: QueuedMessageRole = { role: "owner" };
  const broadcasts: readonly string[][] = [];
  const client: QueuedMessageCoordinatorClient<string> = {
    storage: {
      read: () => ({ isLoading: false, value: state }),
      load: async () => state,
      update: async (recipe) => {
        state = recipe(state);
      },
    },
    role: () => role,
    validate() {},
    requestFollower: async () => {},
    broadcast: async () => {},
    changed() {},
    wake() {},
    error() {},
  };
  const queue = new QueuedMessageCoordinator(client);
  return {
    queue,
    client,
    broadcasts,
    setRole: (next: QueuedMessageRole) => {
      role = next;
    },
    setState: (next: QueuedMessageState<string>) => {
      state = next;
    },
    read: () => state,
  };
}
test("owner FIFO reevaluates each recipe against committed storage rather than optimistic stale state", async () => {
  const f = fixture();
  const gate = deferred<void>();
  const commits: string[][] = [];
  let first = true;
  f.client.storage.update = async (recipe) => {
    if (first) {
      first = false;
      await gate.promise;
    }
    const next = recipe(f.read());
    f.setState(next);
    commits.push([...(next.thread ?? [])]);
  };
  const one = f.queue.update("thread", (messages) => [...messages, "one"]);
  const two = f.queue.update("thread", (messages) => [...messages, "two"]);
  expect(f.queue.readMessages("thread")).toEqual(["persisted", "one", "two"]);
  f.setState({ thread: ["external"] });
  gate.resolve();
  await Promise.all([one, two]);
  expect(commits).toEqual([
    ["external", "one"],
    ["external", "one", "two"],
  ]);
  expect(f.read().thread).toEqual(["external", "one", "two"]);
  f.queue[Symbol.dispose]();
});
test("shutdown drains optimistic queue edits through the final storage write", async () => {
  const f = fixture();
  const gate = deferred<void>();
  f.client.storage.update = async (recipe) => {
    await gate.promise;
    f.setState(recipe(f.read()));
  };
  f.queue.mutate("thread", () => ["paused"]);
  let drained = false;
  const flush = f.queue.flushPendingWrites().then(() => {
    drained = true;
  });
  await Promise.resolve();
  expect(drained).toBe(false);
  expect(f.read().thread).toEqual(["persisted"]);
  f.queue.mutate("thread", (messages) => [...messages, "second"]);
  gate.resolve();
  await flush;
  expect(drained).toBe(true);
  expect(f.read().thread).toEqual(["paused", "second"]);
  f.queue[Symbol.dispose]();
});

test("follower buffers owner broadcasts during writes and reconciles only its current owner", async () => {
  const f = fixture();
  f.setRole({ role: "follower", ownerClientId: "owner-a" });
  const gate = deferred<void>();
  f.client.requestFollower = () => gate.promise;
  const write = f.queue.update("thread", () => ["local"]);
  await Promise.resolve();
  f.queue.receiveBroadcast("wrong-owner", "thread", ["wrong"]);
  f.queue.receiveBroadcast("owner-a", "thread", ["committed"]);
  expect(f.queue.readMessages("thread")).toEqual(["local"]);
  gate.resolve();
  await write;
  expect(f.queue.readMessages("thread")).toEqual(["committed"]);
  expect(f.read().thread).toEqual(["persisted"]);
  f.queue[Symbol.dispose]();
});
test("failed owner admission rolls back the optimistic overlay and does not poison the FIFO", async () => {
  const f = fixture();
  f.setRole({ role: "follower", ownerClientId: "elsewhere" });
  await expect(f.queue.acceptFromFollower("thread", ["rejected"])).rejects.toThrow(
    "no longer owns",
  );
  expect(f.queue.readMessages("thread")).toEqual(["persisted"]);
  f.setRole({ role: "owner" });
  await f.queue.acceptFromFollower("thread", ["accepted"]);
  expect(f.read().thread).toEqual(["accepted"]);
  f.queue[Symbol.dispose]();
});
test("execution wakes do not invalidate an in-flight storage refresh", async () => {
  const f = fixture();
  f.setRole({ role: "follower", ownerClientId: "owner" });
  f.queue.receiveBroadcast("owner", "thread", ["old"]);
  f.setRole({ role: "owner" });
  const loaded = deferred<QueuedMessageState<string>>();
  let loads = 0;
  f.client.storage.load = () => {
    loads++;
    return loaded.promise;
  };
  f.queue.storageChanged();
  expect(f.queue.isRefreshing("thread")).toBe(true);
  f.queue.requestExecutionWake();
  f.queue.requestExecutionWake();
  loaded.resolve({ thread: ["fresh"] });
  await loaded.promise;
  await Promise.resolve();
  expect(f.queue.readMessages("thread")).toEqual(["fresh"]);
  expect(f.queue.isRefreshing("thread")).toBe(false);
  expect(loads).toBe(1);
  f.queue[Symbol.dispose]();
});
