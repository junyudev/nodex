import { FormattedMessage } from "@/lib/i18n";
import { NodexButton } from "@/components/ui/button";
import { usePageDiscussionsControllerContext } from "../page-discussions-context";

/**
 * The bar that says the Page is in Suggest mode. Before any edit it explains what editing does;
 * during a suggestion it counts the changed runs of Blocks and offers Discard and Suggest.
 * It floats at the bottom of the Page's scroll surface and never moves the text.
 */
export function SuggestionBar() {
  const controller = usePageDiscussionsControllerContext();
  if (!controller?.suggesting) return null;
  const session = controller.suggestion;
  return (
    <div className="pointer-events-none sticky bottom-5 z-20 flex justify-center">
      <div
        role="status"
        data-suggestion-bar={session ? "editing" : "idle"}
        className="pointer-events-auto flex h-9 items-center gap-2 rounded-full bg-token-dropdown-background py-1 pr-1 pl-3.5 text-sm shadow-xl-spread ring-[0.5px] ring-token-border"
      >
        <span
          className="size-1.5 shrink-0 rounded-full bg-(--color-token-charts-blue)"
          aria-hidden="true"
        />
        {session ? (
          <>
            <span className="tabular-nums">
              <FormattedMessage
                id="pageDiscussions.suggestionBar.changes"
                defaultMessage="{count, plural, =0 {Suggesting, no changes yet} one {# suggested change} other {# suggested changes}}"
                values={{ count: session.changeCount }}
              />
            </span>
            <NodexButton
              variant="ghostSecondary"
              size="xs"
              disabled={session.submitting}
              onClick={controller.discardSuggestions}
            >
              <FormattedMessage
                id="pageDiscussions.suggestionBar.discard"
                defaultMessage="Discard"
              />
            </NodexButton>
            <NodexButton
              variant="primary"
              size="xs"
              className="rounded-full"
              disabled={session.changeCount === 0 || session.submitting}
              onClick={controller.submitSuggestions}
            >
              <FormattedMessage
                id="pageDiscussions.suggestionBar.suggest"
                defaultMessage="Suggest"
              />
            </NodexButton>
          </>
        ) : (
          <span className="pr-2.5 text-token-text-secondary">
            {controller.canEditPage ? (
              <FormattedMessage
                id="pageDiscussions.suggestionBar.idleEditor"
                defaultMessage="Suggesting: your edits become suggestions for review"
              />
            ) : (
              <FormattedMessage
                id="pageDiscussions.suggestionBar.idleCommenter"
                defaultMessage="You can comment and suggest edits on this Page"
              />
            )}
          </span>
        )}
      </div>
    </div>
  );
}
