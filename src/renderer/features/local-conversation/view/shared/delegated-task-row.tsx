import { useEffect, useSyncExternalStore } from "react";
import { toast } from "@/components/ui/toast";
import { InfoIcon, StopIcon, TerminalActivityIcon } from "@/components/shared/icons";
import { cn } from "@/lib/utils";
import type {
  CodexConversationChildMembership,
  CodexDelegatedTaskView,
  CodexRuntimeNotice,
} from "../../../../../shared/types";
import { useConversationRuntimeOverride } from "../../conversation-runtime";
import {
  canStopDelegatedTask,
  delegatedTaskGroupStatusLabel,
  delegatedTaskStatusLabel,
  isDelegatedTaskLive,
  resolveDelegatedTaskRowStatus,
  runtimeNoticeTone,
  type DelegatedTaskRowStatus,
} from "../../delegated-task-presentation";
import type { ThreadStageActions } from "../../thread-stage-types";
import { SubagentAvatar, SubagentGlyphIcon } from "./subagent-avatar";
import { SubagentActivityDetails, SubagentActivityInline } from "./subagent-activity-inline";

const noSubscription = () => () => {};
const actionClassName =
  "shrink-0 cursor-interaction rounded-sm px-1 text-xs text-token-text-tertiary hover:text-token-foreground focus-visible:outline-2 focus-visible:outline-offset-2 disabled:cursor-default disabled:opacity-60";

function DelegatedTaskDetails({
  task,
  status,
  membership,
  onStop,
}: {
  task: CodexDelegatedTaskView;
  status: DelegatedTaskRowStatus;
  membership: CodexConversationChildMembership | undefined;
  onStop: (() => void) | undefined;
}) {
  const labels = useConversationRuntimeOverride()?.agentLabels;
  const model = membership?.thread?.model ?? null;
  const agent = useSyncExternalStore(
    labels?.subscribe ?? noSubscription,
    () => labels?.label(task.providerInstanceId, model) ?? null,
  );
  const details = task.childThreadId
    ? [task.summary?.trim() || task.prompt.trim()].filter(Boolean)
    : [...new Set([task.prompt.trim(), task.summary?.trim()].filter(Boolean))];
  return (
    <SubagentActivityDetails
      name={task.title}
      status={delegatedTaskStatusLabel(status)}
      statusTone={status === "failed" ? "danger" : "neutral"}
      description={
        details.length > 0 ? (
          <div className="flex max-h-56 flex-col gap-2 overflow-y-auto overscroll-contain">
            {details.map((detail) => (
              <p
                key={detail}
                className={cn(
                  "break-words whitespace-pre-wrap",
                  task.childThreadId && "line-clamp-4",
                )}
              >
                {detail}
              </p>
            ))}
          </div>
        ) : undefined
      }
      metadata={agent}
      path={task.agentPath ?? membership?.agentPath}
      startedAtMs={membership?.createdAtMs}
      action={
        onStop ? (
          <button
            type="button"
            aria-label={`Stop ${task.title}`}
            className={cn(actionClassName, "inline-flex items-center gap-1")}
            onClick={onStop}
          >
            <StopIcon className="icon-xxs" />
            Stop
          </button>
        ) : undefined
      }
    />
  );
}

