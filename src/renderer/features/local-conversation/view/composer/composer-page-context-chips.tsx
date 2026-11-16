import { CloseIcon, PageIcon, PlusIcon } from "@/components/shared/icons";
import { NodexTooltip } from "@/components/ui/tooltip";
import { useIntl } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import type { ComposerPageContextOffer } from "./use-composer-page-context";

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
  const intl = useIntl();
  return offers.map(({ reference, included }) => {
    const title =
      reference.titleSnapshot ||
      intl.formatMessage({
        id: "conversation.composerPageContextChips.untitled",
        defaultMessage: "Untitled",
      });
    const selected = reference.selectedBlockIds.length;
    const tooltip = included
      ? intl.formatMessage(
          {
            id: "conversation.composerPageContextChips.includedTooltip",
            defaultMessage:
              "Sends a link to {title}{selected, plural, =0 {} one { and the {selected} block you selected} other { and the {selected} blocks you selected}}",
          },
          { title, selected },
        )
      : intl.formatMessage(
          {
            id: "conversation.composerPageContextChips.offerTooltip",
            defaultMessage:
              "Send a link to {title}{selected, plural, =0 {} one { and the {selected} block you selected} other { and the {selected} blocks you selected}} with this message",
          },
          { title, selected },
        );
    const LeadingIcon = included ? PageIcon : PlusIcon;
    return (
      <NodexTooltip key={reference.pageId} tooltipContent={tooltip} side="top">
        <button
          type="button"
          aria-pressed={included}
          aria-label={intl.formatMessage(
            {
              id: "conversation.composerPageContextChips.sendPage",
              defaultMessage: "Send {title} with this message",
            },
            { title },
          )}
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
              ·{" "}
              {intl.formatMessage(
                {
                  id: "conversation.composerPageContextChips.blockCount",
                  defaultMessage: "{count, plural, one {{count} block} other {{count} blocks}}",
                },
                { count: selected },
              )}
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
