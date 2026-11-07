import { diffArrays } from "diff";
import { readMarkdown, type MarkdownBlock, type MarkdownInline } from "../../shared/nodex-markdown";

/**
 * Compares two versions of a document by top-level Block, then by word inside a Block edited in
 * place. The comparison is only presentation: Core alone decides what can be restored.
 */
export interface RecoveryDiffRow {
  /** `unchanged` Blocks start collapsed; `context` Blocks stay visible beside a change. */
  readonly kind: "added" | "removed" | "edited" | "context" | "unchanged";
  readonly blocks: readonly MarkdownBlock[];
}

export interface RecoveryDocumentDiff {
  readonly title: { readonly before: string; readonly after: string } | null;
  readonly rows: readonly RecoveryDiffRow[];
  readonly added: number;
  readonly removed: number;
  readonly edited: number;
  /** Added Blocks and the final form of edited ones, without any change marks. */
  readonly newBlocks: readonly MarkdownBlock[];
}

export interface RecoveryDocumentVersion {
  readonly title: string;
  readonly markdown: string;
}

/** Unchanged Blocks kept on each side of a change so it can be read in place. */
const CONTEXT_BLOCKS = 1;
/** Above this many edits Myers' cost stops being worth a comparison nobody can read. */
const MAX_BLOCK_EDIT_DISTANCE = 4_000;
const MAX_WORD_EDIT_DISTANCE = 2_000;
/** A Block sharing less than this with its counterpart reads better as a replacement. */
const MIN_EDIT_SIMILARITY = 0.4;

const INSERTED_STYLES = { backgroundColor: "green" } as const;
const DELETED_STYLES = { backgroundColor: "red", strike: true } as const;

const INLINE_BLOCK_TYPES = new Set([
  "paragraph",
  "heading",
  "bulletListItem",
  "numberedListItem",
  "checkListItem",
  "toggleListItem",
  "quote",
  "callout",
]);

const blockKey = (block: MarkdownBlock): string => JSON.stringify(block);

/** A blank line is spacing, not content; it would only read as a change with nothing in it. */
const isBlankBlock = (block: MarkdownBlock): boolean =>
  block.type === "paragraph" &&
  (block.children?.length ?? 0) === 0 &&
  (!Array.isArray(block.content) || block.content.length === 0);

type InlineAtom =
  | { readonly kind: "word"; readonly key: string; readonly inline: MarkdownInline }
  | { readonly kind: "object"; readonly key: string; readonly inline: MarkdownInline };

const segmenter = new Intl.Segmenter(undefined, { granularity: "word" });

const inlineAtoms = (content: readonly MarkdownInline[]): InlineAtom[] =>
  content.flatMap((inline): InlineAtom[] => {
    if (inline.type !== "text" || !inline.text) {
      return [{ kind: "object", key: JSON.stringify(inline), inline }];
    }
    const styles = JSON.stringify(inline.styles ?? {});
    return Array.from(segmenter.segment(inline.text), ({ segment }) => ({
      kind: "word" as const,
      key: `${styles}\0${segment}`,
      inline: { ...inline, text: segment },
    }));
  });

const appendInline = (output: MarkdownInline[], next: MarkdownInline): void => {
  const previous = output.at(-1);
  if (
    previous?.type === "text" &&
    next.type === "text" &&
    JSON.stringify(previous.styles ?? {}) === JSON.stringify(next.styles ?? {})
  ) {
    output[output.length - 1] = { ...previous, text: `${previous.text ?? ""}${next.text ?? ""}` };
    return;
  }
  output.push(next);
};

const markInline = (
  inline: MarkdownInline,
  styles: Readonly<Record<string, boolean | string>>,
): MarkdownInline =>
  inline.type === "text" ? { ...inline, styles: { ...inline.styles, ...styles } } : inline;

const weight = (atom: InlineAtom): number => (atom.kind === "word" ? atom.key.length : 1);

/**
 * Merges two inline runs into one, carrying insertions and deletions as text marks. Shared
 * leading and trailing runs are trimmed first, so appending to a very long paragraph stays cheap.
 * Returns null when the two share too little for inline marks to be readable.
 */
