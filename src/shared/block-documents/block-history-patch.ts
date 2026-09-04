import type { BlockTreeValue } from "./block-document-codec";

/** Flat semantic coordinates; children are represented by their own placements. */
export interface BlockHistoryState {
  readonly type: string;
  readonly props: Readonly<Record<string, BlockTreeValue>>;
  readonly content: BlockTreeValue | null;
  readonly parentBlockId: string | null;
  readonly beforeBlockId: string | null;
}

export interface BlockHistoryChange {
  readonly blockId: string;
  readonly before: BlockHistoryState | null;
  readonly after: BlockHistoryState | null;
}

export interface BlockHistoryPatch {
  readonly changes: readonly BlockHistoryChange[];
}
