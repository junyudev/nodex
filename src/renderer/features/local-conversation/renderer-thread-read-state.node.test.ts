import { afterEach, expect, it, vi } from "vitest";
import type {
  ThreadReadStateEvent,
  ThreadReadStateRpcOpenResult,
} from "../../../shared/codex-thread-read-state";
const mocks = vi.hoisted(() => ({
  subscribe: vi.fn((_listener: unknown) => vi.fn()),
}));
vi.mock("./local-conversation-deps", () => ({ subscribeCodexEvents: mocks.subscribe }));
import { connectRendererThreadReadState } from "./renderer-thread-read-state";
afterEach(() => vi.clearAllMocks());

it("retires manager work before reopening an invalidated authenticated session", async () => {
  let notify!: (event: ThreadReadStateEvent) => void;
  const calls: string[] = [];
  const session = { unsubscribe: vi.fn(), set: vi.fn(), clearForLogout: vi.fn() };
  const open = vi.fn(async (listener: typeof notify): Promise<ThreadReadStateRpcOpenResult> => {
    notify = listener;
    if (calls.includes("retired")) {
      calls.push("reopen");
      return { status: "unavailable" };
    }
    return {
      status: "ready",
      identity: { kind: "chatgpt", accountId: "old", userId: "user" },
      executionHostKeysByHostId: { local: "local" },
      unreadThreadIdsByHostId: {},
      session,
    };
  });
  using _connection = connectRendererThreadReadState(
    () => ({
      retireNativeHostContext: () => {
        calls.push("retired");
      },
      receiveReadStateSnapshot: vi.fn(),
      receiveReadStateChange: vi.fn(),
    }),
    Promise.resolve({ open, getExecutionHostKeys: async () => ({ local: "local" }) }),
  );
  await vi.waitFor(() => expect(open).toHaveBeenCalledOnce());
  await Promise.resolve();
  notify({ type: "retired", reason: "identity" });
  expect(calls[0]).toBe("retired");
  await vi.waitFor(() => expect(calls).toEqual(["retired", "reopen"]));
});

it("applies notifications arriving during open after the initial snapshot", async () => {
  let resolve!: (result: ThreadReadStateRpcOpenResult) => void;
  let callback!: (event: ThreadReadStateEvent) => void;
  const pending = new Promise<ThreadReadStateRpcOpenResult>((done) => {
    resolve = done;
  });
  const session = {
    unsubscribe: vi.fn(),
    set: vi.fn(async () => ({ status: "ok" as const })),
    clearForLogout: vi.fn(),
  };
  const calls: unknown[] = [];
  const scope = connectRendererThreadReadState(
    () => ({
      retireNativeHostContext: vi.fn(),
      receiveReadStateSnapshot: (ids) => calls.push(ids),
      receiveReadStateChange: (id, unread) => calls.push([id, unread]),
    }),
    Promise.resolve({
      getExecutionHostKeys: async () => ({ local: "key" }),
      open: (listener: typeof callback) => {
        callback = listener;
        return pending;
      },
    }),
  );
  await vi.waitFor(() => expect(callback).toBeDefined());
  const write = scope.set({ hostId: "local", threadId: "new", hasUnreadTurn: false });
  expect(session.set).not.toHaveBeenCalled();
  callback({
    type: "changed",
    origin: "external",
    hostId: "local",
    threadId: "new",
    hasUnreadTurn: true,
  });
  expect(calls).toEqual([]);
  resolve({
    status: "ready",
    identity: { kind: "execution-storage", authMode: "none" },
    executionHostKeysByHostId: { local: "key" },
    unreadThreadIdsByHostId: { local: ["old"] },
    session,
  });
  await vi.waitFor(() => expect(calls).toEqual([["old"], ["new", true]]));
  expect(await write).toEqual({ status: "ok" });
  expect(session.set).toHaveBeenCalledWith({
    hostId: "local",
    threadId: "new",
    hasUnreadTurn: false,
  });
  scope[Symbol.dispose]();
  expect(session.unsubscribe).toHaveBeenCalledOnce();
});

