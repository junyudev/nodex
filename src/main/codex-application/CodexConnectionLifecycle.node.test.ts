import { describe } from "vite-plus/test";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as PubSub from "effect/PubSub";
import type { CodexConnectionState } from "../../shared/types";
import { RemoteHostedPipRuntime } from "../host-runtime/RemoteHostedPipRuntime";
import { CodexApplicationEventHub, type CodexApplicationEvent } from "./CodexApplicationEventHub";
import { CodexConnection, live, projectCodexConnection } from "./CodexConnection";
import { make } from "./CodexConnectionLifecycle";
import { CodexPendingServerRequestRuntime } from "./CodexPendingServerRequestRuntime";
import { CodexProtocolNotificationEffects } from "./CodexProtocolNotificationEffects";
import { CodexSidebarSyncRuntime } from "./CodexSidebarSyncRuntime";
import { CodexSubagentDirectory } from "./CodexSubagentDirectory";
import { CodexUserInputAutoResolution } from "./CodexUserInputAutoResolution";
import { ConversationEntityMap } from "./internal/ConversationEntityMap";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import { make as makeCodexResumeIngress } from "./CodexResumeIngress";
import {
  type CodexApplicationProtocolOccurrence,
  CodexApplicationRequestInbox,
} from "../codex-runtime/CodexApplicationRequestInbox";
import * as Context from "effect/Context";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import {
  CodexExecutionHostAuthState,
  live as executionHostAuthStateLive,
} from "../codex-runtime/CodexExecutionHostAuthState";
import { CodexGateway } from "../codex-runtime/CodexGateway";
import { codexRuntimeError } from "../codex-runtime/CodexRuntimeError";
import type { CodexEndpointEvent } from "../codex-runtime/CodexEventHub";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { MainShutdown, layer as mainShutdownLive } from "../app/MainShutdown";
import { CodexApplicationProtocol } from "./CodexApplicationProtocol";
import {
  CodexProtocolIngress,
  live as liveCodexProtocolIngress,
  runBoundedCausalIngress,
} from "./CodexProtocolIngress";
import { ThreadCreationRuntime } from "./ThreadCreationRuntime";

