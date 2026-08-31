/**
 * Reasoning arrives as independently indexed parts. Keep that indexing dense and bounded so a
 * malformed index can never turn one notification into a sparse-array allocation.
 */
export const CODEX_REASONING_MAX_PARTS = 256;

export const CODEX_REASONING_PARTS_TRUNCATION_MARKER =
  "[Earlier reasoning parts omitted to keep this task responsive]";

function isValidIndex(index: number): boolean {
  return Number.isSafeInteger(index) && index >= 0;
}

function isBoundedReasoningParts(value: unknown): value is readonly unknown[] {
  if (!Array.isArray(value) || value.length > CODEX_REASONING_MAX_PARTS) return false;
  return true;
}

/** A delta may replace an extant part or append exactly one next part; gaps are invalid. */
export function canAppendCodexReasoningPartDelta(value: unknown, index: number): boolean {
  if (!isValidIndex(index)) return false;
  if (!isBoundedReasoningParts(value)) return false;
  const parts = value;
  return (
    index < parts.length || (index === parts.length && parts.length < CODEX_REASONING_MAX_PARTS)
  );
}

/**
 * Applies a previously admitted delta without ever padding a sparse array. The caller must first
 * check `canAppendCodexReasoningPartDelta`.
 */
export function appendCodexReasoningPartDelta(
  value: unknown,
  index: number,
  delta: string,
): readonly string[] {
  if (!isBoundedReasoningParts(value) || !canAppendCodexReasoningPartDelta(value, index)) return [];
  if (index < value.length && delta.length === 0) return value as readonly string[];

  const parts = value.map((part) => (typeof part === "string" ? part : ""));

  if (index === parts.length) return [...parts, delta];
  const next = [...parts];
  next[index] = `${next[index] ?? ""}${delta}`;
  return next;
}

/** Bounds completed/initial reasoning items before they enter canonical state. */
export function boundCodexReasoningParts(parts: string[]): string[] {
  if (parts.length <= CODEX_REASONING_MAX_PARTS) return parts;
  return [
    ...parts.slice(0, CODEX_REASONING_MAX_PARTS - 1),
    CODEX_REASONING_PARTS_TRUNCATION_MARKER,
  ];
}
