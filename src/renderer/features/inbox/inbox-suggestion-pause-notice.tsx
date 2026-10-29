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
  return (
    <NodexTooltip
      tooltipContent={
        <span className="flex max-w-72 flex-col gap-1">
          <span>
            {pause.pace === "spent"
              ? `${pause.agent}’s ${pause.window} limit is used up.`
              : `${pause.agent}’s ${pause.window} limit is nearly used up, and going faster than it resets.`}
          </span>
          <span className="text-token-description-foreground">
            Every message still offers Suggest. Automatic suggestions resume once usage recovers.
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
          Automatic suggestions paused · {describeInboxSuggestionPause(pause, nowMs)}
        </span>
      </p>
    </NodexTooltip>
  );
}
