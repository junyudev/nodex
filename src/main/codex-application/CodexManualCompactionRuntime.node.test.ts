import { assert, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { CodexGateway, CodexThreadHostResolver } from "../codex-runtime/CodexGateway";
import { CodexMainConversationManagers } from "./CodexMainConversationManagers";
import { CodexMainConversationSettings } from "./CodexMainConversationSettings";
import { CodexMainConversationResume } from "./CodexMainConversationResume";
import { ConversationEntityMap, live as entitiesLayer } from "./internal/ConversationEntityMap";
import type { ConversationStreamRole } from "../../shared/codex-conversation-stream";
import { conversationFixture, turnFixture } from "./conversation-test-fixture";
import { codexRuntimeError } from "../codex-runtime/CodexRuntimeError";
import { residentConversationTurns } from "../../shared/codex-conversation-state/codex-turn-mutation";
import {
  CodexManualCompactionClosedError,
  CodexManualCompactionRuntime,
  live,
} from "./CodexManualCompactionRuntime";

const threadId = "thread-manual-compaction";
const turnId = "turn-manual-compaction";

const gateway = (request: CodexGateway["Service"]["requestForThread"]): CodexGateway["Service"] => {
  const unsupported = () => Effect.die(new Error("Unsupported test operation"));
  return CodexGateway.of({
    localHostId: "local",
    requestRawOnHost: () => Effect.die(new Error("Unsupported raw host request")),
    requestRawForThread: () => Effect.die(new Error("Unsupported raw request")),
    events: Stream.empty,
    requestLocal: unsupported as CodexGateway["Service"]["requestLocal"],
    requestOnHost: unsupported as CodexGateway["Service"]["requestOnHost"],
    requestForThread: request,
    notifyLocal: unsupported,
    connection: unsupported,
    connectionChanges: () => Stream.empty,
    awaitReady: unsupported,
    reconcileHost: unsupported,
    removeHost: unsupported,
    restartHost: unsupported,
  });
};

const ownerFixture = Effect.fn("CodexManualCompactionRuntimeTest.ownerFixture")(function* (
  providedScope?: Scope.Scope,
) {
  const scope = providedScope ?? (yield* Scope.Scope);
  const entities = Context.get(
    yield* Layer.buildWithScope(entitiesLayer, scope),
    ConversationEntityMap,
  );
  const install = () => {
    const entity = entities.entity(threadId);
    entity.installFollowerCanonicalState(
      conversationFixture(threadId, [turnFixture(turnId, "inProgress")]),
    );
    return entity;
  };
  const entity = install();
  const calls: string[] = [];
  const resets = new Set<() => void>();
  const controls = {
    generation: 1,
    role: { role: "owner" } as ConversationStreamRole | null,
    settings: Effect.void as Effect.Effect<void, Error>,
    native: Effect.succeed({}) as Effect.Effect<{}, Error>,
    peerError: null as Error | null,
  };
  const manager = {
    hostId: "local",
    get generation() {
      return controls.generation;
    },
    stream: {
      getRole: () => controls.role,
      removeConversation: () => {
        controls.role = null;
      },
    },
    assertCurrent: (generation = controls.generation) => {
      if (generation !== controls.generation) throw new Error("Native generation changed");
    },
    onConnectionReset: (callback: () => void) => {
      resets.add(callback);
      return {
        [Symbol.dispose]() {
          resets.delete(callback);
        },
      };
    },
    onDispose: () => ({ [Symbol.dispose]() {} }),
    coordination: {
      requestThreadFollower: () => {
        calls.push("peer");
        return controls.peerError
          ? Promise.reject(controls.peerError)
          : Promise.resolve({ resultType: "success", result: { ok: true } });
      },
    },
  };
  const native = (...args: unknown[]) =>
    Effect.suspend(() => {
      calls.push("native");
      assert.strictEqual(args[1], "thread/compact/start");
      const options = args[3] as { expectedGeneration?: number } | undefined;
      if (options) assert.strictEqual(options.expectedGeneration, controls.generation);
      return controls.native;
    });
  const context = yield* Layer.buildWithScope(
    live.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(ConversationEntityMap, entities),
          Layer.succeed(CodexGateway, {
            ...gateway(() => Effect.die("Compaction must use its admitted host generation")),
            requestOnHost: native,
          } as CodexGateway["Service"]),
          Layer.succeed(CodexThreadHostResolver, { resolve: () => Effect.succeed("local") }),
          Layer.succeed(CodexMainConversationManagers, {
            get: () => Effect.succeed(manager),
          } as unknown as CodexMainConversationManagers["Service"]),
          Layer.succeed(CodexMainConversationSettings, {
            awaitCurrent: () =>
              Effect.suspend(() => {
                calls.push("settings");
                return controls.settings;
              }),
          } as unknown as CodexMainConversationSettings["Service"]),
          Layer.succeed(CodexMainConversationResume, {
            resume: () =>
              Effect.sync(() => {
                calls.push("resume");
                controls.role = { role: "owner" };
                return { status: "ready", snapshot: null } as const;
              }),
          }),
        ),
      ),
    ),
    scope,
  );
  return {
    runtime: Context.get(context, CodexManualCompactionRuntime),
    controls,
    calls,
    entity,
    entities,
    hasPendingItem: () =>
      residentConversationTurns(entity.readCanonicalState()).some((turn) =>
        turn.items.some((item) => item.type === "contextCompaction" && !item.completed),
      ),
    replace: () => entities.retire(threadId).pipe(Effect.map(install)),
    reconnect: () => {
      controls.generation += 1;
      for (const reset of [...resets]) reset();
      controls.role = { role: "owner" };
    },
  };
});

