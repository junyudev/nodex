import { residentConversationTurns } from "../../shared/codex-conversation-state/codex-turn-mutation";
import type { RequestId } from "@nodex/codex-app-server-protocol";
import type {
  CodexConversationCapabilityFlags,
  CodexConversationItem,
  CodexConversationSnapshot,
  CodexConversationTurn,
  CodexTurnSummary,
} from "../../shared/types";
import { buildCodexTurnOccurrenceKey } from "../../shared/codex-turn-identity";
import type {
  CodexCanonicalConversationState,
  CodexCanonicalTurnState,
} from "../../shared/codex-conversation-state/codex-conversation-state";
import {
  type CodexServerRequestLifecycleResult,
  type CodexServerRequestRawLifecycleResult,
} from "../../shared/codex-conversation-state/codex-server-request-lifecycle";
import { applyCodexLifecycleProjectionDiff } from "../../shared/codex-conversation-state/codex-lifecycle-projection-diff";
import { projectTranscriptEntryToItemView } from "../codex/codex-transcript-projection";

const sameRequestId = (left: RequestId, right: RequestId): boolean =>
  typeof left === typeof right && left === right;

export const buildCodexCanonicalTurnSummary = (
  threadId: string,
  turn: Omit<CodexCanonicalTurnState, "items" | "params">,
  itemIds: readonly string[],
): CodexTurnSummary => ({
  threadId,
  turnId: turn.turnId,
  ...(turn.entityKey === undefined ? {} : { entityKey: turn.entityKey }),
  status: turn.status,
  ...(turn.error?.message === undefined ? {} : { errorMessage: turn.error.message }),
  ...(turn.diff === null ? {} : { diff: turn.diff }),
  itemIds: [...itemIds],
  turnStartedAtMs: turn.turnStartedAtMs,
  ...(turn.firstTurnWorkItemStartedAtMs === undefined
    ? {}
    : { firstTurnWorkItemStartedAtMs: turn.firstTurnWorkItemStartedAtMs }),
  finalAssistantStartedAtMs: turn.finalAssistantStartedAtMs,
  startedAt: turn.turnStartedAtMs,
  completedAt: turn.completedAtMs ?? null,
  durationMs: turn.durationMs,
  ...(turn.commandExecutionStartedAtMsById === undefined
    ? {}
    : { commandExecutionStartedAtMsById: { ...turn.commandExecutionStartedAtMsById } }),
  ...(turn.interruptedCommandExecutionItemIds === undefined
    ? {}
    : {
        interruptedCommandExecutionItemIds: [...turn.interruptedCommandExecutionItemIds],
      }),
  ...(turn.hookRuns === undefined ? {} : { hookRuns: [...turn.hookRuns] }),
  ...(turn.safetyBuffering === undefined
    ? {}
    : {
        safetyBuffering: {
          useCases: [...turn.safetyBuffering.useCases],
          reasons: [...turn.safetyBuffering.reasons],
          showBufferingUi: turn.safetyBuffering.showBufferingUi,
          fasterModel: turn.safetyBuffering.fasterModel,
        },
      }),
});

const projectCapabilityFlags = (
  conversation: CodexConversationSnapshot,
  requests: CodexConversationSnapshot["requests"],
): CodexConversationCapabilityFlags => {
  const latestTurn = conversation.turns.at(-1) ?? null;
  const latestTurnHasUserMessage =
    latestTurn !== null &&
    latestTurn.items.some(
      (item) => item.semanticKind === "userMessage" || item.kind === "userMessage",
    );
  const actionable = !conversation.archived && conversation.statusType !== "systemError";
  return {
    ...conversation.capabilityFlags,
    canEditLastUserTurn: Boolean(
      actionable &&
      latestTurn &&
      latestTurn.status !== "inProgress" &&
      latestTurnHasUserMessage &&
      requests.every((request) => request.turnId !== latestTurn.turnId),
    ),
  };
};

