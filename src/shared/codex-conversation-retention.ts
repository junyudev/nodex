import { residentConversationTurns } from "./codex-conversation-state/codex-turn-mutation";
import type { CodexCanonicalConversationState } from "./codex-conversation-state/codex-conversation-state";
import { selectPrimaryConversationRequest } from "./codex-conversation-request";
import type {
  CodexConversationSnapshot,
  CodexThreadStatusType,
  CodexThreadActiveFlag,
} from "./types";

export function isEphemeralSideConversation(conversation: CodexConversationSnapshot): boolean {
  return conversation.ephemeral === true && conversation.source?.sideConversation === true;
}

/** Keep content that is executing or has not yet acquired a durable server identity. */
export function shouldKeepCodexConversationLoaded(
  conversation: CodexConversationSnapshot,
): boolean {
  const canonical = conversation.canonicalState;
  const complete =
    conversation.turnPagination?.hasLoadedOldest !== false &&
    !conversation.historyRows?.some((row) => row.kind === "gap");
  if (canonical && !canonical.rolloutPath && complete && conversation.turns.length === 0)
    return true;
  if (conversation.statusType === "active") return true;
  if (
    conversation.turns.at(-1)?.status === "inProgress" &&
    (selectPrimaryConversationRequest(conversation) === null ||
      isEphemeralSideConversation(conversation))
  )
    return true;
  return (
    residentConversationTurns(canonical).some((turn) =>
      turn.items.some(
        (item) => item.type === "steeringUserMessage" && item.serverUserMessageId == null,
      ),
    ) ?? false
  );
}

/** Unsubscription keeps pending questions and ephemeral content available for the next resume. */
export function projectCodexConversationAfterUnsubscribe(
  conversation: CodexConversationSnapshot,
  retainHistory: boolean,
): CodexConversationSnapshot {
  if (conversation.resumeState === "needs_resume" && !isEphemeralSideConversation(conversation))
    return conversation;
  const request = selectPrimaryConversationRequest(conversation);
  let statusType: CodexThreadStatusType = "idle";
  let statusActiveFlags: CodexThreadActiveFlag[] = [];
  if (isEphemeralSideConversation(conversation)) statusType = "notLoaded";
  else if (request && request.type !== "implementPlan") {
    statusType = "active";
    statusActiveFlags = [
      request.type === "userInput" ||
      request.type === "optionPicker" ||
      request.type === "setupCodexStep"
        ? "waitingOnUserInput"
        : "waitingOnApproval",
    ];
  }
  const canonical = conversation.canonicalState;
  const keep = retainHistory || isEphemeralSideConversation(conversation);
  return {
    ...conversation,
    resumeState: "needs_resume",
    statusType,
    statusActiveFlags,
    threadRuntimeStatus:
      statusType === "active"
        ? { type: "active", activeFlags: statusActiveFlags }
        : { type: statusType },
    canonicalState: canonical
      ? {
          ...canonical,
          resumeState: "needs_resume",
          threadRuntimeStatus:
            statusType === "active"
              ? { type: "active", activeFlags: statusActiveFlags }
              : { type: statusType },
          ...(keep ? {} : releasedCanonicalHistory(canonical)),
        }
      : canonical,
    ...(keep ? {} : historyReleaseFields(conversation)),
  };
}

function historyReleaseFields(conversation: CodexConversationSnapshot) {
  return {
    turns: [],
    turnPagination: {
      olderCursor: null,
      oldestLoadedTurnId: null,
      isLoadingOlder: false,
      hasLoadedOldest: false,
      backwardsCursor: null,
      loadedTurnCount: 0,
      itemsView: "full" as const,
    },
    turnItemsPaginationById: {},
    historyRows: [],
    historyTopologyGeneration: (conversation.historyTopologyGeneration ?? 0) + 1,
    historyMutationRevision: (conversation.historyMutationRevision ?? 0) + 1,
  };
}

/** Passive history can be released only outside an explicit history read or resume. */
export function canReleasePassiveCodexHistory(conversation: CodexConversationSnapshot): boolean {
  if (conversation.resumeState === "resuming") return false;
  const pagination = conversation.turnPagination;
  if (
    conversation.resumeState === "needs_resume" &&
    (pagination?.hasLoadedOldest !== false ||
      pagination.olderCursor != null ||
      pagination.oldestLoadedTurnId != null)
  )
    return false;
  if (
    pagination?.isLoadingOlder ||
    isEphemeralSideConversation(conversation) ||
    conversation.requests.length > 0 ||
    shouldKeepCodexConversationLoaded(conversation)
  )
    return false;
  return conversation.turns.some((turn) =>
    turn.items.some((item) => item.type !== "forkedFromConversation"),
  );
}

export function projectCodexConversationWithoutHistory(
  conversation: CodexConversationSnapshot,
): CodexConversationSnapshot {
  return {
    ...conversation,
    ...historyReleaseFields(conversation),
    resumeState: "needs_resume",
    canonicalState: conversation.canonicalState
      ? {
          ...conversation.canonicalState,
          resumeState: "needs_resume",
          ...releasedCanonicalHistory(conversation.canonicalState),
        }
      : conversation.canonicalState,
  };
}

/** Releasing fetched history retains its canonical mode and advances its generation. */
function releasedCanonicalHistory(
  state: CodexCanonicalConversationState,
): Pick<CodexCanonicalConversationState, "turns" | "turnHistory"> {
  if (!state.turnHistory) return { turns: [] };
  const generation = state.turnHistory.history.generation + 1;
  const id = `tail:${generation}`;
  return {
    turns: [],
    turnHistory: {
      kind: "canonical",
      history: {
        generation,
        isComplete: false,
        entitiesByKey: {},
        islands: [
          {
            id,
            entries: [],
            olderBoundary: { status: "exhausted", boundaryId: `${id}:older` },
            newerBoundary: { status: "exhausted", boundaryId: `${id}:newer` },
          },
        ],
      },
    },
  };
}
