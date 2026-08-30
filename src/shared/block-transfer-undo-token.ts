/** Opaque, one-shot authority for a Core-owned Block transfer inverse. */
export interface BlockTransferUndoToken {
  readonly transferOperationId: string;
  readonly recipeHash: string;
  readonly storeEpoch: string;
}
