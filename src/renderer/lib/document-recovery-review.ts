import { writeMarkdown } from "../../shared/nodex-markdown";
import type {
  RecoveryDraftInspection,
  RecoveryPreview,
  RecoveryPreviewResult,
  RecoveryPreviewRequest,
} from "../../shared/block-documents/document-recovery";
import { formatRecoveryTime, type RecoveryReviewEntry } from "./document-recovery-entries";
import {
  diffRecoveryDocuments,
  recoveryDiffHasChanges,
  type RecoveryDocumentDiff,
} from "./document-recovery-diff";

type DocumentPreview = Extract<RecoveryPreview, { kind: "document" }>;
type CanvasPreview = Extract<RecoveryPreview, { kind: "canvas" }>;

/** What the review can show for one received draft, once its versions are read. */
export type RecoveryComparison =
  | { readonly kind: "loading" }
  /** `merged` compares with the result of restoring; otherwise with the edits as captured. */
  | {
      readonly kind: "diff";
      readonly diff: RecoveryDocumentDiff;
      readonly merged: boolean;
      readonly before: DocumentPreview;
      readonly after: DocumentPreview;
    }
  /** Nothing to compare with, or the two versions are too far apart to compare usefully. */
  | {
      readonly kind: "document";
      readonly after: DocumentPreview;
      readonly hasCurrent: boolean;
    }
  | {
      readonly kind: "canvas";
      readonly before: CanvasPreview | null;
      readonly after: CanvasPreview;
    }
  | { readonly kind: "unavailable"; readonly explanation: string };

const previewFailure = (error: unknown): RecoveryPreviewResult => ({
  kind: "unavailable",
  explanation: error instanceof Error ? error.message : String(error),
});

/**
 * Prefers the merge Core computes even when it will not apply it. Merged content already accounts
 * for later edits and deletions, so what remains is exactly what these edits would add. Comparing
 * with the captured version instead makes anything written since then look like a difference.
 */
export async function loadRecoveryComparison(
  inspection: RecoveryDraftInspection,
  preview: (
    inspection: RecoveryDraftInspection,
    view: RecoveryPreviewRequest["view"],
  ) => Promise<RecoveryPreviewResult>,
): Promise<RecoveryComparison> {
  const read = (view: RecoveryPreviewRequest["view"]) =>
    preview(inspection, view).catch(previewFailure);
  const merged = inspection.restored;
  const [afterResult, beforeResult] = await Promise.all([
    read(merged ? "restored" : "retained"),
    inspection.current ? read("current") : null,
  ]);
  if (afterResult.kind !== "complete")
    return { kind: "unavailable", explanation: afterResult.explanation };
  const after = afterResult.preview;
  const before = beforeResult?.kind === "complete" ? beforeResult.preview : null;
  if (after.kind === "canvas")
    return { kind: "canvas", after, before: before?.kind === "canvas" ? before : null };
  if (before?.kind !== "document")
    return { kind: "document", after, hasCurrent: inspection.current };
  const diff = diffRecoveryDocuments(before, after);
  return diff
    ? { kind: "diff", diff, merged, before, after }
    : { kind: "document", after, hasCurrent: true };
}

export type RecoveryPrimaryAction =
  | "restore"
  | "copy"
  | "copy-new"
  | "copy-all"
  | "discard"
  | "reopen"
  | "export"
  | null;

export interface RecoveryDecision {
  /** Answers "did I lose anything?" in one sentence. */
  readonly headline: string;
  /** The reason behind a limitation, only when the action alone would not explain it. */
  readonly detail: string | null;
  readonly primary: RecoveryPrimaryAction;
}

export const recoveryBlockCount = (count: number): string =>
  `${count} ${count === 1 ? "block" : "blocks"}`;

const joinPhrases = (phrases: readonly string[]): string =>
  phrases.length < 2
    ? (phrases[0] ?? "")
    : `${phrases.slice(0, -1).join(", ")} and ${phrases.at(-1)}`;

const restorePhrase = (diff: RecoveryDocumentDiff): string => {
  const phrases: string[] = [];
  if (diff.added) phrases.push(`adds ${recoveryBlockCount(diff.added)}`);
  if (diff.edited)
    phrases.push(`changes ${diff.added ? diff.edited : recoveryBlockCount(diff.edited)}`);
  if (diff.removed)
    phrases.push(
      `removes ${diff.added || diff.edited ? diff.removed : recoveryBlockCount(diff.removed)}`,
    );
  if (diff.title) phrases.push("renames this Page");
  return joinPhrases(phrases);
};

/** Blocks that exist only in these edits; what a person would need to carry over by hand. */
const newBlockCount = (diff: RecoveryDocumentDiff): number => diff.added + diff.edited;

const hasNewContent = (diff: RecoveryDocumentDiff, merged: boolean): boolean =>
  // Compared with the captured edits, a Block only in the Page is simply newer than they are.
  merged ? recoveryDiffHasChanges(diff) : newBlockCount(diff) > 0 || diff.title !== null;

const fallbackAction = (inspection: RecoveryDraftInspection): RecoveryPrimaryAction =>
  inspection.can_restore ? "restore" : inspection.can_copy ? "copy" : "export";