it("a host-map refresh retires only managers whose execution identity actually changed", async () => {
  let notify!: (event: ThreadReadStateEvent) => void;
  let hostKeys = { local: "local", remote: "ssh-old" };
  const retired: string[] = [];
  const snapshots: string[] = [];
  const session = { unsubscribe: vi.fn(), set: vi.fn(), clearForLogout: vi.fn() };
  const open = vi.fn(async (listener: typeof notify): Promise<ThreadReadStateRpcOpenResult> => {
    notify = listener;
    return {
      status: "ready",
      identity: { kind: "execution-storage", authMode: "none" },
      executionHostKeysByHostId: hostKeys,
      unreadThreadIdsByHostId: {},
      session,
    };
  });
  using _connection = connectRendererThreadReadState(
    (host) => ({
      retireNativeHostContext: () => {
        retired.push(host);
      },
      receiveReadStateSnapshot: () => {
        snapshots.push(host);
      },
      receiveReadStateChange: () => {},
    }),
    Promise.resolve({ open, getExecutionHostKeys: async () => hostKeys }),
  );
  await vi.waitFor(() => expect(snapshots).toHaveLength(2));
  notify({ type: "retired", reason: "hosts" });
  await vi.waitFor(() => expect(open).toHaveBeenCalledTimes(2));
  expect(retired).toEqual([]);
  hostKeys = { ...hostKeys, remote: "ssh-new" };
  notify({ type: "retired", reason: "hosts" });
  await vi.waitFor(() => expect(retired).toEqual(["remote"]));
});

it("releases a session that finishes opening after window disposal", async () => {
  let resolve!: (result: ThreadReadStateRpcOpenResult) => void;
  const pending = new Promise<ThreadReadStateRpcOpenResult>((done) => {
    resolve = done;
  });
  const open = vi.fn(() => pending);
  const session = { unsubscribe: vi.fn(), set: vi.fn(), clearForLogout: vi.fn() };
  const snapshot = vi.fn();
  const scope = connectRendererThreadReadState(
    () => ({
      retireNativeHostContext: vi.fn(),
      receiveReadStateSnapshot: snapshot,
      receiveReadStateChange: vi.fn(),
    }),
    Promise.resolve({ open, getExecutionHostKeys: async () => ({ local: "key" }) }),
  );
  await vi.waitFor(() => expect(open).toHaveBeenCalledOnce());
  scope[Symbol.dispose]();
  resolve({
    status: "ready",
    identity: { kind: "execution-storage", authMode: "none" },
    executionHostKeysByHostId: { local: "key" },
    unreadThreadIdsByHostId: { local: [] },
    session,
  });
  await vi.waitFor(() => expect(session.unsubscribe).toHaveBeenCalledOnce());
  expect(snapshot).toHaveBeenCalledWith(null);
});

it("retains user and turn writes while identity is unavailable and replays their combined state", async () => {
  let ready = false;
  const set = vi.fn(async () => ({ status: "ok" as const }));
  const session = { set, unsubscribe: vi.fn(), clearForLogout: vi.fn() };
  const open = vi.fn(async () =>
    ready
      ? {
          status: "ready" as const,
          identity: { kind: "execution-storage" as const, authMode: "none" },
          executionHostKeysByHostId: { local: "key" },
          unreadThreadIdsByHostId: { local: [] },
          session,
        }
      : { status: "unavailable" as const },
  );
  const changes = vi.fn();
  const scope = connectRendererThreadReadState(
    () => ({
      retireNativeHostContext: vi.fn(),
      receiveReadStateSnapshot: vi.fn(),
      receiveReadStateChange: changes,
    }),
    Promise.resolve({ getExecutionHostKeys: async () => ({ local: "key" }), open }),
  );
  try {
    await scope.set({ hostId: "local", threadId: "thread", hasUnreadTurn: false }, "user");
    await scope.set({ hostId: "local", threadId: "thread", hasUnreadTurn: true }, "turn");
    expect(set).not.toHaveBeenCalled();
    ready = true;
    (mocks.subscribe.mock.calls.at(-1)![0] as (event: { type: string }) => void)({
      type: "account",
    });
    await vi.waitFor(() =>
      expect(set).toHaveBeenCalledWith({
        hostId: "local",
        threadId: "thread",
        hasUnreadTurn: true,
      }),
    );
    expect(changes).toHaveBeenCalledWith("thread", true);
  } finally {
    scope[Symbol.dispose]();
  }
});
