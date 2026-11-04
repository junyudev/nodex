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
  let contentIndexesBuilt = 0;
  return {
    prepare(contents: readonly string[]): MarkdownSegmentCandidate {
      const previous = committed.segments;
      let nextId = committed.nextId;
      const identify = (content: string, old?: MarkdownSegment) =>
        old?.content === content ? old : { content, key: old?.key ?? `fade-segment-${nextId++}` };
      let prefix = 0;
      while (prefix < contents.length && previous[prefix]?.content === contents[prefix])
        prefix += 1;

      const tail = previous[prefix];
      if (prefix === contents.length || !tail) {
        return {
          segments: contents.map((content, index) => identify(content, previous[index])),
          nextId,
        };
      }
      if (prefix === previous.length - 1) {
        const unchanged = contents.indexOf(tail.content, prefix);
        const match =
          unchanged >= 0
            ? unchanged
            : tail.content && contents[prefix]!.startsWith(tail.content)
              ? prefix
              : -1;
        const segments = contents.map((content, index) =>
          identify(content, index < prefix ? previous[index] : index === match ? tail : undefined),
        );
        return { segments, nextId };
      }

      contentIndexesBuilt += 1;
      const unused = new Set<number>();
      const equal = new Map<string, number[]>();
      for (let index = previous.length - 1; index >= prefix; index -= 1) {
        const value = previous[index]!;
        unused.add(index);
        const indexes = equal.get(value.content) ?? [];
        indexes.push(index);
        equal.set(value.content, indexes);
      }
      const reserved = contents.slice(prefix).map((content) => {
        const match = equal.get(content)?.pop();
        if (match !== undefined) unused.delete(match);
        return match;
      });
      const segments = contents.map((content, index) => {
        if (index < prefix) return previous[index]!;
        const unchanged = reserved[index - prefix];
        if (unchanged !== undefined) return previous[unchanged]!;
        const prior = previous[index];
        if (!prior?.content || !unused.has(index) || !content.startsWith(prior.content))
          return identify(content);
        unused.delete(index);
        return identify(content, prior);
      });
      return { segments, nextId };
    },
    getMeasurements: () => ({ contentIndexesBuilt }),
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
    settle(key: string, ownTarget: boolean): boolean {
      if (!active || !ownTarget || !current.has(key)) return false;
      settled.add(key);
      return true;
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
