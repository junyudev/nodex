import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { assert, it } from "@effect/vitest";
import type { DesktopNotificationActionPayload } from "../../shared/types";
import {
  CodexApplicationEventHub,
  type CodexApplicationEvent,
} from "../codex-application/CodexApplicationEventHub";
import { CodexRendererPresentationRegistry } from "../codex-application/CodexRendererPresentationRegistry";
import { WindowRuntime } from "../window-runtime/WindowRuntime";
import { DesktopNotificationRuntime } from "./DesktopNotificationRuntime";
import { RendererClientRuntime } from "./RendererClientRuntime";
import { UserPresence } from "../../host/UserPresence";
import {
  ApplicationSettings,
  make as makeApplicationSettings,
} from "../settings/ApplicationSettings";
import { CoreModules } from "../core-runtime/CoreModules";
import { live } from "./CodexThreadNotificationRuntime";
import { turnSpeaksThroughNodex } from "../../host/coordinator/notification-session";

it.effect("releases every Codex notification listener with the Main Scope", () =>
  Effect.gen(function* () {
    const listeners: {
      action: ((action: DesktopNotificationActionPayload) => void) | null;
    } = { action: null };
    let dispatchedActionCount = 0;
    let dismissedCount = 0;
    const applicationEvents = yield* PubSub.unbounded<CodexApplicationEvent>();
    const settingsRoot = mkdtempSync(path.join(tmpdir(), "nodex-notification-settings-"));
    const settings = yield* makeApplicationSettings({
      environment: {},
      hostHomeDirectory: settingsRoot,
      settingsPath: path.join(settingsRoot, "config.toml"),
    });
    const scope = yield* Scope.make();
    yield* Layer.buildWithScope(
      live.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(CoreModules, {
              workspace: {
                read: () =>
                  Effect.succeed({ value: { kind: "read_managed_session", managed: null } }),
              },
            } as never),
            Layer.succeed(CodexApplicationEventHub, {
              events: Stream.fromPubSub(applicationEvents),
              publish: (event: CodexApplicationEvent) => {
                PubSub.publishUnsafe(applicationEvents, event);
              },
            } as never),
            Layer.succeed(ApplicationSettings, settings),
            Layer.succeed(CodexRendererPresentationRegistry, {
              hasForegroundClient: () => false,
              isPresentedInForeground: () => false,
              resolvePresentedSurfaceClient: () => "renderer-1",
            } as never),
            Layer.succeed(UserPresence, { isSeen: () => false } as never),
            Layer.succeed(DesktopNotificationRuntime, {
              show: (
                _notification: never,
                _target: never,
                onAction: (action: DesktopNotificationActionPayload) => void,
              ) => {
                listeners.action = onAction;
              },
              dismiss: () => {
                dismissedCount += 1;
              },
            } as never),
            Layer.succeed(RendererClientRuntime, {
              getWebContentsIdForClientId: () => 1,
              sendToClient: () => {
                dispatchedActionCount += 1;
                return true;
              },
            } as never),
            Layer.succeed(WindowRuntime, {
              get: () => ({
                isDestroyed: () => false,
                isMinimized: () => false,
                show: () => undefined,
                focus: () => undefined,
                webContents: { id: 1, isDestroyed: () => false },
              }),
            } as never),
          ),
        ),
      ),
      scope,
    );
    yield* Effect.yieldNow;
    yield* PubSub.publish(applicationEvents, {
      kind: "threadNotification",
      value: {
        type: "user-input-requested",
        hostId: "local",
        conversation: {
          conversationId: "thread-1",
          title: "Question",
          threadSource: null,
          parentThreadId: null,
          source: null,
          sideConversationParentNavigationPath: null,
        },
        requestId: "request-1",
        turnId: "turn-1",
        questionCount: 1,
      },
    });
    yield* PubSub.publish(applicationEvents, {
      kind: "conversationSeen",
      value: "thread-1",
    });
    yield* Effect.yieldNow;
    assert.isNotNull(listeners.action);
    assert.strictEqual(dismissedCount, 1);

    yield* Scope.close(scope, Exit.void);
    yield* PubSub.publish(applicationEvents, {
      kind: "conversationSeen",
      value: "thread-1",
    });
    yield* Effect.yieldNow;
    assert.strictEqual(dismissedCount, 1);
    listeners.action?.({
      notificationId: "question-default-request-1",
      actionId: null,
      actionType: "open",
    });
    assert.strictEqual(dispatchedActionCount, 0);
    rmSync(settingsRoot, { recursive: true, force: true });
  }),
);

it.effect("a finished turn stays quiet only when Nodex speaks for it", () =>
  Effect.gen(function* () {
    const core = (managed: readonly string[]) =>
      ({
        workspace: {
          read: (request: { readonly kind: string; readonly session_id?: string }) =>
            Effect.succeed({
              value:
                request.kind === "read_coordinator"
                  ? { kind: "read_coordinator", session_id: "nodex" }
                  : {
                      kind: "read_managed_session",
                      managed: managed.includes(request.session_id ?? "") ? {} : null,
                    },
            }),
        },
      }) as never;
    const finished = (sessionId: string) =>
      ({
        type: "turn-completed",
        hostId: "local",
        conversation: {
          conversationId: `thread-${sessionId}`,
          runtimeSessionId: sessionId,
          title: sessionId,
          threadSource: null,
          parentThreadId: null,
          source: null,
          sideConversationParentNavigationPath: null,
        },
        turnId: `turn-${sessionId}`,
        status: "completed",
        lastAgentMessage: "Done.",
        heartbeatAssistantMessage: null,
        automationNotificationDecision: null,
        hasPendingContinuation: false,
      }) as never;
    // Nodex speaks only through its posts, and for the chats it manages.
    assert.isTrue(yield* turnSpeaksThroughNodex(core([]), finished("nodex")));
    assert.isTrue(yield* turnSpeaksThroughNodex(core(["work"]), finished("work")));
    assert.isFalse(yield* turnSpeaksThroughNodex(core([]), finished("chat")));
  }),
);
