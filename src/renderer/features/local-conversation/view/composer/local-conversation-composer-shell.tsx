import { AsyncQuestionComposer } from "./async-question-surface";
import { NodexDropdownItem, NodexDropdownMenu } from "@/components/ui/dropdown";
import {
  closestCenter,
  DndContext,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type Modifier,
} from "@dnd-kit/core";
import {
  arrayMove,
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { AnimatePresence, motion } from "motion/react";
import {
  useEffect,
  forwardRef,
  useLayoutEffect,
  useMemo,
  useState,
  type ButtonHTMLAttributes,
  type FormEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import {
  ActivitySpinnerIcon,
  AutomationMoreIcon,
  ChevronRightIcon,
  ComposerResumeIcon,
  DeleteIcon,
  EditIcon,
  QueueFailureIcon,
  QueuePauseIcon,
  QueuePendingInfoIcon,
  QueueSteerIcon,
  QueuedFollowUpIcon,
  SidePanelSideChatIcon,
  SidebarManualOrderIcon,
  StopIcon,
} from "@/components/shared/icons";
import { serializeSortableTranslation } from "@/lib/sortable-transform";
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
import type {
  ThreadComposerShellBackgroundAgentRowModel,
  ThreadComposerShellPendingSteerRowModel,
  ThreadComposerShellQueuedFollowUpRowModel,
  ThreadFooterModel,
  ThreadStageActions,
} from "../../thread-stage-types";
import { getThreadGoalMessage } from "../../thread-goal-copy";
import { ModelSelectorDropdown, ThreadComposer } from "./local-conversation-thread-composer";
import { ComposerAdaptiveFooter } from "./composer-adaptive-footer";
import {
  useComposerIntelligenceController,
  type ComposerIntelligenceController,
} from "./use-composer-intelligence-controller";
import {
  shouldShowThreadComposerStatusStrip,
  ThreadComposerStatusStrip,
} from "./local-conversation-thread-composer-status-strip";
import { ComposerContextRail, ComposerContextRailSlot } from "../composer-context-rail";
import { CodexPendingRequestCard } from "./request-cards/codex-pending-request-card";
import { CODEX_THREAD_ACCORDION_TRANSITION } from "../shared/thread-motion";
import {
  LOCAL_CONVERSATION_FIXED_ABOVE_COMPOSER_QUEUE_PORTAL_ATTRIBUTE,
  LOCAL_CONVERSATION_FIXED_ABOVE_COMPOSER_QUEUE_PORTAL_ID,
} from "../local-conversation-above-composer-portal";
import { buildCodexCanonicalRequestIdentityKey } from "../../../../../shared/codex-conversation-state/codex-conversation-state";
import { usePortalHost } from "../use-portal-host";
import { DiffStats } from "../shared/tools/diff-file-shared";
import { ThreadGoalStatusRow } from "./local-conversation-thread-goal-status-row";
import { buildBackgroundAgentOpenContext } from "../../projection/background-subagent-open-context";
import {
  buildBackgroundSubagentCompactStripModel,
  getBackgroundSubagentListRows,
} from "../../projection/background-subagent-summary-model";
import { SubagentAvatar } from "../shared/subagent-avatar";
import { CodexShimmerText } from "../shared/codex-shimmer-text";
import {
  useAutoReviewApprovalNudgeActions,
  useAutoReviewApprovalNudgeState,
} from "../../auto-review-approval-nudge-state";
import { AutoReviewApprovalNudge } from "./auto-review-approval-nudge";
import {
  ComposerScope,
  ThreadScope,
  resolveComposerScopeIdentity,
} from "@/lib/workbench-ui-scopes";
import { ScopeProvider, useScopeHandle, useScopedAtom } from "@/lib/maitai";
import { activeComposerFocusNonceAtom } from "./composer-draft-state";
import { useContextualKeyboardActionTarget } from "@/lib/use-contextual-keyboard-action-target";
import { markContextualKeyboardActionTargetActive } from "@/lib/contextual-keyboard-actions";

interface LocalConversationComposerShellProps {
  model: ThreadFooterModel;
  actions: ThreadStageActions;
  errorMessage: string | null;
  onErrorMessage: (message: string | null) => void;
  contextRailLeadingContent?: ReactNode;
  hasFixedPortalContent?: boolean;
}

function TerminalIcon() {
  return (
    <svg
      viewBox="0 0 20 20"
      className="icon-2xs shrink-0 text-token-input-placeholder-foreground/70"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M4.5 5.75C4.5 5.05964 5.05964 4.5 5.75 4.5H14.25C14.9404 4.5 15.5 5.05964 15.5 5.75V14.25C15.5 14.9404 14.9404 15.5 14.25 15.5H5.75C5.05964 15.5 4.5 14.9404 4.5 14.25V5.75Z"
        fill="currentColor"
      />
    </svg>
  );
}

const QUEUE_GHOST_BUTTON_CLASS_NAME =
  "no-drag cursor-interaction inline-flex items-center gap-1 whitespace-nowrap rounded-full border border-transparent text-token-text-tertiary select-none electron:rounded-md enabled:hover:bg-token-list-hover-background data-[state=open]:bg-token-list-hover-background focus:outline-none focus-visible:ring-2 focus-visible:ring-token-focus focus-visible:ring-offset-0 disabled:cursor-default disabled:opacity-40";
const QUEUE_MENU_ICON_CLASS_NAME =
  "icon-xs text-token-foreground opacity-75 group-focus:opacity-100 group-hover:opacity-100";

const QueueActionButton = forwardRef<
  HTMLButtonElement,
  Omit<ButtonHTMLAttributes<HTMLButtonElement>, "aria-label"> & { ariaLabel: string }
>(function QueueActionButton({ ariaLabel, className, children, ...buttonProps }, ref) {
  return (
    <button
      {...buttonProps}
      ref={ref}
      type="button"
      aria-label={ariaLabel}
      className={cn(
        QUEUE_GHOST_BUTTON_CLASS_NAME,
        "flex items-center justify-center p-0.5 electron:p-1 electron:[&>svg]:icon-sm [&>svg]:icon-2xs",
        className,
      )}
    >
      {children}
    </button>
  );
});

function ComposerGhostIconButton({
  ariaLabel,
  onClick,
  children,
}: {
  ariaLabel: string;
  onClick?: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={ariaLabel}
      className="electron:p-1 electron:[&>svg]:icon-sm inline-flex size-6 items-center justify-center rounded-full p-0.5 text-token-input-placeholder-foreground transition-colors hover:bg-token-foreground/5 hover:text-token-foreground focus-visible:outline-none [&>svg]:icon-2xs"
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function QueueLabelActionButton({
  ariaLabel,
  onClick,
  disabled = false,
  children,
}: {
  ariaLabel: string;
  onClick?: () => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className={cn(QUEUE_GHOST_BUTTON_CLASS_NAME, "px-2 py-0.5 text-sm leading-[18px]")}
      aria-label={ariaLabel}
      onClick={onClick}
      disabled={disabled}
    >
      {children}
    </button>
  );
}

function ComposerShellCard({
  showRoundedTop,
  children,
}: {
  showRoundedTop: boolean;
  children: ReactNode;
}) {
  return (
    <div
      className={cn(
        "bg-token-input-background/70 text-token-foreground border-token-border/80 relative overflow-clip border-x border-t backdrop-blur-sm",
        showRoundedTop && "rounded-t-2xl",
      )}
    >
      {children}
    </div>
  );
}

function clampTransformToRect(
  transform: { x: number; y: number; scaleX: number; scaleY: number },
  rect: {
    top: number;
    left: number;
    right: number;
    bottom: number;
    width: number;
    height: number;
  },
  containerRect: {
    top: number;
    left: number;
    width: number;
    height: number;
  },
) {
  const nextTransform = { ...transform };

  if (rect.top + transform.y <= containerRect.top) {
    nextTransform.y = containerRect.top - rect.top;
  } else if (rect.bottom + transform.y >= containerRect.top + containerRect.height) {
    nextTransform.y = containerRect.top + containerRect.height - rect.bottom;
  }

  if (rect.left + transform.x <= containerRect.left) {
    nextTransform.x = containerRect.left - rect.left;
  } else if (rect.right + transform.x >= containerRect.left + containerRect.width) {
    nextTransform.x = containerRect.left + containerRect.width - rect.right;
  }

  return nextTransform;
}

const restrictHorizontalTransform: Modifier = ({ transform }) => {
  return {
    ...transform,
    x: 0,
  };
};

const restrictToScrollableAncestor: Modifier = ({
  draggingNodeRect,
  transform,
  scrollableAncestorRects,
}) => {
  const scrollRect = scrollableAncestorRects[0];
  if (!draggingNodeRect || !scrollRect) {
    return transform;
  }

  return clampTransformToRect(transform, draggingNodeRect, scrollRect);
};

function PendingSteerTooltipContent() {
  return (
    <div className="max-w-sm space-y-1 text-pretty whitespace-normal">
      <p>
        This steer will be submitted to the model as soon as possible without interrupting it,
        usually at the next tool call.
      </p>
      <p className="text-token-description-foreground">
        Interrupt the model if you want to give it more immediate input.
      </p>
    </div>
  );
}

function QueuedFollowUpTooltipContent() {
  return <>Submit without interrupting the model</>;
}

function FailedQueuedFollowUpWarningTooltipContent() {
  return (
    <div className="max-w-sm space-y-1 text-center whitespace-normal">
      <p>This queued message could not be sent</p>
      <p className="opacity-65">Retry, edit, or delete it to continue the queue</p>
    </div>
  );
}

function FailedQueuedFollowUpRetryTooltipContent() {
  return (
    <div className="max-w-sm space-y-1 text-center whitespace-normal">
      <p>Try sending this queued message again</p>
      <p className="opacity-65">Edit or delete it if retry keeps failing</p>
    </div>
  );
}

function PendingSteerRow({ row }: { row: ThreadComposerShellPendingSteerRowModel }) {
  return (
    <div className="flex min-w-0 items-center justify-between gap-2 py-0.5 text-sm">
      <div className="flex min-w-0 flex-1 items-center gap-1.5">
        <span className="flex h-4 shrink-0 items-center justify-center">
          <QueueSteerIcon className="text-token-text-tertiary/70" />
        </span>
        <span className="text-size-chat line-clamp-2 min-w-0 flex-1 leading-4 text-token-foreground">
          {row.displayText}
        </span>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <NodexTooltip tooltipContent={<PendingSteerTooltipContent />}>
          <QueueActionButton ariaLabel="Why this steer is pending">
            <QueuePendingInfoIcon />
          </QueueActionButton>
        </NodexTooltip>
      </div>
    </div>
  );
}

function QueuedFollowUpRow({
  row,
  actions,
  isQueueingEnabled,
  threadId,
  canDrag,
}: {
  row: ThreadComposerShellQueuedFollowUpRowModel;
  actions: ThreadStageActions;
  isQueueingEnabled: boolean;
  threadId: string;
  canDrag: boolean;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: row.followUpId, disabled: !canDrag });
  const isFailed = row.pauseKind === "failed";
  const disabled = row.isInFlight === true;

  return (
    <motion.div
      ref={setNodeRef}
      style={{
        transform: serializeSortableTranslation(transform),
        transition,
      }}
      initial={{ height: 0, opacity: 0 }}
      animate={{ height: "auto", opacity: 1 }}
      exit={{ height: 0, opacity: 0 }}
      transition={CODEX_THREAD_ACCORDION_TRANSITION}
      className="overflow-visible"
    >
      <div
        data-queued-follow-up-row={row.followUpId}
        className={cn(
          "group flex min-w-0 items-center justify-between gap-2 py-0.5 text-sm",
          (isDragging || disabled) && "opacity-60",
        )}
      >
        <div className="flex min-w-0 flex-1 items-center gap-1.5">
          <span className="flex h-4 shrink-0 items-center justify-center">
            {canDrag ? (
              <span
                ref={setActivatorNodeRef}
                className="relative -ms-3 flex h-4 cursor-grab items-center justify-center ps-3 active:cursor-grabbing"
                {...attributes}
                {...listeners}
              >
                <SidebarManualOrderIcon
                  className={cn(
                    "icon-2xs text-token-text-tertiary/70 pointer-events-none absolute start-0 top-1/2 -translate-y-1/2 transition-opacity",
                    isDragging ? "opacity-100" : "opacity-0 group-hover:opacity-100",
                  )}
                />
                <QueuedFollowUpIcon className="text-token-text-tertiary/70" />
              </span>
            ) : (
              <QueuedFollowUpIcon className="text-token-text-tertiary/70" />
            )}
          </span>
          <div className="min-w-0 flex-1 leading-4">
            <div className="flex min-w-0 items-start gap-1.5">
              {isFailed ? (
                <NodexTooltip tooltipContent={<FailedQueuedFollowUpWarningTooltipContent />}>
                  <span className="mt-0.5 inline-flex shrink-0" aria-label="Queue delivery failed">
                    <QueueFailureIcon className="text-[var(--color-text-warning)]" />
                  </span>
                </NodexTooltip>
              ) : null}
              {row.imagePreviewSource ? (
                <img
                  src={row.imagePreviewSource}
                  alt="Image attachment"
                  draggable={false}
                  className="composer-attachment-surface size-6 shrink-0 rounded border border-strong object-cover"
                />
              ) : null}
              <span className="text-size-chat line-clamp-1 max-h-lh min-w-0 self-center leading-5 whitespace-pre-wrap text-token-foreground">
                {row.displayText || "Queued follow-up"}
              </span>
            </div>
          </div>
        </div>
        {disabled ? <ActivitySpinnerIcon className="icon-2xs shrink-0" /> : null}
        <div className="flex shrink-0 items-center gap-1">
          <NodexTooltip
            side="top"
            tooltipContent={
              isFailed ? (
                <FailedQueuedFollowUpRetryTooltipContent />
              ) : (
                <QueuedFollowUpTooltipContent />
              )
            }
            tooltipBodyClassName="max-w-80 text-center whitespace-normal leading-snug"
          >
            <QueueLabelActionButton
              ariaLabel={
                isFailed
                  ? "Try sending this queued message again"
                  : "Submit without interrupting the model"
              }
              disabled={disabled}
              onClick={() => {
                void actions.onSendQueuedFollowUpNow(threadId, row.followUpId);
              }}
            >
              <QueueSteerIcon />
              <span>{isFailed ? "Retry" : "Steer"}</span>
            </QueueLabelActionButton>
          </NodexTooltip>
          <QueueActionButton
            ariaLabel="Delete queued message"
            disabled={disabled}
            onClick={() => {
              void actions.onRemoveQueuedFollowUp(threadId, row.followUpId);
            }}
          >
            <DeleteIcon className="icon-2xs" />
          </QueueActionButton>
          <NodexDropdownMenu
            triggerButton={
              <QueueActionButton ariaLabel="Queued message actions" disabled={disabled}>
                <AutomationMoreIcon className="icon-2xs" />
              </QueueActionButton>
            }
            side="top"
            align="end"
            contentWidth="xs"
          >
            <NodexDropdownItem
              disabled={disabled}
              onSelect={() => {
                void actions.onEditQueuedFollowUp({
                  threadId,
                  followUpId: row.followUpId,
                  prompt: row.prompt,
                  promptInput: row.promptInput,
                  ledgerRevision: row.ledgerRevision,
                });
              }}
              leftSlot={<EditIcon className={QUEUE_MENU_ICON_CLASS_NAME} />}
            >
              Edit message
            </NodexDropdownItem>
            {actions.onOpenSideChat ? (
              <NodexDropdownItem
                disabled={disabled}
                onSelect={() => {
                  void actions.onOpenSideChat?.({
                    kind: "submit",
                    prompt: row.prompt,
                    promptInput: row.promptInput,
                  });
                }}
                leftSlot={<SidePanelSideChatIcon className={QUEUE_MENU_ICON_CLASS_NAME} />}
              >
                Open in side chat
              </NodexDropdownItem>
            ) : null}
            <NodexDropdownItem
              onSelect={() => {
                actions.onQueueingEnabledChange(!isQueueingEnabled);
              }}
              leftSlot={<QueuedFollowUpIcon className={QUEUE_MENU_ICON_CLASS_NAME} />}
            >
              {isQueueingEnabled ? "Turn off queueing" : "Turn on queueing"}
            </NodexDropdownItem>
          </NodexDropdownMenu>
        </div>
      </div>
    </motion.div>
  );
}

function QueuePanel({
  model,
  actions,
  showRoundedTop,
}: {
  model: ThreadFooterModel;
  actions: ThreadStageActions;
  showRoundedTop: boolean;
}) {
  const threadId = model.threadId;
  const pendingSteerRows = model.composerShell.pendingSteerRows;
  const queuedFollowUpRows = model.composerShell.queuedFollowUpRows;
  const queueStatus = model.composerShell.queuedFollowUpStatus ?? "ready";
  const queueError = model.composerShell.queuedFollowUpError ?? null;
  const hasInterruptedRows = queuedFollowUpRows.some((row) => row.pauseKind === "interrupted");
  const hasInFlightRow = queuedFollowUpRows.some((row) => row.isInFlight === true);
  const [isResumePending, setResumePending] = useState(false);
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 6,
      },
    }),
  );

  if (
    !threadId ||
    (queueStatus === "ready" && pendingSteerRows.length === 0 && queuedFollowUpRows.length === 0)
  ) {
    return null;
  }

  const queuedFollowUpIds = queuedFollowUpRows.map((entry) => entry.followUpId);

  const handleDragEnd = (event: DragEndEvent) => {
    if (hasInFlightRow) return;
    const overId = event.over?.id;
    if (!overId) {
      return;
    }

    const activeId = String(event.active.id);
    const nextOverId = String(overId);
    if (activeId === nextOverId) {
      return;
    }

    const previousIndex = queuedFollowUpIds.indexOf(activeId);
    const nextIndex = queuedFollowUpIds.indexOf(nextOverId);
    if (previousIndex < 0 || nextIndex < 0) {
      return;
    }

    void actions.onReorderQueuedFollowUps(
      threadId,
      arrayMove(queuedFollowUpIds, previousIndex, nextIndex),
    );
  };

  const handleResume = async () => {
    if (!actions.onResumeQueuedFollowUps || isResumePending) return;
    setResumePending(true);
    try {
      await actions.onResumeQueuedFollowUps(threadId);
    } catch (error) {
      toast.danger(error instanceof Error ? error.message : "Could not resume the queue", {
        id: "queued-follow-up-resume-failed",
      });
    } finally {
      setResumePending(false);
    }
  };

  return (
    <ComposerShellCard showRoundedTop={showRoundedTop}>
      <div className="vertical-scroll-fade-mask hide-scrollbar flex max-h-[30dvh] flex-col gap-px overflow-x-hidden overflow-y-auto px-3 py-row-y">
        {hasInterruptedRows ? (
          <>
            <div className="group flex min-w-0 items-center justify-between gap-2 py-0.5 text-sm">
              <div className="flex min-w-0 flex-1 items-center gap-1.5">
                <span className="flex h-4 shrink-0 items-center justify-center">
                  <QueuePauseIcon className="text-token-text-tertiary/70" />
                </span>
                <div className="text-size-chat min-w-0 flex-1 leading-4 text-token-foreground">
                  Queue paused because you interrupted
                </div>
              </div>
              <QueueLabelActionButton
                ariaLabel="Resume"
                disabled={isResumePending || !actions.onResumeQueuedFollowUps}
                onClick={() => void handleResume()}
              >
                {isResumePending ? (
                  <ActivitySpinnerIcon className="icon-2xs shrink-0" />
                ) : (
                  <ComposerResumeIcon className="icon-2xs shrink-0" />
                )}
                <span>Resume</span>
              </QueueLabelActionButton>
            </div>
            <div className="border-t border-subtle" aria-hidden="true" />
          </>
        ) : null}
        {queueStatus === "loading" ? (
          <div
            className="semantic-text-secondary flex items-center gap-2 py-1 text-sm"
            role="status"
          >
            <ActivitySpinnerIcon className="icon-2xs" />
            <span>Loading queued messages…</span>
          </div>
        ) : null}
        {queueStatus === "error" ? (
          <div className="flex items-start gap-2 py-1 text-sm text-danger" role="alert">
            <QueueFailureIcon />
            <span>{queueError || "Queued messages could not be loaded"}</span>
          </div>
        ) : null}
        {pendingSteerRows.map((row) => (
          <PendingSteerRow key={row.steerId} row={row} />
        ))}
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          modifiers={[restrictHorizontalTransform, restrictToScrollableAncestor]}
          onDragEnd={handleDragEnd}
        >
          <SortableContext items={queuedFollowUpIds} strategy={verticalListSortingStrategy}>
            <AnimatePresence initial={false}>
              {queuedFollowUpRows.map((row) => (
                <QueuedFollowUpRow
                  key={row.followUpId}
                  row={row}
                  actions={actions}
                  isQueueingEnabled={model.isQueueingEnabled}
                  threadId={threadId}
                  canDrag={queuedFollowUpRows.length > 1 && !hasInFlightRow}
                />
              ))}
            </AnimatePresence>
          </SortableContext>
        </DndContext>
      </div>
    </ComposerShellCard>
  );
}