it.effect("routes public compaction through the follower's owner after pending settings", () =>
  Effect.gen(function* () {
    const f = yield* ownerFixture();
    f.controls.role = { role: "follower", ownerClientId: "window" };
    yield* f.runtime.start(threadId);
    assert.deepEqual(f.calls, ["settings", "peer"]);
    assert.strictEqual(f.runtime.consumeSource(threadId), "automatic");
  }),
);

for (const change of ["connection", "entity"] as const) {
  it.effect(`rejects compaction when ${change} changes while settings finish`, () =>
    Effect.gen(function* () {
      const f = yield* ownerFixture();
      f.controls.settings =
        change === "entity" ? f.replace().pipe(Effect.asVoid) : Effect.sync(f.reconnect);
      const result = yield* f.runtime.start(threadId).pipe(Effect.result);
      assert.strictEqual(result._tag, "Failure");
      assert.deepEqual(f.calls, ["settings"]);
      assert.strictEqual(f.runtime.consumeSource(threadId), "automatic");
    }),
  );
}

it.effect("routes compaction to the owner selected after pending settings finish", () =>
  Effect.gen(function* () {
    const f = yield* ownerFixture();
    f.controls.settings = Effect.sync(() => {
      f.controls.role = { role: "follower", ownerClientId: "new-window" };
    });
    yield* f.runtime.start(threadId);
    assert.deepEqual(f.calls, ["settings", "peer"]);
    assert.strictEqual(f.runtime.consumeSource(threadId), "automatic");
  }),
);

for (const roleAfterSettings of ["owner", "follower"] as const) {
  it.effect(
    `uses the current ${roleAfterSettings} role when pending settings lose their owner`,
    () =>
      Effect.gen(function* () {
        const f = yield* ownerFixture();
        f.controls.role =
          roleAfterSettings === "owner"
            ? { role: "follower", ownerClientId: "old-window" }
            : { role: "owner" };
        f.controls.settings = Effect.sync(() => {
          f.controls.role =
            roleAfterSettings === "owner"
              ? { role: "owner" }
              : { role: "follower", ownerClientId: "new-window" };
        }).pipe(
          Effect.andThen(
            Effect.fail(
              codexRuntimeError({
                operation: "settings-test",
                reason: "request",
                retryable: false,
                cause: new Error("no-client-found"),
              }),
            ),
          ),
        );
        const result = yield* f.runtime.start(threadId).pipe(Effect.result);
        assert.strictEqual(result._tag, roleAfterSettings === "follower" ? "Success" : "Failure");
        assert.deepEqual(
          f.calls,
          roleAfterSettings === "follower" ? ["settings", "peer"] : ["settings"],
        );
        assert.strictEqual(f.runtime.consumeSource(threadId), "automatic");
      }),
  );
}

for (const failure of ["peer timeout", "no-client-found"] as const) {
  it.effect(`recovers a missing compaction owner only for ${failure}`, () =>
    Effect.gen(function* () {
      const f = yield* ownerFixture();
      f.controls.role = { role: "follower", ownerClientId: "window" };
      f.controls.peerError = new Error(failure);
      const result = yield* f.runtime.start(threadId).pipe(Effect.result);
      assert.strictEqual(result._tag, failure === "no-client-found" ? "Success" : "Failure");
      assert.deepEqual(
        f.calls,
        failure === "no-client-found"
          ? ["settings", "peer", "resume", "settings", "native"]
          : ["settings", "peer"],
      );
    }),
  );
}

