import { useEffect, useState, useSyncExternalStore } from "react";
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
  delegatedTaskStatusLabel,
  isDelegatedTaskLive,
  resolveDelegatedTaskRowStatus,
  runtimeNoticeTone,
} from "../../delegated-task-presentation";
import type { ThreadStageActions } from "../../thread-stage-types";
import { CodexShimmerText } from "./codex-shimmer-text";
import { SubagentGlyphIcon } from "./subagent-avatar";
import { ThreadActivityShell, ThreadRichActivityHeader } from "./tools/tool-primitives";

const noSubscription = () => () => {};
const actionClassName =
  "shrink-0 cursor-interaction rounded-sm px-1 text-xs text-token-text-tertiary hover:text-token-foreground focus-visible:outline-2 focus-visible:outline-offset-2 disabled:cursor-default disabled:opacity-60";

/** One delegated task: who runs it, its live status, and the actions its owner allows. */
export function DelegatedTaskRow({
  task,
  parentThreadId,
  membership,
  onOpenThread,
}: {
  task: CodexDelegatedTaskView;
  parentThreadId: string;
  membership: CodexConversationChildMembership | undefined;
  onOpenThread?: ThreadStageActions["onOpenThread"];
}) {
  const runtime = useConversationRuntimeOverride();
  const port = runtime?.delegatedTasks;
  const labels = runtime?.agentLabels;
  const model = membership?.thread?.model ?? null;
  const agent = useSyncExternalStore(
    labels?.subscribe ?? noSubscription,
    () => labels?.label(task.providerInstanceId, model) ?? null,
  );
  const stopRequested = useSyncExternalStore(
    port?.subscribe ?? noSubscription,
    () => port?.isStopping(task.taskId) ?? false,
  );
  const live = isDelegatedTaskLive(task.status);
  useEffect(() => {
    if (!live && stopRequested) port?.settle(task.taskId);
  }, [live, port, stopRequested, task.taskId]);
  const [expanded, setExpanded] = useState(false);
  const status = resolveDelegatedTaskRowStatus(task.status, stopRequested);
  const childThreadId = task.childThreadId;
  const stop = () => {
    if (!port) return;
    void port.stop(parentThreadId, task).catch((cause: unknown) => {
      toast.danger(cause instanceof Error ? cause.message : "Could not stop this subagent");
    });
  };
  const open = () => {
    if (!childThreadId || !onOpenThread) return;
    void onOpenThread(childThreadId, {
      subagent: {
        agentRole: null,
        conversationId: childThreadId,
        diffStats: null,
        displayName: task.title,
        spawnModel: model,
        status: task.status === "waiting" ? "waiting" : live ? "active" : "done",
        statusSummary: task.summary,
      },
    });
  };
  const details = [task.prompt.trim(), task.summary?.trim()].filter(Boolean);
  return (
    <ThreadActivityShell
      testId="delegated-task-row"
      header={
        <ThreadRichActivityHeader
          accessibleLabel={`${task.title}, ${delegatedTaskStatusLabel(status)}`}
          disclosure={
            details.length > 0
              ? { expanded, onToggle: () => setExpanded((current) => !current) }
              : undefined
          }
          icon={<SubagentGlyphIcon className="icon-xs shrink-0 text-token-conversation-body" />}
          summary={
            <span className="min-w-0 truncate">
              <CodexShimmerText active={status === "running"}>{task.title}</CodexShimmerText>
              {agent ? <span className="text-token-text-tertiary">{` · ${agent}`}</span> : null}
            </span>
          }
          accessory={
            <span className="flex shrink-0 items-center gap-1">
              <span
                className={cn(
                  "text-xs whitespace-nowrap",
                  status === "failed" ? "text-token-charts-red" : "text-token-text-tertiary",
                )}
                data-delegated-task-status={status}
              >
                {delegatedTaskStatusLabel(status)}
              </span>
              {port && canStopDelegatedTask(task) && status !== "stopping" ? (
                <button
                  type="button"
                  aria-label={`Stop ${task.title}`}
                  className={actionClassName}
                  onClick={stop}
                >
                  Stop
                </button>
              ) : null}
              {childThreadId && onOpenThread ? (
                <button
                  type="button"
                  aria-label={`Open ${task.title}`}
                  className={actionClassName}
                  onClick={open}
                >
                  Open
                </button>
              ) : null}
            </span>
          }
        />
      }
      body={
        expanded ? (
          <div className="flex flex-col gap-1 pt-1 pl-5 text-size-chat text-token-text-secondary">
            {details.map((detail) => (
              <p key={detail} className="line-clamp-6 break-words whitespace-pre-wrap">
                {detail}
              </p>
            ))}
          </div>
        ) : null
      }
    />
  );
}

function RuntimeNoticeIcon({ notice }: { notice: CodexRuntimeNotice | undefined }) {
  const className = "icon-xs shrink-0";
  if (notice?.kind === "stopped") return <StopIcon className={className} />;
  if (notice?.kind === "report" && notice.source === "subagent")
    return <SubagentGlyphIcon className={className} />;
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
