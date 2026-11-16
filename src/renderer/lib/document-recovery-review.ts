import { getIntl } from "@/lib/i18n";
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
  getIntl().formatMessage(
    {
      id: "lib.documentRecoveryReview.blockCount",
      defaultMessage: "{count, plural, one {# block} other {# blocks}}",
    },
    { count },
  );

const joinPhrases = (phrases: readonly string[]): string =>
  phrases.length < 2
    ? (phrases[0] ?? "")
    : getIntl().formatMessage(
        { id: "lib.documentRecoveryReview.joinPhrases", defaultMessage: "{leading} and {last}" },
        {
          leading: phrases.slice(0, -1).join(
            getIntl().formatMessage({
              id: "lib.documentRecoveryReview.listSeparator",
              defaultMessage: ", ",
              description: "Separator between the leading phrases of a list ending in “and”",
            }),
          ),
          last: phrases.at(-1),
        },
      );

const restorePhrase = (diff: RecoveryDocumentDiff): string => {
  const phrases: string[] = [];
  if (diff.added)
    phrases.push(
      getIntl().formatMessage(
        { id: "lib.documentRecoveryReview.adds", defaultMessage: "adds {count}" },
        { count: recoveryBlockCount(diff.added) },
      ),
    );
  if (diff.edited)
    phrases.push(
      getIntl().formatMessage(
        { id: "lib.documentRecoveryReview.changes", defaultMessage: "changes {count}" },
        { count: diff.added ? diff.edited : recoveryBlockCount(diff.edited) },
      ),
    );
  if (diff.removed)
    phrases.push(
      getIntl().formatMessage(
        { id: "lib.documentRecoveryReview.removes", defaultMessage: "removes {count}" },
        { count: diff.added || diff.edited ? diff.removed : recoveryBlockCount(diff.removed) },
      ),
    );
  if (diff.title)
    phrases.push(
      getIntl().formatMessage({
        id: "lib.documentRecoveryReview.renamesPage",
        defaultMessage: "renames this Page",
      }),
    );
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
  get discarded() {
    return getIntl().formatMessage({
      id: "lib.documentRecoveryReview.discarded",
      defaultMessage: "You discarded these edits. The Page was not changed.",
    });
  },
  get copied() {
    return getIntl().formatMessage({
      id: "lib.documentRecoveryReview.copied",
      defaultMessage: "These edits were saved as a separate copy.",
    });
  },
  get restored() {
    return getIntl().formatMessage({
      id: "lib.documentRecoveryReview.restored",
      defaultMessage: "These edits were restored to the Page.",
    });
  },
  get already_saved() {
    return getIntl().formatMessage({
      id: "lib.documentRecoveryReview.alreadySaved",
      defaultMessage: "These edits were already in the Page. Nothing was lost.",
    });
  },
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
      return {
        headline: getIntl().formatMessage({
          id: "lib.documentRecoveryReview.comparing",
          defaultMessage: "Comparing with the current version…",
        }),
        detail: null,
        primary: null,
      };
    case "unavailable":
      return {
        headline: getIntl().formatMessage({
          id: "lib.documentRecoveryReview.unavailablePreview",
          defaultMessage: "These edits are safe, but can’t be shown here.",
        }),
        detail: comparison.explanation,
        primary: fallbackAction(inspection),
      };
    case "canvas":
      return inspection.can_restore
        ? {
            headline: getIntl().formatMessage({
              id: "lib.documentRecoveryReview.compareCanvas",
              defaultMessage: "Compare the current Canvas with the result of restoring.",
            }),
            detail: null,
            primary: "restore",
          }
        : {
            headline: getIntl().formatMessage({
              id: "lib.documentRecoveryReview.canvasCannotMerge",
              defaultMessage: "These edits can’t be merged into the current Canvas.",
            }),
            detail,
            primary: fallbackAction(inspection),
          };
    case "document":
      return {
        headline: comparison.hasCurrent
          ? getIntl().formatMessage({
              id: "lib.documentRecoveryReview.tooDifferent",
              defaultMessage: "These edits are too different from the Page to compare.",
            })
          : getIntl().formatMessage({
              id: "lib.documentRecoveryReview.originalMissing",
              defaultMessage: "The original Page no longer exists.",
            }),
        detail,
        // Nothing here marks which Blocks are new, so only the whole version can be copied.
        primary: inspection.can_restore ? "restore" : inspection.can_copy ? "copy" : "copy-all",
      };
    case "diff": {
      const { diff, merged } = comparison;
      if (!hasNewContent(diff, merged))
        return {
          headline: getIntl().formatMessage({
            id: "lib.documentRecoveryReview.nothingNew",
            defaultMessage: "Nothing new. Everything in these edits is already in the Page.",
          }),
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
          headline: getIntl().formatMessage(
            {
              id: "lib.documentRecoveryReview.cannotRemove",
              defaultMessage: "These edits would remove {count}, but can’t be applied.",
            },
            { count: recoveryBlockCount(diff.removed) },
          ),
          detail,
          primary: inspection.can_copy ? "copy" : "discard",
        };
      return {
        headline:
          count === 0
            ? getIntl().formatMessage({
                id: "lib.documentRecoveryReview.renamedPage",
                defaultMessage: "These edits renamed this Page.",
              })
            : getIntl().formatMessage(
                {
                  id: "lib.documentRecoveryReview.blocksMissing",
                  defaultMessage:
                    "{count, plural, one {# block isn’t in the Page yet.} other {# blocks aren’t in the Page yet.}}",
                },
                { count },
              ),
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
  get discarded() {
    return getIntl().formatMessage({
      id: "lib.documentRecoveryReview.statusDiscarded",
      defaultMessage: "Discarded",
    });
  },
  get copied() {
    return getIntl().formatMessage({
      id: "lib.documentRecoveryReview.statusCopied",
      defaultMessage: "Saved as a copy",
    });
  },
  get restored() {
    return getIntl().formatMessage({
      id: "lib.documentRecoveryReview.statusRestored",
      defaultMessage: "Restored",
    });
  },
  get already_saved() {
    return getIntl().formatMessage({
      id: "lib.documentRecoveryReview.statusSaved",
      defaultMessage: "Already saved",
    });
  },
} as const satisfies Record<NonNullable<RecoveryDraftInspection["summary"]["resolution"]>, string>;

export const recoveryEntryIsPending = (entry: RecoveryReviewEntry): boolean =>
  entry.kind === "staged" || !entry.draft.resolution;

export const recoveryEntryTitle = (entry: RecoveryReviewEntry): string =>
  entry.kind === "received"
    ? entry.draft.source_title?.trim() ||
      getIntl().formatMessage({
        id: "lib.documentRecoveryReview.untitled",
        defaultMessage: "Untitled Page",
      })
    : entry.source.sourceKind === "canvas"
      ? getIntl().formatMessage({
          id: "lib.documentRecoveryReview.canvasEdits",
          defaultMessage: "Canvas edits",
        })
      : getIntl().formatMessage({
          id: "lib.documentRecoveryReview.pageEdits",
          defaultMessage: "Page edits",
        });

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
  if (sending.includes(entry.source.sourceKey))
    return {
      label: getIntl().formatMessage({
        id: "lib.documentRecoveryReview.saving",
        defaultMessage: "Saving…",
      }),
      attention: false,
    };
  return {
    label: stamped(
      entry.source.failure
        ? getIntl().formatMessage({
            id: "lib.documentRecoveryReview.needsAttention",
            defaultMessage: "Needs attention",
          })
        : getIntl().formatMessage({
            id: "lib.documentRecoveryReview.onDevice",
            defaultMessage: "On this device",
          }),
    ),
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
