import type { AgentRuntimeOperations } from "@nodex/agent-runtime/contracts";
import type { SessionQueueInput } from "./session-control-schemas";
export type SessionQueueResult = AgentRuntimeOperations["thread.queue-control"]["output"];
export type SessionQueueEntry = Extract<SessionQueueResult, { queuedId: string }>;
export class SessionQueueError extends Error {
  constructor(
    readonly reason: "not_queued" | "invalid_cursor" | "protected_entry" | "unsupported",
    message: string,
  ) {
    super(message);
  }
}
export const queueText = (text: string, max: number) => {
  const chars = Array.from(text);
  return { text: chars.slice(0, max).join(""), truncated: chars.length > max };
};
export const requireQueuedEntry = <T extends { readonly queuedId: string }>(
  entries: readonly T[],
  queuedId: string,
): T => {
  const found = entries.find((entry) => entry.queuedId === queuedId);
  if (!found) throw new SessionQueueError("not_queued", "The message is no longer queued");
  return found;
};
export const reorderedQueueIds = (
  ids: readonly string[],
  moving: string,
  before: string | null,
): string[] => {
  if (!ids.includes(moving) || (before !== null && !ids.includes(before)))
    throw new SessionQueueError("not_queued", "The message is no longer queued");
  if (before === moving) return [...ids];
  const result = ids.filter((id) => id !== moving);
  result.splice(before === null ? result.length : result.indexOf(before), 0, moving);
  return result;
};
/** Native owner projections use stable IDs for bounded queue continuations. */
export const readSessionQueue = (
  threadId: string,
  entries: readonly SessionQueueEntry[],
  input: Extract<SessionQueueInput, { action: "list" | "read" }>,
): SessionQueueResult => {
  if (input.action === "read") {
    const found = requireQueuedEntry(entries, input.queuedId);
    return { ...found, ...queueText(found.text, 6000) };
  }
  const prefix = `${encodeURIComponent(threadId)}:`;
  if (input.cursor !== undefined && !input.cursor.startsWith(prefix))
    throw new SessionQueueError("invalid_cursor", "Queue cursor belongs to another execution");
  const after = input.cursor?.slice(prefix.length);
  const offset =
    after === undefined ? 0 : entries.findIndex((entry) => entry.queuedId === after) + 1;
  if (after !== undefined && offset === 0)
    throw new SessionQueueError("invalid_cursor", "Queue cursor is no longer available");
  const page = entries.slice(offset, offset + input.limit);
  return {
    items: page.map((entry) => ({ ...entry, ...queueText(entry.text, 250) })),
    nextCursor: offset + page.length < entries.length ? `${prefix}${page.at(-1)!.queuedId}` : null,
  };
};