/** Runtime tasks share the native activity's quiet visual grammar, with current task states. */
export function DelegatedTaskGroup({
  tasks,
  parentThreadId,
  childMemberships,
  onOpenThread,
  onOpenSubagentsPanel,
}: {
  tasks: readonly CodexDelegatedTaskView[];
  parentThreadId: string;
  childMemberships?: readonly CodexConversationChildMembership[];
  onOpenThread?: ThreadStageActions["onOpenThread"];
  onOpenSubagentsPanel?: ThreadStageActions["onOpenSubagentsPanel"];
}) {
  const port = useConversationRuntimeOverride()?.delegatedTasks;
  // A primitive snapshot records every addressed Stop request without allocating per read.
  const stopping = useSyncExternalStore(port?.subscribe ?? noSubscription, () =>
    tasks.map((task) => (port?.isStopping(task.taskId) ? "1" : "0")).join(""),
  );
  useEffect(() => {
    tasks.forEach((task, index) => {
      if (!isDelegatedTaskLive(task.status) && stopping[index] === "1") port?.settle(task.taskId);
    });
  }, [port, stopping, tasks]);
  const statuses = tasks.map((task, index) =>
    resolveDelegatedTaskRowStatus(task.status, stopping[index] === "1"),
  );
  const memberships = new Map(
    childMemberships?.map((membership) => [membership.threadId, membership]),
  );
  const items = tasks.map((task, index) => {
    const membership = task.childThreadId ? memberships.get(task.childThreadId) : undefined;
    const model = membership?.thread?.model ?? null;
    const status = statuses[index] ?? task.status;
    const childThreadId = task.childThreadId;
    const onOpen =
      childThreadId && onOpenThread
        ? () => {
            void onOpenThread(childThreadId, {
              subagent: {
                agentRole: null,
                conversationId: childThreadId,
                diffStats: null,
                displayName: task.title,
                spawnModel: model,
                status:
                  task.status === "waiting"
                    ? "waiting"
                    : isDelegatedTaskLive(task.status)
                      ? "active"
                      : "done",
                statusSummary: task.summary,
              },
            });
          }
        : undefined;
    const onStop =
      port && canStopDelegatedTask(task) && status !== "stopping"
        ? () => {
            void port.stop(parentThreadId, task).catch((cause: unknown) => {
              toast.danger(cause instanceof Error ? cause.message : "Could not stop this subagent");
            });
          }
        : undefined;
    return {
      id: task.taskId,
      name: task.title,
      seed: task.childThreadId,
      onOpen,
      details: (
        <DelegatedTaskDetails task={task} status={status} membership={membership} onStop={onStop} />
      ),
    };
  });
  return (
    <SubagentActivityInline
      items={items}
      statusLabel={delegatedTaskGroupStatusLabel(statuses)}
      statusTone={statuses.includes("failed") ? "danger" : "neutral"}
      onOpenAll={onOpenSubagentsPanel}
      testId="delegated-task-group"
    />
  );
}

function RuntimeNoticeIcon({ notice }: { notice: CodexRuntimeNotice | undefined }) {
  const className = "icon-xs shrink-0";
  if (notice?.kind === "stopped") return <StopIcon className={className} />;
  if (notice?.kind === "report" && notice.source === "subagent") {
    return notice.childThreadId ? (
      <SubagentAvatar seed={notice.childThreadId} className={className} />
    ) : (
      <SubagentGlyphIcon className={className} />
    );
  }
  if (notice?.kind === "report" && notice.source === "command")
    return <TerminalActivityIcon className={className} />;
  return <InfoIcon className={className} />;
}

/**
 * Execution events with no provider item: reported background work (which also opens an
 * automatic Run), a Run's stop marker, and Runtime information.
 */
export function RuntimeNoticeRow({
  message,
  notice,
  onOpenThread,
}: {
  message: string;
  notice: CodexRuntimeNotice | undefined;
  onOpenThread?: ThreadStageActions["onOpenThread"];
}) {
  const childThreadId = notice?.kind === "report" ? notice.childThreadId : null;
  return (
    <div
      className={cn(
        "flex min-w-0 items-center gap-1.5 text-size-chat",
        runtimeNoticeTone(notice) === "danger"
          ? "text-token-charts-red"
          : "text-token-conversation-body",
      )}
      data-runtime-notice={notice?.kind ?? "info"}
    >
      <RuntimeNoticeIcon notice={notice} />
      <span className="min-w-0 truncate">{message}</span>
      {childThreadId && onOpenThread ? (
        <button
          type="button"
          className={actionClassName}
          aria-label={`Open ${message}`}
          onClick={() => void onOpenThread(childThreadId)}
        >
          Open
        </button>
      ) : null}
    </div>
  );
}
