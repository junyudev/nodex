import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import { vi } from "vite-plus/test";
import { make } from "./CodexNodeReplRuntime";
import { CodexEndpointMap } from "../codex-runtime/CodexEndpointMap";
import type { CodexAppServerSessionService } from "../codex-runtime/CodexAppServerSession";
import { codexRuntimeError, type CodexRuntimeError } from "../codex-runtime/CodexRuntimeError";
import * as NodeReplCleanup from "../platform/node/CodexNodeReplCleanup";
import {
  CodexMainConversationManagers,
  type MainConversationManager,
} from "./CodexMainConversationManagers";
import { ConversationEntityMap } from "./internal/ConversationEntityMap";

it.effect.each(["current", "other-peer", "reconnected", "replaced"] as const)(
  "owner cleanup revalidates the peer and captured conversation after discovery: %s",
  (scenario) =>
    Effect.gen(function* () {
      let generation = 1;
      const entity = { readCanonicalState: () => ({ hostId: "remote", sessionId: "session" }) };
      let current: typeof entity | undefined = entity;
      const manager = {
        get generation() {
          return generation;
        },
        assertCurrent: (expected: number) => {
          if (expected !== generation) throw new Error("Connection changed");
        },
        findOwner: () => {
          if (scenario === "reconnected") generation++;
          if (scenario === "replaced") current = undefined;
          return Promise.resolve(scenario === "other-peer" ? "different" : "peer");
        },
      } as unknown as MainConversationManager;
      const service = yield* make.pipe(
        Effect.provideService(CodexEndpointMap, {
          localHostId: "local",
          endpoint: () => Effect.die("Remote cleanup must not touch local processes"),
        } as unknown as CodexEndpointMap["Service"]),
        Effect.provideService(CodexMainConversationManagers, {
          get: () => Effect.succeed(manager),
        } as unknown as CodexMainConversationManagers["Service"]),
        Effect.provideService(ConversationEntityMap, {
          current: () => current,
        } as unknown as ConversationEntityMap["Service"]),
      );
      const result = yield* service
        .cleanupForOwner("remote", "thread", "turn", "peer")
        .pipe(Effect.result);
      assert.strictEqual(result._tag, scenario === "current" ? "Success" : "Failure");
    }),
);

const emptyCounts = { failedCount: 0, killedCount: 0, scannedCount: 0, staleCount: 0 };

const localFixture = Effect.gen(function* () {
  const resets = new Set<() => void>();
  const disposals = new Set<() => void>();
  const retirements = new Set<(id: string, generation: number) => void>();
  const terminated = yield* Deferred.make<never, CodexRuntimeError>();
  const original = {
    generation: 1,
    readCanonicalState: () => ({ hostId: "local", sessionId: "session" }),
  };
  const control = {
    generation: 1,
    entity: original as typeof original | null,
    afterEndpoint: () => {},
    afterSession: () => {},
    sessionGeneration: 1,
  };
  const subscribe = (listeners: Set<() => void>, listener: () => void): Disposable => {
    listeners.add(listener);
    return {
      [Symbol.dispose]: () => {
        listeners.delete(listener);
      },
    };
  };
  const manager = {
    get generation() {
      return control.generation;
    },
    assertCurrent: (expected = control.generation) => {
      if (expected !== control.generation) throw new Error("Connection changed");
    },
    findOwner: () => Promise.resolve("peer"),
    onConnectionReset: (listener: () => void) => subscribe(resets, listener),
    onDispose: (listener: () => void) => subscribe(disposals, listener),
  } as unknown as MainConversationManager;
  const service = yield* make.pipe(
    Effect.provideService(CodexEndpointMap, {
      localHostId: "local",
      endpoint: () =>
        Effect.sync(() => {
          control.afterEndpoint();
          return {
            session: Effect.sync(() => {
              control.afterSession();
              return {
                hostId: "local",
                generation: control.sessionGeneration,
                initialize: { codexHome: "/test/codex-home" },
                termination: Deferred.await(terminated),
              } as unknown as CodexAppServerSessionService;
            }),
          };
        }),
    } as unknown as CodexEndpointMap["Service"]),
    Effect.provideService(CodexMainConversationManagers, {
      get: () => Effect.succeed(manager),
    } as unknown as CodexMainConversationManagers["Service"]),
    Effect.provideService(ConversationEntityMap, {
      current: () => control.entity,
      subscribeRetired: (listener: (id: string, generation: number) => void) => {
        retirements.add(listener);
        return {
          [Symbol.dispose]: () => {
            retirements.delete(listener);
          },
        };
      },
    } as unknown as ConversationEntityMap["Service"]),
  );
  return { service, control, terminated, resets, disposals, retirements };
});

