import type { ThreadReadEvidence } from "./history-contracts.ts";

interface Coverage {
  readonly version: string;
  readonly totalChars: number;
  readonly ranges: readonly (readonly [number, number])[];
  readonly touchedAt: number;
}

/** Volatile read proofs hold coordinates, never content. Eviction can only leave delivery unread. */
export const makeHistoryReadCoverage = (
  options: {
    readonly maximumItems?: number;
    readonly maximumRanges?: number;
    readonly idleMs?: number;
  } = {},
) => {
  const entries = new Map<string, Coverage>();
  const maximumItems = options.maximumItems ?? 256;
  const maximumRanges = options.maximumRanges ?? 128;
  const idleMs = options.idleMs ?? 24 * 60 * 60 * 1000;
  if (
    ![maximumItems, maximumRanges, idleMs].every(
      (value) => Number.isSafeInteger(value) && value > 0,
    )
  )
    throw new RangeError("Read coverage bounds must be positive safe integers");
  return (input: {
    readonly callerThreadId: string;
    readonly callerRunId: string;
    readonly targetThreadId: string;
    readonly targetRunId: string | null;
    readonly evidence: ThreadReadEvidence;
    readonly currentVersion: string;
    readonly totalChars: number;
    readonly now: number;
  }): boolean => {
    const { evidence } = input;
    for (const [key, value] of entries)
      if (input.now - value.touchedAt >= idleMs) entries.delete(key);
    const key = JSON.stringify([
      input.callerThreadId,
      input.callerRunId,
      input.targetThreadId,
      input.targetRunId,
      evidence.sourceThreadId,
      evidence.itemId,
      evidence.format,
    ]);
    const previous = entries.get(key);
    if (
      previous &&
      (previous.version !== input.currentVersion || previous.totalChars !== input.totalChars)
    )
      entries.delete(key);
    if (
      evidence.contentVersion !== input.currentVersion ||
      evidence.totalChars !== input.totalChars ||
      ![evidence.offset, evidence.length, evidence.totalChars].every(Number.isSafeInteger) ||
      evidence.offset < 0 ||
      evidence.length < 0 ||
      evidence.offset > input.totalChars ||
      evidence.length > input.totalChars - evidence.offset
    )
      return false;
    const current = entries.get(key);
    const sorted = [
      ...(current?.ranges ?? []),
      [evidence.offset, evidence.offset + evidence.length] as const,
    ].sort((left, right) => left[0] - right[0]);
    const ranges: Array<[number, number]> = [];
    for (const [start, end] of sorted) {
      const last = ranges.at(-1);
      if (last && start <= last[1]) last[1] = Math.max(last[1], end);
      else ranges.push([start, end]);
    }
    const bounded =
      ranges.length <= maximumRanges
        ? ranges
        : [[evidence.offset, evidence.offset + evidence.length] as const];
    entries.delete(key);
    while (entries.size >= maximumItems) entries.delete(entries.keys().next().value!);
    entries.set(key, {
      version: input.currentVersion,
      totalChars: input.totalChars,
      ranges: bounded,
      touchedAt: input.now,
    });
    return bounded.length === 1 && bounded[0]![0] === 0 && bounded[0]![1] === input.totalChars;
  };
};
