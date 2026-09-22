import { footerText } from "./thread-footer-i18n";
import { useLayoutEffect, useRef, useState } from "react";
import {
  ThumbDownFilledIcon,
  ThumbDownIcon,
  ThumbMixedIcon,
  ThumbUpFilledIcon,
  ThumbUpIcon,
} from "@/components/shared/icons";
import { NodexDropdownItem, NodexDropdownMenu } from "@/components/ui/dropdown";
import { NodexTooltip } from "@/components/ui/tooltip";
import {
  threadMessageActionButtonClassName,
  type AssistantMessageRating,
} from "./thread-message-actions";

export function AssistantRatingMenu({
  selectedRating,
  onSelect,
}: {
  selectedRating: AssistantMessageRating | null;
  onSelect: (rating: AssistantMessageRating | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const restoreFocus = useRef(false);
  useLayoutEffect(() => {
    if (!restoreFocus.current) return;
    restoreFocus.current = false;
    triggerRef.current?.focus();
  }, [selectedRating]);

  const selectRating = (rating: AssistantMessageRating | null) => {
    restoreFocus.current = true;
    setOpen(false);
    onSelect(rating);
  };

  if (selectedRating !== null) {
    const good = selectedRating === "thumbs_up";
    const label = footerText(
      good ? "Remove good response feedback" : "Remove bad response feedback",
    );
    const Icon = good ? ThumbUpFilledIcon : ThumbDownFilledIcon;
    return (
      <NodexTooltip tooltipContent={label} side="top" delay={700}>
        <button
          ref={triggerRef}
          type="button"
          aria-label={label}
          aria-pressed="true"
          className={threadMessageActionButtonClassName}
          onClick={(event) => {
            event.stopPropagation();
            selectRating(null);
          }}
        >
          <Icon className="icon-xs electron:icon-sm" />
        </button>
      </NodexTooltip>
    );
  }

  return (
    <NodexDropdownMenu
      open={open}
      onOpenChange={setOpen}
      side="top"
      align="start"
      triggerTooltipContent={footerText("Rate response")}
      triggerTooltipDelay={700}
      triggerTooltipSideOffset={2}
      contentClassName="min-w-0 rounded-2xl"
      finalFocus={triggerRef}
      triggerButton={
        <button
          ref={triggerRef}
          type="button"
          aria-label={footerText("Rate response")}
          data-state={open ? "open" : "closed"}
          className={threadMessageActionButtonClassName}
          onClick={(event) => event.stopPropagation()}
        >
          <ThumbMixedIcon className="icon-xs electron:icon-sm" />
        </button>
      }
    >
      <NodexDropdownItem
        className="rounded-xl"
        leftSlot={<ThumbUpIcon className="size-5! text-token-foreground" />}
        onSelect={() => selectRating("thumbs_up")}
      >
        {footerText("Good response")}
      </NodexDropdownItem>
      <NodexDropdownItem
        className="rounded-xl"
        leftSlot={<ThumbDownIcon className="size-5! text-token-foreground" />}
        onSelect={() => selectRating("thumbs_down")}
      >
        {footerText("Bad response")}
      </NodexDropdownItem>
    </NodexDropdownMenu>
  );
}
