import { castDraft, isDraft, original } from "immer";
import {
  mergeCodexCanonicalTurnStates,
  type CodexCanonicalConversationState,
  type CodexCanonicalTurnState,
} from "./codex-conversation-state";
import {
  CanonicalHistoryItemLoader,
  listCanonicalHistoryTurns,
  loadCanonicalHistoryBoundaryPage,
  replaceCanonicalHistoryDraft,
  type CanonicalHistoryClient,
} from "./codex-canonical-history-loader";
import {
  createCodexHistoryBoundaryRef,
  readCurrentCodexHistoryBoundary,
  type CodexHistoryBoundaryRef,
} from "./codex-history-topology";
import { residentConversationTurns } from "./codex-turn-mutation";

export function hasCompleteCanonicalConversationHistory(
  state: CodexCanonicalConversationState,
): boolean {
  if (
    state.turnsPagination?.source === "compact" ||
    residentConversationTurns(state).some((turn) => turn.itemsPagination?.hasLoadedOldest === false)
  )
    return false;
  if (state.turnHistory)
    return state.turnHistory.history.isComplete && state.turnHistory.history.islands.length === 1;
  return state.resumeState === "resumed" && (state.turnsPagination?.hasLoadedOldest ?? true);
}
const firstBoundary = (state: CodexCanonicalConversationState): CodexHistoryBoundaryRef | null => {
  const history = state.turnHistory?.history;
  if (!history) return null;
  for (const island of history.islands)
    for (const edge of ["older", "newer"] as const) {
      const boundary = edge === "older" ? island.olderBoundary : island.newerBoundary;
      if (boundary.status === "available")
        return createCodexHistoryBoundaryRef(history.generation, island.id, edge, boundary);
    }
  return null;
};
const isTailBoundary = (
  state: CodexCanonicalConversationState,
  ref: CodexHistoryBoundaryRef,
): boolean => {
  const history = state.turnHistory?.history;
  if (
    !history ||
    ref.edge !== "older" ||
    history.islands.length !== 1 ||
    history.islands[0]?.newerBoundary.status !== "exhausted"
  )
    return false;
  return readCurrentCodexHistoryBoundary(history, ref) !== null;
};
const matchesTailPagination = (
  state: CodexCanonicalConversationState,
  ref: CodexHistoryBoundaryRef,
): boolean => {
  const history = state.turnHistory?.history;
  const boundary = history ? readCurrentCodexHistoryBoundary(history, ref) : null;
  if (
    !history ||
    !boundary ||
    !isTailBoundary(state, ref) ||
    state.turnsPagination?.olderCursor !== boundary.handle.cursor ||
    state.turnsPagination.oldestLoadedTurnId !== boundary.handle.oldestLoadedTurnId
  )
    return false;
  const turns = residentConversationTurns(state);
  return boundary.handle.oldestLoadedTurnId === null
    ? (turns[0]?.turnId ?? null) === null
    : turns.some((turn) => turn.turnId === boundary.handle.oldestLoadedTurnId);
};