export function mergeInlineEdits(
  before: readonly MarkdownInline[],
  after: readonly MarkdownInline[],
): readonly MarkdownInline[] | null {
  const left = inlineAtoms(before);
  const right = inlineAtoms(after);
  let prefix = 0;
  while (prefix < left.length && prefix < right.length && left[prefix]!.key === right[prefix]!.key)
    prefix += 1;
  let suffix = 0;
  while (
    suffix < left.length - prefix &&
    suffix < right.length - prefix &&
    left[left.length - 1 - suffix]!.key === right[right.length - 1 - suffix]!.key
  )
    suffix += 1;
  const leftMiddle = left.slice(prefix, left.length - suffix);
  const rightMiddle = right.slice(prefix, right.length - suffix);
  const changes = diffArrays(
    leftMiddle.map((atom) => atom.key),
    rightMiddle.map((atom) => atom.key),
    { maxEditLength: MAX_WORD_EDIT_DISTANCE },
  );
  if (!changes) return null;

  const total = Math.max(
    left.reduce((sum, atom) => sum + weight(atom), 0),
    right.reduce((sum, atom) => sum + weight(atom), 0),
  );
  let shared = 0;
  const output: MarkdownInline[] = [];
  left.slice(0, prefix).forEach((atom) => {
    shared += weight(atom);
    appendInline(output, atom.inline);
  });
  let leftIndex = 0;
  let rightIndex = 0;
  for (const change of changes) {
    for (let index = 0; index < change.value.length; index += 1) {
      if (change.removed) {
        appendInline(output, markInline(leftMiddle[leftIndex]!.inline, DELETED_STYLES));
        leftIndex += 1;
      } else if (change.added) {
        appendInline(output, markInline(rightMiddle[rightIndex]!.inline, INSERTED_STYLES));
        rightIndex += 1;
      } else {
        const atom = rightMiddle[rightIndex]!;
        shared += weight(atom);
        appendInline(output, atom.inline);
        leftIndex += 1;
        rightIndex += 1;
      }
    }
  }
  right.slice(right.length - suffix).forEach((atom) => {
    shared += weight(atom);
    appendInline(output, atom.inline);
  });
  return total > 0 && shared / total >= MIN_EDIT_SIMILARITY ? output : null;
}

const editedBlock = (before: MarkdownBlock, after: MarkdownBlock): MarkdownBlock | null => {
  if (
    before.type !== after.type ||
    !INLINE_BLOCK_TYPES.has(after.type) ||
    !Array.isArray(before.content) ||
    !Array.isArray(after.content) ||
    JSON.stringify(before.props ?? {}) !== JSON.stringify(after.props ?? {}) ||
    JSON.stringify(before.children ?? []) !== JSON.stringify(after.children ?? [])
  )
    return null;
  const content = mergeInlineEdits(
    before.content as readonly MarkdownInline[],
    after.content as readonly MarkdownInline[],
  );
  return content ? { ...after, content } : null;
};

type ChangeRow = {
  readonly kind: "added" | "removed" | "edited";
  /** Carries change marks when edited, so it stays presentation-only. */
  readonly block: MarkdownBlock;
  readonly source: MarkdownBlock;
};

/** Pairs a replaced run in document order, so an edited Block stays where the reader expects it. */
const pairChanges = (
  removed: readonly MarkdownBlock[],
  added: readonly MarkdownBlock[],
): ChangeRow[] => {
  const rows: ChangeRow[] = [];
  let nextAdded = 0;
  for (const before of removed) {
    let match = -1;
    let merged: MarkdownBlock | null = null;
    for (let index = nextAdded; index < added.length; index += 1) {
      merged = editedBlock(before, added[index]!);
      if (merged) {
        match = index;
        break;
      }
    }
    if (!merged) {
      rows.push({ kind: "removed", block: before, source: before });
      continue;
    }
    for (let index = nextAdded; index < match; index += 1)
      rows.push({ kind: "added", block: added[index]!, source: added[index]! });
    rows.push({ kind: "edited", block: merged, source: added[match]! });
    nextAdded = match + 1;
  }
  for (let index = nextAdded; index < added.length; index += 1)
    rows.push({ kind: "added", block: added[index]!, source: added[index]! });
  return rows;
};