function BackgroundTerminalRow({
  terminal,
}: {
  terminal: ThreadFooterModel["composerShell"]["backgroundTerminalRows"][number];
}) {
  const visibleRow = (
    <div className="min-w-0">
      <div className="truncate font-mono text-sm">
        <span>{terminal.command}</span>
        {terminal.previewLine ? (
          <span className="ml-1 text-token-description-foreground">{terminal.previewLine}</span>
        ) : null}
      </div>
    </div>
  );

  if (terminal.command.length === 0 && terminal.previewLine == null) {
    return visibleRow;
  }

  return (
    <NodexTooltip
      tooltipContent={
        <div className="max-h-40 max-w-[36rem] overflow-auto font-mono text-sm leading-5">
          <div className="break-all whitespace-pre-wrap">{terminal.command}</div>
          {terminal.previewLine ? (
            <div className="mt-1 break-all whitespace-pre-wrap text-token-description-foreground">
              {terminal.previewLine}
            </div>
          ) : null}
        </div>
      }
      side="top"
      hoverable
      tooltipBodyClassName="max-w-none"
    >
      {visibleRow}
    </NodexTooltip>
  );
}

function BackgroundTerminalPanel({
  threadId,
  rows,
  actions,
  showRoundedTop,
}: {
  threadId: string;
  rows: ThreadFooterModel["composerShell"]["backgroundTerminalRows"];
  actions: ThreadStageActions;
  showRoundedTop: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  if (rows.length === 0) {
    return null;
  }

  return (
    <ComposerShellCard showRoundedTop={showRoundedTop}>
      <div className="flex items-center justify-between gap-2 px-3 py-row-y">
        <div className="flex min-w-0 items-center gap-2">
          <TerminalIcon />
          <span className="text-size-chat min-w-0 truncate leading-4 text-token-description-foreground">
            Running {rows.length === 1 ? "1 terminal" : `${rows.length} terminals`}
          </span>
        </div>
        <div className="flex items-center gap-1">
          <NodexTooltip tooltipContent="Stop background terminals">
            <ComposerGhostIconButton
              ariaLabel="Stop"
              onClick={() => {
                void actions.onCleanBackgroundTerminals(threadId);
              }}
            >
              <StopIcon className="icon-2xs" />
            </ComposerGhostIconButton>
          </NodexTooltip>
          <ComposerGhostIconButton
            ariaLabel={
              expanded ? "Collapse running terminals details" : "Expand running terminals details"
            }
            onClick={() => {
              setExpanded((current) => !current);
            }}
          >
            <ChevronRightIcon
              className={cn(
                "icon-2xs text-current transition-transform duration-300",
                expanded && "rotate-90",
              )}
            />
          </ComposerGhostIconButton>
        </div>
      </div>
      <motion.div
        initial={false}
        animate={{
          height: expanded ? "auto" : 0,
          opacity: expanded ? 1 : 0,
        }}
        transition={CODEX_THREAD_ACCORDION_TRANSITION}
        className={expanded ? "overflow-visible" : "overflow-hidden"}
        style={{
          pointerEvents: expanded ? "auto" : "none",
        }}
      >
        <div className="flex flex-col gap-2 px-3 pt-0.5 pb-3">
          {rows.map((row) => (
            <BackgroundTerminalRow key={row.id} terminal={row} />
          ))}
        </div>
      </motion.div>
    </ComposerShellCard>
  );
}

function resolveBackgroundRowStatusText(
  status: ThreadComposerShellBackgroundAgentRowModel["status"],
) {
  if (status === "active") {
    return "is working";
  }
  if (status === "waiting") {
    return "is awaiting instruction";
  }
  return "is done";
}

function BackgroundAgentRowTooltipContent({
  row,
}: {
  row: ThreadComposerShellBackgroundAgentRowModel;
}) {
  if (!row.agentRole && !row.spawnModel) return null;

  return (
    <span className="flex flex-col gap-0.5">
      {row.agentRole ? <span>{row.agentRole}</span> : null}
      {row.spawnModel ? <span>Uses {row.spawnModel}</span> : null}
    </span>
  );
}

function BackgroundAgentRow({
  row,
  actions,
}: {
  row: ThreadComposerShellBackgroundAgentRowModel;
  actions: ThreadStageActions;
}) {
  const active = row.status === "active";
  const metadataTooltip = <BackgroundAgentRowTooltipContent row={row} />;
  const statusText = resolveBackgroundRowStatusText(row.status);

  return (
    <div className="px-0 py-1">
      <div className="text-size-chat block min-w-0 truncate leading-4 text-token-description-foreground">
        <div className="group flex items-center justify-between gap-2">
          <NodexTooltip
            disabled={!row.agentRole && !row.spawnModel}
            side="top"
            tooltipContent={metadataTooltip}
            tooltipBodyClassName="items-start"
          >
            <button
              type="button"
              className="flex max-w-full min-w-0 cursor-interaction items-center gap-1 bg-transparent p-0"
              onClick={() => {
                void actions.onOpenThread(row.conversationId, buildBackgroundAgentOpenContext(row));
              }}
            >
              <span className="flex min-w-0 items-center gap-1.5 text-token-foreground">
                <SubagentAvatar
                  seed={row.conversationId}
                  className="icon-2xs pointer-events-none"
                />
                <span className="min-w-0 truncate font-medium">{row.displayName}</span>
              </span>
              <CodexShimmerText
                active={active}
                variant="classic"
                className="shrink-0 whitespace-nowrap text-token-description-foreground"
              >
                {statusText}
              </CodexShimmerText>
            </button>
          </NodexTooltip>
          {row.diffStats ? (
            <DiffStats
              additions={row.diffStats.linesAdded}
              deletions={row.diffStats.linesRemoved}
              className="mr-0.5 shrink-0 text-size-chat"
            />
          ) : null}
        </div>
      </div>
    </div>
  );
}

function BackgroundAgentPanel({
  rows,
  actions,
  showRoundedTop,
}: {
  rows: ThreadFooterModel["composerShell"]["backgroundAgentRows"];
  actions: ThreadStageActions;
  showRoundedTop: boolean;
}) {
  const compactModel = buildBackgroundSubagentCompactStripModel(rows);
  const legacyRows = getBackgroundSubagentListRows(rows);
  const stoppableThreadIds = rows
    .filter((row) => row.status !== "done")
    .map((row) => row.conversationId);
  const canStopAll = stoppableThreadIds.length > 0 && Boolean(actions.onStopBackgroundAgents);
  if (rows.length === 0) return null;

  const aggregateContent =
    compactModel.displayRows.length > 0 ? (
      <>
        <span className="flex shrink-0 items-center gap-1.5">
          {compactModel.displayRows.map((row) => (
            <SubagentAvatar key={row.conversationId} seed={row.conversationId} className="size-4" />
          ))}
        </span>
        <span className="text-size-chat min-w-0 truncate leading-4 text-token-foreground">
          {compactModel.workingCount > 0
            ? `${compactModel.workingCount} working`
            : `${compactModel.doneCount} done`}
        </span>
        {compactModel.workingCount > 0 && compactModel.doneCount > 0 ? (
          <span className="text-size-chat shrink-0 text-token-text-tertiary">
            {compactModel.doneCount} done
          </span>
        ) : null}
      </>
    ) : null;

  return (
    <ComposerShellCard showRoundedTop={showRoundedTop}>
      {aggregateContent ? (
        <div className="group flex min-h-8 items-center gap-2 px-3 py-row-y">
          {actions.onOpenSubagentsPanel ? (
            <button
              type="button"
              aria-label="Open subagents"
              className="flex min-w-0 flex-1 cursor-interaction items-center gap-2 rounded-md text-left focus-visible:outline-2 focus-visible:outline-offset-2"
              onClick={() => void actions.onOpenSubagentsPanel?.()}
            >
              {aggregateContent}
            </button>
          ) : (
            <div className="flex min-w-0 flex-1 items-center gap-2">{aggregateContent}</div>
          )}
          {canStopAll ? (
            <NodexTooltip tooltipContent="Stop all subagents in this chat">
              <ComposerGhostIconButton
                ariaLabel="Stop all"
                onClick={() => void actions.onStopBackgroundAgents?.(stoppableThreadIds)}
              >
                <StopIcon className="icon-2xs" />
              </ComposerGhostIconButton>
            </NodexTooltip>
          ) : null}
        </div>
      ) : null}
      {legacyRows.length > 0 ? (
        <div className="flex flex-col gap-0.5 px-3 pb-2">
          {legacyRows.map((row) => (
            <BackgroundAgentRow key={row.conversationId} row={row} actions={actions} />
          ))}
        </div>
      ) : null}
    </ComposerShellCard>
  );
}

function RequestCardStack({
  model,
  actions,
  intelligenceController,
  onManualApproval,
}: {
  model: ThreadFooterModel;
  actions: ThreadStageActions;
  intelligenceController: ComposerIntelligenceController;
  onManualApproval: (conversationId: string) => Promise<void>;
}) {
  const entries = [model.composerShell.backgroundRequest, model.composerShell.activeRequest].filter(
    (entry) => entry !== null,
  );

  return (
    <div className="relative flex flex-col gap-2">
      {entries.map((entry) => {
        if (!entry) {
          return null;
        }
        return (
          <div
            key={`${entry.surface}:${buildCodexCanonicalRequestIdentityKey(entry.request.requestId)}`}
            className="flex flex-col"
          >
            <CodexPendingRequestCard
              entry={entry}
              actions={actions}
              intelligenceController={intelligenceController}
              onManualApproval={onManualApproval}
            />
          </div>
        );
      })}
      {model.composerShell.activeRequest?.request.type === "implementPlan" ? (
        <div data-implement-plan-intelligence-footer="true">
          <ComposerAdaptiveFooter
            input={null}
            layout="multiline"
            leadingControls={
              <ModelSelectorDropdown model={model} controller={intelligenceController} />
            }
            trailingControls={null}
          />
        </div>
      ) : null}
    </div>
  );
}

export type ComposerReplacementOwner = "normal" | "autoReviewNudge" | "requestStack";

export function resolveComposerReplacementOwner(input: {
  threadId: string | null;
  hasAutoReviewNudge: boolean;
  isResponseInProgress: boolean;
  hasRequestCards: boolean;
}): ComposerReplacementOwner {
  if (!input.threadId) return "normal";
  if (input.hasAutoReviewNudge && !input.isResponseInProgress) return "autoReviewNudge";
  if (input.hasRequestCards) return "requestStack";
  return "normal";
}

function ThreadGoalResumeConfirmationDialog({
  model,
  actions,
}: {
  model: ThreadFooterModel;
  actions: ThreadStageActions;
}) {
  const goal = model.conversation?.threadGoalResumeConfirmation ?? null;
  const threadId = model.threadId;
  const [pendingAction, setPendingAction] = useState<"dismiss" | "resume" | null>(null);

  if (!threadId || !goal) {
    return null;
  }

  const isPaused = goal.status === "paused";
  const title = isPaused
    ? getThreadGoalMessage("composer.threadGoal.resumeConfirmation.title")
    : getThreadGoalMessage("composer.threadGoal.resumeConfirmation.resumableTitle");
  const dismissLabel = isPaused
    ? getThreadGoalMessage("composer.threadGoal.resumeConfirmation.keepPaused")
    : getThreadGoalMessage("composer.threadGoal.resumeConfirmation.notNow");
  const isBusy = pendingAction !== null;

  const handleDismiss = async () => {
    if (!actions.onDismissThreadGoalResumeConfirmation) {
      return;
    }

    setPendingAction("dismiss");
    try {
      await actions.onDismissThreadGoalResumeConfirmation(threadId);
    } catch {
      toast.danger(getThreadGoalMessage("composer.threadGoal.resumeConfirmation.dismissError"));
    } finally {
      setPendingAction(null);
    }
  };

  const handleResume = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!actions.onSetThreadGoal) {
      return;
    }

    setPendingAction("resume");
    try {
      await actions.onSetThreadGoal({
        threadId,
        status: "active",
      });
    } catch {
      toast.danger(getThreadGoalMessage("composer.threadGoal.statusUpdateError"));
    } finally {
      setPendingAction(null);
    }
  };

  return (
    <NodexDialog
      open
      onOpenChange={(open) => {
        if (!open) {
          void handleDismiss();
        }
      }}
    >
      <NodexDialogContent showCloseButton={false}>
        <NodexDialogForm onSubmit={handleResume}>
          <NodexDialogHeader>
            <NodexDialogTitle>{title}</NodexDialogTitle>
            <NodexDialogDescription>
              {getThreadGoalMessage("composer.threadGoal.resumeConfirmation.subtitle")}
            </NodexDialogDescription>
          </NodexDialogHeader>
          <NodexDialogBody>
            <div className="line-clamp-4 rounded-lg bg-token-bg-secondary px-3 py-2 text-sm text-token-foreground">
              {goal.objective}
            </div>
          </NodexDialogBody>
          <NodexDialogFooter>
            <NodexDialogAction
              disabled={isBusy || !actions.onDismissThreadGoalResumeConfirmation}
              onClick={() => {
                void handleDismiss();
              }}
            >
              {dismissLabel}
            </NodexDialogAction>
            <NodexDialogAction
              type="submit"
              tone="primary"
              disabled={isBusy || !actions.onSetThreadGoal}
            >
              {getThreadGoalMessage("composer.threadGoal.resumeConfirmation.resume")}
            </NodexDialogAction>
          </NodexDialogFooter>
        </NodexDialogForm>
      </NodexDialogContent>
    </NodexDialog>
  );
}

