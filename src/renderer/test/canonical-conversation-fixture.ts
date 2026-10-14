import type {
  Thread,
  ThreadItem,
  ThreadRevertResponse,
  ThreadSettings,
} from "@nodex/codex-app-server-protocol/v2";
import type { CodexConversationSnapshot } from "../../shared/types";
import { buildAgentActivityV2CorpusThread } from "../../shared/codex-conversation-state/test-fixtures/agent-activity-v2-corpus-provenance";
import { createCodexCanonicalHydratedConversationState } from "../../shared/codex-conversation-state/codex-conversation-state";

export function buildThreadFromConversation(conversation: CodexConversationSnapshot): Thread {
  const seconds = (milliseconds: number) =>
    conversation.canonicalState?.historyMode === "paginated"
      ? Math.floor(milliseconds / 1000)
      : milliseconds / 1000;
  return {
    ...buildAgentActivityV2CorpusThread([]),
    historyMode: conversation.canonicalState?.historyMode ?? "legacy",
    id: conversation.threadId,
    sessionId: `session-${conversation.threadId}`,
    forkedFromId: null,
    parentThreadId: conversation.source?.parentThreadId ?? null,
    preview: conversation.threadPreview,
    ephemeral: conversation.ephemeral ?? false,
    modelProvider: conversation.modelProvider ?? "openai",
    createdAt: seconds(conversation.createdAt),
    updatedAt: seconds(conversation.updatedAt),
    recencyAt: seconds(conversation.updatedAt),
    status:
      conversation.statusType === "active"
        ? { type: "active", activeFlags: conversation.statusActiveFlags }
        : { type: conversation.statusType },
    path: null,
    cwd: conversation.cwd ?? "",
    cliVersion: "test",
    source: "appServer",
    threadSource: conversation.threadSource ?? conversation.canonicalState?.threadSource ?? null,
    agentNickname: null,
    agentRole: null,
    gitInfo: null,
    name: conversation.threadName,
    turns: conversation.turns.map((turn) => ({
      rootTurnId: null,
      id: turn.turnId!,
      items: turn.items.map((item) => {
        if (item.rawItem && typeof item.rawItem === "object") {
          return item.rawItem;
        }
        return {
          id: item.itemId,
          type: item.kind === "userMessage" ? "userMessage" : "agentMessage",
          ...(item.kind === "userMessage"
            ? {
                clientId: null,
                content: [{ type: "text", text: item.markdownText ?? "", text_elements: [] }],
              }
            : {
                text: item.markdownText ?? "",
                phase: null,
                memoryCitation: null,
                delivery: null,
              }),
        };
      }) as ThreadItem[],
      itemsView: "full",
      status: turn.status,
      error: turn.errorMessage
        ? {
            message: turn.errorMessage,
            codexErrorInfo: null,
            additionalDetails: null,
            misalignment: null,
          }
        : null,
      startedAt: seconds(turn.startedAt ?? turn.turnStartedAtMs ?? conversation.createdAt),
      completedAt: turn.completedAt ? seconds(turn.completedAt) : null,
      durationMs: turn.durationMs ?? null,
    })),
  };
}
export function buildRevertResponseFromConversation(
  conversation: CodexConversationSnapshot,
): ThreadRevertResponse {
  return {
    thread: { ...buildThreadFromConversation(conversation), turns: [] },
    turnsBackwardsCursor: null,
    itemsBackwardsCursor: null,
  };
}
export function withCanonicalState(
  conversation: CodexConversationSnapshot,
  historyMode = conversation.canonicalState?.historyMode ?? "legacy",
): CodexConversationSnapshot {
  const thread = { ...buildThreadFromConversation(conversation), historyMode };
  const canonical = createCodexCanonicalHydratedConversationState(thread, {
    hostId: "local",
    ...{
      model: "gpt-test-fixture",
      reasoningEffort: "high",
      cwd: conversation.cwd ?? "/workspace/project",
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      sandboxPolicy: { type: "readOnly", networkAccess: false },
      activePermissionProfile: null,
      runtimeWorkspaceRoots: [conversation.cwd ?? "/workspace/project"],
      pendingRequests: conversation.canonicalRequests,
      hasUnreadTurn: conversation.hasUnreadTurn,
    },
  });
  const latestConversationSettings = conversation.latestThreadSettings;
  const latestCollaborationMode = latestConversationSettings?.collaborationMode ?? {
    mode: "default" as const,
    settings: {
      model: latestConversationSettings?.model ?? "gpt-test-fixture",
      reasoning_effort: latestConversationSettings?.reasoningEffort ?? "high",
      developer_instructions: null,
    },
  };
  const latestThreadSettings = {
    cwd: conversation.cwd ?? "/workspace/project",
    approvalPolicy: "on-request" as const,
    approvalsReviewer: "user" as const,
    sandboxPolicy: { type: "readOnly" as const, networkAccess: false },
    activePermissionProfile: null,
    model: latestConversationSettings?.model ?? "gpt-test-fixture",
    modelProvider: conversation.modelProvider ?? "openai",
    serviceTier: null,
    effort: latestConversationSettings?.reasoningEffort ?? "high",
    summary: null,
    collaborationMode: latestCollaborationMode,
    multiAgentMode: "explicitRequestOnly" as const,
    disabledPluginIds: [],
    personality: latestConversationSettings?.personality ?? null,
  } satisfies ThreadSettings;
  const canonicalTurns = canonical.turns.map((turn, index) => {
    const projected = conversation.turns[index];
    if (!projected) return turn;
    return {
      ...turn,
      turnId: projected.turnId,
      turnStartedAtMs: projected.turnStartedAtMs ?? null,
      completedAtMs: projected.completedAt ?? null,
      firstTurnWorkItemStartedAtMs: projected.firstTurnWorkItemStartedAtMs ?? null,
      finalAssistantStartedAtMs: projected.finalAssistantStartedAtMs ?? null,
      commandExecutionStartedAtMsById: projected.commandExecutionStartedAtMsById,
      interruptedCommandExecutionItemIds: projected.interruptedCommandExecutionItemIds,
      hookRuns: projected.hookRuns,
    };
  });
  const projectedTurns = conversation.turns.map((turn, turnIndex) => {
    const canonicalTurn = canonicalTurns[turnIndex];
    if (!canonicalTurn) return turn;
    return {
      ...turn,
      items: turn.items.map((item) => {
        const ownerItemId = item.commandExecutionItemId ?? item.itemId;
        const rawRecord =
          typeof item.rawItem === "object" && item.rawItem !== null
            ? (item.rawItem as {
                id?: unknown;
                type?: unknown;
              })
            : null;
        const rawOwner = canonicalTurn.items.find(
          (candidate) =>
            candidate.id === ownerItemId &&
            (typeof rawRecord?.type !== "string" || candidate.type === rawRecord.type),
        );
        if (!rawOwner) return item;
        return {
          ...item,
          rawItemId: rawOwner.id,
          rawItemType: rawOwner.type,
        };
      }),
    };
  });
  return {
    ...conversation,
    turns: projectedTurns,
    canonicalState: {
      ...canonical,
      ...(conversation.source?.sideConversation !== undefined
        ? { sideConversation: conversation.source.sideConversation }
        : {}),
      latestThreadSettings,
      hydrationContext: canonical.hydrationContext
        ? {
            ...canonical.hydrationContext,
            latestThreadSettings: {
              ...latestThreadSettings,
              permissions: null,
            },
          }
        : null,
      threadGoal: conversation.threadGoal ?? null,
      completedThreadGoal: conversation.completedThreadGoal ?? null,
      threadGoalResumeConfirmation: conversation.threadGoalResumeConfirmation ?? null,
      turns: canonicalTurns,
    },
  };
}
export function withPaginatedCanonicalState(
  conversation: CodexConversationSnapshot,
): CodexConversationSnapshot {
  return withCanonicalState(conversation, "paginated");
}
export function ensureCanonicalResumeFixture(
  value: CodexConversationSnapshot | null,
): CodexConversationSnapshot | null {
  if (value === null) return null;
  const candidate = value as Partial<CodexConversationSnapshot>;
  if (
    typeof candidate.threadId !== "string" ||
    !Array.isArray(candidate.turns) ||
    typeof candidate.resumeState !== "string"
  ) {
    throw new Error("Resume fixture is not a complete conversation snapshot");
  }
  if (candidate.canonicalState !== undefined) {
    return candidate as CodexConversationSnapshot;
  }
  return withCanonicalState(candidate as CodexConversationSnapshot);
}
