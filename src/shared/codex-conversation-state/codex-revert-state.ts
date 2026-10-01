import type { Draft } from "immer";
import type { CodexCanonicalConversationState } from "./codex-conversation-state";

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
        if (
          !turn ||
          (!revertedTurnIds.has(turn.turnId) && !(island === tail && turn.turnId === null))
        )
          return true;
        delete history.entitiesByKey[value];
        return false;
      });
    }
  }
  if (tail?.entries.length === 0) {
    tail.olderBoundary =
      turnsBackwardsCursor === null
        ? { status: "exhausted", boundaryId: `${tail.id}:older` }
        : {
            status: "available",
            boundaryId: `${tail.id}:older`,
            handle: { cursor: turnsBackwardsCursor, oldestLoadedTurnId: null },
            progressKey: JSON.stringify([turnsBackwardsCursor, null]),
          };
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
