import type { QueryClient } from "@tanstack/react-query";
import { createBoundedOperationId } from "../../shared/operation-identity";
import {
  createLatestReturnedValueOwner,
  type LatestReturnedValueOwner,
} from "./latest-returned-value-owner";
import { queryKeys } from "./query-keys";
import {
  defineRendererCommand,
  invokePlainCommandWithTrace,
  invokeRendererQuery,
} from "./renderer-command";
import type { ThreadNotificationSettings, WindowRestoreSettings } from "./types";

const updateWindowRestoreSettingsCommand = defineRendererCommand({
  key: "window_restore_settings.update",
  channel: "settings:window-restore:update",
  authority: "main",
  owner: "window-restore-settings",
  protocol: { kind: "returned_value" },
});

const updateThreadNotificationSettingsCommand = defineRendererCommand({
  key: "thread_notification_settings.update",
  channel: "settings:thread-notifications:update",
  authority: "main",
  owner: "thread-notification-settings",
  protocol: { kind: "returned_value" },
});

export const DEFAULT_WINDOW_RESTORE_SETTINGS: WindowRestoreSettings = { policy: "all" };

export const DEFAULT_THREAD_NOTIFICATION_SETTINGS: ThreadNotificationSettings = {
  turnMode: "unfocused",
  permissionsEnabled: true,
  questionsEnabled: true,
};

export function normalizeWindowRestoreSettings(value: unknown): WindowRestoreSettings {
  if (typeof value !== "object" || value === null) return DEFAULT_WINDOW_RESTORE_SETTINGS;
  const policy = (value as { policy?: unknown }).policy;
  return policy === "all" || policy === "last-window" || policy === "none"
    ? { policy }
    : DEFAULT_WINDOW_RESTORE_SETTINGS;
}

export function normalizeThreadNotificationSettings(value: unknown): ThreadNotificationSettings {
  if (!value || typeof value !== "object") return DEFAULT_THREAD_NOTIFICATION_SETTINGS;
  const candidate = value as Partial<ThreadNotificationSettings>;
  if (
    candidate.turnMode !== "off" &&
    candidate.turnMode !== "unfocused" &&
    candidate.turnMode !== "always"
  ) {
    return DEFAULT_THREAD_NOTIFICATION_SETTINGS;
  }
  if (
    typeof candidate.permissionsEnabled !== "boolean" ||
    typeof candidate.questionsEnabled !== "boolean"
  ) {
    return DEFAULT_THREAD_NOTIFICATION_SETTINGS;
  }
  return {
    turnMode: candidate.turnMode,
    permissionsEnabled: candidate.permissionsEnabled,
    questionsEnabled: candidate.questionsEnabled,
  };
}

const equalWindowRestoreSettings = (
  left: WindowRestoreSettings,
  right: WindowRestoreSettings,
): boolean => left.policy === right.policy;

const equalThreadNotificationSettings = (
  left: ThreadNotificationSettings,
  right: ThreadNotificationSettings,
): boolean =>
  left.turnMode === right.turnMode &&
  left.permissionsEnabled === right.permissionsEnabled &&
  left.questionsEnabled === right.questionsEnabled;

let windowRestoreOwners = new WeakMap<
  QueryClient,
  LatestReturnedValueOwner<WindowRestoreSettings>
>();
let threadNotificationOwners = new WeakMap<
  QueryClient,
  LatestReturnedValueOwner<ThreadNotificationSettings>
>();

export function windowRestoreSettingsOwnerFor(
  queryClient: QueryClient,
): LatestReturnedValueOwner<WindowRestoreSettings> {
  const current = windowRestoreOwners.get(queryClient);
  if (current) return current;
  const owner = createLatestReturnedValueOwner({
    initialValue: normalizeWindowRestoreSettings(
      queryClient.getQueryData(queryKeys.settings.windowRestore()),
    ),
    equals: equalWindowRestoreSettings,
    operationId: () => createBoundedOperationId("renderer.window-restore-settings.update"),
    project: (_current, desired) => desired,
    port: {
      read: async () =>
        normalizeWindowRestoreSettings(await invokeRendererQuery("settings:window-restore:get")),
      update: async (desired, trace) =>
        normalizeWindowRestoreSettings(
          await invokePlainCommandWithTrace(updateWindowRestoreSettingsCommand, trace, desired),
        ),
    },
    semanticKey: updateWindowRestoreSettingsCommand.key,
    owner: updateWindowRestoreSettingsCommand.owner,
    scopeKind: "window",
  });
  windowRestoreOwners.set(queryClient, owner);
  return owner;
}

export function threadNotificationSettingsOwnerFor(
  queryClient: QueryClient,
): LatestReturnedValueOwner<ThreadNotificationSettings> {
  const current = threadNotificationOwners.get(queryClient);
  if (current) return current;
  const owner = createLatestReturnedValueOwner({
    initialValue: normalizeThreadNotificationSettings(
      queryClient.getQueryData(queryKeys.settings.threadNotifications()),
    ),
    equals: equalThreadNotificationSettings,
    operationId: () => createBoundedOperationId("renderer.thread-notification-settings.update"),
    project: (_current, desired) => desired,
    port: {
      read: async () =>
        normalizeThreadNotificationSettings(
          await invokeRendererQuery("settings:thread-notifications:get"),
        ),
      update: async (desired, trace) =>
        normalizeThreadNotificationSettings(
          await invokePlainCommandWithTrace(
            updateThreadNotificationSettingsCommand,
            trace,
            desired,
          ),
        ),
    },
    semanticKey: updateThreadNotificationSettingsCommand.key,
    owner: updateThreadNotificationSettingsCommand.owner,
    scopeKind: "application",
  });
  threadNotificationOwners.set(queryClient, owner);
  return owner;
}

export function resetMainReturnedSettingsOwnersForTests(): void {
  windowRestoreOwners = new WeakMap();
  threadNotificationOwners = new WeakMap();
}
