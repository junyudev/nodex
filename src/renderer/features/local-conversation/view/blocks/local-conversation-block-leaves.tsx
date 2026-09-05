import {
  useCallback,
  useEffect,
  useState,
  type CSSProperties,
  type FormEvent,
  type ReactNode,
} from "react";
import { motion } from "motion/react";
import { ChevronRightIcon, GoalTargetIcon, HooksIcon } from "@/components/shared/icons";
import { BudgetedMarkdownRenderer } from "../shared/markdown/budgeted-markdown-renderer";
import { AutomaticApprovalReviewSurface } from "../shared/automatic-approval-review-surface";
import { MultiAgentActionSurface } from "../shared/multi-agent-action-surface";
import { ImageViewSurface } from "../shared/image-view-surface";
import { GeneratedImageGallery } from "../shared/generated-image-gallery";
import { CompletedRequestActivitySurface } from "../shared/completed-request-activity-surface";
import { PlanMessage } from "../shared/plan-message";
import { ReasoningSurface } from "../shared/reasoning-surface";
import { SubagentAvatar } from "../shared/subagent-avatar";
import { TurnDiffSurface } from "../shared/turn-diff-surface";
import {
  AssistantRatingButton,
  CopyMessageActionButton,
  EditMessageIcon,
  ForkMessageIcon,
  MessageTimestamp,
  ThreadActionIconButton,
  ThreadMessageActionRow,
  USER_COPY_FEEDBACK_MS,
  type AssistantMessageRating,
} from "../shared/thread-message-actions";
import { TodoListSurface } from "../shared/todo-list-surface";
import { getToolComponent } from "../shared/tools/get-tool-component";
import { DynamicToolCallSummary } from "../shared/tools/dynamic-tool-call";
import { WorktreeInitActivityList } from "../shared/tools/worktree-init-activity-list";
import {
  JsonBlock,
  ThreadActivityDisclosure,
  type ThreadActivitySummaryTransition,
} from "../shared/tools/tool-primitives";
import { ToolActivityIcon, resolveToolActivityEntryIcon } from "../shared/tools/tool-call-icons";
import { UserMessageText } from "../shared/user-message-collapse";
import {
  CODEX_THREAD_ACCORDION_TRANSITION,
  CODEX_THREAD_DIVIDER_ENTER_ANIMATE,
  CODEX_THREAD_DIVIDER_ENTER_INITIAL,
} from "../shared/thread-motion";
import { useMeasuredElementHeight } from "../shared/use-measured-element-height";
import { CodexShimmerProvider, CodexShimmerText } from "../shared/codex-shimmer-text";
import { AnsweredUserInputBlock } from "../composer/request-cards/answered-user-input-block";
import { UserAttachmentStrip } from "../shared/user-message-attachments";
import { useWorkedForLabelText } from "../shared/use-worked-for-label";
import type { CodexWorktreeInitActivity } from "../../../../lib/codex-worktree-init-activity";
import { semanticActivityStatusFromLifecycle } from "../../../../lib/semantic-activity-status";
import type {
  CodexConversationChildMembership,
  CodexConversationItem,
} from "../../../../lib/types";
import type { ReviewOpenIntent } from "@/features/review/model/review-view-state";
import { resolveCodexThreadDetailLevel } from "../../../../lib/codex-thread-settings";
import { logAssistantStreamingDebugState } from "../../../../lib/assistant-streaming-debug";
import { useCodexThreadSettings } from "../../../../lib/use-codex-thread-settings";
import { useResolvedReducedMotion } from "../../../../lib/use-reduced-motion";
import { cn } from "../../../../lib/utils";
import { stripCodexRemarkDirectiveLines } from "../../../../../shared/codex-remark-directives";
import { DEFAULT_CODEX_HOST_ID } from "../../../../../shared/codex-host";
import { resolveCompletedMcpServerElicitationView } from "../../projection/mcp-server-elicitation-view";
import { buildHookFeedbackSettingsHref } from "../../projection/hook-feedback-settings";
import { resolveHookFeedbackSettingsTarget } from "../../../../lib/codex-hooks-route";
import { formatThreadAgentActivityCompletedSummaryPart } from "../../projection/agent-activity-v2-summary";
import type {
  ThreadAssistantMessageActionsModel,
  ThreadBlockModel,
  ThreadAgentActivityCompletedSummaryPart,
  ThreadAgentActivityGroupHeader,
  ThreadPlanSidePanelState,
  ThreadStageActions,
  ThreadSubagentActivityInlineRowModel,
  ThreadTranscriptBlockModel,
  ThreadWorkedForBlockModel,
} from "../../thread-stage-types";
import { THREAD_VISUAL_TOKENS } from "./local-conversation-visual-tokens";
import { useHookFeedbackSettingsNavigation } from "../hook-feedback-settings-navigation";

export interface ThreadLeafBlockProps {
  block: ThreadTranscriptBlockModel;
  isLatestTurn: boolean;
  isStreamingTurn: boolean;
  isSearchMatch?: boolean;
  isActiveSearchMatch?: boolean;
  projectWorkspacePath?: string | null;
  projectlessOutputDirectory?: string | null;
  childMemberships?: readonly CodexConversationChildMembership[];
  threadCwd?: string | null;
  onEditLastUserTurn?: (input: {
    threadId: string;
    turnId: string;
    message: string;
  }) => void | Promise<void>;
  onForkFromTurn?: (input: {
    threadId: string;
    turnId: string;
    message: string;
    isLatestTurn: boolean;
  }) => void | Promise<void>;
  onOpenTurnDiffReview?: (intent: ReviewOpenIntent) => void | Promise<void>;
  onOpenTurnDiffFileInSidePanel?: ThreadStageActions["onOpenTurnDiffFileInSidePanel"];
  onOpenSideChat?: ThreadStageActions["onOpenSideChat"];
  onOpenThread?: ThreadStageActions["onOpenThread"];
  onOpenSummaryScheduledAutomation?: ThreadStageActions["onOpenSummaryScheduledAutomation"];
  onOpenMcpAppSidePanel?: ThreadStageActions["onOpenMcpAppSidePanel"];
  onOpenPlanInSidePanel?: ThreadStageActions["onOpenPlanInSidePanel"];
  onClosePlanSidePanel?: ThreadStageActions["onClosePlanSidePanel"];
  planSidePanelState?: ThreadPlanSidePanelState | null;
  allowInProgressTurnDiff?: boolean;
  turnDiffHoverPreviewDisabled?: boolean;
  assistantAfter?: ReactNode;
  alwaysShowAssistantMessageActions?: boolean;
  compactUserMessageActions?: boolean;
}

