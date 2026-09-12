import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import type { ThreadGoal } from "@nodex/codex-app-server-protocol/v2";
import {
  GoalChevronRightIcon,
  DeleteIcon,
  EditIcon,
  GoalPauseIcon,
  GoalResumeIcon,
  GoalTargetIcon,
  ActivitySpinnerIcon,
} from "@/components/shared/icons";
import {
  NodexDialog,
  NodexDialogAction,
  NodexDialogBody,
  NodexDialogContent,
  NodexDialogDescription,
  NodexDialogFooter,
  NodexDialogForm,
  NodexDialogHeader,
  NodexDialogTitle,
} from "@/components/ui/dialog";
import { NodexTooltip } from "@/components/ui/tooltip";
import { toast } from "@/components/ui/toast";
import { cn } from "@/lib/utils";
import type { ThreadStageActions } from "../../thread-stage-types";
import { formatWorkedForTimeLabel } from "../../thread-worked-for-time";
import {
  formatThreadGoalStatusLabel,
  formatThreadGoalTokenProgress,
  getThreadGoalMessage,
} from "../../thread-goal-copy";
import {
  cleanupMaterializedThreadGoalDraft,
  materializeThreadGoalDraft,
  readThreadGoalEditableObjective,
} from "../../thread-goal-materialization";

type GoalRowPendingAction = "edit" | "status" | "clear" | null;

function resolveThreadGoalToggleTarget(status: ThreadGoal["status"]): ThreadGoal["status"] | null {
  if (status === "active") return "paused";
  if (status === "paused" || status === "blocked" || status === "usageLimited") return "active";
  return null;
}

function resolveThreadGoalMetaText(goal: ThreadGoal, nowMs: number): string {
  if (goal.tokenBudget !== null && (goal.status === "active" || goal.status === "budgetLimited")) {
    return formatThreadGoalTokenProgress({
      used: goal.tokensUsed,
      budget: goal.tokenBudget,
    });
  }

  const elapsedMs =
    goal.status === "active"
      ? goal.timeUsedSeconds * 1000 + nowMs - goal.updatedAt * 1000
      : goal.timeUsedSeconds * 1000;
  return formatWorkedForTimeLabel(elapsedMs) ?? "0s";
}

function useThreadGoalNowMs(ticking: boolean): number {
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    if (!ticking) {
      setNowMs(Date.now());
      return undefined;
    }

    const interval = window.setInterval(() => {
      setNowMs(Date.now());
    }, 1000);

    return () => {
      window.clearInterval(interval);
    };
  }, [ticking]);

  return nowMs;
}

function useIsObjectiveTruncated({ disabled }: { disabled: boolean }) {
  const [element, setElement] = useState<HTMLSpanElement | null>(null);
  const [isTruncated, setIsTruncated] = useState(false);

  useLayoutEffect(() => {
    if (disabled || !element) {
      setIsTruncated(false);
      return undefined;
    }

    const update = () => {
      const nextIsTruncated = element.scrollWidth > element.clientWidth;
      setIsTruncated((current) => (current === nextIsTruncated ? current : nextIsTruncated));
    };

    update();

    if (typeof ResizeObserver === "undefined") return undefined;

    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => {
      observer.disconnect();
    };
  }, [disabled, element]);

  return {
    objectiveRef: setElement,
    isObjectiveTruncated: isTruncated,
  };
}

function ThreadGoalRowIconButton({
  ariaLabel,
  tooltip,
  disabled,
  loading = false,
  onClick,
  children,
  ariaExpanded,
}: {
  ariaLabel: string;
  tooltip: string;
  disabled?: boolean;
  loading?: boolean;
  onClick?: () => void;
  children: ReactNode;
  ariaExpanded?: boolean;
}) {
  return (
    <NodexTooltip side="top" tooltipContent={tooltip}>
      <button
        type="button"
        aria-label={ariaLabel}
        aria-expanded={ariaExpanded}
        disabled={disabled || loading}
        className="border-token-border no-drag cursor-interaction flex items-center gap-1 border whitespace-nowrap select-none focus:outline-none disabled:cursor-not-allowed disabled:opacity-40 rounded-full electron:rounded-md text-token-text-tertiary enabled:hover:bg-token-list-hover-background data-[state=open]:bg-token-list-hover-background border-transparent electron:p-1 electron:[&>svg]:icon-sm flex items-center justify-center p-0.5 [&>svg]:icon-2xs"
        onClick={onClick}
      >
        {loading ? <ActivitySpinnerIcon className="icon-2xs" /> : children}
      </button>
    </NodexTooltip>
  );
}

