import type {
  CodexConversationResumeState,
  CodexConversationSnapshot,
  CodexConversationTurn,
} from "../../lib/types";
import {
  isBlockingConversationRequest,
  selectConversationLiveRequests,
  selectConversationTurnRequestsByTurnId,
  selectTurnScopedConversationRequests,
  type CodexTurnScopedConversationRequest,
} from "./conversation-request-helpers";
import { buildCodexTurnOccurrenceKey } from "../../../shared/codex-turn-identity";

export {
  selectConversationLiveRequests,
  selectPlanImplementationRequest,
} from "./conversation-request-helpers";

export interface LocalConversationSearchUnit {
  key: string;
  threadId: string;
  turnId: string | null;
  turnKey: string;
  itemId: string;
  role: "user" | "assistant";
  text: string;
}

export interface VisibleConversationTurnEntry {
  turn: CodexConversationTurn;
  turnId: string | null;
  turnKey: string;
  turnSearchKey: string;
  /** Centered timestamp shown before this turn when transcript adjacency warrants it. */
  timestampSeparatorAtMs?: number | null;
  requests: CodexTurnScopedConversationRequest[];
  isMostRecentTurn: boolean;
  /**
   * Immutable render-facing revision of the turn and its scoped requests.
   * Canonical item objects stay identity-stable across streaming updates; this
   * snapshot lets memoized consumers observe their new revision without
   * serializing the complete item payload.
   */
  readonly renderRevision?: VisibleConversationTurnRenderRevision;
}

interface VisibleConversationTurnItemRevision {
  readonly item: CodexConversationTurn["items"][number];
  readonly itemId: string;
  readonly updatedAt: number;
  readonly status: CodexConversationTurn["items"][number]["status"];
  readonly assistantPhase: string | undefined;
}

interface VisibleConversationTurnRequestRevision {
  readonly request: CodexTurnScopedConversationRequest;
  readonly completed: boolean | undefined;
  readonly response: unknown;
}

export interface VisibleConversationTurnRenderRevision {
  readonly turnStatus: CodexConversationTurn["status"];
  readonly errorMessage: string | undefined;
  readonly diff: string | undefined;
  readonly turnStartedAtMs: number | null | undefined;
  readonly firstTurnWorkItemStartedAtMs: number | null | undefined;
  readonly finalAssistantStartedAtMs: number | null | undefined;
  readonly startedAt: number | null | undefined;
  readonly completedAt: number | null | undefined;
  readonly durationMs: number | null | undefined;
  readonly commandExecutionStartedAtMsById: CodexConversationTurn["commandExecutionStartedAtMsById"];
  readonly interruptedCommandExecutionItemIds: CodexConversationTurn["interruptedCommandExecutionItemIds"];
  readonly hookRuns: CodexConversationTurn["hookRuns"];
  readonly tokenUsage: CodexConversationTurn["tokenUsage"];
  readonly safetyBuffering: CodexConversationTurn["safetyBuffering"];
  readonly itemIds: readonly string[];
  readonly items: readonly VisibleConversationTurnItemRevision[];
  readonly requests: readonly VisibleConversationTurnRequestRevision[];
}

const EMPTY_VISIBLE_TURN_ENTRIES: VisibleConversationTurnEntry[] = [];
const EMPTY_PARENT_TURNS: CodexConversationTurn[] = [];
const visibleTurnEntriesByTurn = new WeakMap<
  CodexConversationTurn,
  {
    revision: VisibleConversationTurnRenderRevision;
    entries: VisibleConversationTurnEntry[];
  }
>();
const visibleTurnEntrySelectionsByTurns = new WeakMap<
  readonly CodexConversationTurn[],
  Array<{
    parentTurns: readonly CodexConversationTurn[];
    requestsByTurnId: ReadonlyMap<string, CodexTurnScopedConversationRequest[]>;
    resumeState: CodexConversationResumeState;
    revisions: readonly VisibleConversationTurnRenderRevision[];
    entries: VisibleConversationTurnEntry[];
  }>
>();

