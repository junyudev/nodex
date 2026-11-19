/** A top-level Block as the editor reports it: its identity and, separately, its Markdown. */
export interface SuggestionBlock {
  readonly id: string;
}

/** One Suggested edit: replace these original sibling Blocks with this Markdown. */
export interface SuggestionHunk {
  readonly blockIds: readonly string[];
  readonly oldMarkdown: string;
  readonly newMarkdown: string;
}

interface HunkRange {
  readonly baseStart: number;
  readonly baseEnd: number;
  readonly draftStart: number;
  readonly draftEnd: number;
}

/** Aligns the copies by Block identity and emits disjoint replacement ranges. */
export function computeSuggestionHunks<T extends SuggestionBlock>(
  base: readonly T[],
  draft: readonly T[],
  markdownOf: (blocks: readonly T[]) => string,
): readonly SuggestionHunk[] {
  if (base.length === 0) return [];
  const draftIndex = new Map(draft.map((block, index) => [block.id, index]));
  const ranges: HunkRange[] = [];
  let baseCursor = 0;
  let draftCursor = 0;
  const flush = (baseEnd: number, draftEnd: number) => {
    if (baseCursor === baseEnd && draftCursor === draftEnd) return;
    let range = { baseStart: baseCursor, baseEnd, draftStart: draftCursor, draftEnd };
    // A pure insertion needs an original Block. Use the preceding unchanged Block,
    // or the following one at the top of the Page.
    if (baseCursor === baseEnd) {
      range =
        baseCursor > 0
          ? { ...range, baseStart: baseCursor - 1, draftStart: draftCursor - 1 }
          : { ...range, baseEnd: baseEnd + 1, draftEnd: draftEnd + 1 };
    }
    const previous = ranges.at(-1);
    if (previous && previous.baseEnd > range.baseStart) {
      // The shared anchor appears only once in the contiguous replacement.
      ranges[ranges.length - 1] = {
        ...previous,
        baseEnd: Math.max(previous.baseEnd, range.baseEnd),
        draftEnd: Math.max(previous.draftEnd, range.draftEnd),
      };
    } else {
      ranges.push(range);
    }
  };
  let lastDraft = -1;
  for (const [baseAt, block] of base.entries()) {
    const draftAt = draftIndex.get(block.id);
    if (draftAt === undefined || draftAt < lastDraft) continue;
    lastDraft = draftAt;
    if (markdownOf([block]) !== markdownOf([draft[draftAt]!])) continue;
    flush(baseAt, draftAt);
    baseCursor = baseAt + 1;
    draftCursor = draftAt + 1;
  }
  flush(base.length, draft.length);
  return ranges.map(({ baseStart, baseEnd, draftStart, draftEnd }) => {
    const original = base.slice(baseStart, baseEnd);
    return {
      blockIds: original.map((block) => block.id),
      oldMarkdown: markdownOf(original),
      newMarkdown: markdownOf(draft.slice(draftStart, draftEnd)),
    };
  });
}
