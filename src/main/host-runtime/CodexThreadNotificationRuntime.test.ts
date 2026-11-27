import type * as Context from "effect/Context";
import { CoreAuthority } from "../core-runtime/CoreAuthority";
import * as Deferred from "effect/Deferred";
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
import type {
  DesktopNotificationActionInvocation,
  DesktopNotificationActionPayload,
  DesktopNotificationPayload,
} from "../../shared/types";
import {
  CodexApplicationEventHub,
  type CodexApplicationEvent,
} from "../codex-application/CodexApplicationEventHub";
import { CodexRendererPresentationRegistry } from "../codex-application/CodexRendererPresentationRegistry";
import { MiniRuntime } from "../mini/MiniRuntime";
import { live as workbenchDelivery } from "./WorkbenchNotificationDelivery";
import { ApplicationWindowRuntime } from "../window-runtime/ApplicationWindowRuntime";
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
import { chatNotificationRole } from "../../host/work-observation/notification-session";

const stubService = <I, S>(key: Context.Key<I, S>, methods: Partial<NoInfer<S>>) =>
  Layer.succeed(key, methods as S);

it.effect(
  "shows uncovered chat attention in the background and opens it after Workbench is ready",
  () =>
    Effect.gen(function* () {
      const shown: {
        notification: DesktopNotificationPayload;
        origin: unknown;
        click: (action: DesktopNotificationActionPayload) => void;
      }[] = [];
      const dispatched = yield* Deferred.make<DesktopNotificationActionInvocation>();
      const handled = yield* Deferred.make<void>();
      const applicationEvents = yield* PubSub.unbounded<CodexApplicationEvent>();
      const rendererReady = yield* PubSub.unbounded<number>();
      let initialized = false;
      let windowOpened = false;
      const settingsRoot = mkdtempSync(path.join(tmpdir(), "nodex-notification-settings-"));
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => rmSync(settingsRoot, { recursive: true, force: true })),
      );
      const settings = yield* makeApplicationSettings({
        environment: {},
        hostHomeDirectory: settingsRoot,
        settingsPath: path.join(settingsRoot, "config.toml"),
      });
      const workbench = {
        isDestroyed: () => false,
        webContents: { id: 1 },
      };
      const scope = yield* Scope.make();
      yield* Layer.buildWithScope(
        live.pipe(
          Layer.provide(workbenchDelivery),
          Layer.provide(
            Layer.mergeAll(
              Layer.succeed(CoreAuthority, {
                identity: { libraryId: "personal" },
              } as CoreAuthority["Service"]),
              Layer.succeed(CoreModules, {
                workspace: {
                  read: (request: { kind: string }) =>
                    Effect.succeed({
                      value:
                        request.kind === "decision_run"
                          ? { kind: "decision_run", decision_run: null }
                          : { kind: "managed_chat", managed: null },
                    }),
                },
              } as never),
              Layer.succeed(CodexApplicationEventHub, {
                events: Stream.fromPubSub(applicationEvents),
                publish: (event: CodexApplicationEvent) => {
                  PubSub.publishUnsafe(applicationEvents, event);
                },
              } as never),
              Layer.succeed(ApplicationSettings, settings),
              stubService(MiniRuntime, {
                restingCoverage: () => ({ chats: ["covered-session"], turns: [], notice: false }),
              }),
              stubService(CodexRendererPresentationRegistry, {
                hasForegroundClient: () => false,
                resolvePresentedSurfaceClient: () => null,
              }),
              stubService(UserPresence, { isSeen: () => false }),
              stubService(DesktopNotificationRuntime, {
                show: (notification, origin, click) => {
                  shown.push({ notification, origin, click });
                },
                dismiss: () => {
                  Deferred.doneUnsafe(handled, Effect.void);
                },
              }),
              stubService(ApplicationWindowRuntime, {
                focusPersonal: () => {
                  windowOpened = true;
                  return workbench as never;
                },
                rendererLoaded: Stream.fromPubSub(rendererReady),
              }),
              stubService(RendererClientRuntime, {
                getClientIdForWebContentsId: () => "renderer-1",
                sendToClient: (_clientId, _channel, invocation) => {
                  Deferred.doneUnsafe(
                    dispatched,
                    Effect.succeed(invocation as DesktopNotificationActionInvocation),
                  );
                  return true;
                },
              }),
              stubService(WindowRuntime, {
                events: Stream.never,
                getLastFocused: () => null,
                isRendererInitialized: () => initialized,
              }),
            ),
          ),
        ),
        scope,
      );

      const approval = (sessionId: string) =>
        PubSub.publish(applicationEvents, {
          kind: "threadNotification",
          value: {
            type: "approval-requested",
            hostId: "local",
            conversation: {
              conversationId: `thread-for-${sessionId}`,
              runtimeSessionId: sessionId,
              title: "Approval",
              threadSource: null,
              parentThreadId: null,
              source: null,
              sideConversationParentNavigationPath: null,
            },
            requestId: sessionId,
            turnId: "turn-1",
            prompt: null,
          },
        });
      yield* approval("covered-session");
      yield* approval("uncovered-session");
      // Resolve after both approvals have passed through the stream.
      yield* PubSub.publish(applicationEvents, { kind: "conversationSeen", value: "other-thread" });
      yield* Deferred.await(handled);
      assert.lengthOf(shown, 1);
      const [item] = shown;
      assert.isNull(item!.origin);
      assert.isFalse(windowOpened);
      const click = {
        notificationId: item!.notification.id,
        actionId: null,
        actionType: "open",
      } as const;
      item!.click(click);
      assert.isTrue(windowOpened);
      assert.isFalse(yield* Deferred.isDone(dispatched));
      initialized = true;
      yield* PubSub.publish(rendererReady, workbench.webContents.id);
      const invocation = yield* Deferred.await(dispatched);
      assert.include(invocation, {
        spaceId: "personal",
        conversationId: "thread-for-uncovered-session",
        navigationPath: "session:uncovered-session/thread:thread-for-uncovered-session",
        requestId: "uncovered-session",
      });
      yield* Scope.close(scope, Exit.void);
    }),
);

it.effect(
  "classifies decision runs separately from managed chats and ordinary chat attention",
  () =>
    Effect.gen(function* () {
      const core = (managed: readonly string[]) =>
        ({
          workspace: {
            read: (request: { readonly kind: string; readonly session_id?: string }) =>
              Effect.succeed({
                value:
                  request.kind === "decision_run"
                    ? {
                        kind: "decision_run",
                        decision_run: request.session_id === "decision" ? {} : null,
                      }
                    : {
                        kind: "managed_chat",
                        managed: managed.includes(request.session_id ?? "") ? {} : null,
                      },
              }),
          },
        }) as never;
      assert.equal(yield* chatNotificationRole(core([]), "decision"), "decision");
      assert.equal(yield* chatNotificationRole(core(["work"]), "work"), "managed");
      assert.equal(yield* chatNotificationRole(core([]), "chat"), "chat");
    }),
);
