import type { Thread, Turn } from "@nodex/codex-app-server-protocol/v2";
import { assert, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import { produce } from "immer";
import type { ConversationStreamRole } from "../../shared/codex-conversation-stream";
import { replaceCanonicalHistoryDraft } from "../../shared/codex-conversation-state/codex-canonical-history-loader";
import { createCodexCanonicalHydratedConversationState } from "../../shared/codex-conversation-state/codex-conversation-state";
import { residentConversationTurns } from "../../shared/codex-conversation-state/codex-turn-mutation";
import { ScopedCallbackRuntime, layer as callbackLayer } from "../app/ScopedCallbackRuntime";
import {
  CodexAppServerCapabilities,
  createCodexAppServerCapabilitySnapshot,
} from "../codex-runtime/CodexAppServerCapabilities";
import { CodexGateway } from "../codex-runtime/CodexGateway";
import { CodexMainConversationManagers } from "./CodexMainConversationManagers";
import { make } from "./CodexMainConversationHistory";
import { ConversationEntityMap } from "./internal/ConversationEntityMap";
import { makeConversationEntityStateRegistry } from "./internal/ConversationEntityState";

const turn = (id: string): Turn => ({
  id,
  items: [],
  itemsView: "full",
  status: "completed",
  error: null,
  startedAt: 1,
  completedAt: 2,
  durationMs: 1,
});

const fixture = Effect.fn("historyTest.fixture")(function* () {
  const callbacks = Context.get(
    yield* Layer.buildWithScope(callbackLayer, yield* Scope.Scope),
    ScopedCallbackRuntime,
  );
  const registry = makeConversationEntityStateRegistry();
  const metadata = {
    id: "thread",
    historyMode: "legacy",
    turns: [turn("tail")],
    cwd: "/workspace",
    status: { type: "idle" },
    source: "appServer",
    createdAt: 1,
    updatedAt: 1,
    model: null,
    reasoningEffort: null,
    requests: [],
  } as unknown as Thread;
  const canonical = produce(
    createCodexCanonicalHydratedConversationState(metadata, {
      hostId: "local",
      model: "test",
      reasoningEffort: null,
      cwd: "/workspace",
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      sandboxPolicy: { type: "readOnly", networkAccess: false },
      activePermissionProfile: null,
      runtimeWorkspaceRoots: ["/workspace"],
    }),
    (draft) => {
      replaceCanonicalHistoryDraft(draft, draft.turns, false, {
        cursor: "older",
        oldestLoadedTurnId: "tail",
      });
      draft.turnsPagination = {
        olderCursor: "older",
        oldestLoadedTurnId: "tail",
        isLoadingOlder: false,
        hasLoadedOldest: false,
      };
    },
  );
  const install = () => {
    const entity = registry.acquire("thread");
    entity.installFollowerCanonicalState(canonical);
    registry.registerThreadMetadata(metadata);
    return entity;
  };
  const original = install();
  let role: ConversationStreamRole = { role: "owner" };
  let generation = 1;
  let requestCount = 0;
  let publications = 0;
  const resets = new Set<() => void>();
  const disposals = new Set<() => void>();
  const listen = (listeners: Set<() => void>, callback: () => void): Disposable => {
    listeners.add(callback);
    return {
      [Symbol.dispose]() {
        listeners.delete(callback);
      },
    };
  };
  const manager = {
    hostId: "local",
    get generation() {
      return generation;
    },
    assertCurrent(expected = generation) {
      if (expected !== generation) throw new Error("Native connection changed");
    },
    onDispose: (callback: () => void) => listen(disposals, callback),
    onConnectionReset: (callback: () => void) => listen(resets, callback),
    stream: {
      getRole: () => role,
      getRevision: () => publications,
      broadcastSnapshot: () => ++publications,
    },
  };
  const requested = yield* Deferred.make<void>();
  const released = yield* Deferred.make<void>();
  const capability = createCodexAppServerCapabilitySnapshot({
    hostId: "local",
    generation: 1,
    userAgent: "codex/0.0.0",
  });
  const service = yield* make.pipe(
    Effect.provideService(ConversationEntityMap, {
      current: registry.current,
      readThreadMetadata: registry.readThreadMetadata,
      subscribeRetired: registry.subscribeRetired,
    } as unknown as ConversationEntityMap["Service"]),
    Effect.provideService(CodexMainConversationManagers, {
      get: () => Effect.succeed(manager),
      current: () => manager,
    } as unknown as CodexMainConversationManagers["Service"]),
    Effect.provideService(CodexAppServerCapabilities, {
      forHost: () => Effect.succeed(capability),
      forThread: () => Effect.succeed(capability),
      isCurrent: () => Effect.succeed(generation === capability.generation),
    }),
    Effect.provideService(CodexGateway, {
      requestOnHost: (_hostId: string, method: string) =>
        Effect.gen(function* () {
          assert.strictEqual(method, "thread/turns/list");
          requestCount += 1;
          yield* Deferred.succeed(requested, undefined);
          yield* Deferred.await(released);
          return { data: [turn("oldest")], nextCursor: null, backwardsCursor: null };
        }),
    } as unknown as CodexGateway["Service"]),
    Effect.provideService(ScopedCallbackRuntime, callbacks),
  );
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      for (const dispose of [...disposals]) dispose();
      registry.releaseAll();
    }),
  );
  return {
    service,
    original,
    registry,
    install,
    requested,
    released,
    requestCount: () => requestCount,
    publications: () => publications,
    setRole(next: ConversationStreamRole) {
      role = next;
    },
    reset() {
      generation += 1;
      for (const reset of [...resets]) reset();
    },
  };
});

