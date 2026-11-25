import { describe } from "vite-plus/test";
import { EventEmitter } from "node:events";
import type {
  CodexUserInputAutoResolutionConversation,
  CodexUserInputAutoResolutionChange,
} from "../../shared/codex-user-input-auto-resolution";
import * as Effect from "effect/Effect";
import * as Context from "effect/Context";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { assert, it } from "@effect/vitest";
import {
  CodexApplicationEventHub,
  type CodexApplicationEvent,
} from "../codex-application/CodexApplicationEventHub";
import {
  CodexRendererPresentationRegistry,
  make as makePresentationRegistry,
} from "../codex-application/CodexRendererPresentationRegistry";
import { CodexUserInputAutoResolution } from "../codex-application/CodexUserInputAutoResolution";
import type {
  WindowRuntimeLifecycleEvent,
  WindowRuntimePrimaryWindowSnapshot,
} from "../window-runtime/window-runtime-lifecycle";
import { live } from "./CodexRendererProjectionRuntime";
import {
  RendererClientRuntime,
  live as rendererClientLive,
  live as liveRendererClientRuntime,
} from "./RendererClientRuntime";
import { WindowRuntime } from "../window-runtime/WindowRuntime";
import * as Fiber from "effect/Fiber";
import {
  CODEX_HOST_CHUNKED_MESSAGE_MARKER,
  CODEX_HOST_CHUNK_INLINE_THRESHOLD_BYTES,
  type CodexHostMessagePart,
} from "../../shared/codex-host-chunked-message";

