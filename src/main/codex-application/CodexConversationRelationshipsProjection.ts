import { selectPrimaryBackgroundConversationRequest } from "../../shared/codex-conversation-request";
import { isRawCodexSubagentThreadIdLabel } from "../../shared/codex-subagent-display";
import type {
  CodexCanonicalConversationState,
  CodexConversationChildMembership,
  CodexConversationSnapshot,
  CodexThreadStatusType,
} from "../../shared/types";

export interface CodexConversationRelationshipThread {
  readonly threadId: string;
  readonly parentThreadId: string | null;
  readonly threadName: string | null;
  readonly threadPreview: string;
  readonly model: string | null;
  readonly agentNickname: string | null;
  readonly agentRole: string | null;
  readonly agentPath: string | null;
  readonly statusType: CodexThreadStatusType;
  readonly archived: boolean;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface CodexConversationRelationshipChild {
  readonly thread: CodexConversationRelationshipThread;
  readonly conversation: CodexConversationSnapshot | null;
}

const nonBlank = (value: string | null | undefined): string | null => value?.trim() || null;

/** Extracts child identity from the canonical protocol document, never from renderer views. */
export const extractCodexConversationRelationshipThreadIds = (
  state: CodexCanonicalConversationState | null,
): readonly string[] => {
  if (!state) return [];
  const ids = new Set<string>();
  for (const turn of state.turns) {
    for (const item of turn.items) {
      if (item.type !== "collabAgentToolCall") continue;
      for (const rawThreadId of item.receiverThreadIds) {
        const threadId = rawThreadId.trim();
        if (threadId && threadId !== state.protocol.id) ids.add(threadId);
      }
    }
  }
  return [...ids];
};

export const hasFriendlyCodexConversationRelationshipIdentity = (
  thread: CodexConversationRelationshipThread,
): boolean =>
  Boolean(nonBlank(thread.agentNickname)) ||
  Boolean(
    nonBlank(thread.threadName) &&
    !isRawCodexSubagentThreadIdLabel(thread.threadName, thread.threadId),
  );

const actorName = (child: CodexConversationRelationshipChild): string => {
  const conversationName = nonBlank(child.conversation?.threadName);
  if (conversationName) return conversationName;
  const durableName = nonBlank(child.thread.threadName);
  if (durableName) return durableName;
  const nickname =
    nonBlank(child.conversation?.agentNickname) ?? nonBlank(child.thread.agentNickname);
  if (nickname) return nickname.startsWith("@") ? nickname.slice(1) : nickname;
  return (
    nonBlank(child.conversation?.threadPreview) ??
    nonBlank(child.thread.threadPreview) ??
    child.thread.threadId
  );
};

const threadMetadata = (
  child: CodexConversationRelationshipChild,
): CodexConversationChildMembership["thread"] => {
  const displayName = nonBlank(child.conversation?.threadName) ?? nonBlank(child.thread.threadName);
  const nickname =
    nonBlank(child.conversation?.agentNickname) ?? nonBlank(child.thread.agentNickname);
  const agentRole = nonBlank(child.conversation?.agentRole) ?? nonBlank(child.thread.agentRole);
  const model = nonBlank(child.conversation?.executionProfile?.modelId) ?? child.thread.model;
  if (!displayName && !nickname && !agentRole) return null;
  return {
    ...(displayName ? { displayName, name: displayName } : {}),
    nickname,
    model,
    agentRole,
  };
};

/** Pure durable/canonical-to-presentation relationship projection. */
export const projectCodexConversationRelationships = (input: {
  readonly parent: CodexConversationSnapshot;
  readonly canonicalChildThreadIds: readonly string[];
  readonly children: readonly CodexConversationRelationshipChild[];
}): readonly CodexConversationChildMembership[] => {
  const canonicalOrder = new Map(
    input.canonicalChildThreadIds.map((threadId, index) => [threadId, index] as const),
  );
  const hasInlineSubagentActivity = input.parent.turns.some((turn) =>
    turn.items.some((item) => item.subagentActivity !== undefined),
  );
  const hasInlineReference = (threadId: string): boolean =>
    input.parent.turns.some((turn) =>
      turn.items.some((item) => item.subagentActivity?.agentThreadId === threadId),
    );
  const children = [...input.children]
    .filter(
      (child) =>
        child.thread.parentThreadId === input.parent.threadId &&
        !child.thread.archived &&
        !child.conversation?.archived,
    )
    .sort((left, right) => {
      const leftOrder = canonicalOrder.get(left.thread.threadId);
      const rightOrder = canonicalOrder.get(right.thread.threadId);
      if (leftOrder !== undefined || rightOrder !== undefined) {
        if (leftOrder === undefined) return 1;
        if (rightOrder === undefined) return -1;
        if (leftOrder !== rightOrder) return leftOrder - rightOrder;
      }
      return (
        left.thread.createdAt - right.thread.createdAt ||
        left.thread.threadId.localeCompare(right.thread.threadId)
      );
    });

  return children.map((child): CodexConversationChildMembership => {
    const threadId = child.thread.threadId;
    const metadata = threadMetadata(child);
    const agentRole = nonBlank(child.conversation?.agentRole) ?? nonBlank(child.thread.agentRole);
    const agentPath = nonBlank(child.conversation?.agentPath) ?? nonBlank(child.thread.agentPath);
    return {
      threadId,
      parentThreadId: input.parent.threadId,
      role: selectPrimaryBackgroundConversationRequest(child.conversation)
        ? "childApproval"
        : "backgroundChild",
      actorName: actorName(child),
      agentRole,
      agentPath,
      createdAtMs: child.conversation?.createdAt ?? child.thread.createdAt,
      updatedAtMs: child.conversation?.updatedAt ?? child.thread.updatedAt,
      statusType: child.conversation?.statusType ?? child.thread.statusType,
      showInlineActivity: Boolean(
        agentPath ||
        hasInlineReference(threadId) ||
        (!canonicalOrder.has(threadId) && hasInlineSubagentActivity),
      ),
      ...(metadata ? { thread: metadata } : {}),
    };
  });
};
