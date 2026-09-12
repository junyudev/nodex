import { produce, type Draft } from "immer";
import type { Thread } from "@nodex/codex-app-server-protocol/v2";
import { hydrateCodexCanonicalTurns, type CodexCanonicalConversationState } from "./codex-conversation-state";
import { canonicalPermissionsForMode } from "./codex-native-permissions";
import { replaceCanonicalHistoryDraft } from "./codex-canonical-history-loader";

export function mutateCodexCanonicalRollbackThread(state: Draft<CodexCanonicalConversationState>, thread: Thread): boolean {
  if (state.id !== thread.id) return false;
  const roots = state.cwd ? [state.cwd] : [];
  const permissions = canonicalPermissionsForMode("auto", roots, {})!;
  const turns = hydrateCodexCanonicalTurns(thread.id, thread.turns, {
    hostId: state.hostId,
    model: state.latestModel ?? "",
    reasoningEffort: state.latestReasoningEffort ?? null,
    cwd: thread.cwd || state.cwd || "/",
    approvalPolicy: permissions.approvalPolicy,
    approvalsReviewer: permissions.approvalsReviewer,
    sandboxPolicy: permissions.sandboxPolicy,
    activePermissionProfile: permissions.activePermissionProfile ?? null,
    runtimeWorkspaceRoots: roots,
  });
  if (state.turnHistory?.kind === "canonical") replaceCanonicalHistoryDraft(state, turns, true);
  else Object.assign(state, { turns });
  state.turnsPagination = { olderCursor: null, oldestLoadedTurnId: null, isLoadingOlder: false, hasLoadedOldest: true };
  state.requests = [];
  state.resumeState = "resumed";
  state.sessionId = thread.sessionId;
  state.rolloutPath = thread.path ?? state.rolloutPath;
  state.cwd = thread.cwd || state.cwd;
  state.source = thread.source;
  state.agentNickname = thread.agentNickname;
  state.forkedFromId = thread.forkedFromId;
  Object.assign(state, { gitInfo: thread.gitInfo, threadRuntimeStatus: thread.status });
  state.hasUnreadTurn = false;
  const updatedAt = thread.updatedAt * 1000;
  if (Number.isFinite(updatedAt)) state.updatedAt = updatedAt;
  return true;
}
export function replaceCodexCanonicalRollbackThread(state: CodexCanonicalConversationState, thread: Thread): CodexCanonicalConversationState | null {
  let accepted = false;
  const next = produce(state, (draft) => { accepted = mutateCodexCanonicalRollbackThread(draft, thread); });
  return accepted ? next : null;
}

/** Identity-based revert removes only the reverted suffix and keeps retained history resident. */
export function mutateCodexCanonicalRevert(
  state: Draft<CodexCanonicalConversationState>,
  response: import("@nodex/codex-app-server-protocol/v2").ThreadRevertResponse,
  revertedTurnIds: ReadonlySet<string | null>,
): void {
  const { thread, turnsBackwardsCursor, itemsBackwardsCursor } = response;
  const history = state.turnHistory?.history;
  const lastIsland = history?.islands.at(-1);
  const tail = lastIsland?.newerBoundary.status === "exhausted" ? lastIsland : undefined;
  if (!history) state.turns = state.turns.filter((turn) => !revertedTurnIds.has(turn.turnId));
  else {
    history.generation += 1;
    for (const island of history.islands) {
      island.entries = island.entries.filter(({ value }) => {
        const turn = history.entitiesByKey[value];
        if (!turn || (!revertedTurnIds.has(turn.turnId) && !(island === tail && turn.turnId === null))) return true;
        delete history.entitiesByKey[value];
        return false;
      });
    }
  }
  if (tail?.entries.length === 0) {
    tail.olderBoundary = turnsBackwardsCursor === null
      ? { status: "exhausted", boundaryId: `${tail.id}:older` }
      : { status: "available", boundaryId: `${tail.id}:older`, handle: { cursor: turnsBackwardsCursor, oldestLoadedTurnId: null }, progressKey: JSON.stringify([turnsBackwardsCursor, null]) };
    if (turnsBackwardsCursor === null && history?.islands.length === 1) history.isComplete = true;
    if (state.turnsPagination) {
      state.turnsPagination.olderCursor = turnsBackwardsCursor;
      state.turnsPagination.oldestLoadedTurnId = null;
      state.turnsPagination.hasLoadedOldest = turnsBackwardsCursor === null;
    }
  }
  state.sessionId = thread.sessionId;
  state.paginatedHistory = { itemsBackwardsCursor };
  state.rolloutPath = thread.path ?? state.rolloutPath;
  state.cwd = thread.cwd || state.cwd;
  state.threadRuntimeStatus = thread.status;
}
