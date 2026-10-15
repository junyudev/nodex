import { constants, copyFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Notification, type WebContents } from "electron";
import type {
  DesktopNotificationActionPayload,
  DesktopNotificationHideSelector,
  DesktopNotificationPayload,
} from "../../shared/types";
import { toDesktopNotificationPlainText } from "../../shared/desktop-notification-text";
import { MainConfig } from "../app/MainConfig";
import { getLogger } from "../logging/logger";

const MAX_ACTIONS = 4;
const MACOS_NOTIFICATION_SOUND_FILENAME = "nodex-notification.aiff";

type NotificationEventName = "action" | "click" | "close" | "failed" | "reply";

export interface DesktopNotificationInstance {
  show(): void;
  close(): void;
  on(event: NotificationEventName, listener: (...args: unknown[]) => void): void;
}

export interface DesktopNotificationRuntimeOptions {
  readonly isSupported: () => boolean;
  readonly createNotification: (
    input: Electron.NotificationConstructorOptions,
  ) => DesktopNotificationInstance;
  readonly homeDirectory: string;
  readonly logger: Pick<Console, "warn">;
  readonly platform: NodeJS.Platform;
  readonly soundSourcePaths: readonly string[];
}

interface ActiveDesktopNotification {
  readonly notification: DesktopNotificationInstance;
  readonly notificationId: string;
  readonly conversationId: string | null;
  readonly navigationPath: string | null;
  readonly originWebContentsId: number;
  readonly remove: () => void;
}

export interface DesktopNotificationRuntimeService {
  readonly show: (
    notification: DesktopNotificationPayload,
    originWebContents: WebContents,
    onAction: (payload: DesktopNotificationActionPayload) => void,
    onRemove?: () => void,
  ) => void;
  readonly dismiss: (selector: DesktopNotificationHideSelector) => void;
  readonly dismissByOriginWebContentsId: (webContentsId: number) => void;
}

export class DesktopNotificationRuntime extends Context.Service<
  DesktopNotificationRuntime,
  DesktopNotificationRuntimeService
>()("nodex/main/host-runtime/DesktopNotificationRuntime") {}

const createElectronNotification = (
  input: Electron.NotificationConstructorOptions,
): DesktopNotificationInstance => {
  const notification = new Notification(input);
  const typedNotification = notification as Notification & {
    on(event: NotificationEventName, listener: (...args: unknown[]) => void): Notification;
  };
  return {
    show: () => notification.show(),
    close: () => notification.close(),
    on: (event, listener) => {
      if (event === "action") {
        typedNotification.on("action", (eventObject, index) => listener(eventObject, index));
        return;
      }
      if (event === "reply") {
        typedNotification.on("reply", (eventObject, reply) => listener(eventObject, reply));
        return;
      }
      if (event === "failed") {
        typedNotification.on("failed", (_eventObject, error) => listener(error));
        return;
      }
      typedNotification.on(event, () => listener());
    },
  };
};

