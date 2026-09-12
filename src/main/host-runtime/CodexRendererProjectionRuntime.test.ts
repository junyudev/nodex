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
import { CodexFreshThreadLaunchRuntime } from "../codex-application/CodexFreshThreadLaunchRuntime";
import {
  CodexRendererPresentationRegistry,
  make as makePresentationRegistry,
} from "../codex-application/CodexRendererPresentationRegistry";
import { CodexUserInputAutoResolution } from "../codex-application/CodexUserInputAutoResolution";
import type { CodexUserInputAutoResolutionChange } from "../../shared/codex-user-input-auto-resolution";
import type {
  WindowRuntimeLifecycleEvent,
  WindowRuntimePrimaryWindowSnapshot,
} from "../window-runtime/window-runtime-lifecycle";
import { live } from "./CodexRendererProjectionRuntime";
import { RendererClientRuntime, live as rendererClientLive } from "./RendererClientRuntime";
import { WindowRuntime } from "../window-runtime/WindowRuntime";

it.effect(
  "clears retired documents, reuses the client after reload, and releases all projection subscriptions",
  () =>
    Effect.gen(function* () {
      const reevaluated: string[] = [];
      const released: string[] = [];
      const autoResolutionChanges = yield* PubSub.unbounded<CodexUserInputAutoResolutionChange>();
      const applicationEvents = yield* PubSub.unbounded<CodexApplicationEvent>();
      const projectedChanges: Array<readonly [string, unknown]> = [];
      const windowEvents = yield* PubSub.unbounded<WindowRuntimeLifecycleEvent>();
      const scope = yield* Scope.make();
      const presentation = yield* makePresentationRegistry.pipe(
        Effect.provideService(Scope.Scope, scope),
      );
      const clientsContext = yield* Layer.build(rendererClientLive());
      const rendererClients = Context.get(clientsContext, RendererClientRuntime);
      const deliveredHostMessages: unknown[] = [];
      const webContents = {
        id: 1,
        isDestroyed: () => false,
        send: (channel: string, payload: unknown) => {
          if (channel === "codex:host-message") deliveredHostMessages.push(payload);
        },
      };
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
              Layer.succeed(CodexFreshThreadLaunchRuntime, {
                releaseRenderer: (clientId: string) => released.push(clientId),
              } as never),
              Layer.succeed(CodexRendererPresentationRegistry, presentation),
              Layer.succeed(RendererClientRuntime, rendererClients),
              Layer.succeed(CodexUserInputAutoResolution, {
                changes: Stream.fromPubSub(autoResolutionChanges),
                reevaluatePresentation: (conversationId: string) =>
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
                      isDestroyed: () => false,
                      send: (channel: string, change: unknown) => {
                        projectedChanges.push([channel, change]);
                      },
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
      const hostMessage = { type: "error" as const, hostId: "local", message: "Host disconnected" };
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
      assert.deepEqual(reevaluated, ["thread-1"]);
      assert.deepEqual(released, [clientId]);
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
        presentation.setPresented("thread-1", clientId, "new-surface", true).presentedInForeground,
      );
      yield* rendererClients.disposeClient(clientId);
      yield* Effect.yieldNow;
      assert.deepEqual(reevaluated, ["thread-1", "thread-1"]);
      assert.deepEqual(released, [clientId, clientId]);
      assert.isFalse(presentation.isPresentedInForeground("thread-1"));
      yield* PubSub.publish(autoResolutionChanges, {
        type: "timedOut",
        conversationId: "thread-1",
        requestId: "request-1",
      });
      yield* PubSub.publish(applicationEvents, {
        kind: "pendingWorktreesChanged",
        value: [],
      });
      yield* Effect.yieldNow;
      assert.deepEqual(projectedChanges, [
        [
          "codex:user-input:auto-resolution:changed",
          {
            type: "timedOut",
            conversationId: "thread-1",
            requestId: "request-1",
          },
        ],
        ["codex:pending-worktrees:changed", []],
      ]);
      yield* Scope.close(scope, Exit.void);
      yield* PubSub.publish(applicationEvents, {
        kind: "pendingWorktreesChanged",
        value: [],
      });
      yield* PubSub.publish(autoResolutionChanges, {
        type: "timedOut",
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
      assert.strictEqual(projectedChanges.length, 2);
      assert.deepEqual(reevaluated, ["thread-1", "thread-1"]);
      assert.deepEqual(released, [clientId, clientId]);
      assert.isFalse(presentation.hasForegroundClient());
    }),
);