function ThreadGoalEditDialog({
  initialObjective,
  open,
  pending,
  onOpenChange,
  onSubmit,
}: {
  initialObjective: string;
  open: boolean;
  pending: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (objective: string) => Promise<void>;
}) {
  const [objective, setObjective] = useState(initialObjective);

  useEffect(() => {
    if (open) {
      setObjective(initialObjective);
    }
  }, [initialObjective, open]);

  const trimmedObjective = objective.trim();
  const canSave =
    !pending && trimmedObjective.length > 0 && trimmedObjective !== initialObjective.trim();

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canSave) return;
    await onSubmit(trimmedObjective);
  };

  return (
    <NodexDialog open={open} onOpenChange={onOpenChange}>
      <NodexDialogContent>
        <NodexDialogForm onSubmit={handleSubmit}>
          <NodexDialogHeader>
            <NodexDialogTitle className="flex items-center gap-2">
              <GoalTargetIcon className="icon-2xs text-token-input-placeholder-foreground/80" />
              <span>{getThreadGoalMessage("composer.threadGoal.editDialog.title")}</span>
            </NodexDialogTitle>
            <NodexDialogDescription className="sr-only">
              {getThreadGoalMessage("composer.threadGoal.editDialog.ariaLabel")}
            </NodexDialogDescription>
          </NodexDialogHeader>
          <NodexDialogBody>
            <textarea
              rows={3}
              className="min-h-[240px] w-full resize-none rounded-2xl border border-token-border bg-token-input-background px-3 py-2 text-token-input-foreground shadow-sm outline-none focus:ring-1 focus:ring-token-focus"
              autoFocus
              aria-label={getThreadGoalMessage("composer.threadGoal.editDialog.ariaLabel")}
              value={objective}
              disabled={pending}
              onKeyDown={(event) => {
                if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault();
                  event.currentTarget.form?.requestSubmit();
                }
              }}
              onInput={(event) => {
                setObjective(event.currentTarget.value);
              }}
            />
          </NodexDialogBody>
          <NodexDialogFooter>
            <NodexDialogAction disabled={pending} onClick={() => onOpenChange(false)}>
              {getThreadGoalMessage("composer.threadGoal.editDialog.cancel")}
            </NodexDialogAction>
            <NodexDialogAction tone="primary" type="submit" disabled={!canSave}>
              {getThreadGoalMessage("composer.threadGoal.editDialog.save")}
            </NodexDialogAction>
          </NodexDialogFooter>
        </NodexDialogForm>
      </NodexDialogContent>
    </NodexDialog>
  );
}