describe("CodexConnectionLifecycle", () => {
  it.effect("settles a lost generation and marks loaded conversations before reconnect sync", () =>
    Effect.gen(function* () {
      const trace: string[] = [];
      const published: CodexApplicationEvent[] = [];
      const transitions = yield* PubSub.unbounded<ReadonlyMap<string, CodexConnectionState>>();
      const native = {
        sourceEpoch: "endpoint",
        transportKind: "websocket" as const,
        generation: 1,
      };
      const disconnected: Array<{ hostId: string; generation: number | undefined }> = [];
      const resolved: Array<{ hostId: string; generation: number }> = [];
      const runtime = yield* make.pipe(
        Effect.provideService(
          CodexConnection,
          CodexConnection.of({
            readAll: Effect.succeed(
              new Map([["local", { status: "connected" as const, retries: 0, native }]]),
            ),
            allChanges: Stream.fromPubSub(transitions),
            read: Effect.succeed({ status: "connected", retries: 0, lastConnectedAt: 1 }),
            readForHost: () => Effect.succeed({ status: "connected", retries: 0 }),
            changes: Stream.empty,
          }),
        ),
        Effect.provideService(
          CodexApplicationEventHub,
          CodexApplicationEventHub.of({
            events: Stream.empty,
            publish: (event) => published.push(event),
          }),
        ),
        Effect.provideService(
          CodexPendingServerRequestRuntime,
          CodexPendingServerRequestRuntime.of({
            disconnectIdentities: (hostId: string, generation?: number) => {
              disconnected.push({ hostId, generation });
              return [{ threadId: "thread-1", requestId: 7, generation: generation ?? 1 }];
            },
          } as unknown as CodexPendingServerRequestRuntime["Service"]),
        ),
        Effect.provideService(
          CodexProtocolNotificationEffects,
          CodexProtocolNotificationEffects.of({
            apply: ({ notification, hostId, generation }) =>
              Effect.sync(() => {
                resolved.push({ hostId, generation });
                assert.strictEqual(notification.method, "serverRequest/resolved");
                if (notification.method !== "serverRequest/resolved") return;
                trace.push(`${notification.method}:${notification.params.requestId}`);
              }).pipe(Effect.as("retain" as const)),
          }),
        ),
        Effect.provideService(
          CodexSidebarSyncRuntime,
          CodexSidebarSyncRuntime.of({
            sync: (input: Parameters<CodexSidebarSyncRuntime["Service"]["sync"]>[0]) =>
              Effect.sync(() => {
                assert.deepEqual(input, {
                  policy: "force",
                  reason: "app-server-reconnect",
                });
                trace.push("sidebar");
              }).pipe(Effect.as({} as never)),
          } as unknown as CodexSidebarSyncRuntime["Service"]),
        ),
        Effect.provideService(
          CodexSubagentDirectory,
          CodexSubagentDirectory.of({
            reconcileAfterReconnect: ({
              loadedThreadIds,
            }: {
              loadedThreadIds: readonly string[];
            }) => Effect.sync(() => trace.push(`subagents:${loadedThreadIds.join(",")}`)),
          } as unknown as CodexSubagentDirectory["Service"]),
        ),
        Effect.provideService(
          CodexUserInputAutoResolution,
          CodexUserInputAutoResolution.of({
            handleDisconnect: (hostId: string, generation?: number) =>
              Effect.sync(() => {
                assert.strictEqual(generation, hostId === "local" ? 1 : 7);
                trace.push("auto-resolution");
              }),
          } as unknown as CodexUserInputAutoResolution["Service"]),
        ),
        Effect.provideService(
          ConversationEntityMap,
          ConversationEntityMap.of({
            registerThreadMetadata: () => {},
            readThreadMetadata: () => null,
            runCommand: (<A, E, R>(
              _threadId: string,
              operation: Effect.Effect<A, E, R>,
            ): Effect.Effect<A, E, R> =>
              operation) as ConversationEntityMap["Service"]["runCommand"],
            forHost: (hostId: string) => {
              assert.strictEqual(hostId, "local");
              trace.push("read-local-threads");
              return [{ threadId: "thread-1" }];
            },
          } as unknown as ConversationEntityMap["Service"]),
        ),
        Effect.provideService(
          RemoteHostedPipRuntime,
          RemoteHostedPipRuntime.of({
            retireLocalCodexHost: () => Effect.sync(() => trace.push("pip-retire")),
          } as unknown as RemoteHostedPipRuntime["Service"]),
        ),
      );

      const connected = (retries: number): CodexConnectionState => ({
        status: "connected",
        retries,
        lastConnectedAt: 1,
      });
      yield* runtime.observe({ status: "error", retries: 1, message: "lost" });
      yield* runtime.observe(connected(1));
      yield* Effect.yieldNow;

      assert.deepEqual(trace, [
        "pip-retire",
        "auto-resolution",
        "serverRequest/resolved:7",
        "read-local-threads",
        "sidebar",
        "subagents:thread-1",
      ]);
      assert.strictEqual(
        published.filter((event) => event.kind === "codex" && event.value.type === "connection")
          .length,
        2,
      );
      assert.strictEqual(
        published.filter(
          (event) =>
            event.kind === "hostMessage" &&
            event.value.type === "sharedObjectUpdated" &&
            event.value.object.objectType === "connection",
        ).length,
        0,
      );
      assert.deepEqual(disconnected, [{ hostId: "local", generation: 1 }]);
      assert.deepEqual(resolved, [{ hostId: "local", generation: 1 }]);
      trace.length = 0;
      published.length = 0;
      // Exercise the subscribed production host stream, including a new connection generation
      // appearing in the starting event before the old generation's requests are retired.
      yield* PubSub.publish(
        transitions,
        new Map([
          [
            "remote",
            {
              status: "connected",
              retries: 0,
              native: { ...native, generation: 7 },
            },
          ],
        ]),
      );
      yield* Effect.yieldNow;
      yield* PubSub.publish(
        transitions,
        new Map([
          [
            "remote",
            {
              status: "starting",
              retries: 1,
              native: { ...native, generation: 8 },
            },
          ],
        ]),
      );
      for (let i = 0; i < 20 && resolved.length < 2; i++) yield* Effect.yieldNow;
      assert.deepEqual(disconnected.at(-1), { hostId: "remote", generation: 7 });
      assert.deepEqual(resolved.at(-1), { hostId: "remote", generation: 7 });
      assert.deepEqual(trace, ["auto-resolution", "serverRequest/resolved:7"]);
      assert.isEmpty(published);
    }),
  );
});

