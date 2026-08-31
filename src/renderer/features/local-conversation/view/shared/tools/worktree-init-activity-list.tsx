import type { ReactNode } from "react";
import { ThreadIcon, WorktreeSetupStatusIcon, WorktreeStatusIcon } from "@/components/shared/icons";
import type { CodexWorktreeInitActivity } from "@/lib/codex-worktree-init-activity";
import { codexWorktreeInitActivityLabel } from "@/lib/codex-worktree-init-activity";
import { cn } from "@/lib/utils";
import {
  semanticActivitySummaryClassName,
  semanticActivityTextClassName,
} from "@/lib/semantic-activity-status";
import { CodexShimmerText } from "../codex-shimmer-text";
import { ThreadExecShellContainer } from "./thread-command-shell-block";
import { ThreadActivityDisclosure } from "./tool-primitives";

function WorktreeInitActivityIcon({
  activity,
  worktreeIcon,
}: {
  activity: CodexWorktreeInitActivity;
  worktreeIcon: ReactNode;
}) {
  const className = cn("icon-xs shrink-0", semanticActivityTextClassName(activity.status));

  if (activity.kind === "worktree") {
    if (worktreeIcon !== null) return worktreeIcon;
    return <WorktreeStatusIcon className={className} />;
  }
  if (activity.kind === "setup") {
    return <WorktreeSetupStatusIcon aria-hidden="true" className={className} />;
  }
  return <ThreadIcon className={className} />;
}

function RunningConversationActivity({ activity }: { activity: CodexWorktreeInitActivity }) {
  return (
    <div className="mt-3 min-w-0">
      <CodexShimmerText className="text-size-chat leading-[calc(var(--codex-chat-font-size)_+_8px)] truncate select-none">
        {codexWorktreeInitActivityLabel(activity)}
      </CodexShimmerText>
    </div>
  );
}

export interface WorktreeInitActivityListProps {
  activities: readonly CodexWorktreeInitActivity[];
  actions?: ReactNode;
  worktreeIcon?: ReactNode;
}

export function WorktreeInitActivityList({
  activities,
  actions = null,
  worktreeIcon = null,
}: WorktreeInitActivityListProps) {
  const actionTargetId = actions === null ? null : (activities.at(-1)?.id ?? null);

  return (
    <div className="flex w-full max-w-3xl flex-col gap-2">
      {activities.map((activity) => {
        if (activity.kind === "conversation" && activity.status === "running") {
          return <RunningConversationActivity key={activity.id} activity={activity} />;
        }

        const isActionTarget = activity.id === actionTargetId;
        const footer = isActionTarget ? (
          <div
            className={cn(
              "flex items-center justify-end gap-2",
              activity.outputText.length > 0 && "px-3 pb-3",
            )}
          >
            {actions}
          </div>
        ) : null;
        const body =
          activity.outputText.length > 0 ? (
            <ThreadExecShellContainer
              command=""
              output={activity.outputText}
              isInProgress={activity.status === "running"}
              footer={footer}
              surface="plain"
            />
          ) : (
            footer
          );

        return (
          <ThreadActivityDisclosure
            autoExpandWhileRunning
            key={`${activity.id}:${isActionTarget}`}
            canExpand={body !== null}
            defaultExpanded={isActionTarget}
            indentContent={false}
            icon={
              <WorktreeInitActivityIcon
                activity={activity}
                worktreeIcon={activity.kind === "worktree" ? worktreeIcon : null}
              />
            }
            summary={
              <CodexShimmerText
                active={activity.status === "running"}
                className={cn(
                  "min-w-0 truncate text-size-chat group-hover/activity-header:text-token-foreground",
                  semanticActivitySummaryClassName(activity.status),
                )}
              >
                {codexWorktreeInitActivityLabel(activity)}
              </CodexShimmerText>
            }
            status={activity.status === "skipped" ? "completed" : activity.status}
          >
            {body}
          </ThreadActivityDisclosure>
        );
      })}
    </div>
  );
}
