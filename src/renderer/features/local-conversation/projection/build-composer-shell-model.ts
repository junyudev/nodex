import type {
  CodexBackgroundTerminalRow,
  CodexConversationChildMembership,
  CodexCanonicalServerRequest,
  CodexConversationLiveRequest,
  CodexConversationSnapshot,
  CodexConversationServerRequest,
  CodexConversationTurn,
  CodexPendingSteer,
  CodexQueuedFollowUp,
  CodexQueuedFollowUpProjection,
  CodexThreadActiveFlag,
  CodexThreadStatusType,
} from "../../../lib/types";
import type {
  ThreadComposerShellModel,
  ThreadComposerShellPendingRequestModel,
} from "../thread-stage-types";
import {
  buildComposerPendingSteerRows,
  buildComposerQueuedFollowUpRows,
} from "./build-composer-follow-up-lane-model";
import {
  selectPrimaryBackgroundConversationRequest,
  selectPrimaryConversationRequest,
} from "../conversation-request-helpers";
import { buildBackgroundSubagentRows } from "./background-subagent-row-model";

interface ExplicitBuildComposerShellModelInput {
  threadId: string | null;
  turns: CodexConversationTurn[];
  requests: CodexConversationServerRequest[];
  canonicalRequests?: CodexCanonicalServerRequest[];
  pendingSteers: CodexPendingSteer[];
  queuedFollowUps: CodexQueuedFollowUp[];
  queuedFollowUpProjection?: CodexQueuedFollowUpProjection;
  backgroundTerminalRows: CodexBackgroundTerminalRow[];
  childMemberships: CodexConversationChildMembership[];
  statusType: CodexThreadStatusType | null;
  statusActiveFlags: CodexThreadActiveFlag[];
  knownConversationsById: Record<string, CodexConversationSnapshot>;
  primaryRequest?: CodexConversationLiveRequest | null;
}

interface LegacyBuildComposerShellModelInput {
  conversation: CodexConversationSnapshot;
  childMemberships?: CodexConversationChildMembership[];
  knownConversationsById: Record<string, CodexConversationSnapshot>;
  primaryRequest?: CodexConversationLiveRequest | null;
}

export type BuildComposerShellModelInput =
  | ExplicitBuildComposerShellModelInput
  | LegacyBuildComposerShellModelInput;

function normalizeBuildComposerShellModelInput(
  input: BuildComposerShellModelInput,
): ExplicitBuildComposerShellModelInput {
  if ("conversation" in input) {
    return {
      threadId: input.conversation.threadId,
      turns: input.conversation.turns,
      requests: input.conversation.requests,
      canonicalRequests: input.conversation.canonicalRequests,
      pendingSteers: input.conversation.pendingSteers,
      queuedFollowUps: [...input.conversation.queuedFollowUps.entries],
      queuedFollowUpProjection: input.conversation.queuedFollowUps,
      backgroundTerminalRows: input.conversation.backgroundTerminalRows,
      childMemberships: input.childMemberships ?? [],
      statusType: input.conversation.statusType,
      statusActiveFlags: input.conversation.statusActiveFlags,
      knownConversationsById: input.knownConversationsById,
      primaryRequest: input.primaryRequest,
    };
  }

  return input;
}

function resolveRequestItem(
  turns: readonly CodexConversationTurn[],
  request: ThreadComposerShellPendingRequestModel["request"] | null,
) {
  if (!request) return null;
  const turn = turns.find((candidate) => candidate.turnId === request.turnId);
  if (!turn) return null;
  return turn.items.find((item) => item.itemId === request.itemId) ?? null;
}

