/** Reasoning indexes are safe non-negative integers; omitted earlier parts stay dense. */
export function canAppendCodexReasoningPartDelta(value: unknown, index: number): boolean {
  return Array.isArray(value) && Number.isSafeInteger(index) && index >= 0;
}

/** Canonical/native arrays retain every part; a text delta fills any missing preceding slots. */
export function appendCodexReasoningPartDelta(
  value: unknown,
  index: number,
  delta: string,
): readonly string[] {
  if (!Array.isArray(value) || !canAppendCodexReasoningPartDelta(value, index)) return [];
  if (index < value.length && delta.length === 0) return value as readonly string[];
  const parts = [...value] as string[];
  while (parts.length <= index) parts.push("");
  parts[index] = `${parts[index] ?? ""}${delta}`;
  return parts;
}