/** Complete loads coalesce, hydrate tail pages in one transaction, then finish partial items. */
export class CanonicalCompleteHistoryLoader implements Disposable {
  private readonly loads = new Map<string, Promise<void>>();
  private readonly items: CanonicalHistoryItemLoader;
  private disposed = false;
  private generation = 0;
  private readonly ownsItems: boolean;
  constructor(
    private readonly client: CanonicalHistoryClient,
    items?: CanonicalHistoryItemLoader,
  ) {
    this.items = items ?? new CanonicalHistoryItemLoader(client);
    this.ownsItems = items === undefined;
  }
  [Symbol.dispose](): void {
    this.disposed = true;
    if (this.ownsItems) this.items[Symbol.dispose]();
    this.loads.clear();
  }
  resetAfterReconnect(): void {
    this.generation += 1;
    this.loads.clear();
    this.items.cancelLoads();
  }
  async load(conversationId: string): Promise<readonly CodexCanonicalTurnState[]> {
    const generation = this.generation;
    const initial = this.client.getConversation(conversationId);
    if (!initial || initial.resumeState !== "resumed")
      throw new Error("Conversation must be resumed before loading history");
    if (!hasCompleteCanonicalConversationHistory(initial)) {
      let pending = this.loads.get(conversationId);
      if (!pending) {
        pending = this.loadRemaining(conversationId, this.generation);
        this.loads.set(conversationId, pending);
      }
      try {
        await pending;
      } finally {
        if (this.loads.get(conversationId) === pending) this.loads.delete(conversationId);
      }
    }
    const current = this.client.getConversation(conversationId);
    if (
      this.disposed ||
      generation !== this.generation ||
      !current ||
      !hasCompleteCanonicalConversationHistory(current)
    )
      throw new Error("Failed to load complete conversation history");
    return residentConversationTurns(current);
  }
  private async loadRemaining(id: string, generation: number): Promise<void> {
    while (!this.disposed && generation === this.generation) {
      const state = this.client.getConversation(id);
      if (!state) break;
      const ref = firstBoundary(state);
      if (!ref) {
        if (!state.turnHistory && state.turnsPagination?.olderCursor != null) {
          await this.loadTail(id, state, generation);
          continue;
        }
        break;
      }
      if (matchesTailPagination(state, ref)) {
        await this.loadTail(id, state, generation, ref);
        continue;
      }
      await loadCanonicalHistoryBoundaryPage(this.client, id, ref, {
        requestOptions: { priority: "background", source: "tail_history" },
      });
    }
    if (!this.disposed && generation === this.generation)
      await this.items.loadRemainingTurnItems(id);
  }
  private async loadTail(
    id: string,
    initial: CodexCanonicalConversationState,
    generation: number,
    ref?: CodexHistoryBoundaryRef,
  ): Promise<void> {
    const pagination = initial.turnsPagination;
    const cursor = pagination?.olderCursor ?? null;
    if (cursor === null) return;
    if (!ref)
      this.client.updateConversation(id, (draft) => {
        draft.turnsPagination = {
          ...(pagination?.source ? { source: pagination.source } : {}),
          olderCursor: cursor,
          oldestLoadedTurnId: pagination?.oldestLoadedTurnId ?? null,
          isLoadingOlder: true,
          hasLoadedOldest: false,
        };
      });
    try {
      await this.loadTailPages(id, initial, generation, ref);
    } catch (error) {
      const current = this.client.getConversation(id)?.turnsPagination;
      if (
        this.disposed ||
        generation !== this.generation ||
        current?.olderCursor !== cursor ||
        current.source !== pagination?.source
      )
        return;
      if (!ref)
        this.client.updateConversation(id, (draft) => {
          if (draft.turnsPagination?.olderCursor !== cursor) return;
          draft.turnsPagination = {
            ...(pagination?.source ? { source: pagination.source } : {}),
            olderCursor: cursor,
            oldestLoadedTurnId: pagination?.oldestLoadedTurnId ?? null,
            isLoadingOlder: false,
            hasLoadedOldest: false,
          };
        });
      throw error;
    }
  }
  private async loadTailPages(
    id: string,
    initial: CodexCanonicalConversationState,
    generation: number,
    ref?: CodexHistoryBoundaryRef,
  ): Promise<void> {
    const pagination = initial.turnsPagination;
    const startCursor = pagination?.olderCursor ?? null;
    if (startCursor === null) return;
    const valid = (): CodexCanonicalConversationState | null => {
      const current = this.client.getConversation(id);
      if (
        this.disposed ||
        generation !== this.generation ||
        !current ||
        (ref && !isTailBoundary(current, ref)) ||
        current.turnsPagination?.olderCursor !== startCursor ||
        current.turnsPagination?.source !== pagination?.source
      )
        return null;
      return current;
    };
    const pages: (readonly CodexCanonicalTurnState[])[] = [];
    let cursor: string | null = startCursor;
    while (cursor !== null) {
      const page = await listCanonicalHistoryTurns(this.client, id, {
        cursor,
        limit: 5,
        ...(ref ? { sortDirection: "desc" } : {}),
        source: pagination?.source === "compact" ? "compact" : "ordinary",
        requestOptions: { priority: "background", source: "tail_history" },
      });
      if (!valid()) return;
      pages.push(
        this.client.mapTurns(id, [...page.response.data].reverse(), page.itemsPaginationByTurnId),
      );
      if (page.response.nextCursor === cursor)
        throw new Error("Failed to load remaining conversation turns");
      cursor = page.response.nextCursor;
    }
    const current = valid();
    if (!current) return;
    const older = pages.reverse().flat();
    const currentTurns = residentConversationTurns(current);
    const oldest = pagination?.oldestLoadedTurnId ?? null;
    const index = oldest === null ? -1 : currentTurns.findIndex((turn) => turn.turnId === oldest);
    const merged =
      index === -1
        ? mergeCodexCanonicalTurnStates(older, currentTurns)
        : mergeCodexCanonicalTurnStates(
            mergeCodexCanonicalTurnStates(currentTurns.slice(0, index), older),
            currentTurns.slice(index),
          );
    let applied = false;
    this.client.updateConversation(
      id,
      (draft) => {
        if (ref && !isTailBoundary(draft as CodexCanonicalConversationState, ref)) return;
        const history = draft.turnHistory?.history;
        const island = history?.islands[0];
        if (ref && history && island) {
          const existing = new Map(
            island.entries.flatMap((entry) => {
              const turn = history.entitiesByKey[entry.value];
              return turn
                ? [
                    [
                      turn.turnId ?? (isDraft(turn) ? (original(turn) ?? turn) : turn),
                      entry,
                    ] as const,
                  ]
                : [];
            }),
          );
          island.entries = merged.map((turn, index) => {
            const entry = existing.get(turn.turnId ?? turn);
            const key =
              entry?.value ??
              (turn.turnId === null ? `${island.id}:local:${index}` : `turn:${turn.turnId}`);
            history.entitiesByKey[key] = castDraft(turn);
            return entry ?? { key, value: key };
          });
          island.olderBoundary = {
            boundaryId: island.olderBoundary.boundaryId,
            status: "exhausted",
          };
          history.isComplete = true;
          draft.turns = [];
        } else replaceCanonicalHistoryDraft(draft, merged, pagination?.source !== "compact");
        draft.turnsPagination = {
          ...(pagination?.source ? { source: pagination.source } : {}),
          olderCursor: null,
          oldestLoadedTurnId: older.find((turn) => turn.turnId !== null)?.turnId ?? oldest,
          isLoadingOlder: false,
          hasLoadedOldest: true,
        };
        applied = true;
      },
      false,
    );
    if (applied) this.client.broadcastSnapshot(id);
  }
}
