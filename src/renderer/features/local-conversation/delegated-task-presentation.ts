import { defineMessages, getIntl, type IntlShape, type MessageDescriptor } from "@/lib/i18n";
import type { ConversationRecovery } from "../../../shared/conversation-recovery";
import type {
  CodexDelegatedTaskStatus,
  CodexDelegatedTaskView,
  CodexRuntimeNotice,
} from "../../../shared/types";
import {
  recoveryProgressLabel,
  recoveryStatusLabel,
} from "./projection/conversation-recovery-presentation";

/**
 * The row additionally shows a Stop request that the task has not settled yet, and a running
 * task that is waiting to recover from a transient provider failure.
 */
export type DelegatedTaskRowStatus = CodexDelegatedTaskStatus | "stopping" | "retrying";

export const isDelegatedTaskLive = (status: CodexDelegatedTaskStatus): boolean =>
  status === "running" || status === "waiting";

export function resolveDelegatedTaskRowStatus(
  task: Pick<CodexDelegatedTaskView, "status" | "recovery">,
  stopRequested: boolean,
): DelegatedTaskRowStatus {
  if (!isDelegatedTaskLive(task.status)) return task.status;
  if (stopRequested) return "stopping";
  return task.recovery ? "retrying" : task.status;
}

const STATUS_LABEL: Record<DelegatedTaskRowStatus, MessageDescriptor> = defineMessages({
  running: { id: "conversation.delegatedTaskPresentation.running", defaultMessage: "Running" },
  waiting: { id: "conversation.delegatedTaskPresentation.waiting", defaultMessage: "Waiting" },
  retrying: { id: "conversation.delegatedTaskPresentation.retrying", defaultMessage: "Retrying" },
  stopping: { id: "conversation.delegatedTaskPresentation.stopping", defaultMessage: "Stopping…" },
  stopped: { id: "conversation.delegatedTaskPresentation.stopped", defaultMessage: "Stopped" },
  cancelled: {
    id: "conversation.delegatedTaskPresentation.cancelled",
    defaultMessage: "Cancelled",
  },
  failed: { id: "conversation.delegatedTaskPresentation.failed", defaultMessage: "Failed" },
  completed: { id: "conversation.delegatedTaskPresentation.completed", defaultMessage: "Done" },
});

export const delegatedTaskStatusLabel = (
  status: DelegatedTaskRowStatus,
  intl: IntlShape = getIntl(),
): string => intl.formatMessage(STATUS_LABEL[status]);

const SUMMARY_STATUS_ORDER: readonly DelegatedTaskRowStatus[] = [
  "failed",
  "stopping",
  "retrying",
  "waiting",
  "running",
  "cancelled",
  "stopped",
  "completed",
];

/** A mixed group keeps every outcome visible instead of projecting a false shared lifecycle. */
export function delegatedTaskGroupStatusLabel(
  statuses: readonly DelegatedTaskRowStatus[],
  intl: IntlShape = getIntl(),
): string {
  const first = statuses[0];
  if (first === undefined) return "";
  const count = statuses.length;
  if (statuses.every((status) => status === first)) {
    switch (first) {
      case "running":
        return intl.formatMessage(
          {
            id: "conversation.delegatedTaskPresentation.groupWorking",
            defaultMessage: "{count, plural, one {is working} other {are working}}",
          },
          { count },
        );
      case "waiting":
        return intl.formatMessage(
          {
            id: "conversation.delegatedTaskPresentation.groupWaiting",
            defaultMessage: "{count, plural, one {is waiting} other {are waiting}}",
          },
          { count },
        );
      case "retrying":
        return intl.formatMessage(
          {
            id: "conversation.delegatedTaskPresentation.groupRetrying",
            defaultMessage: "{count, plural, one {is retrying} other {are retrying}}",
          },
          { count },
        );
      case "stopping":
        return intl.formatMessage(
          {
            id: "conversation.delegatedTaskPresentation.groupStopping",
            defaultMessage: "{count, plural, one {is stopping…} other {are stopping…}}",
          },
          { count },
        );
      case "completed":
        return intl.formatMessage({
          id: "conversation.delegatedTaskPresentation.groupFinished",
          defaultMessage: "finished",
        });
      case "cancelled":
        return intl.formatMessage(
          {
            id: "conversation.delegatedTaskPresentation.groupCancelled",
            defaultMessage: "{count, plural, one {was cancelled} other {were cancelled}}",
          },
          { count },
        );
      case "stopped":
      case "failed":
        return delegatedTaskStatusLabel(first, intl).toLowerCase();
    }
  }
  const counts = new Map<DelegatedTaskRowStatus, number>();
  for (const status of statuses) counts.set(status, (counts.get(status) ?? 0) + 1);
  return `— ${SUMMARY_STATUS_ORDER.flatMap((status) => {
    const count = counts.get(status);
    if (count === undefined) return [];
    const label =
      status === "running"
        ? intl.formatMessage({
            id: "conversation.delegatedTaskPresentation.mixedWorking",
            defaultMessage: "working",
          })
        : delegatedTaskStatusLabel(status, intl).toLowerCase();
    return [
      intl.formatMessage(
        {
          id: "conversation.delegatedTaskPresentation.mixedStatus",
          defaultMessage: "{count} {label}",
        },
        { count, label },
      ),
    ];
  }).join(" · ")}`;
}

/** Only an open task can be stopped, and only through its exact owning Run. */
export const canStopDelegatedTask = (task: CodexDelegatedTaskView): boolean =>
  isDelegatedTaskLive(task.status) && task.ownerRunId !== null;

/** A recovering task's detail names its cause and progress, like the transcript's recovery row. */
export function delegatedTaskRecoveryLabel(
  recovery: ConversationRecovery,
  now: number,
  intl: IntlShape = getIntl(),
): string {
  return [recoveryStatusLabel(recovery, intl), recoveryProgressLabel(recovery, now, intl)]
    .filter(Boolean)
    .join(" · ");
}

/** Markdown export mirrors the row: title, who ran it and how it ended. */
export function delegatedTaskMarkdownLines(
  task: CodexDelegatedTaskView,
): readonly (string | null)[] {
  return [
    task.title,
    `Status: ${STATUS_LABEL[task.status].defaultMessage}`,
    task.summary ? `Result: ${task.summary}` : null,
  ];
}

export type RuntimeNoticeTone = "neutral" | "danger";

export const runtimeNoticeTone = (notice: CodexRuntimeNotice | undefined): RuntimeNoticeTone =>
  notice?.kind === "report" && notice.outcome === "failed" ? "danger" : "neutral";