export interface ThreadSpecialBlockProps {
  block: ThreadBlockModel;
  isLatestTurn: boolean;
  isStreamingTurn: boolean;
  projectWorkspacePath?: string | null;
  projectlessOutputDirectory?: string | null;
  childMemberships?: readonly CodexConversationChildMembership[];
  threadCwd?: string | null;
  onOpenTurnDiffReview?: (intent: ReviewOpenIntent) => void | Promise<void>;
  onOpenTurnDiffFileInSidePanel?: ThreadStageActions["onOpenTurnDiffFileInSidePanel"];
  onOpenSideChat?: ThreadStageActions["onOpenSideChat"];
  onOpenThread?: ThreadStageActions["onOpenThread"];
  onOpenSummaryScheduledAutomation?: ThreadStageActions["onOpenSummaryScheduledAutomation"];
  onOpenMcpAppSidePanel?: ThreadStageActions["onOpenMcpAppSidePanel"];
  onOpenPlanInSidePanel?: ThreadStageActions["onOpenPlanInSidePanel"];
  onClosePlanSidePanel?: ThreadStageActions["onClosePlanSidePanel"];
  planSidePanelState?: ThreadPlanSidePanelState | null;
  turnDiffHoverPreviewDisabled?: boolean;
}

function UserMessageGoalStatus() {
  return (
    <div className="ms-1 mr-1 flex items-center gap-2">
      <GoalTargetIcon className="icon-2xs shrink-0 text-token-description-foreground" />
      <span className="text-token-description-foreground text-xs">Sent as goal</span>
    </div>
  );
}

function UserMessageDeliveryFailureStatus() {
  return (
    <span className="mr-1 text-xs text-danger" role="status">
      Not sent
    </span>
  );
}

function UserMessageHookFeedbackStatus({ href, onOpen }: { href: string; onOpen?: () => void }) {
  return (
    <a
      href={href}
      className="text-size-chat-sm inline-flex cursor-interaction items-center gap-1 rounded-md px-1 py-0.5 !text-token-description-foreground hover:!text-token-foreground"
      onClick={(event) => {
        if (!onOpen) return;
        if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
          return;
        event.preventDefault();
        onOpen();
      }}
    >
      <HooksIcon aria-hidden className="icon-2xs shrink-0" />
      <span>Hook feedback</span>
    </a>
  );
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null) return null;
  return value as Record<string, unknown>;
}

function humanizeBlockType(type: ThreadBlockModel["type"]): string {
  switch (type) {
    case "streamError":
      return "Stream error";
    case "systemError":
      return "System error";
    case "remoteTaskCreated":
      return "Remote task created";
    case "personalityChanged":
      return "Personality changed";
    case "forkedFromConversation":
      return "Forked conversation";
    case "modelChanged":
      return "Model changed";
    case "modelRerouted":
      return "Model rerouted";
    case "contextCompaction":
      return "Context automatically compacted";
    case "worktreeInit":
      return "Worktree initialization";
    case "automaticApprovalReview":
      return "Approval review";
    case "autoReviewInterruptionWarning":
      return "Auto-review interrupted";
    case "hook":
      return "Hook";
    case "planImplementation":
      return "Plan implementation";
    case "mcpServerElicitation":
      return "MCP elicitation";
    case "mcpToolCall":
      return "MCP tool call";
    case "multiAgentAction":
      return "Multi-agent action";
    case "webSearch":
      return "Web search";
    case "userInputResponse":
      return "User input response";
    default:
      return "System event";
  }
}

const EDIT_MESSAGE_MIN_ROWS = 2;
const EDIT_MESSAGE_MAX_ROWS = 6;

function resizeEditMessageTextarea(element: HTMLTextAreaElement): void {
  const lineHeightPx = Number.parseFloat(window.getComputedStyle(element).lineHeight);
  if (!Number.isFinite(lineHeightPx)) return;

  const minHeightPx = lineHeightPx * EDIT_MESSAGE_MIN_ROWS;
  const maxHeightPx = lineHeightPx * EDIT_MESSAGE_MAX_ROWS;
  element.style.height = "auto";
  element.style.height = `${Math.min(Math.max(element.scrollHeight, minHeightPx), maxHeightPx)}px`;
  element.style.overflowY = element.scrollHeight > maxHeightPx ? "auto" : "hidden";
}

function renderCollapsedActivityEntry({
  entry,
  isLatestTurn,
  isStreamingTurn,
  projectWorkspacePath,
  projectlessOutputDirectory,
  threadCwd,
  onOpenTurnDiffReview,
  onOpenTurnDiffFileInSidePanel,
  onOpenThread,
  onOpenSummaryScheduledAutomation,
  onOpenMcpAppSidePanel,
  turnDiffHoverPreviewDisabled,
}: {
  entry: Extract<ThreadBlockModel, { type: "agentActivityGroup" }>["entries"][number];
  isLatestTurn: boolean;
  isStreamingTurn: boolean;
  projectWorkspacePath?: string | null;
  projectlessOutputDirectory?: string | null;
  threadCwd?: string | null;
  onOpenTurnDiffReview?: (intent: ReviewOpenIntent) => void | Promise<void>;
  onOpenTurnDiffFileInSidePanel?: ThreadStageActions["onOpenTurnDiffFileInSidePanel"];
  onOpenThread?: ThreadStageActions["onOpenThread"];
  onOpenSummaryScheduledAutomation?: ThreadStageActions["onOpenSummaryScheduledAutomation"];
  onOpenMcpAppSidePanel?: ThreadStageActions["onOpenMcpAppSidePanel"];
  turnDiffHoverPreviewDisabled?: boolean;
}) {
  const sharedProps = {
    isLatestTurn,
    isStreamingTurn,
    projectWorkspacePath,
    projectlessOutputDirectory,
    threadCwd,
    onOpenTurnDiffReview,
    onOpenTurnDiffFileInSidePanel,
    onOpenThread,
    onOpenSummaryScheduledAutomation,
    onOpenMcpAppSidePanel,
    turnDiffHoverPreviewDisabled,
  };

  if (entry.type === "automaticApprovalReview")
    return (
      <ThreadAutomaticApprovalReviewBlock
        block={entry as ThreadTranscriptBlockModel}
        {...sharedProps}
      />
    );
  if (entry.type === "streamError")
    return <ThreadStreamErrorBlock block={entry as ThreadTranscriptBlockModel} {...sharedProps} />;
  if (entry.type === "systemError")
    return <ThreadSystemErrorBlock block={entry as ThreadTranscriptBlockModel} {...sharedProps} />;
  if (entry.type === "contextCompaction")
    return (
      <ThreadContextCompactionBlock block={entry as ThreadTranscriptBlockModel} {...sharedProps} />
    );
  if (
    entry.type === "exec" ||
    entry.type === "fileChange" ||
    entry.type === "mcpToolCall" ||
    entry.type === "dynamicToolCall" ||
    entry.type === "webSearch"
  ) {
    return <ThreadToolSurfaceBlock block={entry as ThreadTranscriptBlockModel} {...sharedProps} />;
  }
  if (entry.type === "hook") {
    return <ThreadHookBlock block={entry as ThreadTranscriptBlockModel} {...sharedProps} />;
  }

  return null;
}

function formatCompletedActivityPart(
  part: ThreadAgentActivityCompletedSummaryPart,
  index: number,
): string | null {
  return formatThreadAgentActivityCompletedSummaryPart(part, {
    isLeading: index === 0,
  });
}

