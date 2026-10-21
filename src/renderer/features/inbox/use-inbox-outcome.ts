import type { InboxItem } from "../../../shared/inbox";
import {
  useAgentRuntimeSessionActivity,
  type AgentRuntimeActivityStore,
} from "@/lib/agent-runtime-session-activity";
import { runtimeSessionLiveIndicator } from "@/lib/session-execution";
import { useRuntimeSessionStatuses } from "@/lib/use-page-chat-activity";
import { describeInboxOutcome, type InboxOutcome } from "./inbox-presentation";

/** The chat a message was handed to, when that chat's status is its Runtime activity. */
const runtimeChatSessionId = (item: InboxItem): string | null => {
  const chat = item.proposal?.chat;
  return chat?.executionRef ? chat.sessionId : null;
};

/** Where a handled message went, with the receiving chat's live state. */
export function useInboxOutcome(item: InboxItem, store?: AgentRuntimeActivityStore): InboxOutcome {
  const activity = useAgentRuntimeSessionActivity(runtimeChatSessionId(item), store);
  return describeInboxOutcome(item, runtimeSessionLiveIndicator(activity));
}

/** Outcomes for a list of handled messages; only their Runtime chats' changes re-render it. */
export function useInboxOutcomes(
  items: readonly InboxItem[],
  store?: AgentRuntimeActivityStore,
): ReadonlyMap<string, InboxOutcome> {
  const statuses = useRuntimeSessionStatuses(
    [...new Set(items.flatMap((item) => runtimeChatSessionId(item) ?? []))],
    store,
  );
  return new Map(
    items.map((item) => {
      const sessionId = runtimeChatSessionId(item);
      return [
        item.pageId,
        describeInboxOutcome(item, sessionId ? (statuses.get(sessionId) ?? null) : null),
      ];
    }),
  );
}
