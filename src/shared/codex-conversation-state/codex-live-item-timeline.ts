import type { Draft } from "immer";
import type { ServerNotification } from "@nodex/codex-app-server-protocol";
import type {
  CodexCanonicalConversationState,
  CodexCanonicalTimelineEntry,
} from "./codex-conversation-state";

export function codexTimelineEntryIdentity(entry: CodexCanonicalTimelineEntry): string {
  if (entry.type === "item") return JSON.stringify([entry.type, entry.turnId, entry.item.id]);
  if (entry.type === "realtime") return `realtime:${entry.item.id}`;
  return `${entry.type}:${entry.turnId}`;
}

/** Live notifications append to the admitted timeline; completion preserves the original position. */
export function mutateCodexLiveItemTimeline(
  state: Draft<CodexCanonicalConversationState>,
  notification: ServerNotification,
  supportsThreadTimeline: boolean,
  readEntryIndex?: (identity: string) => number | undefined,
): void {
  if (!supportsThreadTimeline || state.historyMode !== "paginated" || !state.canonicalVoiceHistory)
    return;
  if (!("threadId" in notification.params) || notification.params.threadId !== state.id) return;
  if (notification.method === "thread/realtime/item/transcript/delta") {
    const value = state.realtimeItems?.[notification.params.itemId];
    if (value?.item.type === "transcriptSegment" && !value.completed)
      value.item.text += notification.params.delta;
    return;
  }
  if (
    notification.method === "thread/realtime/item/started" &&
    notification.params.item.type !== "transcriptSegment"
  )
    return;
  if (
    notification.method !== "turn/started" &&
    notification.method !== "turn/completed" &&
    notification.method !== "item/started" &&
    notification.method !== "item/completed" &&
    notification.method !== "thread/realtime/item/started" &&
    notification.method !== "thread/realtime/item/completed"
  )
    return;
  const timeline = (state.itemTimeline ??= { activeRealtimeSessionAtPageStart: null, entries: [] });
  const position = (timeline.entries.at(-1)?.position ?? 0) + 1;
  let entry: CodexCanonicalTimelineEntry;
  if (notification.method === "turn/started" || notification.method === "turn/completed") {
    const turn = notification.params.turn;
    entry =
      notification.method === "turn/started"
        ? { type: "turnStarted", position, turnId: turn.id, startedAt: turn.startedAt }
        : {
            type: "turnCompleted",
            position,
            turnId: turn.id,
            status: turn.status,
            error: turn.error,
            startedAt: turn.startedAt,
            completedAt: turn.completedAt,
            durationMs: turn.durationMs,
          };
  } else if (notification.method === "item/started" || notification.method === "item/completed") {
    entry = {
      type: "item",
      position,
      turnId: notification.params.turnId,
      item: {
        id: notification.params.item.id,
        type: notification.params.item.type,
        completed: notification.method === "item/completed",
      },
    };
  } else {
    const item = notification.params.item;
    const realtime = (state.realtimeItems ??= {});
    if (realtime[item.id] && notification.method === "thread/realtime/item/started") return;
    realtime[item.id] = {
      item: item as Draft<typeof item>,
      completed: notification.method === "thread/realtime/item/completed",
    };
    entry = { type: "realtime", position, item };
  }
  const identity = codexTimelineEntryIdentity(entry);
  const index = readEntryIndex
    ? readEntryIndex(identity)
    : timeline.entries.findIndex((candidate) => codexTimelineEntryIdentity(candidate) === identity);
  const previous = index === undefined ? undefined : timeline.entries[index];
  if (!previous) {
    timeline.entries.push(entry as Draft<CodexCanonicalTimelineEntry>);
    return;
  }
  if (previous.type === "item" && entry.type === "item" && entry.item.completed)
    previous.item.completed = true;
  if (
    previous.type === "realtime" &&
    entry.type === "realtime" &&
    notification.method === "thread/realtime/item/completed"
  )
    previous.item = entry.item as Draft<typeof entry.item>;
}
