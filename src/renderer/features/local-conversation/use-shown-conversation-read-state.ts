import { useEffect, useState } from "react";
import type { CodexThreadSummary } from "../../lib/types";
import { subscribeCodexAppServerMessage } from "./app-server-message-bus";
import type { ConversationReadActivityToken } from "./conversation-read-state-observer";
import {
  useConversation,
  useConversationRequests,
  useConversationRuntime,
} from "./local-conversation-store";
import { useConversationBodyPresentation } from "./use-conversation-body-presentation";
import { useConversationReadState } from "./use-conversation-read-state";

/**
 * Marks a conversation read while one of its transcripts is shown in a focused window: the main
 * Conversation, or the expanded floating composer while the main transcript is hidden.
 */
export function useShownConversationReadState({
  conversationId,
  summary,
  shown,
}: {
  conversationId: string | null;
  summary: CodexThreadSummary | null;
  shown: boolean;
}) {
  const runtime = useConversationRuntime(conversationId, summary?.executionHostId ?? null);
  const conversation = useConversation(conversationId);
  const requests = useConversationRequests(conversationId);
  const { turns } = useConversationBodyPresentation(conversationId);
  const [activityToken, setActivityToken] = useState<ConversationReadActivityToken | null>(null);
  useEffect(
    () =>
      subscribeCodexAppServerMessage("thread-read-activity", (event) => {
        if (event.hostId !== runtime.hostId || event.conversationId !== conversationId) return;
        setActivityToken({
          hostId: event.hostId,
          threadId: event.conversationId,
          activity: event.activity,
        });
      }),
    [conversationId, runtime.hostId],
  );
  const latestTurn = turns.at(-1) ?? null;
  // App-owned Sessions are read only once their conversation is resident.
  const runtimeSession = runtime.sessionId !== undefined;
  return useConversationReadState({
    identity: conversationId ? JSON.stringify([runtime.hostId, conversationId]) : null,
    active: shown && (!runtimeSession || conversation !== null),
    hasConversation: conversation !== null,
    // Session unread belongs to Core; execution snapshots intentionally do not own it.
    hasUnreadTurn: conversation?.hasUnreadTurn ?? summary?.hasUnreadTurn ?? false,
    hasPersistedUnreadTurn: summary?.hasUnreadTurn ?? false,
    latestRequestId:
      conversation?.canonicalRequests?.at(-1)?.id ?? requests.at(-1)?.requestId ?? null,
    latestTurnId: latestTurn?.turnId ?? null,
    latestTurnStatus: latestTurn?.status ?? null,
    activityToken:
      activityToken?.hostId === runtime.hostId && activityToken.threadId === conversationId
        ? activityToken
        : null,
    onMarkRead: () => {
      if (conversationId) void runtime.markRead(conversationId).catch(() => {});
    },
  });
}