function readRequestCompleted(request: CodexTurnScopedConversationRequest): boolean | undefined {
  if (!("completed" in request)) return undefined;
  return typeof request.completed === "boolean" ? request.completed : undefined;
}

function readRequestResponse(request: CodexTurnScopedConversationRequest): unknown {
  return "response" in request ? request.response : undefined;
}

export function buildVisibleConversationTurnRenderRevision(
  turn: CodexConversationTurn,
  requests: readonly CodexTurnScopedConversationRequest[],
): VisibleConversationTurnRenderRevision {
  return {
    turnStatus: turn.status,
    errorMessage: turn.errorMessage,
    diff: turn.diff,
    turnStartedAtMs: turn.turnStartedAtMs,
    firstTurnWorkItemStartedAtMs: turn.firstTurnWorkItemStartedAtMs,
    finalAssistantStartedAtMs: turn.finalAssistantStartedAtMs,
    startedAt: turn.startedAt,
    completedAt: turn.completedAt,
    durationMs: turn.durationMs,
    commandExecutionStartedAtMsById: turn.commandExecutionStartedAtMsById,
    interruptedCommandExecutionItemIds: turn.interruptedCommandExecutionItemIds,
    hookRuns: turn.hookRuns,
    tokenUsage: turn.tokenUsage,
    safetyBuffering: turn.safetyBuffering,
    itemIds: [...turn.itemIds],
    items: turn.items.map((item) => ({
      item,
      itemId: item.itemId,
      updatedAt: item.updatedAt,
      status: item.status,
      assistantPhase: item.assistantPhase,
    })),
    requests: requests.map((request) => ({
      request,
      completed: readRequestCompleted(request),
      response: readRequestResponse(request),
    })),
  };
}

export function areVisibleConversationTurnRenderRevisionsEqual(
  left: VisibleConversationTurnRenderRevision,
  right: VisibleConversationTurnRenderRevision,
): boolean {
  if (
    left.turnStatus !== right.turnStatus ||
    left.errorMessage !== right.errorMessage ||
    left.diff !== right.diff ||
    left.turnStartedAtMs !== right.turnStartedAtMs ||
    left.firstTurnWorkItemStartedAtMs !== right.firstTurnWorkItemStartedAtMs ||
    left.finalAssistantStartedAtMs !== right.finalAssistantStartedAtMs ||
    left.startedAt !== right.startedAt ||
    left.completedAt !== right.completedAt ||
    left.durationMs !== right.durationMs ||
    left.commandExecutionStartedAtMsById !== right.commandExecutionStartedAtMsById ||
    left.interruptedCommandExecutionItemIds !== right.interruptedCommandExecutionItemIds ||
    left.hookRuns !== right.hookRuns ||
    left.tokenUsage !== right.tokenUsage ||
    left.safetyBuffering !== right.safetyBuffering ||
    left.itemIds.length !== right.itemIds.length ||
    left.items.length !== right.items.length ||
    left.requests.length !== right.requests.length
  ) {
    return false;
  }

  for (let index = 0; index < left.itemIds.length; index += 1) {
    if (left.itemIds[index] !== right.itemIds[index]) return false;
  }
  for (let index = 0; index < left.items.length; index += 1) {
    const leftItem = left.items[index];
    const rightItem = right.items[index];
    if (!leftItem || !rightItem) return false;
    if (
      leftItem.item !== rightItem.item ||
      leftItem.itemId !== rightItem.itemId ||
      leftItem.updatedAt !== rightItem.updatedAt ||
      leftItem.status !== rightItem.status ||
      leftItem.assistantPhase !== rightItem.assistantPhase
    ) {
      return false;
    }
  }
  for (let index = 0; index < left.requests.length; index += 1) {
    const leftRequest = left.requests[index];
    const rightRequest = right.requests[index];
    if (!leftRequest || !rightRequest) return false;
    if (
      leftRequest.request !== rightRequest.request ||
      leftRequest.completed !== rightRequest.completed ||
      leftRequest.response !== rightRequest.response
    ) {
      return false;
    }
  }
  return true;
}

