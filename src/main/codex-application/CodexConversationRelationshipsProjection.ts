import { conversationTurnsWithOverlay } from "../../shared/codex-conversation-state/codex-conversation-state";
import { selectPrimaryBackgroundConversationRequest } from "../../shared/codex-conversation-request";
import type { CodexConversationRequestContext } from "../../shared/codex-conversation-request-context";
import { projectCodexBackgroundRequest } from "../../shared/codex-background-request-projection";
import { projectCodexCanonicalTurnItemViews } from "../../shared/codex-canonical-item-projector";
import { extractCodexThreadSubagentMetadata } from "../../shared/codex-subagent-metadata";
import { isRawCodexSubagentThreadIdLabel } from "../../shared/codex-subagent-display";
import type {
  CodexCanonicalConversationState,
  CodexConversationChildMembership,
  CodexConversationSnapshot,
  CodexThreadStatusType,
} from "../../shared/types";

export interface CodexConversationRelationshipThread {
  readonly threadId: string;
  readonly projectId: string | null;
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
  readonly canonicalState: CodexCanonicalConversationState | null;
}

const nonBlank = (value: string | null | undefined): string | null => value?.trim() || null;

/** Extracts child identity from the canonical protocol document, never from renderer views. */
export const extractCodexConversationRelationshipThreadIds = (
  state: CodexCanonicalConversationState | null,
): readonly string[] => {
  if (!state) return [];
  const ids = new Set<string>();
  for (const turn of conversationTurnsWithOverlay(state)) {
    for (const item of turn.items) {
      if (item.type === "subAgentActivity") {
        if (item.kind === "interacted") continue;
        const threadId = item.agentThreadId.trim();
        if (threadId && threadId !== state.id) ids.add(threadId);
        continue;
      }
      if (item.type !== "collabAgentToolCall") continue;
      for (const rawThreadId of item.receiverThreadIds) {
        const threadId = rawThreadId.trim();
        if (threadId && threadId !== state.id) ids.add(threadId);
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

/** Canonical metadata overrides a dormant view; archive and Project ownership stay durable. */
export const projectCodexConversationRelationshipThread = (
  child: CodexConversationRelationshipChild,
): CodexConversationRelationshipThread => {
  const state = child.canonicalState;
  const view = child.conversation;
  const metadata = state ? extractCodexThreadSubagentMetadata(state) : null;
  return {
    ...child.thread,
    threadName: nonBlank(state?.title) ?? nonBlank(view?.threadName) ?? child.thread.threadName,
    threadPreview: nonBlank(view?.threadPreview) ?? child.thread.threadPreview,
    model:
      nonBlank(state?.latestThreadSettings?.model ?? state?.latestModel) ??
      view?.executionProfile?.modelId ??
      child.thread.model,
    agentNickname:
      nonBlank(metadata?.agentNickname) ??
      nonBlank(view?.agentNickname) ??
      child.thread.agentNickname,
    agentRole: nonBlank(metadata?.agentRole) ?? nonBlank(view?.agentRole) ?? child.thread.agentRole,
    agentPath: nonBlank(metadata?.agentPath) ?? nonBlank(view?.agentPath) ?? child.thread.agentPath,
    statusType: state?.threadRuntimeStatus.type ?? view?.statusType ?? child.thread.statusType,
    createdAt: state?.createdAt ?? view?.createdAt ?? child.thread.createdAt,
    updatedAt: state?.updatedAt ?? view?.updatedAt ?? child.thread.updatedAt,
  };
};

/** Projects only pending-request Turns and their file-change rows, without hydrating a transcript. */
const backgroundRequestContext = (
  child: CodexConversationRelationshipChild,
): CodexConversationRequestContext | null => {
  const state = child.canonicalState;
  if (!state) return child.conversation;
  const projectId = child.thread.projectId;
  const requests = [
    ...(child.conversation?.requests.filter(
      (request) => request.type === "nodexAgentAuthorization",
    ) ?? []),
    ...state.requests.flatMap((request) => {
      const projected = projectCodexBackgroundRequest({ projectId }, request);
      return projected?.threadId === state.id ? [projected] : [];
    }),
  ];
  const turnIds = new Set(requests.map((request) => request.turnId));
  const fileItemIds = new Set(
    requests.flatMap((request) =>
      request.type === "approval" && request.kind === "file" ? [request.itemId] : [],
    ),
  );
  return {
    projectId,
    threadId: state.id,
    requests,
    canonicalRequests: [...state.requests],
    turns: conversationTurnsWithOverlay(state)
      .filter((turn) => turn.turnId !== null && turnIds.has(turn.turnId))
      .map((turn) => {
        const items = projectCodexCanonicalTurnItemViews({
          threadId: state.id,
          turnId: turn.turnId,
          turnStatus: turn.status,
          items: turn.items.filter(
            (item) => item.type === "fileChange" && fileItemIds.has(item.id),
          ),
          observedAtMs: state.updatedAt,
        }).map(({ normalizedKind, ...view }) => ({ ...view, kind: normalizedKind }));
        return {
          threadId: state.id,
          turnId: turn.turnId,
          status: turn.status,
          itemIds: items.map((item) => item.itemId),
          items,
        };
      }),
  };
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
  readonly parent: CodexCanonicalConversationState;
  readonly canonicalChildThreadIds: readonly string[];
  readonly children: readonly CodexConversationRelationshipChild[];
}): readonly CodexConversationChildMembership[] => {
  const canonicalOrder = new Map(
    input.canonicalChildThreadIds.map((threadId, index) => [threadId, index] as const),
  );
  const parentTurns = conversationTurnsWithOverlay(input.parent);
  const hasInlineSubagentActivity = parentTurns.some((turn) =>
    turn.items.some((item) => item.type === "subAgentActivity" && item.kind !== "interacted"),
  );
  const hasInlineReference = (threadId: string): boolean =>
    parentTurns.some((turn) =>
      turn.items.some(
        (item) =>
          item.type === "subAgentActivity" &&
          item.kind !== "interacted" &&
          item.agentThreadId === threadId,
      ),
    );
  const childById = new Map(input.children.map((child) => [child.thread.threadId, child]));
  const belongsToParent = (child: CodexConversationRelationshipChild): boolean => {
    const visited = new Set<string>();
    let current: CodexConversationRelationshipChild | undefined = child;
    while (current && !current.thread.archived && !visited.has(current.thread.threadId)) {
      visited.add(current.thread.threadId);
      const parentId: string | null = current.thread.parentThreadId;
      if (parentId === input.parent.id) return true;
      current = parentId ? childById.get(parentId) : undefined;
    }
    return false;
  };
  const children = [...input.children].filter(belongsToParent).sort((left, right) => {
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
    const requestContext = backgroundRequestContext(child);
    const request = selectPrimaryBackgroundConversationRequest(requestContext);
    const requestItem =
      requestContext?.turns
        .find((turn) => turn.turnId === request?.turnId)
        ?.items.find((item) => item.itemId === request?.itemId) ?? null;
    const resolved = {
      ...child,
      thread: projectCodexConversationRelationshipThread(child),
      conversation: null,
    };
    const threadId = resolved.thread.threadId;
    const metadata = threadMetadata(resolved);
    const agentRole = nonBlank(resolved.thread.agentRole);
    const agentPath = nonBlank(resolved.thread.agentPath);
    return {
      threadId,
      parentThreadId: resolved.thread.parentThreadId ?? input.parent.id,
      role: request ? "childApproval" : "backgroundChild",
      pendingRequest: request ? { request, requestItem } : null,
      actorName: actorName(resolved),
      agentRole,
      agentPath,
      createdAtMs: resolved.thread.createdAt,
      updatedAtMs: resolved.thread.updatedAt,
      statusType: resolved.thread.statusType,
      showInlineActivity: Boolean(
        agentPath ||
        hasInlineReference(threadId) ||
        (!canonicalOrder.has(threadId) && hasInlineSubagentActivity),
      ),
      ...(metadata ? { thread: metadata } : {}),
    };
  });
};
