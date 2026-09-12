import { residentConversationTurns } from "../../shared/codex-conversation-state/codex-turn-mutation";
import type {
  CodexCanonicalConversationState,
  CodexCanonicalTurnState,
  CodexConversationSnapshot,
  CodexConversationThreadSettings,
  CodexConversationTurn,
  CodexItemView,
} from "../../shared/types";
import { applyCodexLifecycleProjectionDiff } from "../../shared/codex-conversation-state/codex-lifecycle-projection-diff";
import { buildCodexTurnOccurrenceKey } from "../../shared/codex-turn-identity";
import { parseThreadStatus } from "./CodexThreadCatalogProjection";

const asCurrentView = (item: CodexConversationTurn["items"][number]): CodexItemView => ({
  ...item,
  normalizedKind: item.kind,
});

export const projectCodexConversationThreadSettings = (
  state: CodexCanonicalConversationState,
): CodexConversationThreadSettings | null => {
  const hydration = state.hydrationContext;
  const settings = state.latestThreadSettings ?? hydration?.latestThreadSettings;
  if (!settings) return null;
  return {
    model: settings.model ?? hydration?.latestModel ?? hydration?.model ?? "",
    modelProvider: "modelProvider" in settings ? settings.modelProvider : state.modelProvider,
    serviceTier: settings.serviceTier ?? null,
    reasoningEffort: settings.effort ?? null,
    summary: settings.summary ?? null,
    collaborationMode: settings.collaborationMode ?? null,
    personality: settings.personality ?? null,
  };
};

/** Projects canonical Thread-level metadata without introducing a second mutable record. */
export const projectCodexConversationMetadataSnapshot = (input: {
  readonly conversation: CodexConversationSnapshot;
  readonly state: CodexCanonicalConversationState;
}): CodexConversationSnapshot => {
  const settings = input.state.latestThreadSettings;
  const permissions = input.state.currentPermissions ?? settings ?? null;
  const status = parseThreadStatus(input.state.threadRuntimeStatus);
  const projectedSettings = projectCodexConversationThreadSettings(input.state);
  return {
    ...input.conversation,
    threadName: input.state.title?.trim() || input.conversation.threadName,
    cwd: input.state.cwd,
    approvalPolicy: permissions?.approvalPolicy ?? input.conversation.approvalPolicy ?? null,
    approvalsReviewer:
      permissions?.approvalsReviewer ?? input.conversation.approvalsReviewer ?? null,
    sandbox: permissions?.sandboxPolicy ?? input.conversation.sandbox ?? null,
    latestCollaborationMode: input.state.latestCollaborationMode,
    latestThreadSettings: projectedSettings,
    latestTokenUsageInfo: input.state.latestTokenUsageInfo ?? null,
    threadGoal: input.state.threadGoal ?? null,
    completedThreadGoal: input.state.completedThreadGoal ?? null,
    threadGoalResumeConfirmation: input.state.threadGoalResumeConfirmation ?? null,
    statusType: status.statusType,
    statusActiveFlags: status.statusActiveFlags,
    threadRuntimeStatus: status.threadRuntimeStatus,
  };
};

