import { useState } from "react";
import type { RecoveryDiffRow, RecoveryDocumentDiff } from "@/lib/document-recovery-diff";
import { recoveryBlockCount } from "@/lib/document-recovery-review";
import { cn } from "@/lib/utils";
import { RecoveryDocumentPreview, type RecoveryPreviewContext } from "./recovery-preview";

type PreviewFiles = Parameters<typeof RecoveryDocumentPreview>[0]["files"];

// Word changes reuse the editor's color marks; their tones must beat its Page color palette.
const CHANGE_MARKS = cn(
  "[&_[data-style-type=backgroundColor][data-value=green]]:rounded-[3px]",
  "[&_[data-style-type=backgroundColor][data-value=green]]:bg-token-charts-green/25!",
  "[&_[data-style-type=backgroundColor][data-value=red]]:rounded-[3px]",
  "[&_[data-style-type=backgroundColor][data-value=red]]:bg-token-charts-red/20!",
  "[&_[data-style-type=backgroundColor][data-value=red]]:text-token-text-secondary",
);

const ROW_TREATMENT = {
  added: {
    label: "Added",
    className:
      "bg-token-charts-green/8 shadow-[inset_2px_0_0_var(--color-token-charts-green)] rounded-r-md",
  },
  removed: {
    label: "Removed",
    className:
      "bg-token-charts-red/8 shadow-[inset_2px_0_0_var(--color-token-charts-red)] rounded-r-md opacity-80 [&_.bn-inline-content]:line-through",
  },
  edited: {
    label: "Changed",
    className: cn(
      "shadow-[inset_2px_0_0_var(--color-token-border-xstrong)] rounded-r-md",
      CHANGE_MARKS,
    ),
  },
  context: { label: "Unchanged", className: "opacity-55" },
} as const;

/** Hidden Blocks stay out of the document until asked for, so a long Page opens instantly. */
function CollapsedRow({
  row,
  label,
  files,
  context,
}: {
  readonly row: RecoveryDiffRow;
  readonly label: string;
  readonly files: PreviewFiles;
  readonly context: RecoveryPreviewContext;
}) {
  const [expanded, setExpanded] = useState(false);
  if (expanded)
    return (
      <section aria-label={label} className={cn("px-3", ROW_TREATMENT.context.className)}>
        <RecoveryDocumentPreview content={row.blocks} files={files} context={context} />
      </section>
    );
  return (
    <button
      type="button"
      onClick={() => setExpanded(true)}
      className="flex w-full items-center gap-3 px-3 py-1 text-xs text-token-description-foreground outline-none hover:text-token-text-secondary focus-visible:text-token-text-primary"
    >
      <span aria-hidden="true" className="h-px flex-1 bg-token-border" />
      {label}
      <span aria-hidden="true" className="h-px flex-1 bg-token-border" />
    </button>
  );
}

/**
 * Renders a comparison as one readable document: real Page typography, changes marked in place,
 * unchanged Blocks folded away. `merged` is false when the other side is the edits as captured,
 * where a Block found only in the Page is newer rather than something restoring would remove.
 */
export function RecoveryDiff({
  diff,
  merged,
  files,
  context,
}: {
  readonly diff: RecoveryDocumentDiff;
  readonly merged: boolean;
  readonly files: PreviewFiles;
  readonly context: RecoveryPreviewContext;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      {diff.title ? (
        <section
          aria-label="Title changed"
          className="flex flex-wrap items-baseline gap-x-2 px-3 py-1 text-sm"
        >
          <span className="text-token-description-foreground">Title</span>
          <span className="rounded-[3px] bg-token-charts-red/20 text-token-text-secondary line-through">
            {diff.title.before || "Untitled Page"}
          </span>
          <span className="rounded-[3px] bg-token-charts-green/25 text-token-text-primary">
            {diff.title.after || "Untitled Page"}
          </span>
        </section>
      ) : null}
      {diff.rows.map((row, index) => {
        const key = `${index}:${row.kind}`;
        if (row.kind === "unchanged")
          return (
            <CollapsedRow
              key={key}
              row={row}
              label={`${recoveryBlockCount(row.blocks.length)} unchanged`}
              files={files}
              context={context}
            />
          );
        if (row.kind === "removed" && !merged)
          return (
            <CollapsedRow
              key={key}
              row={row}
              label={`${recoveryBlockCount(row.blocks.length)} only in the Page`}
              files={files}
              context={context}
            />
          );
        const treatment = ROW_TREATMENT[row.kind];
        return (
          <section
            key={key}
            aria-label={treatment.label}
            className={cn("px-3", treatment.className)}
          >
            <RecoveryDocumentPreview content={row.blocks} files={files} context={context} />
          </section>
        );
      })}
    </div>
  );
}
