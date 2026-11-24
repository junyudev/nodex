import { queryOptions } from "@tanstack/react-query";
import type { ConversationIdentity } from "../../shared/conversation-identity";
import { queryKeys } from "./query-keys";
import { invokeRendererQuery } from "./renderer-command";

/** The execution owner resolves a conversation and its Session; its ID carries no routing rule. */
export function readConversationIdentity(threadId: string): Promise<ConversationIdentity | null> {
  return invokeRendererQuery("conversation:identity:get", threadId);
}

/**
 * Names another conversation where work is attributed to it. Unknown and deleted conversations
 * resolve to null; Session changes refresh what is shown.
 */
export function conversationIdentityQueryOptions(threadId: string) {
  return queryOptions({
    queryKey: queryKeys.conversationIdentity.thread(threadId),
    queryFn: () => readConversationIdentity(threadId),
    staleTime: 60_000,
    retry: false,
  });
}