describe("CodexResumeIngress", () => {
  const make = makeCodexResumeIngress;
  const notification = (
    token: number,
    method: string,
    params: unknown,
  ): CodexApplicationProtocolOccurrence => ({
    kind: "notification",
    protocol: "generated",
    hostId: "local",
    generation: 7,
    occurrenceId: `event-${token}`,
    occurrenceToken: token,
    method,
    params,
  });
  it.effect(
    "releases native notifications and requests in order after removing the resume gate",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const ingress = yield* make;
          const replayed: number[] = [];
          const rejected: number[] = [];
          assert.isTrue(ingress.begin("thread"));
          assert.isFalse(ingress.begin("thread"));
          const events: CodexApplicationProtocolOccurrence[] = [
            notification(1, "turn/started", { threadId: "thread", turn: { id: "turn" } }),
            {
              kind: "request",
              protocol: "generated",
              hostId: "local",
              generation: 7,
              occurrenceId: "request",
              occurrenceToken: 2,
              requestId: 3,
              method: "item/tool/requestUserInput",
              params: { threadId: "thread", turnId: "turn" },
            },
            notification(3, "turn/completed", { threadId: "thread", turn: { id: "turn" } }),
          ];
          for (const occurrence of events)
            assert.isTrue(
              ingress.offer("thread", {
                occurrence,
                replay: (event) =>
                  Effect.sync(() => {
                    assert.isFalse(ingress.has("thread"));
                    replayed.push(event.occurrenceToken);
                    return false;
                  }),
                reject: (event) =>
                  Effect.sync(() => {
                    rejected.push(event.occurrenceToken);
                  }),
              }),
            );
          yield* ingress.release("thread", null);
          assert.deepEqual(replayed, [1, 2, 3]);
          assert.deepEqual(rejected, []);
        }),
      ),
  );
  it.effect("discard settles buffered requests without delivering native notifications", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const ingress = yield* make;
        ingress.begin("thread");
        const rejected: unknown[] = [];
        const event = notification(1, "turn/started", { threadId: "thread", turn: { id: "turn" } });
        ingress.offer("thread", {
          occurrence: event,
          replay: () => Effect.die("must not replay"),
          reject: (occurrence, reason) =>
            Effect.sync(() => {
              rejected.push([occurrence.generation, reason]);
            }),
        });
        yield* ingress.discard("thread", "retired");
        assert.deepEqual(rejected, [[7, "retired"]]);
        assert.isFalse(ingress.has("thread"));
      }),
    ),
  );

  it.effect(
    "interrupted replay rejects every remaining occurrence without touching a successor buffer",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const ingress = yield* make;
          const entered = yield* Deferred.make<void>();
          const rejected: number[] = [];
          const replayed: number[] = [];
          ingress.begin("thread", { hostId: "local", generation: 7 });
          for (const token of [1, 2, 3]) {
            const occurrence = notification(token, "turn/started", {
              threadId: "thread",
              turn: { id: `turn-${token}` },
            });
            ingress.offer("thread", {
              occurrence,
              replay: () =>
                Effect.sync(() => {
                  replayed.push(token);
                }).pipe(
                  Effect.andThen(
                    token === 2
                      ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never))
                      : Effect.void,
                  ),
                  Effect.as(false),
                ),
              reject: (event) =>
                Effect.sync(() => {
                  rejected.push(event.occurrenceToken);
                }),
            });
          }
          const running = yield* ingress.release("thread", null).pipe(Effect.forkChild);
          yield* Deferred.await(entered);
          yield* Effect.yieldNow;
          ingress.begin("thread", { hostId: "local", generation: 8 });
          yield* Fiber.interrupt(running);
          assert.deepEqual(replayed, [1, 2]);
          assert.deepEqual(rejected, [2, 3]);
          assert.isTrue(ingress.has("thread"));
          yield* ingress.release("thread", null);
          assert.deepEqual(rejected, [2, 3]);
        }),
      ),
  );
  it.effect(
    "keeps another host generation outside the gate and settles its own pending ingress on disposal",
    () =>
      Effect.gen(function* () {
        const rejected: number[] = [];
        yield* Effect.scoped(
          Effect.gen(function* () {
            const ingress = yield* make;
            ingress.begin("thread", { hostId: "local", generation: 7 });
            const delivery = (occurrence: CodexApplicationProtocolOccurrence) => ({
              occurrence,
              replay: () => Effect.die("must not replay"),
              reject: (event: CodexApplicationProtocolOccurrence) =>
                Effect.sync(() => {
                  rejected.push(event.occurrenceToken);
                }),
            });
            const event = notification(1, "turn/started", {
              threadId: "thread",
              turn: { id: "turn" },
            });
            assert.isFalse(
              ingress.offer("thread", delivery({ ...event, generation: 8, occurrenceToken: 2 })),
            );
            assert.isFalse(
              ingress.offer("thread", delivery({ ...event, hostId: "remote", occurrenceToken: 3 })),
            );
            assert.isTrue(ingress.offer("thread", delivery(event)));
          }),
        );
        assert.deepEqual(rejected, [1]);
      }),
  );
});

