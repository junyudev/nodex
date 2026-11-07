import { type Draft } from "immer";
import type {
  CodexCanonicalConversationState,
  CodexCanonicalItem,
  CodexCanonicalTurnState,
} from "./codex-conversation-state";

/** Exact `WQ`: replace the first same-ID row regardless of its item type. */
export function upsertCodexCanonicalItemById(
  items: readonly CodexCanonicalItem[],
  item: CodexCanonicalItem,
): readonly CodexCanonicalItem[] {
  const itemIndex = items.findIndex((candidate) => candidate.id === item.id);
  if (itemIndex < 0) {
    return [...items, item];
  }

  const nextItems = [...items];
  nextItems[itemIndex] = item;
  return nextItems;
}

export type CodexConversationTurnAddress =
  | { readonly kind: "canonical"; readonly entityKey: string }
  | { readonly kind: "turns"; readonly index: number };

export interface CodexConversationTurnEntry {
  readonly address: CodexConversationTurnAddress;
  readonly turn: CodexCanonicalTurnState;
}

/** Resident canonical order excludes the presentation overlay. */
export function residentConversationTurnEntries(
  state: CodexCanonicalConversationState | null | undefined,
): readonly CodexConversationTurnEntry[] {
  if (!state) return [];
  const history = state.turnHistory?.history;
  if (!history)
    return state.turns.map((turn, index) => ({ address: { kind: "turns", index }, turn }));
  return history.islands.flatMap((island) =>
    island.entries.flatMap(({ value }) => {
      const turn = history.entitiesByKey[value];
      return turn ? [{ address: { kind: "canonical" as const, entityKey: value }, turn }] : [];
    }),
  );
}

export function residentConversationTurns(
  state: CodexCanonicalConversationState | null | undefined,
): readonly CodexCanonicalTurnState[] {
  return residentConversationTurnEntries(state).map(({ turn }) => turn);
}

export function conversationTurnDraft(
  state: Draft<CodexCanonicalConversationState>,
  address: CodexConversationTurnAddress,
): Draft<CodexCanonicalTurnState> | undefined {
  return address.kind === "canonical"
    ? state.turnHistory?.history.entitiesByKey[address.entityKey]
    : state.turns[address.index];
}

export function appendConversationTurnDraft(
  state: Draft<CodexCanonicalConversationState>,
  turn: CodexCanonicalTurnState,
  createId: () => string,
): Draft<CodexCanonicalTurnState> {
  const history = state.turnHistory?.history;
  if (!history) {
    state.turns.push(turn as Draft<CodexCanonicalTurnState>);
    return state.turns[state.turns.length - 1]!;
  }
  const last = history.islands.at(-1);
  let tail = last?.newerBoundary.status === "exhausted" ? last : undefined;
  if (!tail) {
    const id = `local-live-tail:${createId()}`;
    tail = {
      id,
      entries: [],
      olderBoundary: { status: "exhausted", boundaryId: `${id}:older` },
      newerBoundary: { status: "exhausted", boundaryId: `${id}:newer` },
    };
    history.islands.push(tail);
    history.isComplete = false;
  }
  const key = `${tail.id}:local:${createId()}`;
  tail.entries.push({ key, value: key });
  history.entitiesByKey[key] = turn as Draft<CodexCanonicalTurnState>;
  return history.entitiesByKey[key]!;
}

export function removeConversationTurnDraft(
  state: Draft<CodexCanonicalConversationState>,
  address: CodexConversationTurnAddress,
): void {
  if (address.kind === "turns") {
    state.turns.splice(address.index, 1);
    return;
  }
  const history = state.turnHistory?.history;
  if (!history) return;
  for (let index = 0; index < history.islands.length; index += 1) {
    const island = history.islands[index]!;
    const entryIndex = island.entries.findIndex(({ value }) => value === address.entityKey);
    if (entryIndex < 0) continue;
    island.entries.splice(entryIndex, 1);
    delete history.entitiesByKey[address.entityKey];
    if (
      island.entries.length === 0 &&
      index === history.islands.length - 1 &&
      island.newerBoundary.status === "exhausted" &&
      !history.isComplete
    )
      history.islands.splice(index, 1);
    return;
  }
}
