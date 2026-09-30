import { cn } from "@/lib/utils";
import {
  AutoReviewStatsIndicator,
  GoalAchievedIndicator,
  MemoriesCitedIndicator,
  UsedSkillsIndicator,
} from "./thread-footer-metadata";
import { ActivitySpinnerIcon } from "@/components/shared/icons";
import type { ThreadAssistantMessageActionsModel } from "../../thread-stage-types";
import { HookStatsIndicator } from "./hook-stats-indicator";
import { useThreadForkSubmission } from "./thread-fork-state";
import { footerText } from "./thread-footer-i18n";
import {
  CopyMessageActionButton,
  ForkMessageIcon,
  MessageTimestamp,
  ThreadActionIconButton,
  ThreadMessageActionRow,
} from "./thread-message-actions";

export function AssistantMessageActionsRow({
  actions,
  threadId,
  turnId,
  isLatestTurn,
  onForkFromTurn,
  alwaysShowActions = false,
}: {
  actions: ThreadAssistantMessageActionsModel;
  threadId: string;
  turnId: string | null;
  isLatestTurn: boolean;
  onForkFromTurn?: (input: {
    threadId: string;
    turnId: string;
    message: string;
    isLatestTurn: boolean;
  }) => void | Promise<void>;
  alwaysShowActions?: boolean;
}) {
  const { isForking, forkDisabled } = useThreadForkSubmission(turnId);
  const shouldShowActions =
    actions.copyText !== null ||
    (actions.canFork && onForkFromTurn != null) ||
    actions.hookStats != null ||
    actions.metadata != null;
  if (!shouldShowActions && !(actions.showTimestampWithoutActions && actions.sentAtMs != null))
    return null;

  return (
    <ThreadMessageActionRow align="start">
      {shouldShowActions ? (
        <div
          className={cn(
            "flex h-full items-center gap-0.5",
            !alwaysShowActions &&
              "opacity-0 group-focus-within:opacity-100 group-hover:opacity-100",
          )}
        >
          {actions.copyText !== null ? (
            <CopyMessageActionButton
              text={actions.copyText}
              label="Copy"
              tooltipLabel="Copy response"
              responseIcon
              stopPropagation
            />
          ) : null}
          {actions.canFork && onForkFromTurn && turnId !== null ? (
            <ThreadActionIconButton
              label={footerText("Fork chat from here")}
              tooltip={footerText("Branch in new chat")}
              disabled={forkDisabled}
              aria-busy={isForking || undefined}
              onClick={(event) => {
                event.stopPropagation();
                void onForkFromTurn?.({
                  threadId,
                  turnId,
                  message: "",
                  isLatestTurn,
                });
              }}
            >
              {isForking ? (
                <ActivitySpinnerIcon className="icon-xs electron:icon-sm" />
              ) : (
                <ForkMessageIcon />
              )}
            </ThreadActionIconButton>
          ) : null}
          {actions.metadata?.reviews.length ? (
            <AutoReviewStatsIndicator reviews={actions.metadata.reviews} />
          ) : null}
          {actions.hookStats ? <HookStatsIndicator stats={actions.hookStats} /> : null}
          {actions.metadata?.goalTimeUsedSeconds != null ? (
            <GoalAchievedIndicator seconds={actions.metadata.goalTimeUsedSeconds} />
          ) : null}
          {actions.metadata?.memories.length ? (
            <MemoriesCitedIndicator memories={actions.metadata.memories} />
          ) : null}
          {actions.metadata?.skills.length ? (
            <UsedSkillsIndicator
              skills={actions.metadata.skills}
              cwd={actions.metadata.cwd}
              hostId={actions.metadata.hostId}
            />
          ) : null}
        </div>
      ) : null}
      <MessageTimestamp sentAtMs={actions.sentAtMs} hoverOnly={actions.timestampHoverOnly} />
    </ThreadMessageActionRow>
  );
}
