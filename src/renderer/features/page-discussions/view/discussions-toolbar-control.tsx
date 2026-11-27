import { useState } from "react";
import { FormattedMessage, useIntl } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { NodexSwitch } from "@/components/ui/button";
import { NodexPopover, NodexPopoverContent, NodexPopoverTrigger } from "@/components/ui/popover";
import { ViewerButton } from "@/components/ui/viewer-header";
import { NodexTooltip } from "@/components/ui/tooltip";
import {
  TextActionCommentIcon,
  TextActionCommentPencilIcon,
  FactCheckIcon,
} from "@/components/shared/icons/app-icons";
import {
  revealDiscussionAnchor,
  type PageDiscussionsController,
} from "../use-page-discussions-controller";
import { DiscussionsPanel } from "./discussions-panel";

/**
 * The Page toolbar's Comments control: a count of open Discussions that opens the list of every
 * Discussion on the Page, with the Page's "Nodex answers questions here" setting at its foot.
 */
export function DiscussionsToolbarControl({
  controller,
  canChangeSetting,
}: {
  readonly controller: PageDiscussionsController;
  readonly canChangeSetting: boolean;
}) {
  const intl = useIntl();
  const [open, setOpen] = useState(false);
  const openCount = controller.views.filter((view) => !view.resolved).length;
  const forMe = controller.views.some((view) => view.waiting === "me");
  const label = intl.formatMessage({
    id: "pageDiscussions.toolbar.comments",
    defaultMessage: "Comments",
  });
  return (
    <NodexPopover open={open} onOpenChange={setOpen}>
      <NodexTooltip tooltipContent={label} delayOpen>
        <NodexPopoverTrigger>
          <ViewerButton aria-label={label} data-tab-preview-pin-exempt="true">
            <TextActionCommentIcon className={cn("size-4", forMe && "text-info")} />
            {openCount > 0 ? <span className="text-xs tabular-nums">{openCount}</span> : null}
          </ViewerButton>
        </NodexPopoverTrigger>
      </NodexTooltip>
      <NodexPopoverContent
        aria-label={label}
        align="end"
        className="overflow-hidden rounded-xl bg-token-dropdown-background/95 p-0 shadow-xl-spread ring-[0.5px] ring-token-border backdrop-blur-xl"
      >
        <DiscussionsPanel
          discussions={controller.views}
          nowMs={controller.nowMs}
          initialFilter={forMe ? "me" : "open"}
          onSelect={(discussionId) => {
            setOpen(false);
            revealDiscussionAnchor(
              controller.editor,
              controller.views,
              discussionId,
              controller.setActiveId,
            );
          }}
        />
        {canChangeSetting ? (
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              controller.createAnchoredDiscussion({
                anchor: { kind: "page" },
                body: intl.formatMessage({
                  id: "pageDiscussions.toolbar.checkPageRequest",
                  defaultMessage: "Fact-check this Page.",
                }),
                toNodex: true,
                askKind: "check_page",
              });
            }}
            className="flex w-full cursor-interaction items-center gap-2 border-t-[0.5px] border-token-border px-3 py-2 text-left text-xs text-token-text-secondary hover:bg-token-list-hover-background"
          >
            <FactCheckIcon className="size-3.5" />
            <span className="min-w-0 flex-1">
              <FormattedMessage
                id="pageDiscussions.toolbar.checkPage"
                defaultMessage="Fact-check this Page"
              />
            </span>
          </button>
        ) : null}
        <label className="flex cursor-interaction items-center gap-2 border-t-[0.5px] border-token-border px-3 py-2 text-xs text-token-text-secondary">
          <span className="min-w-0 flex-1">
            <FormattedMessage
              id="pageDiscussions.toolbar.nodexAnswers"
              defaultMessage="Nodex answers questions on this Page"
            />
          </span>
          <NodexSwitch
            checked={controller.nodexAnswersQuestions}
            disabled={!canChangeSetting}
            size="compact"
            onCheckedChange={controller.setNodexAnswersQuestions}
            ariaLabel={intl.formatMessage({
              id: "pageDiscussions.toolbar.nodexAnswers",
              defaultMessage: "Nodex answers questions on this Page",
            })}
          />
        </label>
      </NodexPopoverContent>
    </NodexPopover>
  );
}

/**
 * Editing or suggesting. Editors switch freely; Commenters always suggest, so the control shows
 * the mode without offering the switch.
 */
export function SuggestModeControl({
  controller,
}: {
  readonly controller: PageDiscussionsController;
}) {
  const intl = useIntl();
  const label = controller.canEditPage
    ? intl.formatMessage(
        controller.suggesting
          ? {
              id: "pageDiscussions.toolbar.stopSuggesting",
              defaultMessage: "Stop suggesting and edit directly",
            }
          : {
              id: "pageDiscussions.toolbar.startSuggesting",
              defaultMessage: "Suggest edits instead of editing",
            },
      )
    : intl.formatMessage({
        id: "pageDiscussions.toolbar.commenterSuggesting",
        defaultMessage: "You can suggest edits; an editor accepts them",
      });
  return (
    <NodexTooltip tooltipContent={label} delayOpen>
      <ViewerButton
        aria-label={label}
        aria-pressed={controller.suggesting}
        variant={controller.suggesting ? "selected" : "default"}
        disabled={!controller.canEditPage}
        data-tab-preview-pin-exempt="true"
        onClick={() => controller.setSuggestMode(!controller.suggesting)}
      >
        <TextActionCommentPencilIcon className="size-4" />
        {controller.suggesting ? (
          <span className="text-xs">
            <FormattedMessage id="pageDiscussions.toolbar.suggesting" defaultMessage="Suggesting" />
          </span>
        ) : null}
      </ViewerButton>
    </NodexTooltip>
  );
}