export function ThreadGoalStatusRow({
  goal,
  hostId,
  actions,
  showRoundedTop = true,
}: {
  goal: ThreadGoal | null;
  hostId: string;
  actions: ThreadStageActions;
  showRoundedTop?: boolean;
}) {
  const [expandedObjective, setExpandedObjective] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<GoalRowPendingAction>(null);
  const [editOpen, setEditOpen] = useState(false);
  const [editInitialObjective, setEditInitialObjective] = useState("");

  const hasGoal = goal !== null && goal.status !== "complete";
  const isExpanded = hasGoal && expandedObjective === goal.objective;
  const { objectiveRef, isObjectiveTruncated } = useIsObjectiveTruncated({
    disabled: !hasGoal || isExpanded,
  });
  const nowMs = useThreadGoalNowMs(goal?.status === "active");
  const toggleTarget = goal ? resolveThreadGoalToggleTarget(goal.status) : null;
  const metaText = useMemo(
    () => (goal ? resolveThreadGoalMetaText(goal, nowMs) : ""),
    [goal, nowMs],
  );

  useEffect(() => {
    if (!hasGoal) {
      setExpandedObjective(null);
      setEditOpen(false);
    }
  }, [hasGoal]);

  if (!hasGoal || !goal) {
    return null;
  }

  const isBusy = pendingAction !== null;

  const handleSetStatus = async () => {
    if (!toggleTarget || !actions.onSetThreadGoal) return;

    setPendingAction("status");
    try {
      await actions.onSetThreadGoal({
        threadId: goal.threadId,
        status: toggleTarget,
      });
    } catch {
      toast.danger(getThreadGoalMessage("composer.threadGoal.statusUpdateError"));
    } finally {
      setPendingAction(null);
    }
  };

  const handleClear = async () => {
    if (!actions.onClearThreadGoal) return;

    setPendingAction("clear");
    try {
      await actions.onClearThreadGoal(goal.threadId);
    } catch {
      toast.danger(getThreadGoalMessage("composer.threadGoal.clearError"));
    } finally {
      setPendingAction(null);
    }
  };

  const handleOpenEdit = async () => {
    setPendingAction("edit");
    try {
      setEditInitialObjective(await readThreadGoalEditableObjective(hostId, goal.objective));
      setEditOpen(true);
    } catch {
      setEditInitialObjective(goal.objective);
      setEditOpen(true);
    } finally {
      setPendingAction(null);
    }
  };

  const handleSaveEdit = async (objective: string) => {
    if (!actions.onSetThreadGoal) return;

    setPendingAction("edit");
    let materialized: Awaited<ReturnType<typeof materializeThreadGoalDraft>> | null = null;
    try {
      materialized = await materializeThreadGoalDraft(hostId, {
        objective,
        pastedTextAttachments: [],
        imageAttachments: [],
      });
      await actions.onSetThreadGoal({
        threadId: goal.threadId,
        objective: materialized.objective,
        status: "active",
        appendTranscriptItem: false,
      });
      materialized = null;
      setEditOpen(false);
    } catch {
      await cleanupMaterializedThreadGoalDraft(hostId, materialized);
      toast.danger(getThreadGoalMessage("composer.threadGoal.editSaveError"));
    } finally {
      setPendingAction(null);
    }
  };

  const toggleTooltip =
    toggleTarget === "paused"
      ? getThreadGoalMessage("composer.threadGoal.pauseTooltip")
      : getThreadGoalMessage("composer.threadGoal.resumeTooltip");
  const toggleLabel =
    toggleTarget === "paused"
      ? getThreadGoalMessage("composer.threadGoal.pause")
      : getThreadGoalMessage("composer.threadGoal.resume");

  return (
    <div className="order-2 flex min-w-0 flex-col" data-thread-goal-status-row="true">
      <div
        className={cn(
          "relative min-w-0 overflow-clip text-token-foreground",
          "border-x border-t border-token-border/80 bg-token-input-background/70 backdrop-blur-sm",
          showRoundedTop && "rounded-t-2xl",
        )}
      >
        <div className="flex items-center justify-between gap-2 px-3 py-row-y">
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <GoalTargetIcon className="icon-2xs shrink-0 text-token-input-placeholder-foreground/70" />
            <div className="text-size-chat flex min-w-0 flex-1 items-center overflow-hidden leading-4">
              <span className="shrink-0 text-token-foreground">
                {formatThreadGoalStatusLabel(goal.status)}
              </span>
              <span
                ref={objectiveRef}
                className="ml-1 min-w-0 truncate text-token-description-foreground"
              >
                {isExpanded ? null : goal.objective}
              </span>
              <span className="ml-1.5 shrink-0 whitespace-nowrap text-token-description-foreground">
                {!isExpanded && !isObjectiveTruncated ? " | " : null}
                {metaText}
              </span>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <ThreadGoalRowIconButton
              ariaLabel={getThreadGoalMessage("composer.threadGoal.edit")}
              tooltip={getThreadGoalMessage("composer.threadGoal.editTooltip")}
              disabled={isBusy || !actions.onSetThreadGoal}
              loading={pendingAction === "edit"}
              onClick={() => {
                void handleOpenEdit();
              }}
            >
              <EditIcon className="icon-2xs" />
            </ThreadGoalRowIconButton>
            {toggleTarget ? (
              <ThreadGoalRowIconButton
                ariaLabel={toggleLabel}
                tooltip={toggleTooltip}
                disabled={isBusy || !actions.onSetThreadGoal}
                loading={pendingAction === "status"}
                onClick={() => {
                  void handleSetStatus();
                }}
              >
                {toggleTarget === "paused" ? (
                  <GoalPauseIcon className="icon-2xs" />
                ) : (
                  <GoalResumeIcon className="icon-2xs" />
                )}
              </ThreadGoalRowIconButton>
            ) : null}
            <ThreadGoalRowIconButton
              ariaLabel={getThreadGoalMessage("composer.threadGoal.clear")}
              tooltip={getThreadGoalMessage("composer.threadGoal.clearTooltip")}
              disabled={isBusy || !actions.onClearThreadGoal}
              loading={pendingAction === "clear"}
              onClick={() => {
                void handleClear();
              }}
            >
              <DeleteIcon className="icon-2xs" />
            </ThreadGoalRowIconButton>
            {isObjectiveTruncated || isExpanded ? (
              <ThreadGoalRowIconButton
                ariaLabel={
                  isExpanded
                    ? getThreadGoalMessage("composer.threadGoal.collapseObjective")
                    : getThreadGoalMessage("composer.threadGoal.expandObjective")
                }
                tooltip={
                  isExpanded
                    ? getThreadGoalMessage("composer.threadGoal.collapseObjectiveTooltip")
                    : getThreadGoalMessage("composer.threadGoal.expandObjectiveTooltip")
                }
                ariaExpanded={isExpanded}
                onClick={() => {
                  setExpandedObjective(isExpanded ? null : goal.objective);
                }}
              >
                <GoalChevronRightIcon
                  className={cn("icon-2xs transition-transform", isExpanded && "rotate-90")}
                />
              </ThreadGoalRowIconButton>
            ) : null}
          </div>
        </div>
        {isExpanded ? (
          <div className="text-size-chat max-h-30 overflow-y-auto px-3 pb-2 leading-5 break-words whitespace-pre-wrap text-token-description-foreground">
            {goal.objective}
          </div>
        ) : null}
      </div>
      <ThreadGoalEditDialog
        initialObjective={editInitialObjective || goal.objective}
        open={editOpen}
        pending={pendingAction === "edit"}
        onOpenChange={(open) => {
          if (!open && pendingAction === "edit") return;
          setEditOpen(open);
        }}
        onSubmit={handleSaveEdit}
      />
    </div>
  );
}
