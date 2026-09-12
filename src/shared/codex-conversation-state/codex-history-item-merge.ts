import type { CodexCanonicalItem } from "./codex-conversation-state";

/** Inserts new items before their next resident anchor, preserving resident values on overlap. */
export function mergeCodexAnchoredHistoryItems<T>(
  existing: readonly T[],
  incoming: readonly T[],
  identity: (item: T) => string,
  direction: CodexHistoryItemMergeMode,
): T[] {
  const residentIds = new Set(existing.map(identity));
  let result = [...existing];
  let pending: T[] = [];
  let overlap = false;
  for (const item of incoming) {
    const id = identity(item);
    if (!residentIds.has(id)) {
      pending.push(item);
      continue;
    }
    overlap = true;
    if (pending.length === 0) continue;
    const index = result.findIndex((candidate) => identity(candidate) === id);
    result.splice(index, 0, ...pending);
    pending = [];
  }
  if (typeof direction === "object" && direction.snapshotBeforeItemId !== null) {
    const index = result.findIndex((item) => identity(item) === direction.snapshotBeforeItemId);
    if (index >= 0) return [...result.slice(0, index), ...pending, ...result.slice(index)];
  }
  return !overlap && direction === "prepend" ? [...pending, ...result] : [...result, ...pending];
}

export type CodexHistoryItemMergeMode =
  | "prepend"
  | "append"
  | { readonly snapshotBeforeItemId: string | null };

const isFinalAnswer = (
  item: CodexCanonicalItem,
): item is Extract<CodexCanonicalItem, { type: "agentMessage" }> =>
  item.type === "agentMessage" &&
  item.phase === "final_answer" &&
  typeof item.text === "string" &&
  typeof item.memoryCitation === "object";

/** Resolves persisted aliases before inserting incoming occurrences around resident anchors. */
export function mergeCodexCanonicalHistoryItems(
  existing: readonly CodexCanonicalItem[],
  incoming: readonly CodexCanonicalItem[],
  mode: CodexHistoryItemMergeMode,
  { preferIncomingItems = false }: { readonly preferIncomingItems?: boolean } = {},
) {
  const snapshot = typeof mode === "object";
  const byId = new Map(existing.map((item) => [item.id, item]));
  const updates = new Map<string, CodexCanonicalItem>();
  const anchors = new Map<string, string>();
  const aliases = new Map<string, string>();
  for (const item of incoming) {
    const resident = byId.get(item.id);
    if (resident) {
      anchors.set(item.id, resident.id);
      const preserveCitation =
        preferIncomingItems &&
        isFinalAnswer(item) &&
        isFinalAnswer(resident) &&
        item.memoryCitation == null &&
        resident.memoryCitation != null;
      updates.set(
        resident.id,
        preserveCitation
          ? { ...item, memoryCitation: resident.memoryCitation }
          : preferIncomingItems || (snapshot && item.type === "agentMessage")
            ? item
            : resident,
      );
      continue;
    }
    if (snapshot || !isFinalAnswer(item)) continue;
    const match = existing.find(
      (candidate) =>
        !updates.has(candidate.id) && isFinalAnswer(candidate) && candidate.text === item.text,
    );
    if (!match || !isFinalAnswer(match)) continue;
    anchors.set(item.id, match.id);
    aliases.set(item.id, match.id);
    updates.set(match.id, {
      ...match,
      ...item,
      id: preferIncomingItems ? item.id : match.id,
      memoryCitation: item.memoryCitation ?? match.memoryCitation,
    });
  }
  let result = existing.map((item) => updates.get(item.id) ?? item);
  let pending: CodexCanonicalItem[] = [];
  for (const item of incoming) {
    const anchor = anchors.get(item.id);
    if (anchor === undefined) {
      pending.push(item);
      continue;
    }
    if (pending.length === 0) continue;
    const index = result.findIndex(
      (candidate) => candidate.id === (updates.get(anchor)?.id ?? anchor),
    );
    if (index < 0) continue;
    result = [...result.slice(0, index), ...pending, ...result.slice(index)];
    pending = [];
  }
  if (pending.length === 0) return { items: result, aliases };
  if (snapshot && mode.snapshotBeforeItemId !== null) {
    const index = result.findIndex((item) => item.id === mode.snapshotBeforeItemId);
    if (index >= 0)
      return { items: [...result.slice(0, index), ...pending, ...result.slice(index)], aliases };
  }
  return {
    items:
      anchors.size === 0 && mode === "prepend" ? [...pending, ...result] : [...result, ...pending],
    aliases,
  };
}