export function LocalConversationComposerShell(props: LocalConversationComposerShellProps) {
  const requestedFocusNonce =
    props.model.composerIntent?.focusNonce ??
    props.model.newThreadComposerIntent?.focusNonce ??
    null;
  const [activeFocusNonce, setActiveFocusNonce] = useScopedAtom(activeComposerFocusNonceAtom);
  const threadHandle = useScopeHandle(ThreadScope);
  useLayoutEffect(() => {
    if (requestedFocusNonce === null || requestedFocusNonce === activeFocusNonce) return;
    setActiveFocusNonce(requestedFocusNonce);
  }, [activeFocusNonce, requestedFocusNonce, setActiveFocusNonce]);
  const focusComposerNonce = requestedFocusNonce ?? activeFocusNonce;
  const descriptor = resolveComposerScopeIdentity({
    kind: props.model.isNewThreadTab ? "new-conversation" : "task",
    stableIdentity: props.model.composerScopeIdentity?.trim() || threadHandle.path,
    focusComposerNonce,
  });

  return (
    <ScopeProvider scope={ComposerScope} descriptor={descriptor}>
      <ScopedLocalConversationComposerShell {...props} />
    </ScopeProvider>
  );
}

function ScopedLocalConversationComposerShell({
  model,
  actions,
  errorMessage,
  onErrorMessage,
  contextRailLeadingContent,
  hasFixedPortalContent = false,
}: LocalConversationComposerShellProps) {
  const intelligenceController = useComposerIntelligenceController(model, actions);
  const permissionState = model.permissionState;
  const autoReviewNudgeState = useAutoReviewApprovalNudgeState();
  const { recordManualApproval: recordManualApprovalForNudge, resolveNudge } =
    useAutoReviewApprovalNudgeActions();
  const autoReviewNudgeEligible =
    permissionState?.mode === "auto" &&
    permissionState.autoReviewAvailable &&
    permissionState.availableModes.includes("guardian-approvals");
  const hasAutoReviewNudge = Boolean(
    model.threadId &&
    autoReviewNudgeEligible &&
    autoReviewNudgeState.activeThreadIds[model.threadId] === true,
  );
  const replacementOwner = resolveComposerReplacementOwner({
    threadId: model.threadId,
    hasAutoReviewNudge,
    isResponseInProgress: model.isThreadRunning,
    hasRequestCards: model.composerShell.showRequestCards,
  });
  const selectorAvailable = model.availableModels.some((candidate) => !candidate.hidden);
  const selectorOwnedBySurface =
    replacementOwner === "normal" ||
    (replacementOwner === "requestStack" &&
      model.composerShell.activeRequest?.request.type === "implementPlan");
  const selectorSurfaceId = `composer-model-picker:${model.composerScopeIdentity?.trim() || model.threadId || "new-thread"}`;
  const selectorPresentationId =
    model.composerScopeIdentity?.trim() || model.threadId || selectorSurfaceId;
  const contextualSelectorTarget = useMemo(
    () => ({
      surfaceId: selectorSurfaceId,
      presentationId: selectorPresentationId,
      canExecute: (commandId: import("../../../../../shared/command-keybindings").CommandId) =>
        commandId === "openModelPicker" && selectorAvailable && selectorOwnedBySurface,
      execute: (commandId: import("../../../../../shared/command-keybindings").CommandId) => {
        if (commandId !== "openModelPicker" || !selectorAvailable || !selectorOwnedBySurface) {
          return false;
        }
        intelligenceController.open();
        return true;
      },
    }),
    [
      intelligenceController,
      selectorAvailable,
      selectorOwnedBySurface,
      selectorPresentationId,
      selectorSurfaceId,
    ],
  );
  useContextualKeyboardActionTarget(contextualSelectorTarget);
  useEffect(() => {
    if (!model.threadId || permissionState?.mode === "auto") return;
    resolveNudge(model.threadId);
  }, [model.threadId, permissionState?.mode, resolveNudge]);
  const recordManualApproval = async (conversationId: string) => {
    await recordManualApprovalForNudge({
      threadId: conversationId,
      eligible: autoReviewNudgeEligible,
    });
  };
  const queuePortalHost = usePortalHost({
    attribute: LOCAL_CONVERSATION_FIXED_ABOVE_COMPOSER_QUEUE_PORTAL_ATTRIBUTE,
    fallbackId: LOCAL_CONVERSATION_FIXED_ABOVE_COMPOSER_QUEUE_PORTAL_ID,
    conversationId: model.threadId,
  });
  const showQueuePanel =
    model.composerShell.pendingSteerRows.length > 0 ||
    model.composerShell.queuedFollowUpRows.length > 0;
  const threadGoal = model.conversation?.threadGoal ?? null;
  const showThreadGoalStatusRow = threadGoal !== null && threadGoal.status !== "complete";
  const backgroundTerminalThreadId = model.threadId;
  const showBackgroundTerminals =
    backgroundTerminalThreadId !== null && model.composerShell.backgroundTerminalRows.length > 0;
  const showBackgroundAgents = model.composerShell.backgroundAgentRows.length > 0;
  const showAuxiliaryLaneStack =
    showQueuePanel || showThreadGoalStatusRow || showBackgroundTerminals || showBackgroundAgents;
  let sectionIndex = hasFixedPortalContent ? 1 : 0;

  const resolveRoundedTop = () => {
    const showRoundedTop = sectionIndex === 0;
    sectionIndex += 1;
    return showRoundedTop;
  };

  const auxiliaryLaneStack = showAuxiliaryLaneStack ? (
    <div className="order-2 flex flex-col">
      {showQueuePanel ? (
        <QueuePanel model={model} actions={actions} showRoundedTop={resolveRoundedTop()} />
      ) : null}
      {showThreadGoalStatusRow ? (
        <ThreadGoalStatusRow
          goal={threadGoal}
          actions={actions}
          showRoundedTop={resolveRoundedTop()}
        />
      ) : null}
      {showBackgroundTerminals ? (
        <BackgroundTerminalPanel
          threadId={backgroundTerminalThreadId}
          rows={model.composerShell.backgroundTerminalRows}
          actions={actions}
          showRoundedTop={resolveRoundedTop()}
        />
      ) : null}
      {showBackgroundAgents ? (
        <BackgroundAgentPanel
          rows={model.composerShell.backgroundAgentRows}
          actions={actions}
          showRoundedTop={resolveRoundedTop()}
        />
      ) : null}
    </div>
  ) : null;
  const showStatusStrip = shouldShowThreadComposerStatusStrip(model);

  return (
    <div
      data-local-conversation-composer-shell="true"
      className="group/async-questions relative flex w-full flex-col gap-2 pb-0"
      onFocusCapture={() => markContextualKeyboardActionTargetActive(selectorSurfaceId)}
      onPointerDownCapture={() => markContextualKeyboardActionTargetActive(selectorSurfaceId)}
    >
      <ThreadGoalResumeConfirmationDialog model={model} actions={actions} />
      {queuePortalHost && auxiliaryLaneStack
        ? createPortal(auxiliaryLaneStack, queuePortalHost)
        : null}
      {!showStatusStrip && contextRailLeadingContent ? (
        <ComposerContextRailSlot visible>
          <ComposerContextRail>
            {contextRailLeadingContent}
            <span aria-hidden="true" className="order-2 min-w-0 flex-1" />
          </ComposerContextRail>
        </ComposerContextRailSlot>
      ) : null}
      {replacementOwner !== "normal" ? (
        <ComposerContextRailSlot visible={showStatusStrip}>
          <ThreadComposerStatusStrip
            model={model}
            actions={actions}
            onErrorMessage={onErrorMessage}
            contextRailLeadingContent={contextRailLeadingContent}
          />
        </ComposerContextRailSlot>
      ) : null}
      {replacementOwner === "normal" && model.threadId ? (
        <AsyncQuestionComposer threadId={model.threadId} model={model} />
      ) : null}
      {replacementOwner === "autoReviewNudge" && model.threadId ? (
        <AutoReviewApprovalNudge threadId={model.threadId} actions={actions} />
      ) : replacementOwner === "requestStack" ? (
        <>
          <RequestCardStack
            model={model}
            actions={actions}
            intelligenceController={intelligenceController}
            onManualApproval={recordManualApproval}
          />
        </>
      ) : (
        <ThreadComposer
          model={model}
          actions={actions}
          errorMessage={errorMessage}
          onErrorMessage={onErrorMessage}
          contextRailLeadingContent={contextRailLeadingContent}
          intelligenceController={intelligenceController}
        />
      )}
    </div>
  );
}
