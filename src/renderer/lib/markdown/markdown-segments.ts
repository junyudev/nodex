import {
  createMarkdownCache,
  MARKDOWN_SEGMENT_CACHE_MAX_KEYS,
  MARKDOWN_SEGMENT_CACHE_MAX_TEXT_UNITS,
} from "./markdown-cache";

export interface MarkdownSegmenter {
  segment(value: string): Iterable<{ readonly segment: string; readonly isWordLike?: boolean }>;
}

/** Word punctuation and spaces remain attached, preserving the exact text surface for Find. */
export function createMarkdownTextSegmentCache() {
  const fallback = createMarkdownCache<readonly string[]>({
    maxKeys: MARKDOWN_SEGMENT_CACHE_MAX_KEYS,
    refreshOnRead: false,
  });
  const bySegmenter = new WeakMap<MarkdownSegmenter, typeof fallback>();
  return {
    read(text: string, decorated: boolean, segmenter: MarkdownSegmenter | null): readonly string[] {
      let cache = segmenter ? bySegmenter.get(segmenter) : fallback;
      if (!cache) {
        cache = createMarkdownCache({
          maxKeys: MARKDOWN_SEGMENT_CACHE_MAX_KEYS,
          refreshOnRead: false,
        });
        if (segmenter) bySegmenter.set(segmenter, cache);
      }
      const key = `${decorated ? "decorated" : "plain"}:${text}`;
      const previous = cache.get(key);
      if (previous) return previous;
      const segments: string[] = [];
      const append = (value: string) => {
        const index = Math.max(segments.length - 1, 0);
        segments[index] = (segments[index] ?? "") + value;
      };
      if (/^[\x00-\x7f]*$/u.test(text)) {
        for (const part of text.matchAll(/[a-zA-Z0-9]+|[^a-zA-Z0-9]+/gu)) {
          if (/^[a-zA-Z0-9]/u.test(part[0])) segments.push(part[0]);
          else append(part[0]);
        }
      } else if (segmenter) {
        for (const { segment, isWordLike } of segmenter.segment(text)) {
          if (isWordLike && !/^\s*$/u.test(segment)) segments.push(segment);
          else append(segment);
        }
      } else {
        segments.push(...(text.match(/\s*\S+(?:\s+|$)/gu) ?? (text ? [text] : [])));
      }
      const value = Object.freeze(segments);
      if (text.length <= MARKDOWN_SEGMENT_CACHE_MAX_TEXT_UNITS) cache.set(key, value);
      return value;
    },
  };
}

export interface MarkdownSegment {
  readonly content: string;
  readonly key: string;
}
export interface MarkdownSegmentCandidate {
  readonly segments: readonly MarkdownSegment[];
  readonly nextId: number;
}

/** Render may prepare many candidates; only the committed one owns subsequent IDs. */
export function createMarkdownSegmentOwner() {
  let committed: MarkdownSegmentCandidate = { segments: [], nextId: 0 };
  return {
    prepare(contents: readonly string[]): MarkdownSegmentCandidate {
      const unused = new Set(committed.segments.map((_value, index) => index));
      const equal = new Map<string, number[]>();
      for (let index = committed.segments.length - 1; index >= 0; index -= 1) {
        const value = committed.segments[index]!;
        const indexes = equal.get(value.content) ?? [];
        indexes.push(index);
        equal.set(value.content, indexes);
      }
      let nextId = committed.nextId;
      const segments = contents.map((content, index) => {
        const previous = committed.segments[index];
        if (
          previous &&
          unused.has(index) &&
          (previous.content === content ||
            (previous.content.length > 0 && content.startsWith(previous.content)))
        ) {
          unused.delete(index);
          return { content, key: previous.key };
        }
        const matches = equal.get(content);
        let matchedIndex = matches?.pop();
        while (matchedIndex !== undefined && !unused.has(matchedIndex))
          matchedIndex = matches?.pop();
        if (matchedIndex !== undefined) {
          unused.delete(matchedIndex);
          return { content, key: committed.segments[matchedIndex]!.key };
        }
        return { content, key: `fade-segment-${nextId++}` };
      });
      return { segments, nextId };
    },
    commit(candidate: MarkdownSegmentCandidate): void {
      committed = candidate;
    },
  };
}

/** Timing and settlement belong to a mounted document, separate from syntax and text caches. */
export function createMarkdownSegmentTimeline(now: () => number = () => performance.now()) {
  let active = true;
  let current = new Set<string>();
  let nextStartAt = 0;
  const starts = new Map<string, number>();
  const delays = new Map<string, number>();
  const settled = new Set<string>();
  const attached = new WeakMap<object, string>();
  return {
    commit(keys: readonly string[], animate: boolean): void {
      current = new Set(keys);
      if (!animate) keys.forEach((key) => settled.add(key));
    },
    isSettled(key: string): boolean {
      return settled.has(key);
    },
    attach(element: object, key: string, delay: number, maximum?: number): number | null {
      if (!active) return null;
      if (attached.get(element) === key) return delays.get(key) ?? 0;
      const time = now();
      const previous = starts.get(key);
      const start =
        previous ??
        Math.min(Math.max(nextStartAt, time), maximum === undefined ? Infinity : time + maximum);
      const value = Math.round(start - time);
      if (previous === undefined) {
        starts.set(key, start);
        delays.set(key, value);
        nextStartAt = start + delay;
      }
      attached.set(element, key);
      return value;
    },
    settle(key: string, ownTarget: boolean): void {
      if (active && ownTarget && current.has(key)) settled.add(key);
    },
    activate(): void {
      active = true;
    },
    dispose(): void {
      active = false;
      current.clear();
    },
  };
}

export const markdownTextSegmentCache = createMarkdownTextSegmentCache();