const RESOLVED_HEADLINES = {
  discarded: "You discarded these edits. The Page was not changed.",
  copied: "These edits were saved as a separate copy.",
  restored: "These edits were restored to the Page.",
  already_saved: "These edits were already in the Page. Nothing was lost.",
} as const satisfies Record<NonNullable<RecoveryDraftInspection["summary"]["resolution"]>, string>;

/** Chooses the sentence and the single recommended action for one received draft. */
export function recoveryDecision(
  inspection: RecoveryDraftInspection,
  comparison: RecoveryComparison,
): RecoveryDecision {
  const resolution = inspection.summary.resolution;
  if (resolution)
    return {
      headline: RESOLVED_HEADLINES[resolution],
      detail: comparison.kind === "unavailable" ? comparison.explanation : null,
      primary: resolution === "discarded" ? "reopen" : null,
    };
  const detail = inspection.can_restore ? null : (inspection.explanation ?? null);
  switch (comparison.kind) {
    case "loading":
      return { headline: "Comparing with the current version…", detail: null, primary: null };
    case "unavailable":
      return {
        headline: "These edits are safe, but can’t be shown here.",
        detail: comparison.explanation,
        primary: fallbackAction(inspection),
      };
    case "canvas":
      return inspection.can_restore
        ? {
            headline: "Compare the current Canvas with the result of restoring.",
            detail: null,
            primary: "restore",
          }
        : {
            headline: "These edits can’t be merged into the current Canvas.",
            detail,
            primary: fallbackAction(inspection),
          };
    case "document":
      return {
        headline: comparison.hasCurrent
          ? "These edits are too different from the Page to compare."
          : "The original Page no longer exists.",
        detail,
        // Nothing here marks which Blocks are new, so only the whole version can be copied.
        primary: inspection.can_restore ? "restore" : inspection.can_copy ? "copy" : "copy-all",
      };
    case "diff": {
      const { diff, merged } = comparison;
      if (!hasNewContent(diff, merged))
        return {
          headline: "Nothing new. Everything in these edits is already in the Page.",
          detail: null,
          primary: "discard",
        };
      if (inspection.can_restore)
        return {
          headline: `Restoring ${restorePhrase(diff)}.`,
          detail: null,
          primary: "restore",
        };
      const count = newBlockCount(diff);
      if (count === 0 && !diff.title)
        return {
          headline: `These edits would remove ${recoveryBlockCount(diff.removed)}, but can’t be applied.`,
          detail,
          primary: inspection.can_copy ? "copy" : "discard",
        };
      return {
        headline:
          count === 0
            ? "These edits renamed this Page."
            : `${recoveryBlockCount(count)} ${count === 1 ? "isn’t" : "aren’t"} in the Page yet.`,
        detail,
        primary: inspection.can_copy ? "copy" : "copy-new",
      };
    }
  }
}

/** The Markdown of only what these edits add, so pasting it back cannot duplicate the Page. */
export const recoveryNewContentMarkdown = (diff: RecoveryDocumentDiff): string =>
  diff.newBlocks.length > 0 ? writeMarkdown(diff.newBlocks) : (diff.title?.after ?? "");

const RESOLUTION_LABELS = {
  discarded: "Discarded",
  copied: "Saved as a copy",
  restored: "Restored",
  already_saved: "Already saved",
} as const satisfies Record<NonNullable<RecoveryDraftInspection["summary"]["resolution"]>, string>;

export const recoveryEntryIsPending = (entry: RecoveryReviewEntry): boolean =>
  entry.kind === "staged" || !entry.draft.resolution;

export const recoveryEntryTitle = (entry: RecoveryReviewEntry): string =>
  entry.kind === "received"
    ? entry.draft.source_title?.trim() || "Untitled Page"
    : entry.source.sourceKind === "canvas"
      ? "Canvas edits"
      : "Page edits";

const entryTime = (entry: RecoveryReviewEntry): string | null =>
  entry.kind === "received"
    ? (entry.draft.resolved_at ?? entry.draft.created_at)
    : entry.source.createdAt;

/** Describes an entry beside its title: when it happened, and anything unusual about it. */
export const recoveryEntryMeta = (
  entry: RecoveryReviewEntry,
  sending: readonly string[],
): { readonly label: string; readonly attention: boolean } => {
  const time = entryTime(entry);
  const stamped = (label: string | null): string =>
    [label, time ? formatRecoveryTime(time) : null].filter(Boolean).join(" · ");
  if (entry.kind === "received")
    return {
      label: stamped(entry.draft.resolution ? RESOLUTION_LABELS[entry.draft.resolution] : null),
      attention: false,
    };
  if (sending.includes(entry.source.sourceKey)) return { label: "Saving…", attention: false };
  return {
    label: stamped(entry.source.failure ? "Needs attention" : "On this device"),
    attention: Boolean(entry.source.failure),
  };
};

/** Pending entries read newest first; the rest of the list is secondary to reviewing them. */
export function orderRecoveryEntries(entries: readonly RecoveryReviewEntry[]): {
  readonly pending: readonly RecoveryReviewEntry[];
  readonly resolved: readonly RecoveryReviewEntry[];
} {
  const sorted = entries.toSorted((left, right) =>
    (entryTime(right) ?? "").localeCompare(entryTime(left) ?? ""),
  );
  return {
    pending: sorted.filter(recoveryEntryIsPending),
    resolved: sorted.filter((entry) => !recoveryEntryIsPending(entry)),
  };
}
