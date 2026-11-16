import { useIntl } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { useContext } from "react";
import type { CodexConversationItem } from "../../../../lib/types";
import {
  CodexTranscriptReadOwnerContext,
  CodexTranscriptTurnEntityContext,
  CodexTranscriptTurnStatusContext,
} from "../../normalized-transcript-hooks";
import { normalizeMessageCopyText } from "../../message-copy-text";
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
import {
  CopyMessageActionButton,
  ForkMessageIcon,
  MessageTimestamp,
  ThreadActionIconButton,
  ThreadMessageActionRow,
} from "./thread-message-actions";

export function AssistantMessageActionsRow({
  actions,
  copySource,
  cwd,
  projectlessOutputDirectory,
  threadId,
  turnId,
  isLatestTurn,
  onForkFromTurn,
}: {
  actions: ThreadAssistantMessageActionsModel;
  copySource?: CodexConversationItem;
  cwd?: string | null;
  projectlessOutputDirectory?: string | null;
  threadId: string;
  turnId: string | null;
  isLatestTurn: boolean;
  onForkFromTurn?: (input: {
    threadId: string;
    turnId: string;
    message: string;
    isLatestTurn: boolean;
  }) => void | Promise<void>;
}) {
  const intl = useIntl();
  const owner = useContext(CodexTranscriptReadOwnerContext);
  const entityKey = useContext(CodexTranscriptTurnEntityContext);
  const presentationStatus = useContext(CodexTranscriptTurnStatusContext);
  const readCopyText = () => {
    if (!copySource) return actions.copyText;
    const rawId = copySource.rawItemId;
    if (rawId && (!owner || !entityKey)) return null;
    const current =
      owner && entityKey && rawId
        ? owner.readProjectedItem(entityKey, rawId, copySource.itemId, presentationStatus)
        : copySource;
    // A bound address cannot fall back to the render-time source after retirement.
    if (
      !current ||
      current.threadId !== threadId ||
      current.turnId !== turnId ||
      current.itemId !== copySource.itemId ||
      current.kind !== copySource.kind
    )
      return null;
    const text = normalizeMessageCopyText(current.markdownText ?? "", {
      cwd,
      projectlessOutputDirectory,
    });
    return text.trim().length > 0 ? text : null;
  };
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
            !actions.alwaysVisible &&
              "opacity-0 group-focus-within:opacity-100 group-hover:opacity-100",
          )}
        >
          {actions.copyText !== null ? (
            <CopyMessageActionButton
              text={actions.copyText}
              getText={readCopyText}
              label={intl.formatMessage({
                id: "conversation.assistantMessageActions.copy",
                defaultMessage: "Copy",
              })}
              tooltipLabel={intl.formatMessage({
                id: "conversation.assistantMessageActions.copyResponse",
                defaultMessage: "Copy response",
              })}
              responseIcon
              stopPropagation
            />
          ) : null}
          {actions.canFork && onForkFromTurn && turnId !== null ? (
            <ThreadActionIconButton
              label={intl.formatMessage({
                id: "conversation.assistantMessageActions.fork",
                defaultMessage: "Fork chat from here",
              })}
              tooltip={intl.formatMessage({
                id: "conversation.assistantMessageActions.branch",
                defaultMessage: "Branch in new chat",
              })}
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
