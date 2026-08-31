import type { ServerNotification } from "@nodex/codex-app-server-protocol";

/**
 * `thread/started` is lifecycle metadata, never a transcript transport. Strip embedded history at
 * the first typed boundary so queues, renderer forwarding, and replay cannot retain it.
 */
export function toCodexThreadStartedMetadataNotification(
  notification: ServerNotification,
): ServerNotification {
  if (notification.method !== "thread/started") return notification;
  return {
    ...notification,
    params: {
      ...notification.params,
      thread: {
        ...notification.params.thread,
        turns: [],
      },
    },
  };
}
