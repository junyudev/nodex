import { useSyncExternalStore } from "react";
import {
  agentRuntimeActivityStore,
  useAgentRuntimeSessionActivity,
  type AgentRuntimeActivityStore,
} from "./agent-runtime-session-activity";
import {
  presentPageChatActivity,
  presentPageChatItemActivity,
  type PageChatActivityPresentation,
} from "./page-chat-activity-presentation";
import { runtimeSessionLiveIndicator, type SessionLiveIndicator } from "./session-execution";
import type { PageChatActivitySummary, PageChatItem } from "./types";

/** A linked chat row; Runtime-bound rows subscribe only to their own Session activity. */
export function usePageChatItemActivity(
  item: PageChatItem,
  store?: AgentRuntimeActivityStore,
): PageChatActivityPresentation {
  const activity = useAgentRuntimeSessionActivity(item.executionRef ? item.sessionId : null, store);
  return presentPageChatItemActivity(item, runtimeSessionLiveIndicator(activity));
}

/** A Page's aggregate glyph adds the live status of its bounded linked Runtime chats. */
export function usePageChatActivity(
  summary: PageChatActivitySummary,
  store?: AgentRuntimeActivityStore,
): PageChatActivityPresentation {
  return presentPageChatActivity(
    summary,
    useRuntimeSessionStatuses(summary.runtimeSessionIds, store),
  );
}

/**
 * Live statuses for a bounded set of Sessions, such as a Page's linked Runtime chats. Only
 * changes to those Sessions re-render the caller; idle Sessions are absent from the map.
 */
export function useRuntimeSessionStatuses(
  sessionIds: readonly string[],
  store: AgentRuntimeActivityStore = agentRuntimeActivityStore,
): ReadonlyMap<string, SessionLiveIndicator> {
  const key = sessionIds.join("\n");
  const snapshot = useSyncExternalStore(
    (listener) => {
      const releases = key
        ? key.split("\n").map((sessionId) => store.subscribeSession(sessionId, listener))
        : [];
      return () => releases.forEach((release) => release());
    },
    () =>
      key
        ? key
            .split("\n")
            .map((sessionId) => store.read(sessionId)?.status ?? "")
            .join("\n")
        : "",
  );
  const statuses = new Map<string, SessionLiveIndicator>();
  if (!key) return statuses;
  const values = snapshot.split("\n");
  key.split("\n").forEach((sessionId, index) => {
    const status = values[index];
    if (status === "running" || status === "waiting" || status === "background")
      statuses.set(sessionId, status);
  });
  return statuses;
}
