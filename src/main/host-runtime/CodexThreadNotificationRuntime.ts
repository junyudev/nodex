import { CoreAuthority } from "../core-runtime/CoreAuthority";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { CoreModules } from "../core-runtime/CoreModules";
import {
  chatNotificationRole,
  notificationSession,
} from "../../host/work-observation/notification-session";
import { CodexApplicationEventHub } from "../codex-application/CodexApplicationEventHub";
import { CodexRendererPresentationRegistry } from "../codex-application/CodexRendererPresentationRegistry";
import { makeCodexThreadNotificationHandler } from "../codex/codex-thread-notification-handler";
import { MiniRuntime } from "../mini/MiniRuntime";
import { getLogger } from "../logging/logger";
import { ApplicationSettings } from "../settings/ApplicationSettings";
import { DesktopNotificationRuntime } from "./DesktopNotificationRuntime";
import { WorkbenchNotificationDelivery } from "./WorkbenchNotificationDelivery";
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
  | MiniRuntime
  | WorkbenchNotificationDelivery
  | UserPresence
> = Layer.effectDiscard(
  Effect.gen(function* () {
    const spaceId = (yield* CoreAuthority).identity.libraryId;
    const events = yield* CodexApplicationEventHub;
    const core = yield* CoreModules;
    const applicationSettings = yield* ApplicationSettings;
    const conversations = yield* CodexRendererPresentationRegistry;
    const presence = yield* UserPresence;
    const notifications = yield* DesktopNotificationRuntime;
    const mini = yield* MiniRuntime;
    const delivery = yield* WorkbenchNotificationDelivery;
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
      showNotification: (notification, resolveAction) =>
        delivery.show(notification, spaceId, resolveAction),
      dismissNotification: notifications.dismiss,
      logger,
    });
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
          const sessionId = yield* notificationSession(core, notification);
          const role = yield* chatNotificationRole(core, sessionId);
          if (role === "decision" || (role === "managed" && notification.type !== "turn-completed"))
            return;
          const coveredByMini =
            "conversation" in notification &&
            !notification.conversation.sideConversationParentNavigationPath &&
            sessionId !== null &&
            mini.restingCoverage().chats.includes(sessionId);
          handle(notification, { managed: role === "managed", coveredByMini });
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
