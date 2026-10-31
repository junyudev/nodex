import type { PageReference } from "../../../../../shared/page-reference";
import { CloseIcon, PageIcon } from "@/components/shared/icons";
import { NodexTooltip } from "@/components/ui/tooltip";

function describeSelection(count: number) {
  return count === 1 ? "1 block" : `${count} blocks`;
}

/**
 * The Pages beside this chat ride along with the next message as references. They are ambient,
 * so they read as quiet outlined references rather than attachments the user added.
 */
export function ComposerPageContextChips({
  references,
  onRemove,
}: {
  readonly references: readonly PageReference[];
  readonly onRemove: (pageId: string) => void;
}) {
  return references.map((reference) => {
    const title = reference.titleSnapshot || "Untitled";
    const selected = reference.selectedBlockIds.length;
    return (
      <NodexTooltip
        key={reference.pageId}
        tooltipContent={
          selected > 0
            ? `Sends a link to ${title} and the ${describeSelection(selected)} you selected`
            : `Sends a link to ${title}`
        }
        side="top"
      >
        <span
          data-composer-page-context={reference.pageId}
          className="group/page-context inline-flex h-6 max-w-60 shrink-0 select-none items-center gap-1 rounded-full pr-0.5 pl-2 text-xs text-token-text-secondary ring-[0.5px] ring-inset ring-token-border"
        >
          <PageIcon className="size-3.5 shrink-0 text-token-description-foreground" />
          <span className="min-w-0 truncate">{title}</span>
          {selected > 0 ? (
            <span className="shrink-0 text-token-description-foreground">
              · {describeSelection(selected)}
            </span>
          ) : null}
          <button
            type="button"
            aria-label={`Don't send ${title}`}
            className="flex size-5 shrink-0 cursor-interaction items-center justify-center rounded-full text-token-description-foreground hover:bg-token-foreground/10 hover:text-token-foreground focus-visible:outline-2 focus-visible:outline-token-focus-border"
            onClick={() => onRemove(reference.pageId)}
          >
            <CloseIcon className="size-3" />
          </button>
        </span>
      </NodexTooltip>
    );
  });
}
