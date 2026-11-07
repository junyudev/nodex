const RANK_WIDTH = 32;

export interface FractionalRankPlan {
  readonly rankKey: string;
  /** Existing identities whose internal key must be rewritten first. */
  readonly rebalancedRankKeys: ReadonlyMap<string, string>;
}

export type FractionalRankErrorCode = "anchor_not_found" | "rebalance_limit";

export class FractionalRankError extends Error {
  constructor(
    readonly code: FractionalRankErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "FractionalRankError";
  }
}

export const isFractionalRankKey = (value: string): boolean =>
  value.length === RANK_WIDTH && /^[0-9a-f]{32}$/.test(value);
