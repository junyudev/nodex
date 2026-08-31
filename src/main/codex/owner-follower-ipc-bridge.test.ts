import { EventEmitter } from "node:events";
import { assert, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import { live, RendererClientRuntime } from "../host-runtime/RendererClientRuntime";
import { runThreadFollowerActionThroughOwner } from "./owner-follower-ipc-bridge";

class FakeWebContents extends EventEmitter {
  readonly sent: Array<{ readonly channel: string; readonly args: readonly unknown[] }> = [];
  destroyed = false;

  constructor(readonly id: number) {
    super();
  }

  isDestroyed(): boolean {
    return this.destroyed;
  }

  send(channel: string, ...args: readonly unknown[]): void {
    if (this.destroyed) throw new Error("webContents destroyed");
    this.sent.push({ channel, args });
  }

  destroy(): void {
    this.destroyed = true;
    this.emit("destroyed");
  }
}

class FakeOwnerFollowerService {
  private readonly ownerByThread = new Map<string, string>();

  getOwnerClientId(threadId: string): string | null {
    return this.ownerByThread.get(threadId) ?? null;
  }

  setOwner(threadId: string, clientId: string): void {
    this.ownerByThread.set(threadId, clientId);
  }
}

const idFactory = (prefix: string): (() => string) => {
  let next = 0;
  return () => `${prefix}:${++next}`;
};

const makeRuntime = Effect.fn("CodexOwnerFollowerTest.makeRuntime")(function* () {
  const scope = yield* Scope.make();
  const context = yield* Layer.buildWithScope(
    live({
      clientIdFactory: idFactory("client"),
      requestIdFactory: idFactory("request"),
    }),
    scope,
  );
  return { runtime: Context.get(context, RendererClientRuntime), scope };
});

const readRendererRequest = (target: FakeWebContents, index: number) => {
  const sent = target.sent[index];
  if (!sent) throw new Error("Missing sent renderer request");
  return sent.args[0] as {
    readonly method: string;
    readonly params: unknown;
    readonly requestId: string;
  };
};

it.effect("routes a follower action through current-owner proof and one request authority", () =>
  Effect.gen(function* () {
    const { runtime, scope } = yield* makeRuntime();
    const service = new FakeOwnerFollowerService();
    const owner = new FakeWebContents(11);
    const follower = new FakeWebContents(12);
    const ownerRegistration = runtime.register(owner);
    const followerRegistration = runtime.register(follower);
    service.setOwner("thread-1", ownerRegistration.clientId);
    const result = yield* Effect.forkChild(
      runThreadFollowerActionThroughOwner(service, runtime, followerRegistration.clientId, {
        conversationId: "thread-1",
        action: { type: "interruptTurn", threadId: "thread-1" },
      }),
    );
    yield* Effect.yieldNow;
    const roleRequest = readRendererRequest(owner, 0);
    assert.strictEqual(roleRequest.method, "thread-role");
    assert.isTrue(
      yield* runtime.handleResponse(owner, {
        type: "success",
        requestId: roleRequest.requestId,
        result: "owner",
      }),
    );
    yield* Effect.yieldNow;
    const actionRequest = readRendererRequest(owner, 1);
    assert.strictEqual(actionRequest.method, "thread-owner-action");
    assert.isTrue(
      yield* runtime.handleResponse(owner, {
        type: "success",
        requestId: actionRequest.requestId,
        result: { ok: true },
      }),
    );
    assert.deepEqual(yield* Fiber.join(result), { ok: true });
    assert.strictEqual(runtime.getPendingRequestCount(), 0);
    yield* Scope.close(scope, Exit.void);
  }),
);

it.effect("normalizes an unavailable older-history page owner", () =>
  Effect.gen(function* () {
    const { runtime, scope } = yield* makeRuntime();
    const service = new FakeOwnerFollowerService();
    const owner = new FakeWebContents(21);
    const follower = new FakeWebContents(22);
    const ownerRegistration = runtime.register(owner);
    const followerRegistration = runtime.register(follower);
    service.setOwner("thread-1", ownerRegistration.clientId);
    owner.destroy();
    yield* Effect.yieldNow;
    const error = yield* runThreadFollowerActionThroughOwner(
      service,
      runtime,
      followerRegistration.clientId,
      {
        conversationId: "thread-1",
        action: {
          type: "loadHistoryPage",
          request: {
            threadId: "thread-1",
            expectedConversationGeneration: 1,
            expectedHistoryMutationRevision: 0,
            target: {
              kind: "turnBoundary",
              boundary: {
                generation: 1,
                islandId: "tail:1",
                edge: "older",
                boundaryId: "older:1",
                progressKey: "cursor:1",
              },
            },
          },
        },
      },
    ).pipe(Effect.asVoid, Effect.flip);
    assert.match(error.message, /no-client-found/);
    assert.match(error.message, /thread-1/);
    yield* Scope.close(scope, Exit.void);
  }),
);

it.effect("normalizes a missing owner before sending follower work", () =>
  Effect.gen(function* () {
    const { runtime, scope } = yield* makeRuntime();
    const service = new FakeOwnerFollowerService();
    const follower = new FakeWebContents(32);
    const followerRegistration = runtime.register(follower);
    const error = yield* runThreadFollowerActionThroughOwner(
      service,
      runtime,
      followerRegistration.clientId,
      {
        conversationId: "thread-missing-owner",
        action: { type: "startTurn", threadId: "thread-missing-owner", prompt: "Continue" },
      },
    ).pipe(Effect.asVoid, Effect.flip);
    assert.match(error.message, /no-client-found/);
    assert.match(error.message, /thread-missing-owner/);
    assert.strictEqual(follower.sent.length, 0);
    yield* Scope.close(scope, Exit.void);
  }),
);
