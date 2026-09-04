/** Core-authored address invalidation, separate from collaborative content edits. */
export interface DocumentHistoryFence {
  readonly headSeq: number;
  readonly blockIds: readonly string[];
  /** Bounded resync may conservatively require semantic replay for the whole body. */
  readonly documentWide: boolean;
}

export const isDocumentHistoryFence = (
  value: unknown,
  headSeq: number,
): value is DocumentHistoryFence => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).length !== 3 ||
    record.headSeq !== headSeq ||
    !Number.isSafeInteger(headSeq) ||
    headSeq < 0 ||
    typeof record.documentWide !== "boolean" ||
    !Array.isArray(record.blockIds) ||
    record.blockIds.length > 512 ||
    record.blockIds.some((id) => typeof id !== "string" || id.length === 0 || id.length > 512) ||
    new Set(record.blockIds).size !== record.blockIds.length ||
    (record.documentWide && record.blockIds.length !== 0)
  )
    return false;
  return new TextEncoder().encode(JSON.stringify(record.blockIds)).byteLength <= 16 * 1024;
};
