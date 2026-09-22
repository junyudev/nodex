import type { CodexConversationItem, CodexConversationTurn } from "./types";

function equalContent(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (!left || !right || typeof left !== "object" || typeof right !== "object") return false;
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  const keys = Object.keys(left);
  return (
    keys.length === Object.keys(right).length &&
    keys.every(
      (key) =>
        Object.hasOwn(right, key) && equalContent(Reflect.get(left, key), Reflect.get(right, key)),
    )
  );
}

function itemContent(item: CodexConversationItem): unknown {
  if (item.rawItem && typeof item.rawItem === "object") {
    const { id: _id, ...content } = item.rawItem as Record<string, unknown>;
    return content;
  }
  // Projected overlays carry transport identities and timestamps absent from canonical items.
  const {
    threadId: _thread,
    turnId: _turn,
    itemId: _item,
    entryId: _entry,
    rawItemId: _raw,
    createdAt: _created,
    updatedAt: _updated,
    sequence: _sequence,
    source: _source,
    timeLabel: _time,
    ...content
  } = item;
  return content;
}

/** Inherited history is readable before execution resumes; item identity is not content identity. */
export function selectOwnConversationTurns(
  turns: readonly CodexConversationTurn[],
  parentTurns: readonly CodexConversationTurn[],
): CodexConversationTurn[] {
  if (parentTurns.length === 0) return [...turns];
  const parentIds = new Set(
    parentTurns.flatMap((turn) => (turn.turnId === null ? [] : [turn.turnId])),
  );
  const parentContent = parentTurns.map((turn) => turn.items.map(itemContent));
  return turns.filter((turn) => {
    if (turn.turnId !== null && parentIds.has(turn.turnId)) return false;
    if (turn.items.length === 0) return true;
    const content = turn.items.map(itemContent);
    return !parentContent.some(
      (parent) =>
        parent.length >= content.length &&
        content.every((item, index) => equalContent(item, parent[index])),
    );
  });
}
