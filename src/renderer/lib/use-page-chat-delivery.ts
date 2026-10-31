import { useAgentRuntimeSessionStatus } from "./agent-runtime-session-activity";
import { useScopedAtomValue } from "./maitai";
import { resolvePageChatDelivery, type PageChatDelivery } from "./page-chat-delivery";
import { threadQueueFollowUpsEnabledAtom } from "./thread-queue-follow-ups-atom";

/** How a Page send would reach this chat right now. */
export function usePageChatDelivery(
  sessionId: string | null | undefined,
  options: { readonly startsNewTurn?: boolean } = {},
): PageChatDelivery {
  const status = useAgentRuntimeSessionStatus(sessionId);
  const queueFollowUps = useScopedAtomValue(threadQueueFollowUpsEnabledAtom);
  return resolvePageChatDelivery({ status, queueFollowUps, startsNewTurn: options.startsNewTurn });
}
