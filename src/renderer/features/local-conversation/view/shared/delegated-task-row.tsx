import { useEffect, useSyncExternalStore } from "react";
import { toast } from "@/components/ui/toast";
import {
  DeniedCircleIcon,
  InfoIcon,
  StopIcon,
  TerminalActivityIcon,
} from "@/components/shared/icons";
import { cn } from "@/lib/utils";
import type {
  CodexConversationChildMembership,
  CodexDelegatedTaskView,
  CodexRuntimeNotice,
} from "../../../../../shared/types";
import type { ConversationAgent } from "../../../../../shared/conversation-identity";
import { useConversationRuntimeOverride } from "../../conversation-runtime";
import {
  canStopDelegatedTask,
  delegatedTaskGroupStatusLabel,
  delegatedTaskRecoveryLabel,
  delegatedTaskStatusLabel,
  isDelegatedTaskLive,
  resolveDelegatedTaskRowStatus,
  runtimeNoticeTone,
  type DelegatedTaskRowStatus,
} from "../../delegated-task-presentation";
import type { ThreadStageActions } from "../../thread-stage-types";
import { SubagentAvatar, SubagentGlyphIcon } from "./subagent-avatar";
import { SubagentActivityDetails, SubagentActivityInline } from "./subagent-activity-inline";
import { useRecoveryNow } from "./use-recovery-now";

const noSubscription = () => () => {};
const actionClassName =
  "shrink-0 cursor-interaction rounded-sm px-1 text-xs text-token-text-tertiary hover:text-token-foreground focus-visible:outline-2 focus-visible:outline-offset-2 disabled:cursor-default disabled:opacity-60";

/** The Agent a child's owner reports, or else the harness its task names. */
function delegatedTaskAgent(
  task: CodexDelegatedTaskView,
  membership: CodexConversationChildMembership | undefined,
): ConversationAgent {
  return (
    membership?.agent ?? {
      kind: task.agentKind,
      providerInstanceId: task.providerInstanceId,
      model: membership?.thread?.model ?? null,
      effort: null,
    }
  );
}

