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
  const hydration = state.sidecar.hydrationContext;
  const settings = state.sidecar.latestThreadSettings ?? hydration?.latestThreadSettings;
  if (!settings) return null;
  return {
    model: settings.model ?? hydration?.latestModel ?? hydration?.model ?? "",
    modelProvider:
      "modelProvider" in settings ? settings.modelProvider : state.protocol.modelProvider,
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
  const settings = input.state.sidecar.latestThreadSettings;
  const hydration = input.state.sidecar.hydrationContext;
  const permissions = settings ?? hydration?.currentPermissions ?? null;
  const status = parseThreadStatus(input.state.protocol.status);
  const projectedSettings = projectCodexConversationThreadSettings(input.state);
  return {
    ...input.conversation,
    threadName: input.state.protocol.name?.trim() || input.conversation.threadName,
    threadPreview: input.state.protocol.preview,
    cwd: input.state.protocol.cwd,
    approvalPolicy: permissions?.approvalPolicy ?? input.conversation.approvalPolicy ?? null,
    approvalsReviewer:
      permissions?.approvalsReviewer ?? input.conversation.approvalsReviewer ?? null,
    sandbox: permissions?.sandboxPolicy ?? input.conversation.sandbox ?? null,
    latestCollaborationMode: projectedSettings?.collaborationMode ?? undefined,
    latestThreadSettings: projectedSettings,
    latestTokenUsageInfo: input.state.sidecar.latestTokenUsageInfo ?? null,
    threadGoal: input.state.sidecar.threadGoal ?? null,
    completedThreadGoal: input.state.sidecar.completedThreadGoal ?? null,
    threadGoalResumeConfirmation: input.state.sidecar.threadGoalResumeConfirmation ?? null,
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
  const turnId = input.afterTurn.protocol.id;
  const projection = applyCodexLifecycleProjectionDiff({
    threadId: input.threadId,
    turnKey: buildCodexTurnOccurrenceKey(turnId, input.turnIndex),
    beforeTurn: input.beforeTurn,
    afterTurn: input.afterTurn,
    currentViews: input.current?.items.map(asCurrentView) ?? [],
    currentTranscript: input.current?.items ?? [],
    observedAtMs: input.observedAtMs,
    isBackgroundSubagentsEnabled: true,
    preserveExistingUpdatedAt: true,
  });

  return {
    ...input.current,
    threadId: input.threadId,
    turnId,
    status: input.afterTurn.protocol.status,
    errorMessage: input.afterTurn.protocol.error?.message ?? undefined,
    ...(input.afterTurn.sidecar.diff === null
      ? { diff: undefined }
      : { diff: input.afterTurn.sidecar.diff }),
    itemIds:
      turnId === null
        ? [...new Set(projection.transcript.map((entry) => entry.itemId))]
        : [...projection.itemIds],
    turnStartedAtMs: input.afterTurn.sidecar.turnStartedAtMs,
    firstTurnWorkItemStartedAtMs: input.afterTurn.sidecar.firstTurnWorkItemStartedAtMs,
    finalAssistantStartedAtMs: input.afterTurn.sidecar.finalAssistantStartedAtMs,
    startedAt: input.afterTurn.sidecar.turnStartedAtMs,
    completedAt: input.afterTurn.sidecar.completedAtMs ?? null,
    durationMs: input.afterTurn.protocol.durationMs,
    commandExecutionStartedAtMsById:
      input.afterTurn.sidecar.commandExecutionStartedAtMsById === undefined
        ? undefined
        : { ...input.afterTurn.sidecar.commandExecutionStartedAtMsById },
    interruptedCommandExecutionItemIds:
      input.afterTurn.sidecar.interruptedCommandExecutionItemIds === undefined
        ? undefined
        : [...input.afterTurn.sidecar.interruptedCommandExecutionItemIds],
    hookRuns:
      input.afterTurn.sidecar.hookRuns === undefined
        ? undefined
        : [...input.afterTurn.sidecar.hookRuns],
    safetyBuffering:
      input.afterTurn.sidecar.safetyBuffering === undefined
        ? undefined
        : {
            ...input.afterTurn.sidecar.safetyBuffering,
            useCases: [...input.afterTurn.sidecar.safetyBuffering.useCases],
            reasons: [...input.afterTurn.sidecar.safetyBuffering.reasons],
          },
    items: projection.transcript.map((entry) => ({ ...entry })),
  };
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
    hasUnreadTurn: input.after.sidecar.hasUnreadTurn,
    turns: input.after.turns.map((afterTurn, turnIndex) => {
      const turnId = afterTurn.protocol.id;
      const beforeAtIndex = input.before?.turns[turnIndex] ?? null;
      const beforeTurn =
        beforeAtIndex?.protocol.id === turnId
          ? beforeAtIndex
          : (input.before?.turns.find((turn) => turn.protocol.id === turnId) ?? null);
      const currentAtIndex = conversation.turns[turnIndex] ?? null;
      const current =
        currentAtIndex?.turnId === turnId
          ? currentAtIndex
          : (conversation.turns.find((turn) => turn.turnId === turnId) ?? null);
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
