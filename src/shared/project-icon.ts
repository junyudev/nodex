const EMOJI_PATTERN = /\p{Extended_Pictographic}/u;

type SegmenterLike = {
  segment(input: string): Iterable<{ segment: string }>;
};

const SegmenterCtor = (Intl as unknown as {
  Segmenter?: new (
    locales?: string | string[],
    options?: { granularity?: "grapheme" | "word" | "sentence" },
  ) => SegmenterLike;
}).Segmenter;

const graphemeSegmenter =
  typeof SegmenterCtor === "function"
    ? new SegmenterCtor(undefined, { granularity: "grapheme" })
    : null;

function findFirstEmojiGrapheme(value: string): string | null {
  if (graphemeSegmenter) {
    for (const segment of graphemeSegmenter.segment(value)) {
      if (EMOJI_PATTERN.test(segment.segment)) {
        return segment.segment;
      }
    }
    return null;
  }

  for (const char of Array.from(value)) {
    if (EMOJI_PATTERN.test(char)) {
      return char;
    }
  }
  return null;
}

export function normalizeProjectIcon(value: unknown): string {
  if (typeof value !== "string") return "";

  const trimmed = value.trim();
  if (!trimmed) return "";

  return findFirstEmojiGrapheme(trimmed) ?? "";
}

export function normalizeProjectIconUpdate(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  return normalizeProjectIcon(value);
}
