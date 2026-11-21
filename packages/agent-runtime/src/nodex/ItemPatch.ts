/**
 * Transcript delivery sends a live item's next version as a patch against the version the same
 * subscriber last received on the same subscription. Streamed text therefore crosses each process
 * boundary once instead of once per update. Both ends use these functions, so a patch always means
 * the same thing to the Runtime that builds it and the reader that applies it.
 *
 * Dependency-free: renderer code imports it directly.
 */

/** An item in its JSON wire form, as one subscription delivers it. */
export type WireItem = { readonly id: string; readonly type: string } & Readonly<
  Record<string, unknown>
>;

export interface ItemPatch {
  readonly itemId: string;
  /** Fields whose value changed, including text that was rewritten rather than extended. */
  readonly set?: Readonly<Record<string, unknown>>;
  /** Fields the previous version had and the next version lacks. */
  readonly unset?: ReadonlyArray<string>;
  /** Text appended to `field` exactly at `offset`, the UTF-16 length of the previous value. */
  readonly append?: { readonly field: string; readonly offset: number; readonly text: string };
}

const TEXT_FIELD: Readonly<Record<string, string>> = {
  user_message: "text",
  assistant_message: "text",
  reasoning: "text",
  proposed_plan: "markdown",
};

/** While an item can still change, its subscriber keeps it as the base for the next patch. */
export function isLiveWireItem(item: WireItem): boolean {
  return (
    item.status === "pending" ||
    item.status === "running" ||
    item.status === "waiting" ||
    item.streaming === true
  );
}

function sameWireValue(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (typeof left !== "object" || typeof right !== "object" || left === null || right === null)
    return false;
  // Both sides come from the same codec, so equal values serialize with the same key order.
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * The patch that turns `previous` into `next`, or null when the two are not versions of one item
 * of one type, which a subscriber must receive whole.
 */
export function diffWireItem(previous: WireItem, next: WireItem): ItemPatch | null {
  if (previous.id !== next.id || previous.type !== next.type) return null;
  const field = TEXT_FIELD[next.type];
  const set: Record<string, unknown> = {};
  let changed = false;
  for (const key of Object.keys(next)) {
    if (key === field || sameWireValue(previous[key], next[key])) continue;
    set[key] = next[key];
    changed = true;
  }
  const unset = Object.keys(previous).filter((key) => !(key in next));
  let append: ItemPatch["append"];
  if (field !== undefined && field in next) {
    const before = previous[field];
    const after = next[field];
    if (
      typeof before === "string" &&
      typeof after === "string" &&
      after.length >= before.length &&
      after.startsWith(before)
    ) {
      if (after.length > before.length)
        append = { field, offset: before.length, text: after.slice(before.length) };
    } else if (!sameWireValue(before, after)) {
      set[field] = after;
      changed = true;
    }
  }
  return {
    itemId: next.id,
    ...(changed ? { set } : {}),
    ...(unset.length > 0 ? { unset } : {}),
    ...(append ? { append } : {}),
  };
}

/** `previous` with `patch` applied, or null when the patch was built against another version. */
export function applyWireItemPatch(previous: WireItem, patch: ItemPatch): WireItem | null {
  if (patch.itemId !== previous.id) return null;
  const next: Record<string, unknown> = { ...previous, ...patch.set };
  for (const key of patch.unset ?? []) delete next[key];
  if (patch.append) {
    const current = previous[patch.append.field];
    if (typeof current !== "string" || current.length !== patch.append.offset) return null;
    next[patch.append.field] = current + patch.append.text;
  }
  return next as WireItem;
}

/**
 * The live items one subscriber holds, in delivery order. The Runtime and the reader keep one
 * each per subscription; the Runtime's bound is the smaller, so a reader never lacks a base the
 * Runtime patches against.
 */
export class LiveWireItems {
  readonly #items = new Map<string, WireItem>();
  readonly limit: number;
  constructor(limit: number) {
    this.limit = limit;
  }

  get(itemId: string): WireItem | undefined {
    return this.#items.get(itemId);
  }

  /** Remember the version just delivered while it is live; forget it once it settles. */
  remember(item: WireItem): void {
    this.#items.delete(item.id);
    if (!isLiveWireItem(item)) return;
    this.#items.set(item.id, item);
    if (this.#items.size > this.limit) {
      const oldest = this.#items.keys().next().value;
      if (oldest !== undefined) this.#items.delete(oldest);
    }
  }

  clear(): void {
    this.#items.clear();
  }

  get size(): number {
    return this.#items.size;
  }
}

/** Live items the Runtime patches against for one transcript subscription. */
export const RUNTIME_LIVE_ITEM_LIMIT = 64;
/** Live items a reader keeps; at least the Runtime's bound. */
export const READER_LIVE_ITEM_LIMIT = 256;