describe("CodexConnection", () => {
  it.effect("projects the authoritative endpoint state without losing retry history", () =>
    Effect.gen(function* () {
      const retrying = projectCodexConnection(
        { status: "connected", retries: 1, lastConnectedAt: 10 },
        {
          kind: "backing-off",
          hostId: "local",
          generation: 2,
          attempt: 3,
          error: codexRuntimeError({
            operation: "session.spawn",
            reason: "spawn",
            retryable: true,
          }),
        },
        20,
      );
      assert.deepEqual(retrying, {
        status: "missingBinary",
        retries: 3,
        message: "Codex session.spawn failed",
      });

      const unsupported = () => Effect.die(new Error("Unsupported test operation"));
      const requestOnHost = ((_hostId: string, method: string) =>
        method === "getAuthStatus"
          ? Effect.succeed({ authMethod: "chatgpt", authToken: null, requiresOpenaiAuth: true })
          : unsupported()) as CodexGateway["Service"]["requestOnHost"];
      const gateway = CodexGateway.of({
        promoteQueuedCatalogPage: Effect.succeed(false),
        localHostId: "local",
        requestRawOnHost: () => Effect.die(new Error("Unsupported raw host request")),
        requestRawForThread: () => Effect.die(new Error("Unsupported raw request")),
        events: Stream.empty,
        requestLocal: unsupported,
        requestOnHost,
        requestForThread: unsupported,
        notifyLocal: unsupported,
        connection: () => Effect.succeed({ kind: "ready", hostId: "local", generation: 1 }),
        connectionChanges: () => Stream.succeed({ kind: "ready", hostId: "local", generation: 1 }),
        awaitReady: () => Effect.void,
        reconcileHost: unsupported,
        removeHost: unsupported,
        restartHost: unsupported,
      });
      const scope = yield* Scope.make();
      const authContext = yield* Layer.buildWithScope(executionHostAuthStateLive, scope);
      const authState = Context.get(authContext, CodexExecutionHostAuthState);
      const context = yield* Layer.buildWithScope(
        live.pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.succeed(CodexGateway, gateway),
              Layer.succeed(CodexApplicationEventHub, { events: Stream.empty, publish: () => {} }),
              Layer.succeed(CodexExecutionHostAuthState, authState),
            ),
          ),
        ),
        scope,
      );
      const connection = Context.get(context, CodexConnection);
      const snapshot = yield* connection.read;
      assert.strictEqual(snapshot.status, "connected");
      assert.strictEqual(snapshot.retries, 0);
      assert.isNumber(snapshot.lastConnectedAt);

      yield* authState.markLoginRequired("local");
      const loginRequired = yield* connection.readForHost("local");
      assert.strictEqual(loginRequired.status, "error");
      assert.deepEqual(loginRequired.error, { code: "login-required" });

      yield* authState.clearLoginRequired("local");
      const recovered = yield* connection.readForHost("local");
      assert.strictEqual(recovered.status, "connected");
      assert.isUndefined(recovered.error);
      yield* Scope.close(scope, Exit.void);
    }),
  );

  it.effect(
    "publishes remote connection provenance independently of the local connection snapshot",
    () =>
      Effect.gen(function* () {
        const endpointEvents = yield* PubSub.unbounded<CodexEndpointEvent>();
        const published: CodexApplicationEvent[] = [];
        const remote = {
          kind: "ready" as const,
          hostId: "remote",
          generation: 7,
          source: { sourceEpoch: "remote-endpoint", transportKind: "websocket" as const },
        };
        const scope = yield* Scope.Scope;
        const authContext = yield* Layer.buildWithScope(executionHostAuthStateLive, scope);
        const authState = Context.get(authContext, CodexExecutionHostAuthState);
        const context = yield* Layer.buildWithScope(
          live.pipe(
            Layer.provide(
              Layer.mergeAll(
                Layer.succeed(CodexGateway, {
                  localHostId: "local",
                  events: Stream.fromPubSub(endpointEvents),
                  connectionChanges: () =>
                    Stream.succeed({ kind: "ready", hostId: "local", generation: 1 }),
                  connection: () => Effect.succeed(remote),
                  requestOnHost: ((_hostId: string, method: string) =>
                    method === "getAuthStatus"
                      ? Effect.succeed({
                          authMethod: "chatgpt",
                          authToken: null,
                          requiresOpenaiAuth: true,
                        })
                      : Effect.die(
                          new Error("Unsupported test operation"),
                        )) as CodexGateway["Service"]["requestOnHost"],
                } as unknown as CodexGateway["Service"]),
                Layer.succeed(CodexApplicationEventHub, {
                  events: Stream.empty,
                  publish: (event) => {
                    published.push(event);
                  },
                }),
                Layer.succeed(CodexExecutionHostAuthState, authState),
              ),
            ),
          ),
          scope,
        );
        const connection = Context.get(context, CodexConnection);
        yield* PubSub.publish(endpointEvents, { kind: "connection", value: remote });
        yield* Effect.yieldNow;
        const read = yield* connection.readForHost("remote");
        assert.deepEqual(read.native, {
          sourceEpoch: "remote-endpoint",
          transportKind: "websocket",
          generation: 7,
        });
        assert.strictEqual((yield* connection.read).native, undefined);
        assert.isTrue(
          published.some(
            (event) =>
              event.kind === "hostMessage" &&
              event.value.type === "sharedObjectUpdated" &&
              event.value.hostId === "remote" &&
              event.value.object.objectType === "connection" &&
              event.value.object.value.native?.generation === 7,
          ),
        );
      }),
  );
});

