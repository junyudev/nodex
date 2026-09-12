import type { Draft } from "immer";
import { listCanonicalHistoryTurns, readCanonicalHistoryItems, type CanonicalHistoryClient } from "./codex-canonical-history-loader";
import { mergeCodexCanonicalTurnState, type CodexCanonicalConversationState, type CodexCanonicalTurnState } from "./codex-conversation-state";
import { availableCodexHistoryBoundary, exhaustedCodexHistoryBoundary, type CodexCanonicalHistoryTopology, type CodexHistoryEntry, type CodexHistoryIsland } from "./codex-history-topology";
import { relocateCodexHydratedSteering } from "./codex-steering-reconciliation";
import { residentConversationTurnEntries, residentConversationTurns, conversationTurnDraft } from "./codex-turn-mutation";

export interface CanonicalHistorySearchMatch {
  readonly conversationId: string;
  readonly itemId: string;
  readonly turnCursor: string;
  readonly turnId: string;
}

function searchPositions(history: CodexCanonicalHistoryTopology<CodexCanonicalTurnState>, entries: readonly CodexHistoryEntry[], lookup: (key: string) => CodexCanonicalTurnState | undefined): Map<string, number> | null {
  const positions = new Map<string, number>();
  const identities = new Map<string, string>();
  const spacing = entries.length + 1;
  let position = 0;
  for (const island of history.islands) {
    for (const entry of island.entries) {
      positions.set(entry.value, position);
      const id = lookup(entry.value)?.turnId;
      if (id != null) identities.set(id, entry.value);
      position += spacing;
    }
    position += spacing;
  }
  const anchorIndex = entries.findIndex((entry) => { const id = lookup(entry.value)?.turnId; return id != null && identities.has(id); });
  if (anchorIndex !== -1) {
    const id = lookup(entries[anchorIndex]!.value)?.turnId;
    const key = id == null ? undefined : identities.get(id);
    const anchor = key == null ? undefined : positions.get(key);
    if (anchor === undefined) return null;
    entries.forEach((entry, index) => positions.set(entry.value, anchor + index - anchorIndex));
    return positions;
  }
  const keys = [...new Set([...positions.keys(), ...entries.map((entry) => entry.value)])];
  if (keys.some((key) => lookup(key)?.turnStartedAtMs == null)) return null;
  keys.sort((left, right) => {
    const a = lookup(left)!; const b = lookup(right)!;
    const difference = a.turnStartedAtMs! - b.turnStartedAtMs!;
    return difference || (a.turnId ?? left).localeCompare(b.turnId ?? right);
  });
  return new Map(keys.map((key, index) => [key, index]));
}