/** Owns every active native notification and callback for exactly one Main Scope. */
export const layer = (
  options: DesktopNotificationRuntimeOptions,
): Layer.Layer<DesktopNotificationRuntime> =>
  Layer.effect(
    DesktopNotificationRuntime,
    Effect.gen(function* () {
      const notifications = new Map<string, ActiveDesktopNotification>();
      let accepting = true;
      let soundResolved = false;
      let soundName: string | null = null;

      const callRemove = (callback: () => void, notificationId: string): void => {
        try {
          callback();
        } catch (error) {
          options.logger.warn("[desktop-notifications] callback cleanup failed", {
            error,
            notificationId,
          });
        }
      };

      const remove = (occurrenceId: string, closeNative: boolean): void => {
        const active = notifications.get(occurrenceId);
        if (!active) return;
        notifications.delete(occurrenceId);
        callRemove(active.remove, active.notificationId);
        if (!closeNative) return;
        try {
          active.notification.close();
        } catch (error) {
          options.logger.warn("[desktop-notifications] native close failed", {
            error,
            notificationId: active.notificationId,
          });
        }
      };

      const dismissWhere = (matches: (active: ActiveDesktopNotification) => boolean): void => {
        for (const [occurrenceId, active] of notifications) {
          if (matches(active)) remove(occurrenceId, true);
        }
      };

      const resolveSoundName = (): string | undefined => {
        if (options.platform !== "darwin") return undefined;
        if (soundResolved) return soundName ?? undefined;
        soundResolved = true;
        const sourcePath = options.soundSourcePaths.find(
          (candidate) => candidate.length > 0 && existsSync(candidate),
        );
        if (!sourcePath) return undefined;

        const soundDirectory = join(options.homeDirectory, "Library", "Sounds");
        const targetPath = join(soundDirectory, MACOS_NOTIFICATION_SOUND_FILENAME);
        try {
          mkdirSync(soundDirectory, { recursive: true });
          if (!existsSync(targetPath)) {
            copyFileSync(sourcePath, targetPath, constants.COPYFILE_EXCL);
          }
          soundName = MACOS_NOTIFICATION_SOUND_FILENAME.replace(/\.[^.]+$/, "");
        } catch {
          soundName = null;
        }
        return soundName ?? undefined;
      };

      const show: DesktopNotificationRuntimeService["show"] = (
        notification,
        originWebContents,
        onAction,
        onRemove = () => undefined,
      ) => {
        if (!accepting || !options.isSupported() || originWebContents.isDestroyed()) {
          callRemove(onRemove, notification.id);
          return;
        }

        const actions = (notification.actions ?? []).slice(0, MAX_ACTIONS);
        const hasReply =
          notification.kind === "turn-complete" &&
          typeof notification.replyPlaceholder === "string" &&
          notification.replyPlaceholder.trim().length > 0;
        const timeoutType = notification.kind === "question" ? "never" : undefined;
        const occurrenceId = notification.occurrenceId ?? notification.id;
        remove(occurrenceId, true);

        let instance: DesktopNotificationInstance;
        try {
          instance = options.createNotification({
            title: toDesktopNotificationPlainText(notification.title),
            body: toDesktopNotificationPlainText(notification.body),
            silent: false,
            timeoutType,
            hasReply,
            replyPlaceholder: hasReply ? notification.replyPlaceholder : undefined,
            sound: resolveSoundName(),
            actions: actions.map((action) => ({ type: "button", text: action.title })),
          });
        } catch (error) {
          options.logger.warn("[desktop-notifications] constructor failed", {
            error,
            notificationId: notification.id,
          });
          callRemove(onRemove, notification.id);
          return;
        }

        let actionConsumed = false;
        const consumeAction = (payload: DesktopNotificationActionPayload): void => {
          if (actionConsumed) return;
          const active = notifications.get(occurrenceId);
          if (!accepting || active?.notification !== instance) return;
          actionConsumed = true;
          remove(occurrenceId, true);
          onAction(payload);
        };

        instance.on("click", () => {
          consumeAction({ notificationId: notification.id, actionId: null, actionType: "open" });
        });
        instance.on("action", (_event, index) => {
          if (typeof index !== "number") return;
          const action = actions[index];
          if (!action) return;
          consumeAction({
            notificationId: notification.id,
            actionId: action.id,
            actionType: action.actionType,
          });
        });
        instance.on("reply", (_event, reply) => {
          if (typeof reply !== "string") return;
          consumeAction({
            notificationId: notification.id,
            actionId: null,
            actionType: "reply",
            reply,
          });
        });
        instance.on("close", () => {
          if (notifications.get(occurrenceId)?.notification === instance) {
            remove(occurrenceId, false);
          }
        });
        instance.on("failed", (error) => {
          if (notifications.get(occurrenceId)?.notification !== instance) return;
          options.logger.warn("[desktop-notifications] native show failed", {
            error,
            notificationId: notification.id,
          });
          remove(occurrenceId, false);
        });

        notifications.set(occurrenceId, {
          notification: instance,
          notificationId: notification.id,
          conversationId: notification.conversationId ?? null,
          navigationPath: notification.navigationPath ?? null,
          originWebContentsId: originWebContents.id,
          remove: onRemove,
        });
        try {
          instance.show();
        } catch (error) {
          options.logger.warn("[desktop-notifications] show threw", {
            error,
            notificationId: notification.id,
          });
          remove(occurrenceId, true);
        }
      };

      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          accepting = false;
          for (const occurrenceId of [...notifications.keys()]) remove(occurrenceId, true);
        }),
      );

      return DesktopNotificationRuntime.of({
        show,
        dismiss: (selector) => {
          if (selector.occurrenceId !== undefined) {
            remove(selector.occurrenceId, true);
            return;
          }
          if (selector.notificationId !== undefined) {
            dismissWhere((active) => active.notificationId === selector.notificationId);
            return;
          }
          if (selector.conversationId !== undefined) {
            dismissWhere((active) => active.conversationId === (selector.conversationId ?? null));
          }
          if (selector.navigationPath !== undefined) {
            dismissWhere((active) => active.navigationPath === (selector.navigationPath ?? null));
          }
        },
        dismissByOriginWebContentsId: (webContentsId) =>
          dismissWhere((active) => active.originWebContentsId === webContentsId),
      });
    }),
  );

export const live: Layer.Layer<DesktopNotificationRuntime, never, MainConfig> = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* MainConfig;
    return layer({
      isSupported: () => Notification.isSupported(),
      createNotification: createElectronNotification,
      homeDirectory: config.homeDirectory,
      logger: getLogger({ component: "desktop-notification-runtime" }),
      platform: config.platform as NodeJS.Platform,
      soundSourcePaths: [
        join(config.resourcesPath, MACOS_NOTIFICATION_SOUND_FILENAME),
        join(config.projectRootPath, "resources", MACOS_NOTIFICATION_SOUND_FILENAME),
      ],
    });
  }),
);