function CompletedActivitySummaryText({
  parts,
}: {
  parts: readonly ThreadAgentActivityCompletedSummaryPart[];
}) {
  const labels = parts.flatMap((part, index): Array<{ key: string; content: ReactNode }> => {
    if (part.kind === "dynamicToolCall") {
      const call = part.item.entry.dynamicToolCall;
      if (!call) return [];
      return [
        {
          key: part.key,
          content: (
            <DynamicToolCallSummary call={{ ...call, completed: true }} variant="summary-text" />
          ),
        },
      ];
    }
    const label = formatCompletedActivityPart(part, index);
    return label == null ? [] : [{ key: `${part.kind}:${index}`, content: label }];
  });
  if (labels.length === 0) return "Worked";

  return labels.map(({ key, content }, index) => (
    <span key={key}>
      {index === 0 ? null : ", "}
      {content}
    </span>
  ));
}

function ActiveActivitySummaryText({
  header,
}: {
  header: Extract<ThreadAgentActivityGroupHeader, { kind: "active" }>;
}) {
  if (header.item.type === "dynamicToolCall") {
    const call = header.item.entry.dynamicToolCall;
    if (call) {
      return <DynamicToolCallSummary call={{ ...call, completed: false }} variant="summary-text" />;
    }
  }

  return <CodexShimmerText>{header.label}</CodexShimmerText>;
}

export function ThreadAgentActivityGroupBlock({
  block,
  isLatestTurn,
  isStreamingTurn,
  projectWorkspacePath,
  projectlessOutputDirectory,
  threadCwd,
  onOpenTurnDiffReview,
  onOpenTurnDiffFileInSidePanel,
  onOpenThread,
  onOpenSummaryScheduledAutomation,
  onOpenMcpAppSidePanel,
  turnDiffHoverPreviewDisabled,
}: ThreadSpecialBlockProps) {
  if (block.type !== "agentActivityGroup") return null;
  const iconItem =
    block.header.kind === "thinking"
      ? null
      : block.header.kind === "active"
        ? block.header.item
        : block.completedHeader.iconItem;
  const icon =
    iconItem == null ? null : resolveToolActivityEntryIcon(iconItem, block.mcpApps ?? []);
  const summaryTransition: ThreadActivitySummaryTransition =
    block.header.kind === "summary" ? "immediate" : "deferred";
  const summaryText =
    block.header.kind === "summary" ? (
      <CompletedActivitySummaryText parts={block.completedHeader.parts} />
    ) : block.header.kind === "active" ? (
      <ActiveActivitySummaryText header={block.header} />
    ) : (
      <CodexShimmerText>{block.header.message ?? "Thinking"}</CodexShimmerText>
    );
  const summary = (
    <span className="inline-flex max-w-full min-w-0 items-center gap-1.5 overflow-hidden">
      {icon ? <ToolActivityIcon descriptor={icon} /> : null}
      <span className="min-w-0 flex-1 truncate">{summaryText}</span>
    </span>
  );
  const body = (
    <CodexShimmerProvider enabled={false}>
      <div
        className="vertical-scroll-fade-mask flex max-h-56 flex-col overflow-x-hidden overflow-y-auto [--edge-fade-distance:1.5rem]"
        style={
          {
            "--conversation-patch-file-gap": "var(--conversation-grouped-item-gap, 4px)",
          } as CSSProperties
        }
      >
        {block.bodyEntries.map((entry) => (
          <div key={entry.id}>
            <div
              aria-hidden="true"
              className="w-full"
              style={{ height: "var(--conversation-grouped-item-gap, 4px)" }}
            />
            {renderCollapsedActivityEntry({
              entry,
              isLatestTurn,
              isStreamingTurn,
              projectWorkspacePath,
              projectlessOutputDirectory,
              threadCwd,
              onOpenTurnDiffReview,
              onOpenTurnDiffFileInSidePanel,
              onOpenThread,
              onOpenSummaryScheduledAutomation,
              onOpenMcpAppSidePanel,
              turnDiffHoverPreviewDisabled,
            })}
          </div>
        ))}
      </div>
    </CodexShimmerProvider>
  );

  return (
    <ThreadActivityDisclosure
      bodyTestId="agent-activity-group-body"
      canExpand={block.canExpand}
      indentContent={false}
      status={semanticActivityStatusFromLifecycle(
        block.status,
        block.header.kind === "summary" ? "completed" : "running",
      )}
      summary={summary}
      summaryKey={block.header.key}
      summaryTransition={summaryTransition}
      shouldAnimateInitialCollapse={block.shouldAnimateInitialCollapse}
    >
      {body}
    </ThreadActivityDisclosure>
  );
}

export function ThreadToolSurfaceBlock({
  block,
  isStreamingTurn,
  projectWorkspacePath,
  threadCwd,
  onOpenTurnDiffFileInSidePanel,
  onOpenThread,
  onOpenSummaryScheduledAutomation,
  onOpenMcpAppSidePanel,
}: ThreadLeafBlockProps) {
  const { settings } = useCodexThreadSettings();
  const item = block.entry;
  const threadDetailLevel = resolveCodexThreadDetailLevel(settings.detailLevel);
  if (item.semanticKind === "mcpToolCall" && threadDetailLevel === "STEPS_PROSE") {
    return null;
  }

  const ToolComponent = getToolComponent(item);
  if (!ToolComponent) return null;

  return (
    <ToolComponent
      item={item}
      projectWorkspacePath={projectWorkspacePath ?? undefined}
      threadCwd={threadCwd ?? undefined}
      isTurnCancelled={block.isTurnCancelled === true}
      isStreamingTurn={isStreamingTurn}
      automaticApprovalReviews={block.automaticApprovalReviews ?? []}
      showDiffDetails={threadDetailLevel !== "STEPS_PROSE"}
      onOpenFileInSidePanel={onOpenTurnDiffFileInSidePanel}
      onOpenSummaryScheduledAutomation={onOpenSummaryScheduledAutomation}
      onOpenThread={onOpenThread}
      onOpenMcpAppSidePanel={onOpenMcpAppSidePanel}
    />
  );
}

export function ThreadTurnDiffBlock({
  block,
  isLatestTurn,
  isStreamingTurn,
  projectWorkspacePath,
  projectlessOutputDirectory,
  threadCwd,
  onOpenTurnDiffReview,
  onOpenTurnDiffFileInSidePanel,
  allowInProgressTurnDiff = false,
  turnDiffHoverPreviewDisabled = false,
}: ThreadLeafBlockProps) {
  const { settings } = useCodexThreadSettings();
  const threadDetailLevel = resolveCodexThreadDetailLevel(settings.detailLevel);
  if (isStreamingTurn && !allowInProgressTurnDiff) return null;
  if (threadDetailLevel === "STEPS_PROSE") return null;

  return (
    <TurnDiffSurface
      item={block.entry}
      isInProgress={isStreamingTurn}
      projectWorkspacePath={projectWorkspacePath ?? undefined}
      threadCwd={threadCwd ?? undefined}
      projectlessOutputDirectory={projectlessOutputDirectory}
      reviewSource={isLatestTurn ? "last-turn" : "selected-turn"}
      onOpenReview={onOpenTurnDiffReview}
      onOpenFileInSidePanel={onOpenTurnDiffFileInSidePanel}
      disableHoverPreview={turnDiffHoverPreviewDisabled}
      deferOffscreenRendering
    />
  );
}

