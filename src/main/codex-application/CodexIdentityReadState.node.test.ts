import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import type {
  ThreadReadStateEvent,
  ThreadReadStateIdentity,
} from "../../shared/codex-thread-read-state";
import { makeIdentityReadState } from "./CodexIdentityReadState";

const setup = Effect.gen(function* () {
  let identity: ThreadReadStateIdentity = { kind: "chatgpt", accountId: "a", userId: "u" };
  let hosts = { local: "endpoint-a" };
  let pending: Effect.Effect<ThreadReadStateIdentity | null> | undefined;
  const outbound: unknown[] = [];
  const storage: Record<string, Record<string, string[]>> = {};
  const owner = yield* makeIdentityReadState({
    readIdentity: Effect.suspend(() => pending ?? Effect.succeed(identity)),
    hostKeys: Effect.sync(() => hosts),
    read: (key) => Effect.sync(() => storage[key] ?? {}),
    write: (key, host, thread, unread) =>
      Effect.sync(() => {
        const values = (storage[key] ??= {});
        values[host] = unread
          ? [...(values[host] ?? []), thread]
          : (values[host] ?? []).filter((id) => id !== thread);
      }),
    clear: (key) =>
      Effect.sync(() => {
        delete storage[key];
      }),
    select: () => Effect.void,
    project: () => Effect.void,
    accepted: (change) =>
      Effect.sync(() => {
        outbound.push(change);
      }),
  });
  const open = Effect.gen(function* () {
    const events: ThreadReadStateEvent[] = [];
    const result = yield* owner.open((event) =>
      Effect.sync(() => {
        events.push(event);
      }),
    );
    assert.strictEqual(result.status, "ready");
    if (result.status !== "ready") throw new Error("Unavailable");
    return { ...result.session, events };
  });
  return {
    owner,
    open,
    outbound,
    setReader: (reader: typeof pending) => {
      pending = reader;
    },
    setIdentity: (value: ThreadReadStateIdentity) => {
      identity = value;
    },
    setHosts: (value: typeof hosts) => {
      hosts = value;
    },
  };
});

it.effect(
  "unread delivery forwards every change without retiring the session before an identity change",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const runtime = yield* setup;
        const slow = yield* runtime.open;
        const captured = yield* runtime.owner.captureContext("local");
        if (!captured) throw new Error("Missing authenticated context");
        const threadIds = Array.from({ length: 1025 }, (_, index) => `thread-${index}`);
        for (const threadId of threadIds) {
          yield* runtime.owner.acceptBroadcast({
            hostId: "local",
            threadId,
            hasUnreadTurn: true,
            context: { identity: slow.identity, executionHostKey: "endpoint-a" },
          });
          assert.strictEqual(slow.events.at(-1)?.type, "changed");
        }
        assert.deepEqual(
          yield* slow.set({ hostId: "local", threadId: "late", hasUnreadTurn: true }),
          { status: "ok" },
        );
        assert.isTrue(yield* captured.isCurrent);
        runtime.setIdentity({ kind: "chatgpt", accountId: "other", userId: "u" });
        yield* runtime.owner.refresh;
        assert.deepEqual(slow.events, [
          ...threadIds.map((threadId) => ({
            type: "changed",
            origin: "external",
            hostId: "local",
            threadId,
            hasUnreadTurn: true,
          })),
          {
            type: "changed",
            origin: "self",
            hostId: "local",
            threadId: "late",
            hasUnreadTurn: true,
          },
          { type: "retired", reason: "identity" },
        ]);
        assert.isFalse(yield* captured.isCurrent);
        assert.deepEqual(
          yield* slow.set({ hostId: "local", threadId: "stale", hasUnreadTurn: true }),
          {
            status: "retired",
          },
        );
        assert.deepEqual((yield* runtime.open).unreadThreadIdsByHostId.local, []);
        runtime.setIdentity(slow.identity);
        yield* runtime.owner.refresh;
        const reopened = yield* runtime.open;
        assert.deepEqual(reopened.unreadThreadIdsByHostId.local, [...threadIds, "late"]);
        yield* slow.unsubscribe;
        assert.deepEqual(
          yield* reopened.set({ hostId: "local", threadId: "new", hasUnreadTurn: true }),
          { status: "ok" },
        );
      }),
    ),
);

it.effect("isolates accounts and retires sessions when identity changes", () =>
  Effect.gen(function* () {
    const runtime = yield* setup;
    const first = yield* runtime.open;
    yield* first.set({ hostId: "local", threadId: "thread", hasUnreadTurn: true });
    runtime.setIdentity({ kind: "chatgpt", accountId: "b", userId: "u" });
    yield* runtime.owner.refresh;
    assert.deepEqual(yield* first.set({ hostId: "local", threadId: "late", hasUnreadTurn: true }), {
      status: "retired",
    });
    const second = yield* runtime.open;
    assert.deepEqual(second.unreadThreadIdsByHostId.local, []);
    runtime.setIdentity({ kind: "chatgpt", accountId: "a", userId: "u" });
    yield* runtime.owner.refresh;
    assert.deepEqual((yield* runtime.open).unreadThreadIdsByHostId.local, ["thread"]);
  }).pipe(Effect.scoped),
);

