import { useQuery } from "@tanstack/react-query";
import { isHostedChat } from "./hosted-chat";
import {
  hostedChatMemberActionsQueryOptions,
  projectSessionDetailQueryOptions,
} from "./query-options";

/** What this Member may do with a chat everyone in its Space shares, as Core reads it to them. */
export interface ChatCapabilities {
  /** Rename, archive or restore, move, compact or clear it, and merge it back. */
  readonly canManage: boolean;
  /** Interrupt its current Run; each subagent or task answers for its own Run. */
  readonly canStop: boolean;
}

const OWN_CHAT: ChatCapabilities = { canManage: true, canStop: true };
const UNKNOWN: ChatCapabilities = { canManage: false, canStop: false };

/**
 * Every chat in a personal Space is its Owner's. In a team Space, Core answers per chat and
 * reader with every session read; until it has, the reader may do neither.
 */
export function useChatCapabilities(sessionId: string | null): ChatCapabilities {
  const hosted = isHostedChat();
  const { data } = useQuery({
    ...projectSessionDetailQueryOptions(sessionId ?? ""),
    enabled: hosted && sessionId !== null,
  });
  if (!hosted) return OWN_CHAT;
  return data ? { canManage: data.canManage, canStop: data.canStop } : UNKNOWN;
}

/**
 * Whether this Member may stop each item's work, a subagent, delegated or background task, by
 * the Run that started it, as Core admits that stop. Work whose Run is unknown stops only for
 * those who may manage the chat; every chat in a personal Space is its Owner's.
 */
export function useRunStopCapabilities(
  sessionId: string | null,
  runIds: readonly (string | null)[],
): (runId: string | null) => boolean {
  const hosted = isHostedChat();
  const { canManage } = useChatCapabilities(sessionId);
  const named = [...new Set(runIds.filter((runId): runId is string => runId !== null))].toSorted();
  const { data } = useQuery({
    ...hostedChatMemberActionsQueryOptions(sessionId, named),
    enabled: hosted && sessionId !== null && named.length > 0,
  });
  if (!hosted) return () => true;
  const stoppable = new Set(data?.runs.filter((run) => run.can_stop).map((run) => run.run_id));
  return (runId) => (runId === null ? canManage : stoppable.has(runId));
}