function areTurnRenderRevisionListsEqual(
  left: readonly VisibleConversationTurnRenderRevision[],
  right: readonly VisibleConversationTurnRenderRevision[],
): boolean {
  if (left.length !== right.length) return false;
  return left.every((revision, index) => {
    const nextRevision = right[index];
    return (
      nextRevision !== undefined &&
      areVisibleConversationTurnRenderRevisionsEqual(revision, nextRevision)
    );
  });
}

function isRenderableConversationTurn(
  turn: CodexConversationTurn,
  requests: readonly CodexTurnScopedConversationRequest[],
): boolean {
  const isStartupToolPrewarm = turn.items.some((item) => {
    if (typeof item.rawItem !== "object" || item.rawItem === null) return false;
    const rawItem = item.rawItem as {
      readonly type?: unknown;
      readonly content?: readonly { readonly type?: unknown; readonly text?: unknown }[];
    };
    return (
      rawItem.type === "userMessage" &&
      rawItem.content?.some(
        (content) =>
          content.type === "text" &&
          typeof content.text === "string" &&
          content.text.startsWith("<startup_tool_prewarm>"),
      ) === true
    );
  });
  if (isStartupToolPrewarm) return false;
  return turn.items.length > 0 || requests.length > 0 || (turn.diff?.trim().length ?? 0) > 0;
}

function createVisibleConversationTurnEntry(input: {
  turn: CodexConversationTurn;
  index: number;
  requests: CodexTurnScopedConversationRequest[];
  isMostRecentTurn: boolean;
  renderRevision: VisibleConversationTurnRenderRevision;
}): VisibleConversationTurnEntry {
  const turnKey = buildCodexTurnOccurrenceKey(input.turn.turnId, input.index);
  const cachedTurn = visibleTurnEntriesByTurn.get(input.turn);
  const candidates =
    cachedTurn !== undefined &&
    areVisibleConversationTurnRenderRevisionsEqual(cachedTurn.revision, input.renderRevision)
      ? cachedTurn.entries
      : [];
  const cached = candidates.find(
    (candidate) =>
      candidate.requests === input.requests &&
      candidate.isMostRecentTurn === input.isMostRecentTurn &&
      candidate.turnKey === turnKey &&
      candidate.turnSearchKey === turnKey &&
      candidate.renderRevision !== undefined &&
      areVisibleConversationTurnRenderRevisionsEqual(
        candidate.renderRevision,
        input.renderRevision,
      ),
  );
  if (cached) {
    return cached;
  }

  const entry: VisibleConversationTurnEntry = {
    turn: {
      ...input.turn,
      itemIds: [...input.turn.itemIds],
      items: [...input.turn.items],
    },
    turnId: input.turn.turnId,
    turnKey,
    turnSearchKey: turnKey,
    requests: input.requests,
    isMostRecentTurn: input.isMostRecentTurn,
    renderRevision: input.renderRevision,
  };
  visibleTurnEntriesByTurn.set(input.turn, {
    revision: input.renderRevision,
    entries: [...candidates, entry],
  });
  return entry;
}

function selectMergedVisibleTurnIds(input: {
  turns: readonly CodexConversationTurn[];
  parentTurns: readonly CodexConversationTurn[];
  resumeState: CodexConversationResumeState;
}): ReadonlySet<string> | null {
  if (input.resumeState !== "resumed" || input.parentTurns.length === 0) {
    return null;
  }

  const parentTurnIds = new Set<string>();
  for (const turn of input.parentTurns) {
    if (turn.turnId !== null) parentTurnIds.add(turn.turnId);
  }

  if (parentTurnIds.size === 0) {
    return null;
  }

  const visibleTurnIds = new Set<string>();
  for (const turn of input.turns) {
    if (turn.turnId !== null && !parentTurnIds.has(turn.turnId)) {
      visibleTurnIds.add(turn.turnId);
    }
  }
  return visibleTurnIds;
}

export function selectVisibleConversationTurns(
  conversation: CodexConversationSnapshot | null,
): CodexConversationTurn[] {
  if (!conversation) return [];
  return conversation.turns;
}

