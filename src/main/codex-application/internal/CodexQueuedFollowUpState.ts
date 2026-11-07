import {
  CODEX_ENDED_STEER_REASON,
  CODEX_INTERRUPTED_STEER_REASON,
  type CodexQueuedFollowUp,
  type CodexQueuedFollowUpPause,
} from "../../../shared/codex-queued-follow-up-state";

export interface CodexQueuedFollowUpLedgerState {
  readonly ledgerRevision: number;
  readonly entries: readonly CodexQueuedFollowUp[];
}

export interface CodexQueuedFollowUpEditToken {
  readonly followUpId: string;
  readonly originalLedgerRevision: number;
  readonly previousFollowUpId: string | null;
  readonly nextFollowUpId: string | null;
  readonly entry: CodexQueuedFollowUp;
}

export interface CodexQueuedFollowUpEditResult {
  readonly state: CodexQueuedFollowUpLedgerState;
  readonly token: CodexQueuedFollowUpEditToken | null;
}

function sameOrder(
  left: readonly CodexQueuedFollowUp[],
  right: readonly CodexQueuedFollowUp[],
): boolean {
  return (
    left.length === right.length &&
    left.every((entry, index) => entry.followUpId === right[index]?.followUpId)
  );
}

function replaceEntries(
  state: CodexQueuedFollowUpLedgerState,
  entries: readonly CodexQueuedFollowUp[],
): CodexQueuedFollowUpLedgerState {
  if (
    sameOrder(state.entries, entries) &&
    state.entries.every((entry, index) => entry === entries[index])
  ) {
    return state;
  }
  return { ledgerRevision: state.ledgerRevision + 1, entries };
}

export function enqueueCodexQueuedFollowUp(
  state: CodexQueuedFollowUpLedgerState,
  entry: CodexQueuedFollowUp,
): CodexQueuedFollowUpLedgerState {
  if (state.entries.some((candidate) => candidate.followUpId === entry.followUpId)) return state;
  return replaceEntries(state, [...state.entries, entry]);
}

export function removeCodexQueuedFollowUp(
  state: CodexQueuedFollowUpLedgerState,
  followUpId: string,
): CodexQueuedFollowUpLedgerState {
  return replaceEntries(
    state,
    state.entries.filter((entry) => entry.followUpId !== followUpId),
  );
}

export function replaceCodexQueuedFollowUp(
  state: CodexQueuedFollowUpLedgerState,
  entry: CodexQueuedFollowUp,
): CodexQueuedFollowUpLedgerState {
  if (!state.entries.some((candidate) => candidate.followUpId === entry.followUpId)) return state;
  return replaceEntries(
    state,
    state.entries.map((candidate) =>
      candidate.followUpId === entry.followUpId ? entry : candidate,
    ),
  );
}

export function reorderCodexQueuedFollowUps(
  state: CodexQueuedFollowUpLedgerState,
  requestedIds: readonly string[],
): CodexQueuedFollowUpLedgerState {
  if (state.entries.length <= 1) return state;
  const byId = new Map(state.entries.map((entry) => [entry.followUpId, entry] as const));
  const seen = new Set<string>();
  const ordered: CodexQueuedFollowUp[] = [];
  for (const followUpId of requestedIds) {
    const entry = byId.get(followUpId);
    if (!entry || seen.has(followUpId)) continue;
    seen.add(followUpId);
    ordered.push(entry);
  }
  for (const entry of state.entries) {
    if (seen.has(entry.followUpId)) continue;
    ordered.push(entry);
  }
  return replaceEntries(state, ordered);
}