it.effect("rejects a changed execution endpoint and does not reuse its unread list", () =>
  Effect.gen(function* () {
    const runtime = yield* setup;
    const first = yield* runtime.open;
    yield* first.set({ hostId: "local", threadId: "thread", hasUnreadTurn: true });
    runtime.setHosts({ local: "endpoint-b" });
    assert.deepEqual(yield* first.set({ hostId: "local", threadId: "late", hasUnreadTurn: true }), {
      status: "retired",
    });
    assert.deepEqual((yield* runtime.open).unreadThreadIdsByHostId.local, []);
  }).pipe(Effect.scoped),
);

it.effect("delivers self and external changes and rejects updates after unsubscribe", () =>
  Effect.gen(function* () {
    const runtime = yield* setup;
    const first = yield* runtime.open;
    const second = yield* runtime.open;
    yield* first.set({ hostId: "local", threadId: "thread", hasUnreadTurn: true });
    assert.deepEqual(first.events, [
      { type: "changed", origin: "self", hostId: "local", threadId: "thread", hasUnreadTurn: true },
    ]);
    assert.deepEqual(second.events, [
      {
        type: "changed",
        origin: "external",
        hostId: "local",
        threadId: "thread",
        hasUnreadTurn: true,
      },
    ]);
    yield* first.unsubscribe;
    assert.deepEqual(yield* first.set({ hostId: "local", threadId: "late", hasUnreadTurn: true }), {
      status: "retired",
    });
  }).pipe(Effect.scoped),
);

it.effect("waits for identity refresh before admitting an old session write", () =>
  Effect.gen(function* () {
    const runtime = yield* setup;
    const first = yield* runtime.open;
    const identity = yield* Deferred.make<ThreadReadStateIdentity>();
    runtime.setReader(Deferred.await(identity));
    const refresh = yield* runtime.owner.refresh.pipe(Effect.forkChild({ startImmediately: true }));
    const write = yield* first
      .set({ hostId: "local", threadId: "late", hasUnreadTurn: true })
      .pipe(Effect.forkChild({ startImmediately: true }));
    assert.deepEqual(runtime.outbound, []);
    yield* Deferred.succeed(identity, { kind: "chatgpt", accountId: "b", userId: "u" });
    yield* Fiber.join(refresh);
    assert.deepEqual(yield* Fiber.join(write), { status: "retired" });
    assert.deepEqual(runtime.outbound, []);
  }).pipe(Effect.scoped),
);

it.effect("accepts matching broadcasts without echo and fences captured context", () =>
  Effect.gen(function* () {
    const runtime = yield* setup;
    const first = yield* runtime.open;
    const captured = yield* runtime.owner.captureContext("local");
    assert.isNotNull(captured);
    if (!captured) return;
    const change = {
      hostId: "local",
      threadId: "remote",
      hasUnreadTurn: true,
      context: captured.context,
    };
    assert.deepEqual(yield* runtime.owner.acceptBroadcast(change), { status: "ok" });
    assert.deepEqual((yield* runtime.open).unreadThreadIdsByHostId.local, ["remote"]);
    assert.deepEqual(runtime.outbound, []);
    runtime.setIdentity({ kind: "chatgpt", accountId: "other", userId: "u" });
    yield* runtime.owner.refresh;
    assert.isFalse(yield* captured.isCurrent);
    assert.deepEqual(yield* runtime.owner.acceptBroadcast(change), { status: "retired" });
    yield* first.unsubscribe;
  }).pipe(Effect.scoped),
);

it.effect("preserves sessions after a same-identity refresh and waits for its result", () =>
  Effect.gen(function* () {
    const runtime = yield* setup;
    const first = yield* runtime.open;
    const identity = yield* Deferred.make<ThreadReadStateIdentity>();
    runtime.setReader(Deferred.await(identity));
    const refresh = yield* runtime.owner.refresh.pipe(Effect.forkChild({ startImmediately: true }));
    const write = yield* first
      .set({ hostId: "local", threadId: "same", hasUnreadTurn: true })
      .pipe(Effect.forkChild({ startImmediately: true }));
    assert.deepEqual(runtime.outbound, []);
    yield* Deferred.succeed(identity, { kind: "chatgpt", accountId: "a", userId: "u" });
    yield* Fiber.join(refresh);
    assert.deepEqual(yield* Fiber.join(write), { status: "ok" });
    assert.strictEqual(runtime.outbound.length, 1);
  }).pipe(Effect.scoped),
);

it.effect("rejects both in-flight and queued broadcasts captured before retirement", () =>
  Effect.gen(function* () {
    const runtime = yield* setup;
    yield* runtime.open;
    const captured = yield* runtime.owner.captureContext("local");
    if (!captured) throw new Error("Missing context");
    const identity = yield* Deferred.make<ThreadReadStateIdentity>();
    runtime.setReader(Deferred.await(identity));
    const change = {
      hostId: "local",
      threadId: "one",
      hasUnreadTurn: true,
      context: captured.context,
    };
    const first = yield* runtime.owner
      .acceptBroadcast(change)
      .pipe(Effect.forkChild({ startImmediately: true }));
    const second = yield* runtime.owner
      .acceptBroadcast({ ...change, threadId: "two" })
      .pipe(Effect.forkChild({ startImmediately: true }));
    yield* runtime.owner.retire("hosts");
    yield* Deferred.succeed(identity, captured.context.identity);
    assert.deepEqual(yield* Fiber.join(first), { status: "retired" });
    assert.deepEqual(yield* Fiber.join(second), { status: "retired" });
    assert.deepEqual((yield* runtime.open).unreadThreadIdsByHostId.local, []);
  }).pipe(Effect.scoped),
);
