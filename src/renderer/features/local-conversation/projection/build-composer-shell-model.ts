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
  ThreadComposerShellBackgroundAgentRowModel,
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
  /** Complete ordered descendants from the scoped Subagent Directory, when available. */
  backgroundAgentRows?: readonly ThreadComposerShellBackgroundAgentRowModel[];
  statusType: CodexThreadStatusType | null;
  statusActiveFlags: CodexThreadActiveFlag[];
  knownConversationsById: Record<string, CodexConversationSnapshot>;
  primaryRequest?: CodexConversationLiveRequest | null;
}

interface LegacyBuildComposerShellModelInput {
  conversation: CodexConversationSnapshot;
  childMemberships?: CodexConversationChildMembership[];
  backgroundAgentRows?: readonly ThreadComposerShellBackgroundAgentRowModel[];
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
      backgroundAgentRows: input.backgroundAgentRows,
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
  rows: readonly ThreadComposerShellBackgroundAgentRowModel[],
  childMemberships: readonly CodexConversationChildMembership[],
  knownConversationsById: Record<string, CodexConversationSnapshot>,
): ThreadComposerShellPendingRequestModel | null {
  const membershipsById = new Map(
    childMemberships.map((membership) => [membership.threadId, membership]),
  );
  // Directory order decides precedence; snapshot residency must not reorder agents.
  for (const row of rows) {
    const childConversation = knownConversationsById[row.conversationId];
    const pending = membershipsById.get(row.conversationId)?.pendingRequest;
    const request =
      pending !== undefined
        ? (pending?.request ?? null)
        : selectPrimaryBackgroundConversationRequest(childConversation ?? null);
    if (!request) {
      continue;
    }

    return {
      request,
      conversationId: row.conversationId,
      surface: "backgroundThread",
      actorName:
        row.displayName.trim() && row.displayName !== row.conversationId
          ? row.displayName
          : "Agent",
      requestItem:
        pending !== undefined
          ? (pending?.requestItem ?? null)
          : resolveRequestItem(childConversation?.turns ?? [], request),
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
      turns: normalized.turns,
      canonicalRequests: normalized.canonicalRequests,
      requests: normalized.requests,
    });
  const backgroundAgentRows =
    normalized.backgroundAgentRows ??
    buildBackgroundSubagentRows({
      childMemberships: normalized.childMemberships,
      knownConversationsById: normalized.knownConversationsById,
      parentTurns: normalized.turns,
    });
  const backgroundRequest = resolveBackgroundRequest(
    backgroundAgentRows,
    normalized.childMemberships,
    normalized.knownConversationsById,
  );

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
    backgroundAgentRows: [...backgroundAgentRows],
    backgroundTerminalRows: normalized.backgroundTerminalRows,
    showRequestCards,
    showComposer: !showRequestCards,
    showApprovalMode,
  };
}
