import { useMemo } from "react";
import type { CodexConversationSnapshot, CodexConversationTurn } from "../../../shared/types";
import { areStructurallyEqual } from "../../../shared/structural-equality";
import { useCodexConversationValue } from "./local-conversation-store";
import { useCodexConversationTranscriptStructure } from "./normalized-transcript-hooks";
import { selectNormalizedConversationTurnEntries } from "./normalized-transcript-selectors";
import {
  hasRecoverableCanonicalTurnItems,
  type NormalizedConversationTurnEntry,
} from "./selectors";
import type { ThreadBodyConversationPresentation } from "./projection/build-thread-body-model";
import type {
  CodexTranscriptReadOwner,
  CodexTranscriptStructure,
} from "./normalized-transcript-read-owner";

const EMPTY_TURNS: CodexConversationTurn[] = [];
const EMPTY_ITEMS: CodexConversationTurn["items"] = [];
const EMPTY_ITEM_IDS: string[] = [];
const EMPTY_REQUESTS: CodexConversationSnapshot["requests"] = [];
const EMPTY_CANONICAL_REQUESTS: NonNullable<CodexConversationSnapshot["canonicalRequests"]> = [];
const EMPTY_ENTRIES: readonly NormalizedConversationTurnEntry[] = [];

export interface ConversationLatestTurnPreview {
  readonly owner: CodexTranscriptReadOwner;
  readonly entry: NormalizedConversationTurnEntry | null;
}

type BodyMetadata = Pick<
  CodexConversationSnapshot,
  | "threadId"
  | "projectId"
  | "resumeState"
  | "archived"
  | "statusType"
  | "requests"
  | "canonicalRequests"
> & {
  readonly paginated: boolean;
};

function selectBodyMetadata(conversation: CodexConversationSnapshot | null): BodyMetadata | null {
  if (!conversation) return null;
  return {
    threadId: conversation.threadId,
    projectId: conversation.projectId,
    resumeState: conversation.resumeState,
    archived: conversation.archived,
    statusType: conversation.statusType,
    requests: conversation.requests,
    canonicalRequests: conversation.canonicalRequests,
    paginated: conversation.canonicalState?.historyMode === "paginated",
  };
}

function equalBodyMetadata(left: BodyMetadata | null, right: BodyMetadata | null): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  return (
    left.threadId === right.threadId &&
    left.projectId === right.projectId &&
    left.resumeState === right.resumeState &&
    left.archived === right.archived &&
    left.statusType === right.statusType &&
    left.paginated === right.paginated &&
    areStructurallyEqual(left.requests, right.requests) &&
    areStructurallyEqual(left.canonicalRequests, right.canonicalRequests)
  );
}

/** These facades carry row metadata. An explicit item read resolves against the current owner. */
export function buildConversationPresentationTurns(
  owner: CodexTranscriptReadOwner,
  structure: CodexTranscriptStructure,
): CodexConversationTurn[] {
  return structure.turns.map(({ entityKey, value }) => {
    const details = value.details;
    return {
      threadId: owner.key.threadId,
      entityKey,
      turnId: details.turnId,
      clientUserMessageId: details.params.clientUserMessageId ?? null,
      status: details.status,
      errorMessage: details.error?.message,
      diff: details.diff ?? undefined,
      turnStartedAtMs: details.turnStartedAtMs,
      startedAt: details.turnStartedAtMs,
      completedAt: details.completedAtMs,
      durationMs: details.durationMs,
      firstTurnWorkItemStartedAtMs: details.firstTurnWorkItemStartedAtMs,
      finalAssistantStartedAtMs: details.finalAssistantStartedAtMs,
      assistantMessageStartedAtMsById: details.assistantMessageStartedAtMsById,
      commandExecutionStartedAtMsById: details.commandExecutionStartedAtMsById,
      interruptedCommandExecutionItemIds: details.interruptedCommandExecutionItemIds
        ? [...details.interruptedCommandExecutionItemIds]
        : undefined,
      hookRuns: details.hookRuns ? [...details.hookRuns] : undefined,
      safetyBuffering: details.safetyBuffering
        ? {
            ...details.safetyBuffering,
            reasons: [...details.safetyBuffering.reasons],
            useCases: [...details.safetyBuffering.useCases],
          }
        : undefined,
      get items() {
        return owner.readTurn(entityKey)?.items ?? EMPTY_ITEMS;
      },
      get itemIds() {
        return owner.readTurn(entityKey)?.itemIds ?? EMPTY_ITEM_IDS;
      },
    };
  });
}

/** Parent chrome observes topology and semantic metadata; addressed text belongs to its leaf. */
export function useConversationBodyPresentation(
  conversationId: string | null,
  parentTurns: readonly CodexConversationTurn[] = EMPTY_TURNS,
) {
  const { owner, structure } = useCodexConversationTranscriptStructure(conversationId);
  const metadata = useCodexConversationValue(conversationId, selectBodyMetadata, equalBodyMetadata);
  const fallbackConversation = useCodexConversationValue(conversationId, (conversation) =>
    !owner || parentTurns.length > 0 ? conversation : null,
  );
  const fallbackTurns = useCodexConversationValue(conversationId, (conversation) =>
    owner ? EMPTY_TURNS : (conversation?.turns ?? EMPTY_TURNS),
  );
  const turns = useMemo(
    () =>
      owner && structure ? buildConversationPresentationTurns(owner, structure) : fallbackTurns,
    [fallbackTurns, owner, structure],
  );
  const requests = metadata?.requests ?? EMPTY_REQUESTS;
  const canonicalRequests = metadata?.canonicalRequests ?? EMPTY_CANONICAL_REQUESTS;
  const entries = useMemo(
    () =>
      owner && structure && metadata
        ? selectNormalizedConversationTurnEntries({
            owner,
            structure,
            conversation: { ...metadata, turns, requests, canonicalRequests },
          })
        : EMPTY_ENTRIES,
    [canonicalRequests, metadata, owner, requests, structure, turns],
  );
  const preview = useMemo<ConversationLatestTurnPreview | null>(
    () => (owner ? { owner, entry: entries.at(-1) ?? null } : null),
    [entries, owner],
  );
  const presentation = useMemo<ThreadBodyConversationPresentation | null>(() => {
    if (!owner || !structure || !metadata || parentTurns.length > 0) return null;
    return {
      threadId: metadata.threadId,
      resumeState: metadata.resumeState,
      archived: metadata.archived,
      statusType: metadata.statusType,
      visibleEntries: entries.map(({ turnId, turnStatus }) => ({ turnId, status: turnStatus })),
      canReadBoundedHistory:
        metadata.paginated &&
        structure.timeline !== null &&
        structure.turns.some(
          ({ value }) =>
            value.itemSlots.entries.length > 0 ||
            value.details.params.input.length > 0 ||
            Boolean(value.details.diff?.trim()) ||
            (value.details.itemsPagination?.evicted === true &&
              hasRecoverableCanonicalTurnItems(value.details)),
        ),
      hasRealtimeHistory:
        structure.itemTimeline?.entries.some(
          (entry) =>
            entry.type === "realtime" &&
            (entry.item.type === "transcriptSegment" ||
              entry.item.type === "bemItemPromoted" ||
              entry.item.type === "realtimeSessionClosed"),
        ) === true,
    };
  }, [entries, metadata, owner, parentTurns.length, structure]);
  return {
    owner,
    structure,
    turns,
    requests,
    canonicalRequests,
    presentation,
    fallbackConversation,
    preview,
  };
}