/** Opens one subagent's own conversation in the Subagents tab beside its parent. */
function openSubagent(
  onOpenThread: ThreadStageActions["onOpenThread"],
  child: {
    readonly threadId: string;
    readonly name: string;
    readonly model: string | null;
    readonly status: "active" | "waiting" | "done";
    readonly summary: string | null;
  },
) {
  return onOpenThread(child.threadId, {
    subagent: {
      agentRole: null,
      conversationId: child.threadId,
      diffStats: null,
      displayName: child.name,
      spawnModel: child.model,
      status: child.status,
      statusSummary: child.summary,
    },
  });
}

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
  const now = useRecoveryNow(task.recovery);
  const details = task.childThreadId
    ? [task.summary?.trim() || task.prompt.trim()].filter(Boolean)
    : [...new Set([task.prompt.trim(), task.summary?.trim()].filter(Boolean))];
  return (
    <SubagentActivityDetails
      name={task.title}
      status={
        status === "retrying" && task.recovery
          ? delegatedTaskRecoveryLabel(task.recovery, now)
          : delegatedTaskStatusLabel(status)
      }
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
      agent={delegatedTaskAgent(task, membership)}
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
    resolveDelegatedTaskRowStatus(task, stopping[index] === "1"),
  );
  const memberships = new Map(
    childMemberships?.map((membership) => [membership.threadId, membership]),
  );
  const items = tasks.map((task, index) => {
    const membership = memberships.get(task.childThreadId ?? task.taskId);
    const status = statuses[index] ?? task.status;
    const childThreadId = task.childThreadId;
    const onOpen =
      childThreadId && onOpenThread
        ? () => {
            void openSubagent(onOpenThread, {
              threadId: childThreadId,
              name: task.title,
              model: membership?.agent?.model ?? membership?.thread?.model ?? null,
              status:
                task.status === "waiting"
                  ? "waiting"
                  : isDelegatedTaskLive(task.status)
                    ? "active"
                    : "done",
              summary: task.summary,
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
  if (notice?.kind === "declined") return <DeniedCircleIcon className={className} />;
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

type SubagentReport = Extract<CodexRuntimeNotice, { kind: "report" }>;

const REPORT_STATUS: Record<SubagentReport["outcome"], { sentence: string; status: string }> = {
  completed: { sentence: "finished", status: "Done" },
  updated: { sentence: "reported back", status: "Running" },
  unknown: { sentence: "finished", status: "Done" },
  failed: { sentence: "failed", status: "Failed" },
  cancelled: { sentence: "stopped", status: "Stopped" },
};

/** The reported subagents, in report order, when the parent still knows each of them. */
function reportedSubagents(
  notice: SubagentReport,
  memberships: readonly CodexConversationChildMembership[],
): readonly CodexConversationChildMembership[] | null {
  const reported =
    notice.taskIds.length > 0
      ? notice.taskIds.map((taskId) => memberships.find((child) => child.taskId === taskId))
      : notice.childThreadId
        ? [memberships.find((child) => child.threadId === notice.childThreadId)]
        : [];
  const known = reported.filter(
    (child): child is CodexConversationChildMembership => child !== undefined,
  );
  return known.length > 0 && known.length === reported.length ? known : null;
}

/**
 * Subagents reporting back read like the row that started them: the same avatars and names, the
 * same details on hover, and each name opens its own conversation.
 */
function SubagentReportRow({
  notice,
  reported,
  onOpenThread,
  onOpenSubagentsPanel,
}: {
  notice: SubagentReport;
  reported: readonly CodexConversationChildMembership[];
  onOpenThread?: ThreadStageActions["onOpenThread"];
  onOpenSubagentsPanel?: ThreadStageActions["onOpenSubagentsPanel"];
}) {
  const { sentence, status } = REPORT_STATUS[notice.outcome];
  const tone = notice.outcome === "failed" ? "danger" : "neutral";
  const items = reported.map((child) => {
    const name = child.displayName?.trim() || "Subagent";
    // A provider's task observation has no conversation of its own to open.
    const conversation = child.task ? null : child.threadId;
    return {
      id: child.taskId ?? child.threadId,
      name,
      seed: conversation,
      onOpen:
        conversation && onOpenThread
          ? () =>
              void openSubagent(onOpenThread, {
                threadId: conversation,
                name,
                model: child.agent?.model ?? child.thread?.model ?? null,
                status: "done",
                summary: null,
              })
          : undefined,
      details: (
        <SubagentActivityDetails
          name={name}
          status={status}
          statusTone={tone}
          agent={child.agent}
          path={child.agentPath}
          startedAtMs={child.createdAtMs}
        />
      ),
    };
  });
  return (
    <SubagentActivityInline
      items={items}
      statusLabel={sentence}
      statusTone={tone}
      onOpenAll={onOpenSubagentsPanel}
      testId="subagent-report"
    />
  );
}

/**
 * Execution events with no provider item: reported background work (which also opens an
 * automatic Run), a Run's stop marker, and Runtime information.
 */
export function RuntimeNoticeRow({
  message,
  notice,
  childMemberships = [],
  onOpenThread,
  onOpenSubagentsPanel,
}: {
  message: string;
  notice: CodexRuntimeNotice | undefined;
  childMemberships?: readonly CodexConversationChildMembership[];
  onOpenThread?: ThreadStageActions["onOpenThread"];
  onOpenSubagentsPanel?: ThreadStageActions["onOpenSubagentsPanel"];
}) {
  const reported =
    notice?.kind === "report" && notice.source === "subagent"
      ? reportedSubagents(notice, childMemberships)
      : null;
  if (notice?.kind === "report" && reported) {
    return (
      <div data-runtime-notice="report">
        <SubagentReportRow
          notice={notice}
          reported={reported}
          onOpenThread={onOpenThread}
          onOpenSubagentsPanel={onOpenSubagentsPanel}
        />
      </div>
    );
  }
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