const projectTurn = (input: {
  readonly before: CodexCanonicalConversationState;
  readonly after: CodexCanonicalConversationState;
  readonly conversation: CodexConversationSnapshot;
  readonly observedAtMs: number;
  readonly turnIndex: number;
}): CodexConversationTurn | null => {
  const afterTurn = residentConversationTurns(input.after)[input.turnIndex];
  if (!afterTurn) return null;
  const existing = input.conversation.turns[input.turnIndex] ?? null;
  const currentTranscript = existing?.items ?? [];
  const projection = applyCodexLifecycleProjectionDiff({
    threadId: input.conversation.threadId,
    turnKey: buildCodexTurnOccurrenceKey(afterTurn.turnId, input.turnIndex, afterTurn.entityKey),
    beforeTurn: residentConversationTurns(input.before)[input.turnIndex] ?? null,
    afterTurn,
    currentViews: currentTranscript.map(projectTranscriptEntryToItemView),
    currentTranscript,
    observedAtMs: input.observedAtMs,
    preserveExistingUpdatedAt: true,
    isBackgroundSubagentsEnabled: true,
  });
  const summary = buildCodexCanonicalTurnSummary(
    input.conversation.threadId,
    afterTurn,
    projection.itemIds,
  );
  return {
    ...(existing ?? summary),
    ...summary,
    items: projection.transcript.map((item): CodexConversationItem => ({ ...item })),
  };
};

/**
 * Projects one committed canonical request lifecycle into the dormant renderer replica.
 * The canonical document remains the authority; this helper owns no state or lifecycle.
 */
export const projectCodexConversationServerRequestLifecycle = (input: {
  readonly before: CodexCanonicalConversationState;
  readonly conversation: CodexConversationSnapshot;
  readonly lifecycle: CodexServerRequestLifecycleResult;
  readonly observedAtMs: number;
}): CodexConversationSnapshot => {
  if (!input.lifecycle.stateChanged) return input.conversation;
  const selectedRequestIds = input.lifecycle.selectedRequestIds;
  const requests = input.conversation.requests.filter((request) =>
    selectedRequestIds.every((requestId) => !sameRequestId(request.requestId, requestId)),
  );
  const turns = [...input.conversation.turns];
  for (const mutation of input.lifecycle.turnMutations) {
    const projected = projectTurn({
      before: input.before,
      after: input.lifecycle.state,
      conversation: input.conversation,
      observedAtMs: input.observedAtMs,
      turnIndex: mutation.turnIndex,
    });
    if (projected) turns[mutation.turnIndex] = projected;
  }
  return {
    ...input.conversation,
    canonicalState: input.lifecycle.state,
    canonicalRequests: [...input.lifecycle.state.requests],
    hasUnreadTurn: input.lifecycle.state.hasUnreadTurn,
    requests,
    turns,
    capabilityFlags: projectCapabilityFlags(input.conversation, requests),
  };
};

export const projectCodexConversationRawServerRequestLifecycle = (input: {
  readonly conversation: CodexConversationSnapshot;
  readonly lifecycle: CodexServerRequestRawLifecycleResult;
}): CodexConversationSnapshot => {
  if (!input.lifecycle.stateChanged) return input.conversation;
  const requests = input.conversation.requests.filter((request) =>
    input.lifecycle.selectedRequestIds.every(
      (requestId) => !sameRequestId(request.requestId, requestId),
    ),
  );
  return {
    ...input.conversation,
    canonicalRequests: [...input.lifecycle.state.requests],
    hasUnreadTurn: input.lifecycle.state.hasUnreadTurn,
    requests,
    capabilityFlags: projectCapabilityFlags(input.conversation, requests),
  };
};

export const projectCodexConversationPlanImplementationCompleted = (input: {
  readonly conversation: CodexConversationSnapshot;
  readonly state: CodexCanonicalConversationState;
  readonly turnId: string;
}): CodexConversationSnapshot => {
  const requests = input.conversation.requests;
  return {
    ...input.conversation,
    canonicalState: input.state,
    canonicalRequests: [...input.state.requests],
    requests,
    turns: input.conversation.turns.map((turn) =>
      turn.turnId !== input.turnId
        ? turn
        : {
            ...turn,
            items: turn.items.map((item) =>
              item.type !== "planImplementation" || item.status === "completed"
                ? item
                : {
                    ...item,
                    status: "completed",
                    rawItem:
                      typeof item.rawItem === "object" && item.rawItem !== null
                        ? { ...item.rawItem, isCompleted: true }
                        : item.rawItem,
                  },
            ),
          },
    ),
    capabilityFlags: projectCapabilityFlags(input.conversation, requests),
  };
};