export function ThreadAutomaticApprovalReviewBlock({ block }: ThreadLeafBlockProps) {
  if (block.type !== "automaticApprovalReview") return null;
  return <AutomaticApprovalReviewSurface item={block.entry} />;
}

export function ThreadMultiAgentActionBlock({
  block,
  childMemberships,
  onOpenThread,
}: ThreadLeafBlockProps) {
  if (block.type !== "multiAgentAction") return null;
  return (
    <MultiAgentActionSurface
      childMemberships={childMemberships}
      items={[block.entry]}
      onOpenThread={onOpenThread}
    />
  );
}

const SUBAGENT_ACTIVITY_VISIBLE_CHIP_COUNT = 3;
const EMPTY_SUBAGENT_ACTIVITY_ROWS: readonly ThreadSubagentActivityInlineRowModel[] = [];

function resolveSubagentActivityStatusLabel(
  rows: readonly ThreadSubagentActivityInlineRowModel[],
): string {
  if (rows.some((row) => row.activityStatus === "interrupted")) return "interrupted";
  if (rows.some((row) => row.activityStatus === "updated")) return "updated";
  if (
    rows.length > 0 &&
    rows.every((row) => row.activityStatus === "done" || row.status === "done")
  )
    return "finished";
  return "started working";
}

function SubagentActivityInlineChip({
  animateEntrance,
  onAnimationEnd,
  onClick,
  row,
}: {
  animateEntrance: boolean;
  onAnimationEnd: () => void;
  onClick?: () => void;
  row: ThreadSubagentActivityInlineRowModel;
}) {
  const content = (
    <>
      <SubagentAvatar seed={row.conversationId} className="size-4" />
      <span className="min-w-0 truncate text-base">{row.displayName}</span>
    </>
  );
  const className = cn(
    "subagent-activity-chip mr-1.5 inline-flex h-7 max-w-48 min-w-0 items-center gap-1.5 rounded-full bg-token-main-surface-secondary pr-2 pl-1.5 align-middle ring-[0.5px] ring-inset ring-token-border-light first:-ml-1.5",
    onClick &&
      "cursor-interaction hover:bg-token-list-hover-background hover:text-token-foreground hover:ring-token-border focus-visible:outline-2 focus-visible:outline-offset-2 active:bg-token-bg-secondary",
  );

  if (!onClick) {
    return (
      <span
        className={className}
        data-animate-entrance={animateEntrance ? "" : undefined}
        onAnimationEnd={animateEntrance ? onAnimationEnd : undefined}
      >
        {content}
      </span>
    );
  }

  return (
    <button
      type="button"
      aria-label={`Open subagent ${row.displayName}`}
      className={className}
      data-animate-entrance={animateEntrance ? "" : undefined}
      onAnimationEnd={animateEntrance ? onAnimationEnd : undefined}
      onClick={onClick}
    >
      {content}
    </button>
  );
}

export function ThreadSubagentActivityInlineGroupBlock({
  block,
  onOpenThread,
}: ThreadLeafBlockProps) {
  const rows =
    block.type === "subagentActivityInlineGroup"
      ? (block.subagentActivityRows ?? EMPTY_SUBAGENT_ACTIVITY_ROWS)
      : EMPTY_SUBAGENT_ACTIVITY_ROWS;
  const reducedMotion = useResolvedReducedMotion();
  const [seenConversationIds, setSeenConversationIds] = useState<ReadonlySet<string>>(
    () => new Set(rows.map((row) => row.conversationId)),
  );
  const markAnimationComplete = useCallback((conversationId: string) => {
    setSeenConversationIds((current) => {
      if (current.has(conversationId)) return current;
      const next = new Set(current);
      next.add(conversationId);
      return next;
    });
  }, []);

  useEffect(() => {
    if (!reducedMotion) return;
    setSeenConversationIds((current) => {
      const next = new Set(current);
      for (const row of rows) next.add(row.conversationId);
      return next.size === current.size ? current : next;
    });
  }, [reducedMotion, rows]);

  if (block.type !== "subagentActivityInlineGroup" || rows.length === 0) return null;

  const visibleRows = rows.slice(0, SUBAGENT_ACTIVITY_VISIBLE_CHIP_COUNT);
  const hiddenCount = rows.length - visibleRows.length;
  const statusLabel = block.subagentActivityStatusLabel ?? resolveSubagentActivityStatusLabel(rows);

  return (
    <div className="min-w-0 text-size-chat relative overflow-visible py-0">
      <div
        aria-label={`Subagents ${statusLabel}`}
        aria-live="polite"
        role="status"
        className="min-w-0 text-sm leading-5 text-token-conversation-body"
        data-testid="subagent-activity-inline-group"
      >
        {visibleRows.map((row) => (
          <SubagentActivityInlineChip
            key={row.conversationId}
            row={row}
            animateEntrance={!reducedMotion && !seenConversationIds.has(row.conversationId)}
            onAnimationEnd={() => markAnimationComplete(row.conversationId)}
            onClick={
              onOpenThread
                ? () => {
                    void onOpenThread(row.conversationId, {
                      subagent: {
                        agentRole: null,
                        conversationId: row.conversationId,
                        diffStats: null,
                        displayName: row.displayName,
                        showInlineActivity: true,
                        spawnModel: null,
                        status: row.status,
                        statusSummary: row.statusSummary,
                      },
                    });
                  }
                : undefined
            }
          />
        ))}
        <span className="align-middle text-base">
          {hiddenCount > 0
            ? `and ${hiddenCount} other ${hiddenCount === 1 ? "subagent" : "subagents"} `
            : null}
          {statusLabel}
        </span>
      </div>
    </div>
  );
}

export function ThreadUserAttachmentStripBlock({ block }: ThreadSpecialBlockProps) {
  if (block.type !== "userAttachmentStrip") return null;
  return <UserAttachmentStrip attachments={block.attachments} />;
}

