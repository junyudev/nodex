import { useState } from "react";
import { EditIcon, DeleteIcon, TextActionCommentIcon } from "@/components/shared/icons";
import { NodexPopover, NodexPopoverContent, NodexPopoverTrigger } from "@/components/ui/popover";
import type {
  ResponseTextAnnotation,
  ThreadTextSelection,
  ThreadTextSelectionContext,
} from "../../../../shared/thread-text-selection";

export function ThreadTextSelectionAttachments({
  context,
  onEditAnnotation,
  onRemoveAnnotation,
  onRemoveSelection,
}: {
  context: ThreadTextSelectionContext;
  onEditAnnotation?: (id: string) => void;
  onRemoveAnnotation?: (id: string) => void;
  onRemoveSelection?: (id: string) => void;
}) {
  return (
    <>
      <TextSelectionAttachmentGroup
        entries={context.responseTextAnnotations}
        kind="annotation"
        onEdit={onEditAnnotation}
        onRemove={onRemoveAnnotation}
      />
      <TextSelectionAttachmentGroup
        entries={context.selectedTextAttachments}
        kind="selection"
        onRemove={onRemoveSelection}
      />
    </>
  );
}

function TextSelectionAttachmentGroup({
  entries,
  kind,
  onEdit,
  onRemove,
}: {
  entries: readonly (ThreadTextSelection | ResponseTextAnnotation)[];
  kind: "annotation" | "selection";
  onEdit?: (id: string) => void;
  onRemove?: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  if (entries.length === 0) return null;
  return (
    <NodexPopover open={open} onOpenChange={setOpen}>
      <NodexPopoverTrigger>
        <button
          type="button"
          data-composer-attachment-pill="true"
          className="inline-flex max-w-80 items-center gap-1 rounded-full border border-default bg-surface-elevated-secondary px-2 py-1.5 text-sm text-default hover:bg-surface-elevated focus-visible:ring-2 focus-visible:ring-ring"
        >
          <TextActionCommentIcon className="icon-2xs shrink-0 text-tertiary" />
          {entries.length} {kind}
          {entries.length === 1 ? "" : "s"}
        </button>
      </NodexPopoverTrigger>
      <NodexPopoverContent
        side="top"
        align="start"
        className="w-96 max-w-[calc(100vw-16px)] p-1"
        finalFocus={onEdit ? false : undefined}
      >
        <ol className="flex max-h-80 flex-col divide-y divide-border overflow-y-auto rounded-lg text-sm">
          {entries.map((entry, index) => (
            <li key={entry.id} className="relative flex min-w-0 items-start gap-2 px-2.5 py-2">
              <div className="flex min-w-0 flex-1 items-start gap-2 text-start select-text">
                <span className="shrink-0 text-tertiary">{index + 1}.</span>
                <span className="flex min-w-0 flex-1 flex-col gap-2">
                  <span>
                    <span className="block text-xs font-medium text-tertiary">Selected text:</span>
                    <span className="mt-0.5 block max-h-40 overflow-auto break-words whitespace-pre-wrap">
                      {entry.text}
                    </span>
                  </span>
                  {"annotation" in entry && entry.annotation?.trim() ? (
                    <span>
                      <span className="block text-xs font-medium text-tertiary">User comment:</span>
                      <span className="mt-0.5 block break-words whitespace-pre-wrap">
                        {entry.annotation}
                      </span>
                    </span>
                  ) : null}
                </span>
              </div>
              {onEdit || onRemove ? (
                <div className="relative flex shrink-0 items-center">
                  {onEdit ? (
                    <button
                      type="button"
                      aria-label={`Edit annotation ${index + 1}`}
                      className="flex size-6 items-center justify-center rounded-lg text-tertiary hover:bg-primary-ghost-hover"
                      onClick={() => {
                        setOpen(false);
                        onEdit(entry.id);
                      }}
                    >
                      <EditIcon className="icon-xs" />
                    </button>
                  ) : null}
                  {onRemove ? (
                    <button
                      type="button"
                      aria-label={`Delete ${kind} ${index + 1}`}
                      className="flex size-6 items-center justify-center rounded-lg text-tertiary hover:bg-primary-ghost-hover"
                      onClick={() => onRemove(entry.id)}
                    >
                      <DeleteIcon className="icon-xs" />
                    </button>
                  ) : null}
                </div>
              ) : null}
            </li>
          ))}
        </ol>
      </NodexPopoverContent>
    </NodexPopover>
  );
}
