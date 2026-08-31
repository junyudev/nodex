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
  turn: CodexCanonicalTurnState,
  itemIds: readonly string[],
): CodexTurnSummary => ({
  threadId,
  turnId: turn.protocol.id,
  status: turn.protocol.status,
  ...(turn.protocol.error?.message === undefined
    ? {}
    : { errorMessage: turn.protocol.error.message }),
  ...(turn.sidecar.diff === null ? {} : { diff: turn.sidecar.diff }),
  itemIds: [...itemIds],
  turnStartedAtMs: turn.sidecar.turnStartedAtMs,
  ...(turn.sidecar.firstTurnWorkItemStartedAtMs === undefined
    ? {}
    : { firstTurnWorkItemStartedAtMs: turn.sidecar.firstTurnWorkItemStartedAtMs }),
  finalAssistantStartedAtMs: turn.sidecar.finalAssistantStartedAtMs,
  startedAt: turn.sidecar.turnStartedAtMs,
  completedAt: turn.sidecar.completedAtMs ?? null,
  durationMs: turn.protocol.durationMs,
  ...(turn.sidecar.commandExecutionStartedAtMsById === undefined
    ? {}
    : { commandExecutionStartedAtMsById: { ...turn.sidecar.commandExecutionStartedAtMsById } }),
  ...(turn.sidecar.interruptedCommandExecutionItemIds === undefined
    ? {}
    : {
        interruptedCommandExecutionItemIds: [...turn.sidecar.interruptedCommandExecutionItemIds],
      }),
  ...(turn.sidecar.hookRuns === undefined ? {} : { hookRuns: [...turn.sidecar.hookRuns] }),
  ...(turn.sidecar.safetyBuffering === undefined
    ? {}
    : {
        safetyBuffering: {
          useCases: [...turn.sidecar.safetyBuffering.useCases],
          reasons: [...turn.sidecar.safetyBuffering.reasons],
          showBufferingUi: turn.sidecar.safetyBuffering.showBufferingUi,
          fasterModel: turn.sidecar.safetyBuffering.fasterModel,
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
  const afterTurn = input.after.turns[input.turnIndex];
  if (!afterTurn) return null;
  const existing = input.conversation.turns[input.turnIndex] ?? null;
  const currentTranscript = existing?.items ?? [];
  const projection = applyCodexLifecycleProjectionDiff({
    threadId: input.conversation.threadId,
    turnKey: buildCodexTurnOccurrenceKey(afterTurn.protocol.id, input.turnIndex),
    beforeTurn: input.before.turns[input.turnIndex] ?? null,
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
    hasUnreadTurn: input.lifecycle.state.sidecar.hasUnreadTurn,
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