function resolveBackgroundRequest(
  input: Pick<ExplicitBuildComposerShellModelInput, "childMemberships">,
  knownConversationsById: Record<string, CodexConversationSnapshot>,
): ThreadComposerShellPendingRequestModel | null {
  for (const membership of input.childMemberships) {
    const childConversation = knownConversationsById[membership.threadId];
    const request = selectPrimaryBackgroundConversationRequest(childConversation ?? null);
    if (!request) {
      continue;
    }

    return {
      request,
      conversationId: membership.threadId,
      surface: "backgroundThread",
      actorName: membership.actorName ?? null,
      requestItem: resolveRequestItem(childConversation?.turns ?? [], request),
    };
  }

  return null;
}

export function buildComposerShellModel(
  input: BuildComposerShellModelInput,
): ThreadComposerShellModel {
  const normalized = normalizeBuildComposerShellModelInput(input);
  const queuedFollowUpProjection = normalized.queuedFollowUpProjection ?? {
    status: "ready",
    ledgerRevision: 0,
    projectionRevision: 0,
    entries: normalized.queuedFollowUps,
    inFlightFollowUpId: null,
    editingFollowUpId: null,
    error: null,
  };

  if (!normalized.threadId) {
    return {
      activeRequest: null,
      backgroundRequest: null,
      pendingSteerRows: [],
      queuedFollowUpRows: [],
      backgroundAgentRows: [],
      backgroundTerminalRows: [],
      showRequestCards: false,
      showComposer: true,
      showApprovalMode: false,
    };
  }

  const activeRequest =
    normalized.primaryRequest ??
    selectPrimaryConversationRequest({
      threadId: normalized.threadId,
      projectId: null,
      source: null,
      threadName: null,
      threadPreview: "",
      cwd: null,
      statusType: normalized.statusType ?? "notLoaded",
      statusActiveFlags: normalized.statusActiveFlags,
      archived: false,
      createdAt: 0,
      updatedAt: 0,
      linkedAt: "",
      latestCollaborationMode: undefined,
      resumeState: "resumed",
      turns: normalized.turns,
      canonicalRequests: normalized.canonicalRequests,
      requests: normalized.requests,
      queuedFollowUps: {
        status: "ready",
        ledgerRevision: 0,
        projectionRevision: 0,
        entries: normalized.queuedFollowUps,
        inFlightFollowUpId: null,
        editingFollowUpId: null,
        error: null,
      },
      pendingSteers: normalized.pendingSteers,
      backgroundTerminalRows: normalized.backgroundTerminalRows,
      capabilityFlags: {
        canEditLastUserTurn: false,
        canForkFromTurn: false,
        canSearch: true,
        canCollapseTurns: true,
      },
    });
  const backgroundRequest = resolveBackgroundRequest(normalized, normalized.knownConversationsById);

  const showRequestCards = activeRequest !== null || backgroundRequest !== null;
  const showApprovalMode =
    activeRequest?.type === "approval" ||
    activeRequest?.type === "permissionRequest" ||
    backgroundRequest !== null;

  return {
    activeRequest: activeRequest
      ? {
          request: activeRequest,
          conversationId: normalized.threadId,
          surface: "activeThread",
          requestItem: resolveRequestItem(normalized.turns, activeRequest),
        }
      : null,
    backgroundRequest,
    pendingSteerRows: buildComposerPendingSteerRows(normalized.pendingSteers),
    queuedFollowUpRows: buildComposerQueuedFollowUpRows(queuedFollowUpProjection),
    queuedFollowUpStatus: queuedFollowUpProjection.status,
    queuedFollowUpLedgerRevision: queuedFollowUpProjection.ledgerRevision,
    queuedFollowUpError: queuedFollowUpProjection.error,
    hasInterruptedQueuedFollowUps: queuedFollowUpProjection.entries.some(
      (entry) => entry.pause?.kind === "interrupted",
    ),
    backgroundAgentRows: buildBackgroundSubagentRows({
      childMemberships: normalized.childMemberships,
      knownConversationsById: normalized.knownConversationsById,
      parentTurns: normalized.turns,
    }),
    backgroundTerminalRows: normalized.backgroundTerminalRows,
    showRequestCards,
    showComposer: !showRequestCards,
    showApprovalMode,
  };
}
