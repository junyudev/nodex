import {
  areConversationLiveRequestsEqual,
  selectConversationTurnRequestsByTurnId,
  selectTurnScopedConversationRequests,
  type CodexTurnScopedConversationRequest,
} from "./conversation-request-helpers";
import type { NormalizedConversationTurnEntry, VisibleConversationContext } from "./selectors";
import type {
  CodexTranscriptReadOwner,
  CodexTranscriptStructure,
} from "./normalized-transcript-read-owner";
import { buildCodexTurnOccurrenceKey } from "../../../shared/codex-turn-identity";
import {
  hasRecoverableCanonicalTurnItems,
  selectVisibleConversationTurnEntries,
  type ConversationTurnListEntry,
} from "./selectors";
import type { CodexConversationTurn } from "../../../shared/types";
import { readCanonicalClientUserMessageId } from "../conversation-launch/session-first-submission-owner";

interface EntryCache {
  readonly row: CodexTranscriptStructure["turns"][number];
  readonly entry: NormalizedConversationTurnEntry;
}
const entriesByRow = new WeakMap<
  CodexTranscriptStructure["turns"][number],
  WeakMap<CodexTranscriptReadOwner, EntryCache>
>();
const selectionsByStructure = new WeakMap<
  CodexTranscriptStructure,
  readonly NormalizedConversationTurnEntry[]
>();
const EMPTY_REQUESTS: CodexTurnScopedConversationRequest[] = [];
const EMPTY_ENTRIES: readonly NormalizedConversationTurnEntry[] = [];
const overlayTurns = new WeakMap<CodexConversationTurn, CodexConversationTurn[]>();

/** Launch presentation is separate from raw transcript authority until its client identity arrives. */
export function selectNormalizedConversationEntriesWithFirstSubmission(input: {
  readonly owner: CodexTranscriptReadOwner;
  readonly structure: CodexTranscriptStructure | null;
  readonly conversation: VisibleConversationContext | null;
  readonly firstSubmissionTurn?: CodexConversationTurn | null;
}): readonly ConversationTurnListEntry[] {
  const entries = input.structure
    ? selectNormalizedConversationTurnEntries({ ...input, structure: input.structure })
    : EMPTY_ENTRIES;
  const overlay = input.firstSubmissionTurn;
  if (!overlay) return entries;
  const clientId = readCanonicalClientUserMessageId(overlay);
  if (
    typeof clientId !== "string" ||
    input.structure?.turns.some((row) => row.value.details.params.clientUserMessageId === clientId)
  )
    return entries;
  let turns = overlayTurns.get(overlay);
  if (!turns) {
    turns = [overlay];
    overlayTurns.set(overlay, turns);
  }
  const overlayEntries = selectVisibleConversationTurnEntries({
    conversation: {
      threadId: overlay.threadId,
      projectId: input.conversation?.projectId ?? null,
      resumeState: "resumed",
      turns,
      requests: [],
      canonicalRequests: [],
    },
    parentTurns: [],
  });
  return [...entries, ...overlayEntries];
}

function equalRequests(
  left: readonly CodexTurnScopedConversationRequest[],
  right: readonly CodexTurnScopedConversationRequest[],
): boolean {
  return (
    left.length === right.length &&
    left.every((request, index) => {
      const other = right[index];
      return (
        other !== undefined &&
        (request === other || areConversationLiveRequestsEqual(request, other))
      );
    })
  );
}

/** Structure is the list dependency. Text stays in the item address family. */
export function selectNormalizedConversationTurnEntries(input: {
  readonly owner: CodexTranscriptReadOwner;
  readonly structure: CodexTranscriptStructure;
  readonly conversation: VisibleConversationContext | null;
}): readonly NormalizedConversationTurnEntry[] {
  const requestsByTurnId = selectConversationTurnRequestsByTurnId(input.conversation);
  const latestEntityKey = input.structure.turnEntityKeys.at(-1);
  const pendingStartedTurnIds = new Set<string>();
  for (const entry of input.structure.itemTimeline?.entries ?? []) {
    if (entry.type === "turnStarted") pendingStartedTurnIds.add(entry.turnId);
    if (entry.type === "turnCompleted") pendingStartedTurnIds.delete(entry.turnId);
  }
  const entries = input.structure.turns.flatMap((row, index) => {
    const details = row.value.details;
    const nextRequests =
      details.turnId === null
        ? EMPTY_REQUESTS
        : selectTurnScopedConversationRequests(requestsByTurnId, details.turnId);
    if (
      row.isStartupPrewarm ||
      (row.value.itemSlots.entries.length === 0 &&
        !row.hasUserMessage &&
        nextRequests.length === 0 &&
        (details.turnId === null || !pendingStartedTurnIds.has(details.turnId)) &&
        !details.diff?.trim() &&
        !hasRecoverableCanonicalTurnItems(details))
    )
      return [];
    const cache = entriesByRow.get(row) ?? new WeakMap<CodexTranscriptReadOwner, EntryCache>();
    entriesByRow.set(row, cache);
    const previous = cache.get(input.owner);
    const isMostRecentTurn = row.entityKey === latestEntityKey;
    if (
      previous?.row === row &&
      previous.entry.isMostRecentTurn === isMostRecentTurn &&
      equalRequests(previous.entry.requests, nextRequests)
    )
      return [previous.entry];
    const requests =
      previous && equalRequests(previous.entry.requests, nextRequests)
        ? previous.entry.requests
        : nextRequests;
    const turnKey = buildCodexTurnOccurrenceKey(details.turnId, index, details.entityKey);
    const entry: NormalizedConversationTurnEntry = {
      historyEntityKey: row.entityKey,
      turnId: details.turnId,
      turnKey,
      turnSearchKey: turnKey,
      turnItemIds: row.itemIds,
      turnStatus: details.status,
      turnStartedAtMs: details.turnStartedAtMs,
      finalAssistantStartedAtMs: details.finalAssistantStartedAtMs,
      hasUserMessage: row.hasUserMessage,
      hasAssistantMessage: row.hasAssistantMessage,
      hasMcpApp: row.hasMcpApp,
      requests,
      isMostRecentTurn,
      readTurn: () => input.owner.readTurn(row.entityKey),
    };
    cache.set(input.owner, { row, entry });
    return [entry];
  });
  const previous = selectionsByStructure.get(input.structure);
  if (
    previous?.length === entries.length &&
    previous.every((entry, index) => entry === entries[index])
  )
    return previous;
  selectionsByStructure.set(input.structure, entries);
  return entries;
}