/** Inserts a search window while retaining resident entry identities at overlaps. */
export function insertCanonicalHistorySearchDraft(state: Draft<CodexCanonicalConversationState>, createId: () => string, input: { readonly turns: readonly CodexCanonicalTurnState[]; readonly olderCursor: string | null; readonly newerCursor: string | null }): boolean {
  const history = state.turnHistory?.history;
  if (!history || input.turns.length === 0) return false;
  const id = `search:${createId()}`;
  if (history.islands.some((island) => island.id === id)) throw new Error(`Duplicate history island ID: ${id}`);
  const installed: Record<string, CodexCanonicalTurnState> = {};
  const lookup = (key: string) => installed[key] ?? history.entitiesByKey[key];
  const incoming = input.turns.map((turn, index) => {
    const value = turn.turnId == null ? `${id}:local:${index}` : `turn:${turn.turnId}`;
    const previous = lookup(value);
    installed[value] = previous ? mergeCodexCanonicalTurnState(previous, turn) : turn;
    return { key: `${id}:${index}`, value };
  });
  const retained = new Set(incoming.map((entry) => entry.value));
  const positions = searchPositions(history, incoming, lookup);
  if (!positions) return false;
  const boundary = (cursor: string | null, edge: "older" | "newer") => cursor == null
    ? exhaustedCodexHistoryBoundary(`${id}:${edge}`)
    : availableCodexHistoryBoundary(`${id}:${edge}`, { cursor, oldestLoadedTurnId: input.turns[0]?.turnId ?? null }, cursor);
  const dedupe = (entries: readonly CodexHistoryEntry[]) => {
    const result: CodexHistoryEntry[] = []; const seen = new Map<string, string>();
    for (const entry of entries) {
      const identity = lookup(entry.value)?.turnId;
      const previous = identity == null ? undefined : seen.get(identity);
      if (previous !== undefined) { if (previous !== entry.value) retained.delete(entry.value); continue; }
      if (identity != null) seen.set(identity, entry.value);
      result.push(entry);
    }
    return result.sort((a, b) => positions.get(a.value)! - positions.get(b.value)!);
  };
  const island: CodexHistoryIsland = { id, entries: dedupe(incoming), olderBoundary: boundary(input.olderCursor, "older"), newerBoundary: boundary(input.newerCursor, "newer") };
  const range = (value: CodexHistoryIsland) => {
    if (value.entries.length === 0) return null;
    let first = Infinity; let last = -Infinity;
    for (const entry of value.entries) {
      const position = positions.get(entry.value);
      if (position === undefined) throw new Error(`Missing search history position for ${entry.value}`);
      first = Math.min(first, position); last = Math.max(last, position);
    }
    return { first, last };
  };
  const incomingRange = range(island)!;
  const overlaps = history.islands.filter((value) => { const current = range(value); return current !== null && current.first <= incomingRange.last && incomingRange.first <= current.last; });
  const participants = [...overlaps, island];
  const first = participants.reduce((a, b) => range(b)!.first < range(a)!.first ? b : a);
  const last = participants.reduce((a, b) => range(b)!.last > range(a)!.last ? b : a);
  const merged = { id: last.id, entries: dedupe([...overlaps.flatMap((value) => value.entries), ...island.entries]), olderBoundary: first.olderBoundary, newerBoundary: last.newerBoundary };
  const islands = [...history.islands.filter((value) => !overlaps.includes(value)), merged].sort((a, b) => { const left = range(a); const right = range(b); return left === null || right === null ? 0 : left.first - right.first; });
  for (const [key, turn] of Object.entries(installed)) if (retained.has(key)) history.entitiesByKey[key] = turn as Draft<CodexCanonicalTurnState>;
  history.islands = islands as Draft<CodexHistoryIsland[]>;
  const entries = residentConversationTurnEntries(state);
  const turns = relocateCodexHydratedSteering(residentConversationTurns(state), (turnId) => residentConversationTurns(state).find((turn) => turn.turnId === turnId)?.itemsPagination);
  turns.forEach((turn, index) => { const current = conversationTurnDraft(state, entries[index]!.address); if (current && current.items !== turn.items) current.items = turn.items as Draft<CodexCanonicalTurnState["items"]>; });
  history.isComplete = islands.length === 1 && islands[0]!.olderBoundary.status === "exhausted" && islands[0]!.newerBoundary.status === "exhausted";
  return true;
}

/** Hydrates both sides of a persisted match and loads its item before placing the window. */
export async function hydrateCanonicalHistorySearchMatch(client: CanonicalHistoryClient, input: CanonicalHistorySearchMatch, createSearchIslandId: () => string): Promise<void> {
  const options = { priority: "interactive", source: "thread_hydration" } as const;
  const [older, newer] = await Promise.all(["desc", "asc"].map((sortDirection) => listCanonicalHistoryTurns(client, input.conversationId, { cursor: input.turnCursor, limit: 5, sortDirection: sortDirection as "desc" | "asc", requestOptions: options })));
  if (!client.getConversation(input.conversationId)) throw new Error("Conversation disappeared while hydrating a search match");
  const turns = [...older!.response.data.slice().reverse(), ...newer!.response.data.slice(1)];
  const pagination = { ...newer!.itemsPaginationByTurnId, ...older!.itemsPaginationByTurnId };
  const match = turns.find((turn) => turn.id === input.turnId);
  const items = match?.items.slice().reverse() ?? [];
  const seen = new Set(items.map((item) => item.id));
  const initial = pagination[input.turnId];
  const progress = initial ? { ...initial } : undefined;
  if (!match) throw new Error("Persisted conversation search match is no longer available");
  while (!seen.has(input.itemId)) {
    if (!progress || progress.hasLoadedOldest) break;
    const page = await readCanonicalHistoryItems(client, input.conversationId, input.turnId, progress.olderCursor, options);
    for (const item of page.items.filter((item) => !seen.has(item.id)).reverse()) { seen.add(item.id); items.push(item); }
    match.itemsView = page.nextCursor == null ? "full" : "summary";
    progress.olderCursor = page.nextCursor; progress.isLoadingOlder = false; progress.hasLoadedOldest = page.nextCursor == null;
    pagination[input.turnId] = progress;
  }
  if (!match || !seen.has(input.itemId)) throw new Error("Persisted conversation search match is no longer available");
  if (items.length !== match.items.length) match.items = items.reverse();
  const mapped = client.mapTurns(input.conversationId, turns, pagination);
  let applied = false;
  client.updateConversation(input.conversationId, (draft) => { applied = insertCanonicalHistorySearchDraft(draft, createSearchIslandId, { turns: mapped, olderCursor: older!.response.nextCursor, newerCursor: newer!.response.nextCursor }); });
  if (!applied) throw new Error("Persisted conversation search match could not be placed");
  client.broadcastSnapshot(input.conversationId);
}
