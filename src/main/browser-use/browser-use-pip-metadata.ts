import {
  asDesktopRecord as asRecord,
  codexDesktopToolItemActivity,
  parseDesktopIdentifier as parseIdentifier,
  type DesktopToolActivity,
} from "@nodex/agent-runtime/contracts";

export type { BrowserUsePipSurface } from "@nodex/agent-runtime/contracts";

export type RemoteHostedPipNotification = { readonly threadId: string } & (
  | (DesktopToolActivity & { readonly turnId?: string })
  | { readonly kind: "thread-ended"; readonly deleted: boolean }
  | { readonly kind: "turn-ended"; readonly completed: boolean; readonly turnId: string }
);

/** Derives a bounded PiP consequence from an already decoded official notification. */
export function parseRemoteHostedPipNotification(
  value: unknown,
): RemoteHostedPipNotification | null {
  const notification = asRecord(value);
  const params = asRecord(notification?.params);
  const method = notification?.method;
  const threadId = parseIdentifier(params?.threadId);
  if (!threadId || typeof method !== "string") return null;

  if (method === "thread/archived" || method === "thread/closed" || method === "thread/deleted") {
    return { deleted: method === "thread/deleted", kind: "thread-ended", threadId };
  }

  if (method === "turn/completed") {
    const turn = asRecord(params?.turn);
    const turnId = parseIdentifier(turn?.id);
    if (!turnId) return null;
    return {
      completed: turn?.status === "completed",
      kind: "turn-ended",
      threadId,
      turnId,
    };
  }

  if (method !== "item/started" && method !== "item/completed") return null;
  const activity = codexDesktopToolItemActivity(params?.item, method === "item/started");
  const turnId = parseIdentifier(params?.turnId);
  return activity ? { ...activity, threadId, ...(turnId ? { turnId } : {}) } : null;
}
