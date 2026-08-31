export const CODEX_HISTORY_RESIDENCY_MAX_VISIBLE_TURN_PINS = 32;
export const CODEX_HISTORY_RESIDENCY_MAX_VISIBLE_ISLAND_PINS = 8;

export interface CodexHistoryResidencyPinsInput {
  readonly threadId: string;
  readonly expectedConversationGeneration: number;
  readonly expectedTopologyGeneration: number;
  readonly expectedHistoryMutationRevision: number;
  readonly turnIds: readonly string[];
  readonly islandIds: readonly string[];
}

export type CodexHistoryResidencyPinsResult =
  | {
      readonly status: "applied";
      readonly evictedTurnIds: readonly string[];
      readonly limitsSatisfied: boolean;
      readonly mutation?: import("./codex-conversation-history-page").CodexConversationHistoryMutation;
    }
  | {
      readonly status: "invalid" | "notLoaded" | "notOwner" | "notPresenting" | "staleGeneration";
    };

function normalizeBoundedIds(values: unknown, maximum: number): readonly string[] | null {
  if (!Array.isArray(values) || values.length > maximum) return null;
  const normalized = new Set<string>();
  for (const value of values) {
    if (typeof value !== "string") return null;
    const id = value.trim();
    if (!id) return null;
    normalized.add(id);
  }
  return [...normalized];
}

/** Validates the renderer-facing residency message without widening its count or identity budget. */
export function parseCodexHistoryResidencyPinsInput(
  input: unknown,
): CodexHistoryResidencyPinsInput | null {
  if (!input || typeof input !== "object") return null;
  const candidate = input as Partial<CodexHistoryResidencyPinsInput>;
  if (typeof candidate.threadId !== "string") return null;
  const threadId = candidate.threadId.trim();
  if (!threadId) return null;
  if (
    !Number.isSafeInteger(candidate.expectedConversationGeneration) ||
    (candidate.expectedConversationGeneration ?? -1) < 1 ||
    !Number.isSafeInteger(candidate.expectedTopologyGeneration) ||
    (candidate.expectedTopologyGeneration ?? -1) < 0 ||
    !Number.isSafeInteger(candidate.expectedHistoryMutationRevision) ||
    (candidate.expectedHistoryMutationRevision ?? -1) < 0
  ) {
    return null;
  }
  const turnIds = normalizeBoundedIds(
    candidate.turnIds,
    CODEX_HISTORY_RESIDENCY_MAX_VISIBLE_TURN_PINS,
  );
  const islandIds = normalizeBoundedIds(
    candidate.islandIds,
    CODEX_HISTORY_RESIDENCY_MAX_VISIBLE_ISLAND_PINS,
  );
  if (!turnIds || !islandIds) return null;
  return {
    threadId,
    expectedConversationGeneration: candidate.expectedConversationGeneration!,
    expectedTopologyGeneration: candidate.expectedTopologyGeneration!,
    expectedHistoryMutationRevision: candidate.expectedHistoryMutationRevision!,
    turnIds,
    islandIds,
  };
}