const pushRow = (
  rows: RecoveryDiffRow[],
  kind: RecoveryDiffRow["kind"],
  blocks: readonly MarkdownBlock[],
): void => {
  if (blocks.length === 0) return;
  const previous = rows.at(-1);
  if (previous?.kind === kind) {
    rows[rows.length - 1] = { kind, blocks: [...previous.blocks, ...blocks] };
    return;
  }
  rows.push({ kind, blocks });
};

const pushUnchanged = (
  rows: RecoveryDiffRow[],
  blocks: readonly MarkdownBlock[],
  position: { readonly first: boolean; readonly last: boolean },
): void => {
  const leading = position.first ? 0 : CONTEXT_BLOCKS;
  const trailing = position.last ? 0 : CONTEXT_BLOCKS;
  if (blocks.length <= leading + trailing + 1) {
    // A single hidden Block costs more to reveal than to show.
    pushRow(rows, "context", blocks);
    return;
  }
  pushRow(rows, "context", blocks.slice(0, leading));
  pushRow(rows, "unchanged", blocks.slice(leading, blocks.length - trailing));
  pushRow(rows, "context", blocks.slice(blocks.length - trailing));
};

/** Returns null when either version cannot be read or the two are too far apart to compare. */
export function diffRecoveryDocuments(
  before: RecoveryDocumentVersion,
  after: RecoveryDocumentVersion,
): RecoveryDocumentDiff | null {
  let left: MarkdownBlock[];
  let right: MarkdownBlock[];
  try {
    left = readMarkdown(before.markdown).filter((block) => !isBlankBlock(block));
    right = readMarkdown(after.markdown).filter((block) => !isBlankBlock(block));
  } catch {
    return null;
  }
  const changes = diffArrays(left.map(blockKey), right.map(blockKey), {
    maxEditLength: MAX_BLOCK_EDIT_DISTANCE,
  });
  if (!changes) return null;

  const rows: RecoveryDiffRow[] = [];
  let added = 0;
  let removed = 0;
  let edited = 0;
  const newBlocks: MarkdownBlock[] = [];
  let leftIndex = 0;
  let rightIndex = 0;
  const hasChange = changes.some((change) => change.added || change.removed);
  for (let index = 0; index < changes.length; index += 1) {
    const change = changes[index]!;
    if (!change.added && !change.removed) {
      if (hasChange)
        pushUnchanged(rows, right.slice(rightIndex, rightIndex + change.value.length), {
          first: index === 0,
          last: index === changes.length - 1,
        });
      leftIndex += change.value.length;
      rightIndex += change.value.length;
      continue;
    }
    const removedChange = change.removed ? change : null;
    const addedChange = change.added
      ? change
      : changes[index + 1]?.added
        ? changes[index + 1]!
        : null;
    if (removedChange && addedChange) index += 1;
    const removedBlocks = left.slice(leftIndex, leftIndex + (removedChange?.value.length ?? 0));
    const addedBlocks = right.slice(rightIndex, rightIndex + (addedChange?.value.length ?? 0));
    leftIndex += removedBlocks.length;
    rightIndex += addedBlocks.length;
    for (const { kind, block, source } of pairChanges(removedBlocks, addedBlocks)) {
      if (kind === "added") added += 1;
      else if (kind === "removed") removed += 1;
      else edited += 1;
      if (kind !== "removed") newBlocks.push(source);
      pushRow(rows, kind, [block]);
    }
  }
  return {
    title: before.title === after.title ? null : { before: before.title, after: after.title },
    rows,
    added,
    removed,
    edited,
    newBlocks,
  };
}

export const recoveryDiffHasChanges = (diff: RecoveryDocumentDiff): boolean =>
  diff.title !== null || diff.added + diff.removed + diff.edited > 0;