it.effect("coalesces complete-history reads and publishes canonical-only history", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    const first = yield* Effect.forkScoped(f.service.loadComplete("local", "thread"));
    yield* Deferred.await(f.requested);
    const second = yield* Effect.forkScoped(f.service.loadComplete("local", "thread"));
    yield* Deferred.succeed(f.released, undefined);
    yield* Fiber.join(first);
    yield* Fiber.join(second);
    assert.strictEqual(f.requestCount(), 1);
    assert.deepEqual(
      residentConversationTurns(f.original.readCanonicalState()).map((t) => t.turnId),
      ["oldest", "tail"],
    );
    assert.isNull(f.original.readSnapshot());
    assert.isAbove(f.publications(), 0);
  }),
);

it.effect("loads older Turns without turning unknown live grants into observed empty grants", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    const before = f.original.readCanonicalState()!;
    const current = before.currentPermissions!;
    f.original.installFollowerCanonicalState(
      produce(before, (draft) => {
        draft.currentPermissions = {
          approvalPolicy: current.approvalPolicy,
          approvalsReviewer: current.approvalsReviewer,
          sandboxPolicy: { type: "readOnly", networkAccess: false },
        };
      }),
    );
    const loading = yield* Effect.forkScoped(f.service.loadComplete("local", "thread"));
    yield* Deferred.await(f.requested);
    yield* Deferred.succeed(f.released, undefined);
    yield* Fiber.join(loading);
    const after = f.original.readCanonicalState()!;
    assert.strictEqual(f.requestCount(), 1);
    assert.deepEqual(
      residentConversationTurns(after).map((entry) => entry.turnId),
      ["oldest", "tail"],
    );
    assert.strictEqual(after.currentPermissions!.runtimeWorkspaceRoots, undefined);
    assert.strictEqual(after.currentPermissions!.activePermissionProfile, undefined);
    assert.deepEqual(residentConversationTurns(after)[0]!.params.sandboxPolicy, {
      type: "readOnly",
      networkAccess: false,
    });
  }),
);

it.effect.each(["entity-replaced", "owner-changed", "owner-restored", "native-reset"] as const)(
  "rejects complete-history acceptance after %s during page I/O",
  (change) =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const pending = yield* Effect.forkScoped(
        f.service.loadComplete("local", "thread").pipe(Effect.exit),
      );
      yield* Deferred.await(f.requested);
      if (change === "entity-replaced") {
        f.registry.releaseGeneration("thread", f.original.generation);
        f.install();
      } else if (change === "native-reset") {
        f.reset();
      } else {
        f.setRole({ role: "follower", ownerClientId: "window" });
        if (change === "owner-restored") f.setRole({ role: "owner" });
      }
      const current = f.registry.current("thread")!;
      const before = current.readCanonicalState();
      yield* Deferred.succeed(f.released, undefined);
      assert.isTrue(Exit.isFailure(yield* Fiber.join(pending)));
      assert.strictEqual(current.readCanonicalState(), before);
      assert.strictEqual(f.publications(), 0);
    }),
);