export function UserMessageBubble({
  block,
  isSearchMatch = false,
  isActiveSearchMatch = false,
  onEditLastUserTurn,
  projectWorkspacePath,
  threadCwd,
  compactUserMessageActions = false,
}: ThreadLeafBlockProps) {
  const content = block.entry.markdownText ?? "";
  const userActions = block.userMessageActions;
  const canEdit = userActions?.canEdit ?? false;
  const isNotSent = block.entry.deliveryStatus === "not-sent";
  const isGoalMessage = block.entry.goal === true;
  const isHookFeedback = block.entry.hookFeedback === true;
  const hookSettingsNavigation = useHookFeedbackSettingsNavigation();
  const hookFeedbackSettingsTarget = resolveHookFeedbackSettingsTarget({
    hostId: hookSettingsNavigation?.hostId ?? DEFAULT_CODEX_HOST_ID,
    cwd: threadCwd,
    sources: block.hookFeedbackSources,
  });
  const hookFeedbackSettingsHref = buildHookFeedbackSettingsHref({
    hostId: hookFeedbackSettingsTarget.hostId,
    cwd: threadCwd,
    sources: block.hookFeedbackSources,
  });
  const hasMessageContent = content.trim().length > 0;
  const shouldRenderFooter =
    isNotSent ||
    isGoalMessage ||
    isHookFeedback ||
    (hasMessageContent && !compactUserMessageActions);
  const [isEditing, setIsEditing] = useState(false);
  const [draftMessage, setDraftMessage] = useState(content);
  const [isSubmittingEdit, setIsSubmittingEdit] = useState(false);
  const clientUserMessageId =
    block.entry.rawItem && typeof block.entry.rawItem === "object"
      ? ((block.entry.rawItem as { readonly clientId?: unknown }).clientId ?? null)
      : null;

  const openInlineEditor = useCallback(() => {
    setDraftMessage(content);
    setIsEditing(true);
  }, [content]);

  const cancelInlineEditor = useCallback(() => {
    setDraftMessage(content);
    setIsEditing(false);
  }, [content]);

  const handleEditSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (!onEditLastUserTurn || isSubmittingEdit || block.turnId === null) return;

      setIsSubmittingEdit(true);
      try {
        await onEditLastUserTurn({
          threadId: block.entry.threadId,
          turnId: block.turnId,
          message: draftMessage.trim(),
        });
        setIsEditing(false);
      } finally {
        setIsSubmittingEdit(false);
      }
    },
    [block.entry.threadId, block.turnId, draftMessage, isSubmittingEdit, onEditLastUserTurn],
  );

  const handleDraftMessageInput = useCallback((element: HTMLTextAreaElement) => {
    resizeEditMessageTextarea(element);
    setDraftMessage(element.value);
  }, []);
  const messageBubble = (
    <div
      data-user-message-bubble="true"
      data-client-user-message-id={
        typeof clientUserMessageId === "string" ? clientUserMessageId : undefined
      }
      data-thread-selected-text-target="true"
      className={THREAD_VISUAL_TOKENS.userBubble}
    >
      {block.entry.questionReplies ? (
        <div className="flex flex-col gap-3">
          {block.entry.questionReplies.map((reply) => (
            <div key={reply.questionItemId} className="flex flex-col gap-1">
              <div className="truncate text-sm text-token-text-secondary">{reply.question}</div>
              <UserMessageText
                text={reply.answer}
                cwd={threadCwd}
                projectWorkspacePath={projectWorkspacePath}
              />
            </div>
          ))}
        </div>
      ) : (
        <UserMessageText
          text={content}
          cwd={threadCwd}
          projectWorkspacePath={projectWorkspacePath}
        />
      )}
    </div>
  );

  return (
    <div
      className={cn(
        "flex flex-col items-end gap-2",
        isSearchMatch && THREAD_VISUAL_TOKENS.searchUnitMatched,
        isActiveSearchMatch && THREAD_VISUAL_TOKENS.searchUnitActive,
      )}
      data-content-search-unit-key={block.searchUnitKey}
    >
      <div className="group flex w-full flex-col items-end justify-end gap-1">
        {isEditing ? (
          <form
            className="flex w-full flex-col gap-4 rounded-2xl bg-token-foreground/5 px-3 py-2.5"
            onSubmit={(event) => {
              void handleEditSubmit(event).catch(() => {});
            }}
          >
            <textarea
              aria-label="Edit message"
              autoFocus
              className="w-full resize-none bg-transparent p-0 text-sm leading-relaxed text-token-foreground outline-none placeholder:text-token-description-foreground"
              rows={EDIT_MESSAGE_MIN_ROWS}
              value={draftMessage}
              onChange={(event) => {
                handleDraftMessageInput(event.currentTarget);
              }}
              onInput={(event) => {
                handleDraftMessageInput(event.currentTarget as HTMLTextAreaElement);
              }}
              onKeyDown={(event) => {
                if (event.key !== "Enter" || !event.metaKey) return;
                event.preventDefault();
                event.currentTarget.form?.requestSubmit();
              }}
              ref={(element) => {
                if (!element) return;
                resizeEditMessageTextarea(element);
              }}
            />
            <div className="flex justify-end gap-1.5">
              <button
                type="button"
                disabled={isSubmittingEdit}
                className="border-token-border user-select-none no-drag cursor-interaction flex items-center gap-1 border focus:outline-none disabled:cursor-not-allowed disabled:opacity-40 rounded-lg border-token-border text-token-button-tertiary-foreground bg-token-bg-fog enabled:hover:bg-token-list-hover-background data-[state=open]:bg-token-list-hover-background border h-token-button-composer px-2 py-0 text-base leading-[18px]"
                onClick={cancelInlineEditor}
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={isSubmittingEdit}
                className="border-token-border user-select-none no-drag cursor-interaction flex items-center gap-1 border focus:outline-none disabled:cursor-not-allowed disabled:opacity-40 rounded-lg bg-token-foreground enabled:hover:bg-token-foreground/80 data-[state=open]:bg-token-foreground/80 text-token-dropdown-background h-token-button-composer px-2 py-0 text-base leading-[18px]"
              >
                Send
              </button>
            </div>
          </form>
        ) : compactUserMessageActions && hasMessageContent ? (
          <div className="flex w-full items-center justify-end gap-1">
            <div className="opacity-0 group-focus-within:opacity-100 group-hover:opacity-100">
              <CopyMessageActionButton
                text={content}
                feedbackMs={USER_COPY_FEEDBACK_MS}
                disabledWhenCopied
              />
            </div>
            {messageBubble}
          </div>
        ) : (
          messageBubble
        )}
        {shouldRenderFooter ? (
          <div className="flex flex-row-reverse items-center gap-1">
            {isNotSent ? <UserMessageDeliveryFailureStatus /> : null}
            {isGoalMessage ? <UserMessageGoalStatus /> : null}
            {isHookFeedback ? (
              <UserMessageHookFeedbackStatus
                href={hookFeedbackSettingsHref}
                onOpen={
                  hookSettingsNavigation?.onOpenHooksSettings
                    ? () => hookSettingsNavigation.onOpenHooksSettings?.(hookFeedbackSettingsTarget)
                    : undefined
                }
              />
            ) : null}
            {isEditing || !hasMessageContent || compactUserMessageActions ? null : (
              <ThreadMessageActionRow align="end">
                <MessageTimestamp sentAtMs={userActions?.sentAtMs ?? null} />
                <div className="flex items-center gap-1">
                  <CopyMessageActionButton
                    text={content}
                    feedbackMs={USER_COPY_FEEDBACK_MS}
                    disabledWhenCopied
                  />
                  {canEdit ? (
                    <ThreadActionIconButton
                      label="Edit message"
                      tooltip="Edit"
                      onClick={openInlineEditor}
                    >
                      <EditMessageIcon />
                    </ThreadActionIconButton>
                  ) : null}
                </div>
              </ThreadMessageActionRow>
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function ThreadUserBubbleBlock(props: ThreadLeafBlockProps) {
  return <UserMessageBubble {...props} />;
}

export function ThreadReasoningBlock({
  block,
  isLatestTurn,
  isStreamingTurn,
  projectWorkspacePath,
  threadCwd,
}: ThreadLeafBlockProps) {
  const item = block.entry;

  return (
    <ReasoningSurface
      item={item}
      parseIncompleteMarkdown={isStreamingTurn && (item.status === "inProgress" || isLatestTurn)}
      cwd={threadCwd}
      projectWorkspacePath={projectWorkspacePath}
    />
  );
}

export function ThreadPlanCardBlock({
  block,
  isLatestTurn,
  isStreamingTurn,
  projectWorkspacePath,
  threadCwd,
  onOpenPlanInSidePanel,
  onClosePlanSidePanel,
  planSidePanelState,
}: ThreadLeafBlockProps) {
  const item = block.entry;
  const isInProgress = item.status === "inProgress";
  const shouldParseIncompleteMarkdown = isStreamingTurn && (isInProgress || isLatestTurn);
  const planKey = item.turnId || item.itemId;
  const boundTurnId = item.turnId;
  const isSidePanelActive = Boolean(
    block.type === "proposedPlan" &&
    !isInProgress &&
    planSidePanelState?.rightPanelEnabled &&
    planSidePanelState.activePlanKey === planKey &&
    planSidePanelState.activeRightPanelTabId === "plan",
  );

  return block.type === "todoList" ? (
    <TodoListSurface item={item} />
  ) : (
    <PlanMessage
      content={item.markdownText ?? ""}
      completed={!isInProgress}
      parseIncompleteMarkdown={shouldParseIncompleteMarkdown}
      cwd={threadCwd}
      projectWorkspacePath={projectWorkspacePath}
      isSidePanelActive={isSidePanelActive}
      onOpenInSidePanel={
        !isInProgress &&
        boundTurnId !== null &&
        planSidePanelState?.rightPanelEnabled &&
        onOpenPlanInSidePanel
          ? () =>
              onOpenPlanInSidePanel({
                planKey,
                threadId: item.threadId,
                turnId: boundTurnId,
                itemId: item.itemId,
                content: item.markdownText ?? "",
                cwd: item.cwd ?? threadCwd ?? null,
                hideCodeBlocks: false,
              })
          : undefined
      }
      onCloseSidePanel={
        isSidePanelActive && onClosePlanSidePanel
          ? () => onClosePlanSidePanel({ planKey })
          : undefined
      }
    />
  );
}

function humanizeHookEventName(value: string | null | undefined): string {
  switch (value) {
    case "preToolUse":
      return "PreToolUse";
    case "postToolUse":
      return "PostToolUse";
    case "sessionStart":
      return "SessionStart";
    case "userPromptSubmit":
      return "UserPromptSubmit";
    case "stop":
      return "Stop";
    default:
      return "Hook";
  }
}

function resolveHookSummary(entry: CodexConversationItem): {
  summary: string;
  status: string;
  details: Array<{ kind: string; text: string }>;
} {
  const raw = asRecord(entry.rawItem);
  const run = asRecord(raw?.run);
  const eventName = typeof run?.eventName === "string" ? run.eventName : null;
  const statusMessage = typeof run?.statusMessage === "string" ? run.statusMessage.trim() : "";
  const status = typeof run?.status === "string" ? run.status : "running";
  const details = Array.isArray(run?.entries)
    ? run.entries.flatMap((candidate) => {
        const parsed = asRecord(candidate);
        if (!parsed || typeof parsed.kind !== "string" || typeof parsed.text !== "string")
          return [];
        return [{ kind: parsed.kind, text: parsed.text }];
      })
    : [];

  return {
    summary:
      statusMessage.length > 0
        ? `${humanizeHookEventName(eventName)} - ${statusMessage}`
        : humanizeHookEventName(eventName),
    status,
    details,
  };
}

export function ThreadHookBlock({ block }: ThreadLeafBlockProps) {
  if (block.type !== "hook") return null;

  return <ThreadHookContent block={block} />;
}

function ThreadHookContent({ block }: { block: ThreadTranscriptBlockModel }) {
  const [expanded, setExpanded] = useState(false);
  const hook = resolveHookSummary(block.entry);

  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        className="group flex w-full min-w-0 items-center gap-1.5 text-left text-size-chat text-token-description-foreground transition-colors hover:text-token-foreground"
        aria-expanded={expanded}
        onClick={() => {
          setExpanded((current) => !current);
        }}
      >
        <ChevronRightIcon
          className={cn(
            "icon-xs shrink-0 transition-transform duration-300",
            expanded && "rotate-90",
          )}
        />
        <span className="min-w-0 flex-1 truncate">{hook.summary}</span>
        <span className="shrink-0 pl-4 text-right">{hook.status}</span>
      </button>
      {expanded ? (
        <div className="ml-5 flex flex-col gap-1">
          {hook.details.map((detail, index) => (
            <p
              key={`${detail.kind}:${index}`}
              className="text-size-chat whitespace-pre-wrap text-token-description-foreground"
              data-hook-entry-kind={detail.kind}
            >
              {detail.kind}: {detail.text}
            </p>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function ThreadWorkedForBlock({ block }: { block: ThreadWorkedForBlockModel }) {
  const label = useWorkedForLabelText({
    timing: {
      status: block.status,
      startedAtMs: block.startedAtMs,
      completedAtMs: block.completedAtMs,
    },
    durationMs: null,
  });
  if (!label) return null;

  return (
    <div className="min-w-0 text-size-chat relative overflow-visible py-0">
      <motion.div
        initial={CODEX_THREAD_DIVIDER_ENTER_INITIAL}
        animate={CODEX_THREAD_DIVIDER_ENTER_ANIMATE}
        transition={CODEX_THREAD_ACCORDION_TRANSITION}
        style={{ overflow: "hidden" }}
      >
        <div className="text-size-chat flex min-h-0 flex-col items-start gap-2 overflow-hidden text-token-text-secondary">
          <span className="text-token-foreground/60">{label}</span>
          <div className="w-full border-t border-current/20" />
        </div>
      </motion.div>
    </div>
  );
}

function AssistantMessageActionsRow({
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
  const [selectedRating, setSelectedRating] = useState<AssistantMessageRating | null>(null);
  const shouldShowActions = actions.copyText !== null || actions.canFork;
  if (!shouldShowActions) return null;

  return (
    <ThreadMessageActionRow align="start" className={alwaysShowActions ? "opacity-100" : undefined}>
      {actions.copyText !== null ? (
        <>
          <CopyMessageActionButton text={actions.copyText} label="Copy" stopPropagation />
          {actions.canRate ? (
            <>
              <AssistantRatingButton
                rating="thumbs_up"
                selectedRating={selectedRating}
                onSelect={setSelectedRating}
              />
              <AssistantRatingButton
                rating="thumbs_down"
                selectedRating={selectedRating}
                onSelect={setSelectedRating}
              />
            </>
          ) : null}
        </>
      ) : null}
      {actions.canFork && turnId !== null ? (
        <ThreadActionIconButton
          label="Fork from this point"
          tooltip="Fork"
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
          <ForkMessageIcon />
        </ThreadActionIconButton>
      ) : null}
      <MessageTimestamp sentAtMs={actions.sentAtMs} />
    </ThreadMessageActionRow>
  );
}

export function ThreadAssistantBodyBlock({
  block,
  isLatestTurn,
  isStreamingTurn,
  isSearchMatch = false,
  isActiveSearchMatch = false,
  projectWorkspacePath,
  threadCwd,
  onForkFromTurn,
  assistantAfter,
  alwaysShowAssistantMessageActions = false,
}: ThreadLeafBlockProps) {
  const markdownText = stripCodexRemarkDirectiveLines(block.entry.markdownText);
  const isAssistantItemStreaming = isStreamingTurn && block.entry.status === "inProgress";
  const assistantActions = block.assistantMessageActions;

  useEffect(() => {
    logAssistantStreamingDebugState(
      "renderer-assistant-block-render",
      `${block.entry.threadId}:${block.turnId}:${block.entry.itemId}`,
      `${isStreamingTurn}:${block.entry.status ?? "null"}:${isAssistantItemStreaming}:${markdownText.length}`,
      {
        threadId: block.entry.threadId,
        turnId: block.turnId,
        itemId: block.entry.itemId,
        itemStatus: block.entry.status ?? null,
        isLatestTurn,
        isStreamingTurn,
        isAssistantItemStreaming,
        markdownLength: markdownText.length,
      },
    );
  }, [
    block.entry.itemId,
    block.entry.status,
    block.entry.threadId,
    block.turnId,
    isAssistantItemStreaming,
    isLatestTurn,
    isStreamingTurn,
    markdownText.length,
  ]);

  return (
    <div
      className={cn(
        isSearchMatch && THREAD_VISUAL_TOKENS.searchUnitMatched,
        isActiveSearchMatch && THREAD_VISUAL_TOKENS.searchUnitActive,
      )}
      data-content-search-unit-key={block.searchUnitKey}
    >
      <div className="group flex min-w-0 flex-col">
        <div className={THREAD_VISUAL_TOKENS.assistantBody} data-thread-selected-text-target="true">
          <BudgetedMarkdownRenderer
            content={markdownText}
            parseIncompleteMarkdown={isAssistantItemStreaming}
            animateStreamingText={isAssistantItemStreaming}
            sourceAriaLabel="Assistant message source"
            sourceIdentity={block.entry.entryId}
            cwd={threadCwd}
            projectWorkspacePath={projectWorkspacePath}
          />
        </div>
        {assistantAfter ? <div className="mt-3">{assistantAfter}</div> : null}
        {assistantActions ? (
          <AssistantMessageActionsRow
            actions={assistantActions}
            threadId={block.entry.threadId}
            turnId={block.turnId}
            isLatestTurn={isLatestTurn}
            onForkFromTurn={onForkFromTurn}
            alwaysShowActions={alwaysShowAssistantMessageActions}
          />
        ) : null}
      </div>
    </div>
  );
}

export function ThreadAssistantActionsBlock({
  block,
  isLatestTurn,
  onForkFromTurn,
  alwaysShowAssistantMessageActions = false,
}: ThreadSpecialBlockProps & {
  onForkFromTurn?: (input: {
    threadId: string;
    turnId: string;
    message: string;
    isLatestTurn: boolean;
  }) => void | Promise<void>;
  alwaysShowAssistantMessageActions?: boolean;
}) {
  if (block.type !== "assistantActions") return null;

  return (
    <div className="group flex min-w-0 flex-col" data-assistant-actions-anchor={block.entry.itemId}>
      <AssistantMessageActionsRow
        actions={block.actions}
        threadId={block.entry.threadId}
        turnId={block.turnId}
        isLatestTurn={isLatestTurn}
        onForkFromTurn={onForkFromTurn}
        alwaysShowActions={alwaysShowAssistantMessageActions}
      />
    </div>
  );
}

export function ThreadUserInputResponseCard({ block }: ThreadLeafBlockProps) {
  if (block.type !== "userInputResponse") return null;
  return <AnsweredUserInputBlock item={block.entry} />;
}

export function ThreadImageViewBlock({ block }: ThreadLeafBlockProps) {
  if (block.type !== "imageView") return null;
  return <ImageViewSurface imagePaths={block.imageViewPaths ?? []} />;
}

export function ThreadGeneratedImageGalleryBlock({ block }: ThreadSpecialBlockProps) {
  if (block.type !== "generatedImageGallery") return null;
  return (
    <div className="flex w-full flex-col gap-3">
      <GeneratedImageGallery
        groupId={block.id}
        images={block.images}
        pendingImageCount={block.pendingImageCount}
        turnStartedAtMs={block.createdAt}
      />
    </div>
  );
}

export function ThreadMcpServerElicitationBlock({ block }: ThreadLeafBlockProps) {
  if (block.type !== "mcpServerElicitation") return null;
  const view = resolveCompletedMcpServerElicitationView(block.entry.rawItem);
  if (!view) return null;
  return <CompletedRequestActivitySurface view={view} />;
}

export function ThreadPlanImplementationBlock({
  block,
  projectWorkspacePath,
  threadCwd,
}: ThreadLeafBlockProps) {
  if (block.type !== "planImplementation") return null;

  const content = block.entry.markdownText?.trim() ?? "";
  if (content.length === 0) return null;

  return (
    <PlanMessage
      content={content}
      completed={block.status === "completed"}
      parseIncompleteMarkdown={false}
      cwd={threadCwd}
      projectWorkspacePath={projectWorkspacePath}
    />
  );
}

export function buildThreadWorktreeInitActivities(
  entry: CodexConversationItem,
): CodexWorktreeInitActivity[] {
  const rawItem = asRecord(entry.rawItem);
  if (rawItem?.type !== "worktreeInit") return [];
  if (typeof rawItem.id !== "string") return [];
  if (typeof rawItem.worktreeOutputText !== "string") return [];

  const activities: CodexWorktreeInitActivity[] = [
    {
      id: `${rawItem.id}:worktree`,
      kind: "worktree",
      status: "completed",
      outputText: rawItem.worktreeOutputText,
    },
  ];
  if (rawItem.setup === null || rawItem.setup === undefined) return activities;

  const setup = asRecord(rawItem.setup);
  if (!setup) return activities;
  if (setup.outcome !== "completed" && setup.outcome !== "skipped") return activities;
  if (typeof setup.outputText !== "string") return activities;

  activities.push({
    id: `${rawItem.id}:setup`,
    kind: "setup",
    status: setup.outcome,
    outputText: setup.outputText,
  });
  return activities;
}

export function ThreadWorktreeInitBlock({ block }: ThreadLeafBlockProps) {
  if (block.type !== "worktreeInit") return null;
  const activities = buildThreadWorktreeInitActivities(block.entry);
  if (activities.length === 0) return null;

  return <WorktreeInitActivityList activities={activities} />;
}

function ContextCompactionIcon({ className }: { className?: string }) {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 20 20"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-hidden="true"
    >
      <path
        d="M12.666 3.50098C13.3549 3.50098 13.9121 3.50133 14.3623 3.53809C14.8202 3.5755 15.2268 3.65483 15.6035 3.84668C16.1988 4.15007 16.6829 4.63424 16.9863 5.22949C17.1782 5.60603 17.2575 6.01205 17.2949 6.46973C17.3317 6.91983 17.3311 7.47721 17.3311 8.16602V15.1377C17.9209 15.3944 18.333 15.9827 18.333 16.667C18.3328 17.5872 17.5872 18.3328 16.667 18.333C15.7466 18.333 15.0002 17.5873 15 16.667C15 15.9832 15.4119 15.3957 16.001 15.1387V8.16602C16.001 7.45532 16.0011 6.96153 15.9697 6.57812C15.939 6.20279 15.8822 5.99093 15.8018 5.83301C15.6258 5.4879 15.3442 5.20711 14.999 5.03125C14.8411 4.95091 14.6291 4.89394 14.2539 4.86328C13.8705 4.83199 13.3767 4.83105 12.666 4.83105H7.5C7.13284 4.83092 6.83496 4.5332 6.83496 4.16602C6.8353 3.79912 7.13305 3.50111 7.5 3.50098H12.666Z"
        fill="currentColor"
      />
      <path
        d="M3.33301 1.66699C4.25337 1.66699 4.99981 2.41269 5 3.33301C5 4.01711 4.58759 4.60453 3.99805 4.86133V11.833C3.99805 12.5438 3.99896 13.0374 4.03027 13.4209C4.06095 13.7963 4.11783 14.008 4.19824 14.166C4.37411 14.5112 4.6549 14.7918 5 14.9678C5.15797 15.0483 5.36958 15.105 5.74512 15.1357C6.12859 15.1671 6.6221 15.168 7.33301 15.168H12.5L12.6338 15.1816C12.9367 15.2437 13.1649 15.5118 13.165 15.833C13.165 16.1543 12.9368 16.4223 12.6338 16.4844L12.5 16.498H7.33301C6.64403 16.498 6.08691 16.4987 5.63672 16.4619C5.17904 16.4245 4.77303 16.3451 4.39648 16.1533C3.8011 15.8499 3.31608 15.365 3.0127 14.7695C2.82102 14.393 2.7415 13.987 2.7041 13.5293C2.66734 13.0791 2.66797 12.5219 2.66797 11.833V4.86035C2.07898 4.60332 1.66699 4.0167 1.66699 3.33301C1.66718 2.41283 2.41284 1.66721 3.33301 1.66699Z"
        fill="currentColor"
      />
      <path
        d="M10.1338 11.0146C10.4366 11.0766 10.6647 11.345 10.665 11.666C10.665 11.9873 10.4367 12.2553 10.1338 12.3174L10 12.3311H7.5C7.13284 12.3309 6.83496 12.0332 6.83496 11.666C6.8353 11.2991 7.13305 11.0011 7.5 11.001H10L10.1338 11.0146Z"
        fill="currentColor"
      />
      <path
        d="M12.6338 7.68164C12.9367 7.74367 13.1649 8.01182 13.165 8.33301C13.165 8.65433 12.9368 8.92232 12.6338 8.98438L12.5 8.99805H7.5C7.13284 8.99791 6.83496 8.7002 6.83496 8.33301C6.83513 7.96596 7.13294 7.6681 7.5 7.66797H12.5L12.6338 7.68164Z"
        fill="currentColor"
      />
    </svg>
  );
}

export function ThreadContextCompactionBlock({ block }: ThreadLeafBlockProps) {
  if (block.type !== "contextCompaction") return null;

  const isCompleted = block.status !== "inProgress";

  return (
    <div className="text-size-chat my-2 flex items-center gap-2 text-token-text-secondary">
      <div className="flex-1 border-t border-current/20" />
      <div className="flex items-center gap-1 whitespace-nowrap">
        {isCompleted ? <ContextCompactionIcon className="icon-2xs" /> : null}
        {isCompleted ? (
          <span>Context automatically compacted</span>
        ) : (
          <CodexShimmerText>Automatically compacting context</CodexShimmerText>
        )}
      </div>
      <div className="flex-1 border-t border-current/20" />
    </div>
  );
}

export function ThreadStreamErrorBlock({ block }: ThreadLeafBlockProps) {
  if (block.type !== "streamError") return null;

  return <ThreadStreamErrorContent block={block} />;
}

function ThreadStreamErrorContent({ block }: { block: ThreadTranscriptBlockModel }) {
  const [isExpanded, setIsExpanded] = useState(false);
  const details = block.entry.additionalDetails?.trim() ?? "";
  const hasDetails = details.length > 0;
  const { elementHeightPx, elementRef } = useMeasuredElementHeight();
  const isOpen = hasDetails && isExpanded;

  return (
    <div className="flex min-w-0 flex-col">
      <div
        className={cn(
          "group flex min-w-0 items-start gap-1",
          hasDetails ? "cursor-interaction" : "cursor-default",
        )}
        onClick={() => {
          if (!hasDetails) return;
          setIsExpanded((current) => !current);
        }}
      >
        <div className="text-size-chat min-w-0 whitespace-pre-wrap text-token-description-foreground/80">
          {block.entry.markdownText ?? "Reconnecting..."}
        </div>
        {hasDetails ? (
          <ChevronRightIcon
            className={cn(
              "text-token-input-placeholder-foreground icon-2xs mt-0.5 shrink-0 transition-all duration-300 opacity-0 group-hover:opacity-100",
              isOpen && "rotate-90 opacity-100",
            )}
          />
        ) : null}
      </div>
      <motion.div
        initial={false}
        animate={{
          height: isOpen ? elementHeightPx : 0,
          opacity: isOpen ? 1 : 0,
        }}
        transition={CODEX_THREAD_ACCORDION_TRANSITION}
        className={isOpen ? "overflow-visible" : "overflow-hidden"}
        style={{ pointerEvents: isOpen ? "auto" : "none" }}
      >
        <div ref={elementRef}>
          {isOpen ? (
            <div className="mt-1 flex flex-col gap-1">
              <div className="text-size-chat whitespace-pre-wrap text-token-description-foreground/80">
                {details}
              </div>
            </div>
          ) : null}
        </div>
      </motion.div>
    </div>
  );
}

export function ThreadSystemErrorBlock({ block }: ThreadLeafBlockProps) {
  if (block.type !== "systemError") return null;

  return (
    <div className="text-size-chat flex w-full wrap-anywhere text-token-description-foreground/80">
      {block.entry.markdownText ?? "Thread hit an error"}
    </div>
  );
}

export function ThreadSystemBannerBlock({ block }: ThreadLeafBlockProps) {
  const item = block.entry;
  const label = humanizeBlockType(block.type);

  if (item.markdownText) {
    return (
      <div className="flex flex-col gap-1.5">
        <div className="text-[11px] font-medium tracking-wide text-token-description-foreground uppercase">
          {label}
        </div>
        <div className="text-size-chat-sm whitespace-pre-wrap text-token-text-secondary">
          {item.markdownText}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1.5">
      <div className="text-[11px] font-medium tracking-wide text-token-description-foreground uppercase">
        {label}
      </div>
      <div>
        <JsonBlock value={item.rawItem} />
      </div>
    </div>
  );
}
