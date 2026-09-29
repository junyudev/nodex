import type { CodexSubagentRow } from "../../../shared/codex-subagent-row-model";
import type {
  CodexConversationChildMembership,
  CodexConversationSnapshot,
} from "../../../shared/types";

/** Provider tasks reuse the task strip; their observation IDs never become executable Threads. */
export const projectNativeTaskRows = (
  memberships: readonly CodexConversationChildMembership[],
  read: (id: string) => CodexConversationSnapshot | null,
): CodexSubagentRow[] =>
  memberships
    .filter((membership) => !membership.task?.ambient && !membership.task?.hidden)
    .map((membership) => {
      const conversation = read(membership.threadId);
      const lastTurn = conversation?.turns.at(-1);
      const lastAssistant = conversation?.turns
        .flatMap((turn) => turn.items)
        .findLast((item) => item.semanticKind === "assistantMessage");
      const waiting = membership.pendingRequest || conversation?.requests.length;
      const active = membership.statusType === "active" || conversation?.statusType === "active";
      return {
        conversationId: membership.threadId,
        parentConversationId: membership.parentThreadId,
        parentTurnKey: null,
        displayName: membership.displayName ?? membership.thread?.displayName ?? "Task",
        actorName: membership.actorName ?? membership.displayName ?? "Task",
        agentRole: membership.agentRole ?? membership.thread?.agentRole ?? null,
        spawnModel: membership.thread?.model ?? null,
        status: waiting ? "waiting" : active ? "active" : "done",
        statusSummary:
          membership.task?.summary ??
          lastTurn?.errorMessage ??
          (lastTurn?.status === "interrupted" ? "Stopped" : null),
        lastAssistantMessage: lastAssistant?.markdownText ?? null,
        lastAssistantMessageAtMs: lastAssistant?.updatedAt ?? null,
        recencyAtMs: membership.updatedAtMs ?? 0,
        showInlineActivity: false,
        objective: membership.displayName ?? null,
        startedAtMs: membership.createdAtMs ?? null,
        isCurrentParentTurn: false,
        diffStats: null,
        canInteract: false,
        role: "backgroundChild",
      };
    });
