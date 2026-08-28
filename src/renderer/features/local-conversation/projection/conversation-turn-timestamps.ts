import type { CodexConversationTurn } from "../../../lib/types";

export const USER_TURN_TIMESTAMP_GAP_MS = 60 * 60 * 1_000;
export const ASSISTANT_TURN_TIMESTAMP_GAP_MS = 10 * 60 * 1_000;

export interface ConversationTimestampMarker {
  readonly role: "user" | "assistant";
  readonly sentAtMs: number | null | undefined;
  readonly breaksPreviousAdjacency?: boolean;
}

export type ConversationTimestampMarkerGroup = readonly ConversationTimestampMarker[] | null;

function isFiniteTimestamp(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function shouldShowConversationTimestamp(input: {
  current: ConversationTimestampMarker;
  previous: ConversationTimestampMarker | null;
  isFirstUserTurn: boolean;
  nowMs: number;
}): boolean {
  if (!isFiniteTimestamp(input.current.sentAtMs)) return false;

  if (input.isFirstUserTurn && input.nowMs - input.current.sentAtMs > USER_TURN_TIMESTAMP_GAP_MS) {
    return true;
  }

  if (input.previous?.role !== "assistant") return false;
  if (!isFiniteTimestamp(input.previous.sentAtMs)) return false;

  const gapMs = input.current.sentAtMs - input.previous.sentAtMs;
  const thresholdMs =
    input.current.role === "user" ? USER_TURN_TIMESTAMP_GAP_MS : ASSISTANT_TURN_TIMESTAMP_GAP_MS;
  return gapMs > thresholdMs;
}

/**
 * Resolves at most one centered timestamp for each render group. A null group is
 * an explicit history boundary: it breaks adjacency and prevents the next
 * loaded user message from being mistaken for the conversation's first turn.
 */
export function resolveConversationTimestampSeparators(
  groups: readonly ConversationTimestampMarkerGroup[],
  nowMs = Date.now(),
): Array<number | null> {
  let previous: ConversationTimestampMarker | null = null;
  let hasSeenUser = false;

  return groups.map((group) => {
    if (group === null) {
      previous = null;
      hasSeenUser = true;
      return null;
    }

    let separatorAtMs: number | null = null;
    for (const marker of group) {
      if (marker.breaksPreviousAdjacency) {
        previous = null;
      }

      const isFirstUserTurn = marker.role === "user" && !hasSeenUser;
      if (
        separatorAtMs === null &&
        shouldShowConversationTimestamp({
          current: marker,
          previous,
          isFirstUserTurn,
          nowMs,
        })
      ) {
        separatorAtMs = marker.sentAtMs ?? null;
      }

      if (marker.role === "user") {
        hasSeenUser = true;
      }
      previous = marker;
    }

    return separatorAtMs;
  });
}

function turnHasPrimaryUserMessage(turn: CodexConversationTurn): boolean {
  return turn.items.some(
    (item) =>
      !item.hookFeedback &&
      item.type !== "steeringUserMessage" &&
      (item.semanticKind === "userMessage" || item.kind === "userMessage"),
  );
}

function turnHasAssistantMessage(turn: CodexConversationTurn): boolean {
  return turn.items.some(
    (item) =>
      item.semanticKind === "assistantMessage" ||
      item.kind === "assistantMessage" ||
      item.type === "agentMessage",
  );
}

function buildTurnTimestampMarkers(turn: CodexConversationTurn): ConversationTimestampMarker[] {
  const markers: ConversationTimestampMarker[] = [];
  if (turnHasPrimaryUserMessage(turn)) {
    markers.push({ role: "user", sentAtMs: turn.turnStartedAtMs });
  }
  if (turnHasAssistantMessage(turn)) {
    markers.push({ role: "assistant", sentAtMs: turn.finalAssistantStartedAtMs });
  }
  return markers;
}

export function resolveConversationTurnTimestampSeparators(
  turns: readonly CodexConversationTurn[],
  options: {
    readonly nowMs?: number;
    readonly startsAfterHistoryBoundary?: boolean;
  } = {},
): Array<number | null> {
  const groups = turns.map(buildTurnTimestampMarkers);
  if (!options.startsAfterHistoryBoundary) {
    return resolveConversationTimestampSeparators(groups, options.nowMs);
  }

  return resolveConversationTimestampSeparators([null, ...groups], options.nowMs).slice(1);
}