export function selectVisibleConversationTurnEntries(input: {
  conversation: CodexConversationSnapshot | null;
  parentTurns?: readonly CodexConversationTurn[] | null;
}): VisibleConversationTurnEntry[] {
  const conversation = input.conversation;
  if (!conversation) {
    return EMPTY_VISIBLE_TURN_ENTRIES;
  }

  const turns = conversation.turns;
  if (turns.length === 0) {
    return EMPTY_VISIBLE_TURN_ENTRIES;
  }

  const requestsByTurnId = selectConversationTurnRequestsByTurnId(conversation);
  const parentTurns = input.parentTurns ?? EMPTY_PARENT_TURNS;
  const requestsByTurn = turns.map((turn) =>
    turn.turnId === null ? [] : selectTurnScopedConversationRequests(requestsByTurnId, turn.turnId),
  );
  const revisions = turns.map((turn, index) =>
    buildVisibleConversationTurnRenderRevision(turn, requestsByTurn[index] ?? []),
  );
  const cachedSelections = visibleTurnEntrySelectionsByTurns.get(turns);
  const cached = cachedSelections?.find(
    (selection) =>
      selection.parentTurns === parentTurns &&
      selection.requestsByTurnId === requestsByTurnId &&
      selection.resumeState === conversation.resumeState &&
      areTurnRenderRevisionListsEqual(selection.revisions, revisions),
  );
  if (cached) {
    return cached.entries;
  }

  const latestTurnIndex = turns.length - 1;
  const mergedVisibleTurnIds = selectMergedVisibleTurnIds({
    turns,
    parentTurns,
    resumeState: conversation.resumeState,
  });
  const entries = turns.flatMap((turn, index) => {
    const requests = requestsByTurn[index] ?? [];
    if (!isRenderableConversationTurn(turn, requests)) {
      return [];
    }

    if (mergedVisibleTurnIds && turn.turnId !== null && !mergedVisibleTurnIds.has(turn.turnId)) {
      return [];
    }

    return [
      createVisibleConversationTurnEntry({
        turn,
        index,
        requests,
        isMostRecentTurn: latestTurnIndex === index,
        renderRevision:
          revisions[index] ?? buildVisibleConversationTurnRenderRevision(turn, requests),
      }),
    ];
  });

  if (entries.length === 0) {
    return EMPTY_VISIBLE_TURN_ENTRIES;
  }

  const retainedSelections =
    cachedSelections?.filter(
      (selection) =>
        !(
          selection.parentTurns === parentTurns &&
          selection.requestsByTurnId === requestsByTurnId &&
          selection.resumeState === conversation.resumeState
        ),
    ) ?? [];
  const nextSelections = [
    ...retainedSelections,
    {
      parentTurns,
      requestsByTurnId,
      resumeState: conversation.resumeState,
      revisions,
      entries,
    },
  ];
  visibleTurnEntrySelectionsByTurns.set(turns, nextSelections);
  return entries;
}

export function selectBlockedTurnIds(conversation: CodexConversationSnapshot | null): string[] {
  if (!conversation) return [];

  return selectConversationLiveRequests(conversation)
    .filter((request) => isBlockingConversationRequest(request))
    .map((request) => request.turnId)
    .filter((turnId, index, values) => values.indexOf(turnId) === index);
}

export function selectConversationSearchUnits(
  conversation: CodexConversationSnapshot | null,
): LocalConversationSearchUnit[] {
  if (!conversation) return [];

  return conversation.turns.flatMap((turn, turnIndex) => {
    const turnKey = buildCodexTurnOccurrenceKey(turn.turnId, turnIndex);
    return turn.items
      .filter(
        (item) =>
          (item.role === "user" || item.role === "assistant") &&
          (item.markdownText ?? "").trim().length > 0,
      )
      .map((item) => ({
        key: `${turnKey}:${item.itemId}`,
        threadId: conversation.threadId,
        turnId: turn.turnId,
        turnKey,
        itemId: item.itemId,
        role: item.role as "user" | "assistant",
        text: (item.markdownText ?? "").trim(),
      }));
  });
}
