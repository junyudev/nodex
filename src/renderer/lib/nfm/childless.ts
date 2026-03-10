import type { NfmBlockType } from "./types";

const CHILDLESS_NFM_BLOCK_TYPES: ReadonlySet<NfmBlockType> = new Set([
  "cardRef",
  "toggleListInlineView",
]);

export function isChildlessNfmBlockType(type: NfmBlockType): boolean {
  return CHILDLESS_NFM_BLOCK_TYPES.has(type);
}

export function isChildlessNfmLikeType(type: unknown): boolean {
  if (typeof type !== "string") return false;
  return CHILDLESS_NFM_BLOCK_TYPES.has(type as NfmBlockType);
}