describe("CodexRendererProjectionRuntime", () => {
  it.effect(
    "clears retired documents, reuses the client after reload, and releases all projection subscriptions",
    () =>
      Effect.gen(function* () {
        const reevaluated: CodexUserInputAutoResolutionConversation[] = [];
        const autoResolutionChanges = yield* PubSub.unbounded<CodexUserInputAutoResolutionChange>();
        const applicationEvents = yield* PubSub.unbounded<CodexApplicationEvent>();
        const projectedChanges: Array<readonly [string, unknown]> = [];
        const remoteChanges: unknown[] = [];
        const windowEvents = yield* PubSub.unbounded<WindowRuntimeLifecycleEvent>();
        const scope = yield* Scope.make();
        const presentation = yield* makePresentationRegistry.pipe(
          Effect.provideService(Scope.Scope, scope),
        );
        const clientsContext = yield* Layer.build(rendererClientLive());
        const rendererClients = Context.get(clientsContext, RendererClientRuntime);
        const deliveredHostMessages: unknown[] = [];
        const webContents = Object.assign(new EventEmitter(), {
          id: 1,
          isDestroyed: () => false,
          send: (channel: string, payload: unknown) => {
            if (channel === "codex:host-message") deliveredHostMessages.push(payload);
          },
        });
        const window: WindowRuntimePrimaryWindowSnapshot = {
          kind: "primary",
          webContentsId: 1,
          windowId: 1,
          focused: true,
          focusSequence: 1,
          activeSessionId: "session-a",
          layoutRevision: 0,
          rendererGeneration: "document-a",
          windowSessionId: "window-a",
        };
        yield* Layer.buildWithScope(
          live.pipe(
            Layer.provide(
              Layer.mergeAll(
                Layer.succeed(CodexApplicationEventHub, {
                  events: Stream.fromPubSub(applicationEvents),
                  publish: (event: CodexApplicationEvent) => {
                    PubSub.publishUnsafe(applicationEvents, event);
                  },
                } as never),
                Layer.succeed(CodexRendererPresentationRegistry, presentation),
                Layer.succeed(RendererClientRuntime, rendererClients),
                Layer.succeed(CodexUserInputAutoResolution, {
                  changes: Stream.fromPubSub(autoResolutionChanges),
                  reevaluatePresentation: (
                    conversationId: CodexUserInputAutoResolutionConversation,
                  ) =>
                    Effect.sync(() => {
                      reevaluated.push(conversationId);
                    }),
                } as never),
                Layer.succeed(WindowRuntime, {
                  events: Stream.fromPubSub(windowEvents),
                  all: () => [
                    {
                      isDestroyed: () => false,
                      webContents: {
                        getURL: () => "http://localhost:3000",
                        isDestroyed: () => false,
                        send: (channel: string, change: unknown) => {
                          projectedChanges.push([channel, change]);
                        },
                      },
                    },
                    {
                      isDestroyed: () => false,
                      webContents: {
                        isDestroyed: () => false,
                        getURL: () => "http://localhost:3000?spaceId=team",
                        send: (channel: string, change: unknown) =>
                          remoteChanges.push([channel, change]),
                      },
                    },
                  ],
                } as never),
              ),
            ),
          ),
          scope,
        );

        yield* Effect.yieldNow;
        const clientId = rendererClients.ensureClient(webContents).clientId;
        yield* Effect.yieldNow;
        const hostMessage = {
          type: "error" as const,
          hostId: "local",
          message: "Host disconnected",
        };
        yield* PubSub.publish(applicationEvents, { kind: "hostMessage", value: hostMessage });
        yield* Effect.yieldNow;
        assert.deepEqual(deliveredHostMessages, [hostMessage]);
        presentation.setClientForegrounded(clientId, true);
        presentation.setPresented("thread-1", clientId, "old-surface", true);
        yield* PubSub.publish(windowEvents, {
          kind: "renderer-changed",
          reason: "navigation-started",
          revision: 1,
          previousRendererGeneration: "document-a",
          window: { ...window, rendererGeneration: null },
        });
        yield* Effect.yieldNow;
        assert.deepEqual(reevaluated, [{ hostId: "local", conversationId: "thread-1" }]);
        assert.isFalse(presentation.isClientPresenting("thread-1", clientId));
        assert.isFalse(
          presentation.setPresented("thread-1", clientId, "stale-surface", true).accepted,
        );
        assert.strictEqual(rendererClients.ensureClient(webContents).clientId, clientId);
        yield* PubSub.publish(windowEvents, {
          kind: "renderer-changed",
          reason: "navigation-committed",
          revision: 2,
          previousRendererGeneration: null,
          window: { ...window, rendererGeneration: "document-b" },
        });
        yield* Effect.yieldNow;
        assert.isTrue(presentation.hasForegroundClient());
        assert.isFalse(presentation.isClientPresenting("thread-1", clientId));
        assert.isTrue(
          presentation.setPresented("thread-1", clientId, "new-surface", true)
            .presentedInForeground,
        );
        yield* rendererClients.disposeClient(clientId);
        yield* Effect.yieldNow;
        assert.deepEqual(reevaluated, [
          { hostId: "local", conversationId: "thread-1" },
          { hostId: "local", conversationId: "thread-1" },
        ]);
        assert.isFalse(presentation.isPresentedInForeground("thread-1"));
        yield* PubSub.publish(autoResolutionChanges, {
          type: "timedOut",
          hostId: "local",
          conversationId: "thread-1",
          requestId: "request-1",
        });
        yield* PubSub.publish(applicationEvents, {
          kind: "pendingWorktreesChanged",
          value: [],
        });
        yield* PubSub.publish(applicationEvents, {
          kind: "codex",
          value: {
            type: "automationChanged",
            event: { automationId: "same-automation", sessionId: null, reason: "upsert" },
          },
        });
        yield* PubSub.publish(applicationEvents, {
          kind: "codex",
          value: {
            type: "automationRunsUpdated",
            event: { automationId: "same-automation", runId: "same-run", reason: "settle" },
          },
        });
        yield* Effect.yieldNow;
        assert.deepEqual(remoteChanges, []);
        assert.deepEqual(projectedChanges, [
          [
            "codex:user-input:auto-resolution:changed",
            {
              type: "timedOut",
              hostId: "local",
              conversationId: "thread-1",
              requestId: "request-1",
            },
          ],
          ["codex:pending-worktrees:changed", []],
          [
            "automations:changed",
            { automationId: "same-automation", sessionId: null, reason: "upsert" },
          ],
          [
            "automations:runs:updated",
            { automationId: "same-automation", runId: "same-run", reason: "settle" },
          ],
        ]);
        yield* Scope.close(scope, Exit.void);
        yield* PubSub.publish(applicationEvents, {
          kind: "pendingWorktreesChanged",
          value: [],
        });
        yield* PubSub.publish(autoResolutionChanges, {
          type: "timedOut",
          hostId: "local",
          conversationId: "thread-1",
          requestId: "ignored",
        });
        const reconnectId = rendererClients.ensureClient(webContents).clientId;
        yield* PubSub.publish(windowEvents, {
          kind: "renderer-changed",
          reason: "navigation-committed",
          revision: 3,
          previousRendererGeneration: null,
          window: { ...window, rendererGeneration: "document-c" },
        });
        yield* rendererClients.disposeClient(reconnectId);
        yield* Effect.yieldNow;
        assert.strictEqual(projectedChanges.length, 4);
        assert.deepEqual(reevaluated, [
          { hostId: "local", conversationId: "thread-1" },
          { hostId: "local", conversationId: "thread-1" },
        ]);
        assert.isFalse(presentation.hasForegroundClient());
      }),
  );
});