describe("CodexProtocolIngress", () => {
  const live = liveCodexProtocolIngress;
  it.effect("preserves FIFO within a causal key while another key progresses", () =>
    Effect.gen(function* () {
      const firstStarted = yield* Deferred.make<void>();
      const releaseFirst = yield* Deferred.make<void>();
      const otherCompleted = yield* Deferred.make<void>();
      const observed: string[] = [];
      const run = yield* runBoundedCausalIngress({
        source: Stream.make(
          { key: "thread-a", label: "a1" },
          { key: "thread-a", label: "a2" },
          { key: "thread-b", label: "b1" },
        ),
        key: ({ key }) => key,
        dispatch: ({ label }) => {
          if (label === "a1") {
            return Effect.sync(() => observed.push("a1:start")).pipe(
              Effect.andThen(Deferred.succeed(firstStarted, undefined)),
              Effect.andThen(Deferred.await(releaseFirst)),
              Effect.andThen(Effect.sync(() => observed.push("a1:end"))),
              Effect.asVoid,
            );
          }
          if (label === "b1") {
            return Effect.sync(() => observed.push("b1")).pipe(
              Effect.andThen(Deferred.succeed(otherCompleted, undefined)),
              Effect.asVoid,
            );
          }
          return Effect.sync(() => observed.push(label));
        },
        capacity: 3,
      }).pipe(Effect.forkChild);

      yield* Deferred.await(firstStarted);
      yield* Deferred.await(otherCompleted);
      assert.deepEqual(observed, ["a1:start", "b1"]);
      yield* Deferred.succeed(releaseFirst, undefined);
      yield* Fiber.join(run);
      assert.deepEqual(observed, ["a1:start", "b1", "a1:end", "a2"]);
    }),
  );

  it.effect("drains a saturated one-permit ingress through source completion", () =>
    Effect.gen(function* () {
      const observed: number[] = [];
      yield* runBoundedCausalIngress({
        source: Stream.fromIterable(Array.from({ length: 64 }, (_, index) => index)),
        key: (value) => `thread-${value % 2}`,
        dispatch: (value) =>
          Effect.sync(() => {
            observed.push(value);
          }),
        capacity: 1,
      });
      assert.deepEqual(
        observed,
        Array.from({ length: 64 }, (_, index) => index),
      );
    }),
  );

  it.effect("a dispatch failure interrupts sibling work while ingress is saturated", () =>
    Effect.gen(function* () {
      const blockedStarted = yield* Deferred.make<void>();
      const blockedInterrupted = yield* Deferred.make<void>();
      const result = yield* runBoundedCausalIngress({
        source: Stream.make("blocked", "failed", "pending"),
        key: (value) => value,
        dispatch: (value) =>
          value === "blocked"
            ? Deferred.succeed(blockedStarted, undefined).pipe(
                Effect.andThen(Effect.never),
                Effect.onInterrupt(() => Deferred.succeed(blockedInterrupted, undefined)),
              )
            : Deferred.await(blockedStarted).pipe(Effect.andThen(Effect.die("dispatch failed"))),
        capacity: 2,
      }).pipe(Effect.exit);
      assert.isTrue(Exit.isFailure(result));
      yield* Deferred.await(blockedInterrupted);
    }),
  );

  it.effect("turns an unexpected canonical ingress exit into runtime-fatal health", () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const shutdownContext = yield* Layer.buildWithScope(mainShutdownLive, scope);
      const shutdown = Context.get(shutdownContext, MainShutdown);
      const protocol = CodexApplicationProtocol.of({
        interpret: () => Effect.void,
        observe: () => Effect.void,
        beginResume: () => false,
        hasResume: () => false,
        releaseResume: () => Effect.void,
        discardResume: () => Effect.void,
        clearConversationBuffer: () => Effect.void,
        releaseThreadStart: () => Effect.void,
      });
      const inbox = CodexApplicationRequestInbox.of({
        occurrences: Stream.die("canonical ingress defect"),
      } as unknown as CodexApplicationRequestInbox["Service"]);
      const threadStarts = ThreadCreationRuntime.of({
        open: () => ({ close: () => Effect.void }),
        materialize: (_hostId, _generation, operation) => operation,
        defer: () => false,
        releases: Stream.never,
        termination: Effect.never,
        clear: () => undefined,
      });
      const context = yield* Layer.buildWithScope(
        live.pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.succeed(CodexApplicationProtocol, protocol),
              Layer.succeed(CodexApplicationRequestInbox, inbox),
              Layer.succeed(ThreadCreationRuntime, threadStarts),
              Layer.succeed(MainShutdown, shutdown),
            ),
          ),
        ),
        scope,
      );
      const ingress = Context.get(context, CodexProtocolIngress);

      const shutdownReason = yield* shutdown.awaitRequest;
      assert.strictEqual(shutdownReason._tag, "RuntimeFatal");
      if (shutdownReason._tag === "RuntimeFatal") {
        assert.strictEqual(shutdownReason.subsystem, "codex-protocol-ingress");
        assert.isDefined(shutdownReason.cause);
      }
      const health = yield* SubscriptionRef.get(ingress.health);
      assert.strictEqual(health._tag, "Failed");
      yield* Scope.close(scope, Exit.void);
    }),
  );
});
