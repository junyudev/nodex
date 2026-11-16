import { getIntl, useIntl } from "@/lib/i18n";
import { PauseIcon } from "@/components/shared/icons";
import { NodexTooltip } from "@/components/ui/tooltip";
import type { InboxSuggestionPause } from "../../../shared/inbox-suggestion-policy";
import { describeInboxSuggestionPause } from "./inbox-presentation";

/**
 * Says, just above where the next message is written, why it will not be suggested on its own:
 * which usage ran short, how much is left and when it comes back.
 */
export function InboxSuggestionPauseNotice({
  pause,
  nowMs,
}: {
  readonly pause: InboxSuggestionPause;
  readonly nowMs: number;
}) {
  const intl = useIntl();
  return (
    <NodexTooltip
      tooltipContent={
        <span className="flex max-w-72 flex-col gap-1">
          <span>
            {pause.pace === "spent"
              ? getIntl().formatMessage(
                  {
                    id: "inbox.inboxSuggestionPauseNotice.limitUsed",
                    defaultMessage: "{agent}’s {window} limit is used up.",
                  },
                  { agent: pause.agent, window: pause.window },
                )
              : getIntl().formatMessage(
                  {
                    id: "inbox.inboxSuggestionPauseNotice.limitNearlyUsed",
                    defaultMessage:
                      "{agent}’s {window} limit is nearly used up, and going faster than it resets.",
                  },
                  { agent: pause.agent, window: pause.window },
                )}
          </span>
          <span className="text-token-description-foreground">
            {getIntl().formatMessage({
              id: "inbox.inboxSuggestionPauseNotice.manualStillAvailable",
              defaultMessage:
                "Every message still offers Suggest. Automatic suggestions resume once usage recovers.",
            })}
          </span>
        </span>
      }
      side="top"
    >
      <p
        role="status"
        className="mb-2 flex max-w-full min-w-0 items-center gap-1.5 self-center px-2 text-xs text-token-description-foreground"
      >
        <PauseIcon className="icon-2xs shrink-0" />
        <span className="truncate">
          {getIntl().formatMessage({
            id: "inbox.inboxSuggestionPauseNotice.paused",
            defaultMessage: "Automatic suggestions paused ·",
          })}{" "}
          {describeInboxSuggestionPause(pause, nowMs, intl)}
        </span>
      </p>
    </NodexTooltip>
  );
}
