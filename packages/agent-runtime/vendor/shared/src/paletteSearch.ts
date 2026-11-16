export interface SearchRange {
  readonly start: number;
  readonly end: number;
}

export interface SearchTextPart {
  readonly text: string;
  readonly highlighted: boolean;
}

export function splitSearchText(text: string, ranges: readonly SearchRange[]): SearchTextPart[] {
  const parts: SearchTextPart[] = [];
  let cursor = 0;
  for (const range of ranges) {
    if (range.start > cursor) parts.push({ text: text.slice(cursor, range.start), highlighted: false });
    if (range.end > Math.max(range.start, cursor)) parts.push({
      text: text.slice(Math.max(range.start, cursor), range.end),
      highlighted: true,
    });
    cursor = Math.max(cursor, range.end);
  }
  if (cursor < text.length) parts.push({ text: text.slice(cursor), highlighted: false });
  return parts;
}

const HALF_LIFE = 14 * 24 * 60 * 60 * 1_000;
const decay = (age: number) => Math.pow(0.5, Math.max(0, age) / HALF_LIFE);

export interface ThreadOpenStats {
  readonly openedAt: number;
  readonly score: number;
  readonly picks: readonly { readonly query: string; readonly at: number }[];
}

export interface MessageSearchRank {
  readonly word: boolean;
  readonly wordQuality: number;
  readonly quality: number;
  readonly score: number;
  readonly authoredAt: string;
}

/** Usage and frequency break ties after the kernel rank and ordered-phrase bonus. */
export function scoreMessageSearch(
  match: {
    readonly quality?: number;
    readonly wordQuality?: number;
    readonly hits?: number;
    readonly messageCreatedAt?: string | null;
  },
  subject: { readonly activityAt: number | null; readonly opens?: Pick<ThreadOpenStats, "openedAt" | "score"> | null },
  now: number,
): MessageSearchRank {
  const wordQuality = match.wordQuality ?? match.quality ?? 1;
  const recency = subject.activityAt === null ? 0 : decay(now - subject.activityAt);
  const opens = subject.opens ? subject.opens.score * decay(now - subject.opens.openedAt) : 0;
  const usage = Math.min(2.5, 1 + recency + 0.5 * Math.log2(1 + opens));
  return {
    word: wordQuality > 0.5,
    wordQuality,
    quality: match.quality ?? wordQuality,
    score: (1 + Math.log2(1 + (match.hits ?? 1))) * usage,
    authoredAt: match.messageCreatedAt ?? "",
  };
}

export const compareMessageSearchRank = (left: MessageSearchRank, right: MessageSearchRank): number =>
  right.wordQuality - left.wordQuality ||
  right.quality - left.quality ||
  right.score - left.score ||
  right.authoredAt.localeCompare(left.authoredAt);