describe("RendererClientRuntime", () => {
  const live = liveRendererClientRuntime;
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

  const idFactory = (prefix: string): (() => string) => {
    let next = 0;
    return () => `${prefix}:${++next}`;
  };

  const makeRuntime = Effect.fn("RendererClientRuntimeTest.makeRuntime")(function* () {
    const scope = yield* Scope.make();
    const context = yield* Layer.buildWithScope(
      live({
        clientIdFactory: idFactory("client"),
        logger: { debug: () => undefined, warn: () => undefined },
      }),
      scope,
    );
    return { runtime: Context.get(context, RendererClientRuntime), scope };
  });

  const waitUntil = (label: string, predicate: () => boolean): Effect.Effect<void> =>
    Effect.gen(function* () {
      // oxlint-disable-next-line nodex/no-polling-loop-in-tests -- Yield to the renderer subscription fibers before reading the delivered projection.
      for (let attempt = 0; attempt < 500; attempt += 1) {
        if (predicate()) return;
        yield* Effect.yieldNow;
      }
      return yield* Effect.die(new Error(`Condition did not settle: ${label}`));
    });

  const rendererChunkedPart = (
    target: FakeWebContents,
    index: number,
    expectedChannel = "codex:host-message",
  ): CodexHostMessagePart => {
    const delivery = target.sent[index];
    if (!delivery) throw new Error(`Renderer delivery ${index} was not sent`);
    assert.strictEqual(delivery.channel, expectedChannel);
    const part = delivery.args[0] as CodexHostMessagePart;
    assert.strictEqual(part.marker, CODEX_HOST_CHUNKED_MESSAGE_MARKER);
    return part;
  };

  it.effect("owns stable renderer registrations and targeted delivery", () =>
    Effect.gen(function* () {
      const { runtime, scope } = yield* makeRuntime();
      const first = new FakeWebContents(10);
      const second = new FakeWebContents(11);
      const firstRegistration = runtime.register(first);
      assert.strictEqual(runtime.ensureClient(first).clientId, firstRegistration.clientId);
      const secondRegistration = runtime.register(second);

      assert.deepEqual(
        runtime.sendToClients(
          [firstRegistration.clientId, secondRegistration.clientId, "client:missing"],
          "codex:test",
          { value: 1 },
        ),
        {
          sentClientIds: ["client:1", "client:2"],
          unavailableClientIds: ["client:missing"],
          failedClientIds: [],
        },
      );
      assert.strictEqual(runtime.getClientCount(), 2);
      assert.strictEqual(runtime.getClientIdForWebContentsId(10), "client:1");
      assert.strictEqual(runtime.getWebContentsIdForClientId("client:2"), 11);
      assert.strictEqual(
        runtime.broadcast("codex:broadcast", null, {
          sourceClientId: firstRegistration.clientId,
          includeSource: false,
        }),
        1,
      );
      assert.deepEqual(runtime.sendToClients([], "codex:none", null), {
        sentClientIds: [],
        unavailableClientIds: [],
        failedClientIds: [],
      });
      yield* firstRegistration.release;
      assert.strictEqual(runtime.getClientCount(), 1);
      yield* Scope.close(scope, Exit.void);
    }),
  );

  it.effect("chunks large routed messages, waits for exact ACKs, and preserves target FIFO", () =>
    Effect.gen(function* () {
      const { runtime, scope } = yield* makeRuntime();
      const target = new FakeWebContents(12);
      const targetId = runtime.register(target).clientId;
      const largeValue = "x".repeat(CODEX_HOST_CHUNK_INLINE_THRESHOLD_BYTES + 1);

      assert.isTrue(runtime.sendToClient(targetId, "codex:host-message", { largeValue }));
      assert.isTrue(runtime.sendToClient(targetId, "codex:event", { type: "queued-after-large" }));
      yield* waitUntil("transfer start", () => target.sent.length === 1);

      let index = 0;
      while (true) {
        const part = rendererChunkedPart(target, index);
        yield* runtime.handleDeliveryAcknowledgment(target, part.transferId, part.sequence + 1);
        assert.strictEqual(target.sent.length, index + 1);
        yield* runtime.handleDeliveryAcknowledgment(target, part.transferId, part.sequence);
        index += 1;
        if (part.kind === "end") break;
        yield* waitUntil(`transfer frame ${index}`, () => target.sent.length === index + 1);
      }

      yield* waitUntil("queued inline delivery", () => target.sent.length === index + 1);
      assert.strictEqual(target.sent[index]?.channel, "codex:event");
      assert.deepEqual(target.sent[index]?.args, [{ type: "queued-after-large" }]);
      yield* Scope.close(scope, Exit.void);
    }),
  );

  it.effect("releases active and queued delivery when its target is destroyed", () =>
    Effect.gen(function* () {
      const { runtime, scope } = yield* makeRuntime();
      const target = new FakeWebContents(13);
      const targetId = runtime.register(target).clientId;
      const largeValue = "x".repeat(CODEX_HOST_CHUNK_INLINE_THRESHOLD_BYTES + 1);

      assert.isTrue(runtime.sendToClient(targetId, "codex:host-message", { largeValue }));
      assert.isTrue(runtime.sendToClient(targetId, "codex:event", { type: "must-not-send" }));
      yield* waitUntil("active transfer start", () => target.sent.length === 1);
      target.destroy();
      yield* waitUntil("client disposal", () => runtime.getClientCount() === 0);
      for (let attempt = 0; attempt < 20; attempt += 1) yield* Effect.yieldNow;

      assert.strictEqual(target.sent.length, 1);
      assert.isFalse(runtime.sendToClient(targetId, "codex:event", null));
      yield* Scope.close(scope, Exit.void);
    }),
  );

  it.effect("keeps renderer ownership stable when an immediate send is rejected", () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const context = yield* Layer.buildWithScope(
        live({
          clientIdFactory: () => "client:failed-delivery",
          logger: { debug: () => undefined, warn: () => undefined },
          send: () => false,
        }),
        scope,
      );
      const runtime = Context.get(context, RendererClientRuntime);
      const target = new FakeWebContents(14);
      const targetId = runtime.register(target).clientId;

      assert.isFalse(runtime.sendToClient(targetId, "codex:host-message", { revision: 7 }));
      assert.strictEqual(runtime.getClientCount(), 1);
      yield* Scope.close(scope, Exit.void);
    }),
  );

  it.effect("projects connected and disposed lifecycle events in admission order", () =>
    Effect.gen(function* () {
      const { runtime, scope } = yield* makeRuntime();
      const lifecycle = yield* Effect.forkChild(
        runtime.events.pipe(Stream.take(2), Stream.runCollect),
      );
      yield* Effect.yieldNow;
      const registration = runtime.register(new FakeWebContents(15));
      yield* Effect.yieldNow;
      yield* registration.release;
      const events = [...(yield* Fiber.join(lifecycle))];
      assert.deepEqual(
        events.map((event) => event.kind),
        ["connected", "disposed"],
      );
      assert.strictEqual(events[0]?.clientId, registration.clientId);
      assert.strictEqual(events[1]?.clientId, registration.clientId);
      yield* Scope.close(scope, Exit.void);
    }),
  );
});