export const projectCodexConversationTurn = (input: {
  readonly threadId: string;
  readonly turnIndex: number;
  readonly beforeTurn: CodexCanonicalTurnState | null;
  readonly afterTurn: CodexCanonicalTurnState;
  readonly current: CodexConversationTurn | null;
  readonly observedAtMs: number;
}): CodexConversationTurn => {
  const turnId = input.afterTurn.turnId;
  const projection = applyCodexLifecycleProjectionDiff({
    threadId: input.threadId,
    turnKey: buildCodexTurnOccurrenceKey(turnId, input.turnIndex, input.afterTurn.entityKey),
    beforeTurn: input.beforeTurn,
    afterTurn: input.afterTurn,
    currentViews: input.current?.items.map(asCurrentView) ?? [],
    currentTranscript: input.current?.items ?? [],
    observedAtMs: input.observedAtMs,
    isBackgroundSubagentsEnabled: true,
    preserveExistingUpdatedAt: true,
  });

  const result: CodexConversationTurn = {
    ...input.current,
    threadId: input.threadId,
    turnId,
    ...(input.afterTurn.entityKey === undefined ? {} : { entityKey: input.afterTurn.entityKey }),
    status: input.afterTurn.status,
    errorMessage: input.afterTurn.error?.message ?? undefined,
    ...(input.afterTurn.diff === null ? { diff: undefined } : { diff: input.afterTurn.diff }),
    itemIds:
      turnId === null
        ? [...new Set(projection.transcript.map((entry) => entry.itemId))]
        : [...projection.itemIds],
    turnStartedAtMs: input.afterTurn.turnStartedAtMs,
    firstTurnWorkItemStartedAtMs: input.afterTurn.firstTurnWorkItemStartedAtMs,
    finalAssistantStartedAtMs: input.afterTurn.finalAssistantStartedAtMs,
    startedAt: input.afterTurn.turnStartedAtMs,
    completedAt: input.afterTurn.completedAtMs ?? null,
    durationMs: input.afterTurn.durationMs,
    commandExecutionStartedAtMsById:
      input.afterTurn.commandExecutionStartedAtMsById === undefined
        ? undefined
        : { ...input.afterTurn.commandExecutionStartedAtMsById },
    interruptedCommandExecutionItemIds:
      input.afterTurn.interruptedCommandExecutionItemIds === undefined
        ? undefined
        : [...input.afterTurn.interruptedCommandExecutionItemIds],
    hookRuns: input.afterTurn.hookRuns === undefined ? undefined : [...input.afterTurn.hookRuns],
    safetyBuffering:
      input.afterTurn.safetyBuffering === undefined
        ? undefined
        : {
            ...input.afterTurn.safetyBuffering,
            useCases: [...input.afterTurn.safetyBuffering.useCases],
            reasons: [...input.afterTurn.safetyBuffering.reasons],
          },
    items: projection.transcript.map((entry) => ({ ...entry })),
  };
  // Clear absent optional fields, including values retained from the previous Turn view.
  return Object.fromEntries(
    Object.entries(result).filter(([, value]) => value !== undefined),
  ) as CodexConversationTurn;
};

/**
 * Pure canonical-to-application projection. The aggregate owns the resulting snapshot;
 * runtimes never need a mutable application facade to apply history or delta changes.
 */
export const projectCodexConversationSnapshot = (input: {
  readonly conversation: CodexConversationSnapshot;
  readonly before: CodexCanonicalConversationState | null;
  readonly after: CodexCanonicalConversationState;
  readonly observedAtMs: number;
}): CodexConversationSnapshot => {
  const conversation = projectCodexConversationMetadataSnapshot({
    conversation: input.conversation,
    state: input.after,
  });
  return {
    ...conversation,
    canonicalState: input.after,
    canonicalRequests: [...input.after.requests],
    hasUnreadTurn: input.after.hasUnreadTurn,
    turns: residentConversationTurns(input.after).map((afterTurn, turnIndex) => {
      const turnId = afterTurn.turnId;
      const beforeAtIndex = residentConversationTurns(input.before)[turnIndex] ?? null;
      const beforeTurn =
        beforeAtIndex?.turnId === turnId
          ? beforeAtIndex
          : (residentConversationTurns(input.before).find((turn) => turn.turnId === turnId) ??
            null);
      const currentAtIndex = conversation.turns[turnIndex] ?? null;
      const entityKey = afterTurn.entityKey;
      const current =
        (entityKey !== undefined && currentAtIndex?.entityKey === entityKey) ||
        currentAtIndex?.turnId === turnId
          ? currentAtIndex
          : (conversation.turns.find(
              (turn) =>
                (entityKey !== undefined && turn.entityKey === entityKey) || turn.turnId === turnId,
            ) ?? null);
      if (beforeTurn === afterTurn && current) return current;
      return projectCodexConversationTurn({
        threadId: conversation.threadId,
        turnIndex,
        beforeTurn,
        afterTurn,
        current,
        observedAtMs: input.observedAtMs,
      });
    }),
  };
};
