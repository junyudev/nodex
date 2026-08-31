import { useEffect, useId, useState, type ReactNode } from "react";
import {
  AutomationActiveStatusIcon,
  ChevronRightIcon,
  DeniedCircleIcon,
  SuccessCircleIcon,
  WorktreeStatusIcon,
} from "@/components/shared/icons";
import { CodexShimmerText } from "@/features/local-conversation/view/shared/codex-shimmer-text";
import { ThreadExecShellContainer } from "@/features/local-conversation/view/shared/tools/thread-command-shell-block";
import { cn } from "@/lib/utils";
import { semanticActivityTextClassName } from "@/lib/semantic-activity-status";
import type {
  CodexPendingWorktreeEntry,
  CodexPendingWorktreeThreadResolution,
} from "../../../shared/codex-pending-worktree";
import {
  resolvePendingWorktreeProgressModel,
  type PendingWorktreeProgressStatus,
  type PendingWorktreeProgressStep,
} from "./pending-worktree-route-model";

const STEP_LABELS: Record<PendingWorktreeProgressStep["kind"], string> = {
  workspace: "Preparing workspace",
  checkout: "Checking out files",
  setup: "Setting up environment",
};

const STATUS_LABELS: Record<PendingWorktreeProgressStatus, string> = {
  pending: "Pending",
  running: "In progress",
  completed: "Completed",
  skipped: "Completed",
  failed: "Failed",
};

function ProgressStatusIcon({ status }: { status: PendingWorktreeProgressStatus }) {
  if (status === "running") return <AutomationActiveStatusIcon className="icon-xs" />;
  if (status === "completed" || status === "skipped") {
    return <SuccessCircleIcon className="icon-xs" />;
  }
  if (status === "failed") return <DeniedCircleIcon className="icon-xs" />;
  return <AutomationActiveStatusIcon className="icon-xs" />;
}

function ProgressStep({ step }: { step: PendingWorktreeProgressStep }) {
  const label =
    step.kind === "setup" && step.status === "skipped"
      ? "Environment setup skipped"
      : STEP_LABELS[step.kind];
  return (
    <div className="flex min-w-0 items-center justify-between gap-3">
      <div
        className={cn(
          "flex min-w-0 items-center gap-2 text-size-chat",
          semanticActivityTextClassName(step.status),
        )}
      >
        <span className="flex h-4 w-4 shrink-0 items-center justify-center">
          <ProgressStatusIcon status={step.status} />
        </span>
        <span className="sr-only">{STATUS_LABELS[step.status]}: </span>
        <span className="truncate">{label}</span>
      </div>
      {step.progressPercentage !== null ? (
        <div className="flex shrink-0 items-center gap-3">
          <div className="h-2 w-28 overflow-hidden rounded-full bg-text/10 rtl:rotate-180">
            <div
              className="h-full w-full rounded-full bg-text-info"
              style={{ transform: `translateX(${step.progressPercentage - 100}%)` }}
            />
          </div>
          <span className="semantic-text-secondary w-12 pe-2 text-end text-size-chat tabular-nums">
            {step.progressPercentage}%
          </span>
        </div>
      ) : null}
    </div>
  );
}

export function PendingWorktreeProgress({
  entry,
  resolution,
  actions,
  actionError,
}: {
  entry: CodexPendingWorktreeEntry;
  resolution: CodexPendingWorktreeThreadResolution | null;
  actions: ReactNode;
  actionError: string | null;
}) {
  const model = resolvePendingWorktreeProgressModel(entry, resolution);
  const detailsId = useId();
  const [detailsExpanded, setDetailsExpanded] = useState(model.detailsInitiallyExpanded);
  const [initialOutput] = useState(model.outputText);

  useEffect(() => {
    setDetailsExpanded(model.detailsInitiallyExpanded);
  }, [entry.attempt, entry.id, model.detailsInitiallyExpanded]);

  const detailsVisible = model.outputText.length > 0;
  const footerVisible = detailsVisible || actions !== null;

  return (
    <div className="flex w-full max-w-3xl flex-col gap-2" data-testid="pending-worktree-progress">
      <div className="flex items-center gap-2 text-size-chat text-tertiary select-none">
        <WorktreeStatusIcon className="icon-xs shrink-0" />
        <CodexShimmerText active={model.titleIsRunning}>{model.title}</CodexShimmerText>
      </div>
      {model.cardVisible ? (
        <div className="flex flex-col gap-3 rounded-xl border-[0.5px] border-default p-3">
          <div className="flex flex-col gap-2 select-none">
            {model.steps.map((step) => (
              <ProgressStep key={step.kind} step={step} />
            ))}
          </div>
          {footerVisible ? (
            <footer className="flex min-w-0 items-center justify-between gap-2">
              {detailsVisible ? (
                <button
                  type="button"
                  aria-controls={detailsId}
                  className="flex cursor-interaction items-center gap-2 text-size-chat text-tertiary select-none focus-visible:ring-2 focus-visible:ring-token-focus focus-visible:outline-none"
                  aria-expanded={detailsExpanded}
                  onClick={() => setDetailsExpanded((current) => !current)}
                >
                  <span className="flex h-4 w-4 items-center justify-center">
                    <ChevronRightIcon
                      className={cn(
                        "icon-2xs transition-transform duration-relaxed",
                        detailsExpanded && "rotate-90",
                      )}
                    />
                  </span>
                  {detailsExpanded ? "Less details" : "More details"}
                </button>
              ) : (
                <span />
              )}
              {actions ? (
                <div className="flex items-center justify-end gap-2">{actions}</div>
              ) : null}
            </footer>
          ) : null}
          {detailsVisible ? (
            <div id={detailsId} hidden={!detailsExpanded}>
              <ThreadExecShellContainer
                surface="plain"
                command=""
                output={detailsExpanded ? model.outputText : initialOutput}
                isInProgress={entry.phase === "creating" || entry.phase === "setting-up"}
              />
            </div>
          ) : null}
          {actionError ? (
            <div role="alert" className="text-size-chat text-danger">
              {actionError}
            </div>
          ) : null}
        </div>
      ) : null}
      {model.startingTask ? (
        <div className="mt-2 text-size-chat text-tertiary select-none">
          <CodexShimmerText>Starting a task</CodexShimmerText>
        </div>
      ) : null}
    </div>
  );
}
