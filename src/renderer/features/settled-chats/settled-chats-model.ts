/** When a run of settled chats was settled, from the reader's own calendar. */
export type SettledDayBucket =
  | { readonly kind: "today" }
  | { readonly kind: "yesterday" }
  | { readonly kind: "previous-7-days" }
  | { readonly kind: "previous-30-days" }
  | { readonly kind: "month"; readonly year: number; readonly month: number };

export interface SettledDayGroup<T> {
  readonly key: string;
  readonly bucket: SettledDayBucket;
  readonly items: readonly T[];
}

const DAY_MS = 86_400_000;

function startOfLocalDay(time: number): number {
  const day = new Date(time);
  day.setHours(0, 0, 0, 0);
  return day.getTime();
}

/** Whole local calendar days from `time` to `now`; a clock change never splits a day. */
function localDaysBefore(time: number, now: number): number {
  return Math.round((startOfLocalDay(now) - startOfLocalDay(time)) / DAY_MS);
}

export function settledDayBucket(settledAt: number, now: number): SettledDayBucket {
  const days = localDaysBefore(settledAt, now);
  if (days <= 0) return { kind: "today" };
  if (days === 1) return { kind: "yesterday" };
  if (days < 7) return { kind: "previous-7-days" };
  if (days < 30) return { kind: "previous-30-days" };
  const date = new Date(settledAt);
  return { kind: "month", year: date.getFullYear(), month: date.getMonth() };
}

function bucketKey(bucket: SettledDayBucket): string {
  return bucket.kind === "month" ? `month:${bucket.year}-${bucket.month}` : bucket.kind;
}

/**
 * Groups a list already ordered newest settlement first into runs that share a bucket. A row
 * Core read without a settlement time joins the run before it, so the order never breaks.
 */
export function groupBySettledDay<T>(
  items: readonly T[],
  settledAtOf: (item: T) => number | null | undefined,
  now: number,
): readonly SettledDayGroup<T>[] {
  const groups: { key: string; bucket: SettledDayBucket; items: T[] }[] = [];
  for (const item of items) {
    const settledAt = settledAtOf(item);
    const last = groups.at(-1);
    if (settledAt == null && last) {
      last.items.push(item);
      continue;
    }
    const bucket =
      settledAt == null ? ({ kind: "today" } as const) : settledDayBucket(settledAt, now);
    const key = bucketKey(bucket);
    if (last?.key === key) last.items.push(item);
    else groups.push({ key, bucket, items: [item] });
  }
  return groups;
}