it.effect.each(["endpoint", "session", "session-generation", "entity"] as const)(
  "does not enter process cleanup after its admitted lifetime changes at %s",
  (boundary) =>
    Effect.gen(function* () {
      const fixture = yield* localFixture;
      const cleanup = vi
        .spyOn(NodeReplCleanup, "cleanupNodeReplExecutions")
        .mockResolvedValue(emptyCounts);
      try {
        if (boundary === "endpoint")
          fixture.control.afterEndpoint = () => {
            fixture.control.generation++;
          };
        if (boundary === "session")
          fixture.control.afterSession = () => {
            fixture.control.generation++;
          };
        if (boundary === "session-generation") fixture.control.sessionGeneration = 2;
        if (boundary === "entity")
          fixture.control.afterSession = () => {
            fixture.control.entity = null;
          };
        const result = yield* fixture.service
          .cleanupForOwner("local", "thread", "turn", "peer")
          .pipe(Effect.result);
        assert.strictEqual(result._tag, "Failure");
        assert.strictEqual(cleanup.mock.calls.length, 0);
      } finally {
        cleanup.mockRestore();
      }
    }),
);

it.effect.each(["reset", "dispose", "termination", "entity"] as const)(
  "cancels pending process cleanup when the admitted %s ends",
  (boundary) =>
    Effect.gen(function* () {
      const fixture = yield* localFixture;
      const started = yield* Deferred.make<void>();
      let resolvePending!: (counts: NodeReplCleanup.NodeReplCleanupCounts) => void;
      const pending = new Promise<NodeReplCleanup.NodeReplCleanupCounts>((resolve) => {
        resolvePending = resolve;
      });
      let signal: AbortSignal | undefined;
      const cleanup = vi
        .spyOn(NodeReplCleanup, "cleanupNodeReplExecutions")
        .mockImplementation((input) => {
          signal = input.signal;
          Deferred.doneUnsafe(started, Effect.void);
          return pending;
        });
      try {
        const fiber = yield* fixture.service
          .cleanupForOwner("local", "thread", "turn", "peer")
          .pipe(Effect.result, Effect.forkChild);
        yield* Deferred.await(started);
        if (boundary === "reset") {
          fixture.control.generation++;
          for (const listener of fixture.resets) listener();
        }
        if (boundary === "dispose") for (const listener of fixture.disposals) listener();
        if (boundary === "entity") {
          fixture.control.entity = null;
          for (const listener of fixture.retirements) listener("thread", 1);
        }
        if (boundary === "termination")
          yield* Deferred.fail(
            fixture.terminated,
            codexRuntimeError({
              operation: "test.session-ended",
              reason: "session-lost",
              hostId: "local",
              retryable: false,
            }),
          );
        yield* Effect.yieldNow;
        resolvePending(emptyCounts);
        const result = yield* Fiber.join(fiber);
        assert.strictEqual(result._tag, "Failure");
        assert.strictEqual(signal?.aborted, true);
        assert.strictEqual(
          fixture.resets.size + fixture.disposals.size + fixture.retirements.size,
          0,
        );
      } finally {
        resolvePending(emptyCounts);
        cleanup.mockRestore();
      }
    }),
);

it.effect("cleans the admitted local session and releases lifetime subscriptions", () =>
  Effect.gen(function* () {
    const fixture = yield* localFixture;
    const cleanup = vi
      .spyOn(NodeReplCleanup, "cleanupNodeReplExecutions")
      .mockResolvedValue(emptyCounts);
    try {
      yield* fixture.service.cleanupForOwner("local", "thread", "turn", "peer");
      assert.strictEqual(cleanup.mock.calls.length, 1);
      assert.strictEqual(cleanup.mock.calls[0]?.[0].codexHome, "/test/codex-home");
      assert.strictEqual(cleanup.mock.calls[0]?.[0].sessionId, "session");
      assert.strictEqual(cleanup.mock.calls[0]?.[0].turnId, "turn");
      assert.strictEqual(
        fixture.resets.size + fixture.disposals.size + fixture.retirements.size,
        0,
      );
    } finally {
      cleanup.mockRestore();
    }
  }),
);

it.effect("does not adopt a successor connection for an earlier interrupt", () =>
  Effect.gen(function* () {
    const fixture = yield* localFixture;
    fixture.control.generation = 2;
    const cleanup = vi
      .spyOn(NodeReplCleanup, "cleanupNodeReplExecutions")
      .mockResolvedValue(emptyCounts);
    try {
      yield* fixture.service.cleanup("local", "session", "turn", 1);
      assert.strictEqual(cleanup.mock.calls.length, 0);
    } finally {
      cleanup.mockRestore();
    }
  }),
);
