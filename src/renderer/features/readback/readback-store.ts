import type { Readback, ReadbackEvent } from "../../../shared/readback";

/** How a Readback left the window. */
export type ReadbackCloseReason =
  /** The person opened its chat from the card. */
  | "opened"
  /** The person replied from the card. */
  | "replied"
  /** The person closed it. */
  | "dismissed"
  /** Its time on screen ran out. */
  | "expired"
  /** Main took it back: the chat was seen, its Run ended in the background, or Readback was off. */
  | "withdrawn"
  /** A newer Readback of the same chat took its place. */
  | "replaced"
  /** Newer Readbacks of other chats pushed it out of the stack. */
  | "overflow";

/** Most Readbacks on screen at once; the oldest leaves first. */
export const READBACK_STACK_LIMIT = 3;

export interface ReadbackStore {
  /** Readbacks on screen, newest first. */
  readonly getSnapshot: () => readonly Readback[];
  readonly subscribe: (listener: () => void) => () => void;
  readonly apply: (event: ReadbackEvent) => void;
  readonly close: (id: string, reason: ReadbackCloseReason) => void;
}

export interface ReadbackStoreOptions {
  readonly limit?: number;
  /** Called once for every Readback that leaves the window. */
  readonly onClose?: (readback: Readback, reason: ReadbackCloseReason) => void;
}

/**
 * The window's Readbacks on screen. Main decides which Readbacks exist and withdraws them;
 * this owner only orders them, keeps one per chat, and bounds the stack.
 */
export function createReadbackStore(options: ReadbackStoreOptions = {}): ReadbackStore {
  const limit = options.limit ?? READBACK_STACK_LIMIT;
  const listeners = new Set<() => void>();
  let readbacks: readonly Readback[] = [];

  const commit = (
    next: readonly Readback[],
    closed: readonly (readonly [Readback, ReadbackCloseReason])[],
  ) => {
    readbacks = next;
    for (const [readback, reason] of closed) options.onClose?.(readback, reason);
    for (const listener of [...listeners]) listener();
  };

  const show = (readback: Readback) => {
    if (readbacks.some((current) => current.id === readback.id)) return;
    const closed: [Readback, ReadbackCloseReason][] = [];
    const others = readbacks.filter((current) => {
      if (current.sessionId !== readback.sessionId) return true;
      closed.push([current, "replaced"]);
      return false;
    });
    const next = [readback, ...others];
    for (const overflow of next.slice(limit)) closed.push([overflow, "overflow"]);
    commit(next.slice(0, limit), closed);
  };

  const close = (id: string, reason: ReadbackCloseReason) => {
    const readback = readbacks.find((current) => current.id === id);
    if (!readback) return;
    commit(
      readbacks.filter((current) => current.id !== id),
      [[readback, reason]],
    );
  };

  return {
    getSnapshot: () => readbacks,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    apply: (event) => {
      if (event.type === "show") show(event.readback);
      else close(event.id, "withdrawn");
    },
    close,
  };
}
