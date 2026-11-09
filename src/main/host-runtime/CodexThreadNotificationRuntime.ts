import { CoreAuthority } from "../core-runtime/CoreAuthority";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { CoreModules } from "../core-runtime/CoreModules";
import { turnSpeaksThroughNodex } from "../../host/coordinator/notification-session";
import { CodexApplicationEventHub } from "../codex-application/CodexApplicationEventHub";
import { CodexRendererPresentationRegistry } from "../codex-application/CodexRendererPresentationRegistry";
import { makeCodexThreadNotificationHandler } from "../codex/codex-thread-notification-handler";
import { getLogger } from "../logging/logger";
import { ApplicationSettings } from "../settings/ApplicationSettings";
import { WindowRuntime } from "../window-runtime/WindowRuntime";
import { DesktopNotificationRuntime } from "./DesktopNotificationRuntime";
import { RendererClientRuntime } from "./RendererClientRuntime";
import { UserPresence } from "../../host/UserPresence";

const logger = getLogger({ component: "codex-thread-notification-runtime" });

/** Owns native-notification ingress and action admission for exactly one Main Scope. */
export const live: Layer.Layer<
  never,
  never,
  | CoreAuthority
  | CoreModules
  | CodexApplicationEventHub
  | ApplicationSettings
  | CodexRendererPresentationRegistry
  | DesktopNotificationRuntime
  | RendererClientRuntime
  | UserPresence
  | WindowRuntime
> = Layer.effectDiscard(
  Effect.gen(function* () {
    const spaceId = (yield* CoreAuthority).identity.libraryId;
    const events = yield* CodexApplicationEventHub;
    const core = yield* CoreModules;
    const applicationSettings = yield* ApplicationSettings;
    const conversations = yield* CodexRendererPresentationRegistry;
    const presence = yield* UserPresence;
    const notifications = yield* DesktopNotificationRuntime;
    const rendererClients = yield* RendererClientRuntime;
    const windows = yield* WindowRuntime;
    let accepting = true;
    let currentSettings = (yield* applicationSettings.snapshot().pipe(Effect.orDie)).notifications;
    const handle = makeCodexThreadNotificationHandler({
      getSettings: () => currentSettings,
      isAppForegrounded: () => conversations.hasForegroundClient(),
      isConversationSeen: (hostId, conversation) =>
        presence.isSeen({
          conversationId: conversation.conversationId,
          hostId,
          sessionId: conversation.runtimeSessionId,
        }),
      resolveTargetClientId: (conversationId) => {
        const presenting = conversations.resolvePresentedSurfaceClient(conversationId);
        if (presenting) return presenting;
        const fallbackWindow = windows.getLastFocused();
        if (!fallbackWindow) return null;
        return rendererClients.getClientIdForWebContentsId(fallbackWindow.webContents.id);
      },
      showNotification: (notification, targetClientId, onAction) => {
        const webContentsId = rendererClients.getWebContentsIdForClientId(targetClientId);
        if (webContentsId === null) return;
        const targetWindow = windows.get(webContentsId);
        if (!targetWindow || targetWindow.isDestroyed()) return;
        notifications.show(notification, targetWindow.webContents, (action) => {
          if (accepting) onAction(action);
        });
      },
      dismissNotification: notifications.dismiss,
      dispatchAction: (targetClientId, action) =>
        rendererClients.sendToClient(targetClientId, "desktop-notification:action", {
          ...action,
          spaceId,
        }),
      focusTargetClient: (targetClientId) => {
        const webContentsId = rendererClients.getWebContentsIdForClientId(targetClientId);
        if (webContentsId === null) return;
        const targetWindow = windows.get(webContentsId);
        if (!targetWindow || targetWindow.isDestroyed()) return;
        if (targetWindow.isMinimized()) targetWindow.restore();
        targetWindow.show();
        targetWindow.focus();
      },
      logger,
    });
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        accepting = false;
      }),
    );
    yield* events.events.pipe(
      Stream.runForEach((event) => {
        if (event.kind === "conversationSeen") {
          return Effect.sync(() => notifications.dismiss({ conversationId: event.value }));
        }
        if (event.kind !== "threadNotification") return Effect.void;
        return Effect.gen(function* () {
          const snapshot = yield* applicationSettings.snapshot();
          currentSettings = snapshot.notifications;
          const notification = event.value;
          if (notification.type !== "turn-completed") {
            if (yield* turnSpeaksThroughNodex(core, notification)) return;
            handle(notification);
            return;
          }
          handle(notification, { managed: yield* turnSpeaksThroughNodex(core, notification) });
        }).pipe(
          Effect.catch((cause) =>
            Effect.sync(() => logger.warn("Could not resolve notification policy", { cause })),
          ),
        );
      }),
      Effect.forkScoped({ startImmediately: true }),
    );
  }),
);
