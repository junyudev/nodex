import { diffWords } from "diff";

export interface SuggestedEditDiffSegment {
  readonly kind: "equal" | "insert" | "delete";
  readonly text: string;
}

/** A word-level comparison, or the plain fact that the texts are too large to compare quickly. */
export type SuggestedEditDiff =
  | { readonly kind: "segments"; readonly segments: readonly SuggestedEditDiffSegment[] }
  | { readonly kind: "too_large" };

/** Suggested edits replace a few Blocks; anything beyond this shows both texts instead. */
const MAX_COMPARED_CHARACTERS = 20_000;
const DIFF_TIMEOUT_MS = 100;

let wordSegmenter: Intl.Segmenter | undefined;

/** Word segmentation that also splits CJK text into words rather than one long token. */
function segmenter(): Intl.Segmenter {
  if (!wordSegmenter) wordSegmenter = new Intl.Segmenter(undefined, { granularity: "word" });
  return wordSegmenter;
}

/** Compares a suggested edit's original and replacement text word by word, within a time bound. */
export function diffSuggestedEdit(original: string, replacement: string): SuggestedEditDiff {
  if (original.length + replacement.length > MAX_COMPARED_CHARACTERS) return { kind: "too_large" };
  const changes = diffWords(original, replacement, {
    timeout: DIFF_TIMEOUT_MS,
    intlSegmenter: segmenter(),
  });
  if (!changes) return { kind: "too_large" };
  const segments: SuggestedEditDiffSegment[] = [];
  for (const change of changes) {
    const kind = change.added ? "insert" : change.removed ? "delete" : "equal";
    const previous = segments.at(-1);
    if (previous?.kind === kind)
      segments[segments.length - 1] = { kind, text: previous.text + change.value };
    else if (change.value) segments.push({ kind, text: change.value });
  }
  return { kind: "segments", segments };
}