it.effect("does not accept compaction success after its native connection retires", () =>
  Effect.gen(function* () {
    const f = yield* ownerFixture();
    f.controls.native = Effect.sync(() => {
      f.reconnect();
      return {};
    });
    const result = yield* f.runtime.start(threadId).pipe(Effect.result);
    assert.strictEqual(result._tag, "Failure");
    assert.strictEqual(f.runtime.consumeSource(threadId), "automatic");
  }),
);

it.effect("an old compaction failure cannot consume a new owner's pending request", () =>
  Effect.gen(function* () {
    const f = yield* ownerFixture();
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    f.controls.native = Deferred.succeed(entered, undefined).pipe(
      Effect.andThen(Deferred.await(release)),
      Effect.andThen(
        Effect.fail(
          codexRuntimeError({
            operation: "manual-compaction-test",
            reason: "request",
            retryable: false,
          }),
        ),
      ),
    );
    const old = yield* Effect.forkChild(f.runtime.start(threadId).pipe(Effect.result));
    yield* Deferred.await(entered);
    f.reconnect();
    f.runtime.clear(threadId);
    f.controls.native = Effect.succeed({});
    yield* f.runtime.start(threadId);
    yield* Deferred.succeed(release, undefined);
    assert.strictEqual((yield* Fiber.join(old))._tag, "Failure");
    assert.strictEqual(f.runtime.consumeSource(threadId), "manual");
    assert.strictEqual(f.runtime.consumeSource(threadId), "automatic");
  }),
);

it.effect("admits compaction before the remote request and correlates its source once", () =>
  Effect.gen(function* () {
    const f = yield* ownerFixture();
    f.controls.native = Effect.sync(() => {
      assert.isTrue(f.hasPendingItem());
      return {};
    });
    yield* f.runtime.start(threadId);
    assert.isTrue(f.hasPendingItem());
    assert.deepEqual(f.calls, ["settings", "native"]);
    assert.strictEqual(f.runtime.consumeSource(threadId), "manual");
    assert.strictEqual(f.runtime.consumeSource(threadId), "automatic");
  }),
);

it.effect("keeps the optimistic projection while another admitted request remains", () =>
  Effect.gen(function* () {
    const f = yield* ownerFixture();
    const firstStarted = yield* Deferred.make<void>();
    const secondStarted = yield* Deferred.make<void>();
    const releaseFirst = yield* Deferred.make<void>();
    const releaseSecond = yield* Deferred.make<void>();
    const failure = codexRuntimeError({
      operation: "manual-compaction-test",
      reason: "request",
      retryable: false,
    });
    let requestCount = 0;
    f.controls.native = Effect.suspend(() => {
      requestCount += 1;
      return requestCount === 1
        ? Deferred.succeed(firstStarted, undefined).pipe(
            Effect.andThen(Deferred.await(releaseFirst)),
            Effect.andThen(Effect.fail(failure)),
          )
        : Deferred.succeed(secondStarted, undefined).pipe(
            Effect.andThen(Deferred.await(releaseSecond)),
            Effect.as({}),
          );
    });

    const first = yield* Effect.forkChild(f.runtime.start(threadId));
    yield* Deferred.await(firstStarted);
    const second = yield* Effect.forkChild(f.runtime.start(threadId));
    yield* Deferred.await(secondStarted);
    yield* Deferred.succeed(releaseFirst, undefined);
    assert.strictEqual(yield* Fiber.join(first).pipe(Effect.flip), failure);
    assert.isTrue(f.hasPendingItem());

    yield* Deferred.succeed(releaseSecond, undefined);
    yield* Fiber.join(second);
    assert.strictEqual(f.runtime.consumeSource(threadId), "manual");
    assert.strictEqual(f.runtime.consumeSource(threadId), "automatic");
  }),
);

it.effect("compensates an interrupted request and rejects admission after Scope close", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    let interrupted = false;
    const scope = yield* Scope.make();
    const f = yield* ownerFixture(scope);
    yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
    f.controls.native = Deferred.succeed(started, undefined).pipe(
      Effect.andThen(Effect.never),
      Effect.onInterrupt(() => Effect.sync(() => void (interrupted = true))),
    );
    const fiber = yield* f.runtime.start(threadId).pipe(Effect.forkIn(scope));
    yield* Deferred.await(started);

    yield* Scope.close(scope, Exit.void);
    yield* Fiber.await(fiber);
    assert.isTrue(interrupted);
    assert.isFalse(f.hasPendingItem());
    assert.instanceOf(
      yield* f.runtime.start(threadId).pipe(Effect.flip),
      CodexManualCompactionClosedError,
    );
  }),
);