export function beginCodexQueuedFollowUpEdit(
  state: CodexQueuedFollowUpLedgerState,
  followUpId: string,
): CodexQueuedFollowUpEditResult {
  const index = state.entries.findIndex((entry) => entry.followUpId === followUpId);
  const entry = state.entries[index];
  if (index < 0 || !entry) return { state, token: null };
  const token: CodexQueuedFollowUpEditToken = {
    followUpId,
    originalLedgerRevision: state.ledgerRevision,
    previousFollowUpId: state.entries[index - 1]?.followUpId ?? null,
    nextFollowUpId: state.entries[index + 1]?.followUpId ?? null,
    entry,
  };
  return {
    state: replaceEntries(
      state,
      state.entries.filter((candidate) => candidate.followUpId !== followUpId),
    ),
    token,
  };
}

export function restoreCodexQueuedFollowUpEdit(
  state: CodexQueuedFollowUpLedgerState,
  token: CodexQueuedFollowUpEditToken,
): CodexQueuedFollowUpLedgerState {
  if (state.entries.some((entry) => entry.followUpId === token.followUpId)) return state;
  const entries = [...state.entries];
  const nextIndex = token.nextFollowUpId
    ? entries.findIndex((entry) => entry.followUpId === token.nextFollowUpId)
    : -1;
  if (nextIndex >= 0) {
    entries.splice(nextIndex, 0, token.entry);
    return replaceEntries(state, entries);
  }
  const previousIndex = token.previousFollowUpId
    ? entries.findIndex((entry) => entry.followUpId === token.previousFollowUpId)
    : -1;
  entries.splice(previousIndex >= 0 ? previousIndex + 1 : entries.length, 0, token.entry);
  return replaceEntries(state, entries);
}

function uniqueNewRecoveredEntries(
  state: CodexQueuedFollowUpLedgerState,
  recovered: readonly CodexQueuedFollowUp[],
  pause: CodexQueuedFollowUpPause,
): readonly CodexQueuedFollowUp[] {
  const recoveredIds = new Set(state.entries.map((entry) => entry.followUpId));
  const unique: CodexQueuedFollowUp[] = [];
  for (const entry of recovered) {
    if (recoveredIds.has(entry.followUpId)) continue;
    recoveredIds.add(entry.followUpId);
    unique.push({ ...entry, pause });
  }
  return unique;
}

export function recoverInterruptedCodexQueuedFollowUps(
  state: CodexQueuedFollowUpLedgerState,
  recovered: readonly CodexQueuedFollowUp[],
): CodexQueuedFollowUpLedgerState {
  const pause = {
    kind: "interrupted",
    reason: CODEX_INTERRUPTED_STEER_REASON,
  } as const;
  const uniqueRecovered = uniqueNewRecoveredEntries(state, recovered, pause);
  const existing = state.entries.map((entry) => (entry.pause ? entry : { ...entry, pause }));
  return replaceEntries(state, [...uniqueRecovered, ...existing]);
}

export function recoverEndedCodexQueuedFollowUps(
  state: CodexQueuedFollowUpLedgerState,
  recovered: readonly CodexQueuedFollowUp[],
): CodexQueuedFollowUpLedgerState {
  const uniqueRecovered = uniqueNewRecoveredEntries(state, recovered, {
    kind: "failed",
    reason: CODEX_ENDED_STEER_REASON,
  });
  return replaceEntries(state, [...uniqueRecovered, ...state.entries]);
}

export function resumeInterruptedCodexQueuedFollowUps(
  state: CodexQueuedFollowUpLedgerState,
): CodexQueuedFollowUpLedgerState {
  return replaceEntries(
    state,
    state.entries.map((entry) =>
      entry.pause?.kind === "interrupted" ? { ...entry, pause: null } : entry,
    ),
  );
}

export function failCodexQueuedFollowUp(
  state: CodexQueuedFollowUpLedgerState,
  followUpId: string,
  reason: string,
): CodexQueuedFollowUpLedgerState {
  return replaceEntries(
    state,
    state.entries.map((entry) =>
      entry.followUpId === followUpId
        ? { ...entry, pause: { kind: "failed", reason } satisfies CodexQueuedFollowUpPause }
        : entry,
    ),
  );
}

export const completeCodexQueuedFollowUp = removeCodexQueuedFollowUp;
