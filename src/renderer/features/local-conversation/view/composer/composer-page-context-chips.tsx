import { CloseIcon, PageIcon, PlusIcon } from "@/components/shared/icons";
import { NodexTooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { ComposerPageContextOffer } from "./use-composer-page-context";

function describeSelection(count: number) {
  return count === 1 ? "1 block" : `${count} blocks`;
}

/**
 * The Pages beside this chat are offered as context for the next message. An offer is a dashed
 * ghost that sends nothing; one click includes it, and it then reads as a reference the user added.
 * Each chip is one toggle that keeps its place, so including or removing a Page never moves focus.
 */
export function ComposerPageContextChips({
  offers,
  onInclude,
  onRemove,
}: {
  readonly offers: readonly ComposerPageContextOffer[];
  readonly onInclude: (pageId: string) => void;
  readonly onRemove: (pageId: string) => void;
}) {
  return offers.map(({ reference, included }) => {
    const title = reference.titleSnapshot || "Untitled";
    const selected = reference.selectedBlockIds.length;
    const sent =
      selected > 0
        ? `a link to ${title} and the ${describeSelection(selected)} you selected`
        : `a link to ${title}`;
    const LeadingIcon = included ? PageIcon : PlusIcon;
    return (
      <NodexTooltip
        key={reference.pageId}
        tooltipContent={included ? `Sends ${sent}` : `Send ${sent} with this message`}
        side="top"
      >
        <button
          type="button"
          aria-pressed={included}
          aria-label={`Send ${title} with this message`}
          data-composer-page-context={reference.pageId}
          className={cn(
            "inline-flex h-6 max-w-60 shrink-0 cursor-interaction select-none items-center gap-1 rounded-full border pl-1.5 text-xs focus-visible:outline-2 focus-visible:outline-token-focus-border motion-safe:transition-colors",
            included
              ? "border-transparent bg-token-foreground/[0.07] pr-1 text-token-foreground hover:bg-token-foreground/10"
              : "border-dashed border-token-border pr-2 text-token-description-foreground hover:border-solid hover:bg-token-foreground/5 hover:text-token-text-secondary",
          )}
          // Keeps the caret in the prompt: the chip is an aside to writing the message.
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => (included ? onRemove : onInclude)(reference.pageId)}
        >
          <LeadingIcon className="size-3.5 shrink-0 text-token-description-foreground" />
          <span className="min-w-0 truncate">{title}</span>
          {selected > 0 ? (
            <span className="shrink-0 text-token-description-foreground">
              · {describeSelection(selected)}
            </span>
          ) : null}
          {included ? (
            <CloseIcon className="size-3 shrink-0 text-token-description-foreground" />
          ) : null}
        </button>
      </NodexTooltip>
    );
  });
}
