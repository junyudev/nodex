import { ThreadTextSelectionAttachments } from "../thread-text-selection-attachments";
import { ResponseAnnotationContext } from "../response-annotation-context";
import { AssistantMessageActionsRow } from "../shared/assistant-message-actions";
import { LocalConversationCreatedThreadCards } from "../local-conversation-created-thread-cards";
import { readAssistantCreatedThreadResults } from "../../projection/assistant-created-thread-results";
import { useCreatedThreadSourceAeon } from "../../created-thread-host-hooks";
import { footerText } from "../shared/thread-footer-i18n";
import { HookStatsIndicator } from "../shared/hook-stats-indicator";
import {
  useCallback,
  useContext,
  useEffect,
  useState,
  type CSSProperties,
  type FormEvent,
  type ReactNode,
} from "react";
import { motion } from "motion/react";
import { NodexTooltip } from "@/components/ui/tooltip";
import { SendIcon } from "@/components/shared/icons/generic-icons";
import {
  ChevronRightIcon,
  ForkIcon,
  GoalTargetIcon,
  HooksIcon,
  QueuePendingInfoIcon,
} from "@/components/shared/icons";
import { MarkdownRenderer } from "../shared/markdown/markdown-renderer";
import { CodexTranscriptTurnEntityContext } from "../../normalized-transcript-hooks";
import { useConversationVisualizationContext } from "../inline-visualization-context";
import { AutomaticApprovalReviewSurface } from "../shared/automatic-approval-review-surface";
import { MultiAgentActionSurface } from "../shared/multi-agent-action-surface";
import { DelegatedTaskGroup, RuntimeNoticeRow } from "../shared/delegated-task-row";
import {
  AgentHandoffDivider,
  ContextClearedDivider,
  TranscriptDivider,
} from "../shared/transcript-divider";
import { ContextCompactionSurface } from "../shared/context-compaction-surface";
import { ImageViewSurface } from "../shared/image-view-surface";
import { ImportedMarkdownImagesProvider } from "../shared/imported-markdown-images";
import { GeneratedImageGallery } from "../shared/generated-image-gallery";
import { CompletedRequestActivitySurface } from "../shared/completed-request-activity-surface";
import { PlanMessage } from "../shared/plan-message";
import { ThoughtDisclosure, ThoughtLivePreview, ThoughtRow } from "../shared/thought-surface";
import {
  SubagentActivityDetails,
  SubagentActivityInline,
} from "../shared/subagent-activity-inline";
import { TurnDiffSurface } from "../shared/turn-diff-surface";
import {
  CopyMessageActionButton,
  EditMessageIcon,
  MessageTimestamp,
  ThreadActionIconButton,
  ThreadMessageActionRow,
  USER_COPY_FEEDBACK_MS,
} from "../shared/thread-message-actions";
import { TodoListSurface } from "../shared/todo-list-surface";
import { getToolComponent } from "../shared/tools/get-tool-component";
import { LazyToolOutput } from "../shared/tools/lazy-tool-output";
import { DynamicToolCallSummary } from "../shared/tools/dynamic-tool-call";
import { WorktreeInitActivityList } from "../shared/tools/worktree-init-activity-list";
import {
  JsonBlock,
  ThreadActivityDisclosure,
  ThreadActivitySummaryLabel,
  type ThreadActivitySummaryTransition,
} from "../shared/tools/tool-primitives";
import { ToolActivityIcon, resolveToolActivityEntryIcon } from "../shared/tools/tool-call-icons";
import { MessageText } from "@/components/message/message-document";
import {
  CODEX_THREAD_ACCORDION_TRANSITION,
  CODEX_THREAD_DIVIDER_ENTER_ANIMATE,
  CODEX_THREAD_DIVIDER_ENTER_INITIAL,
} from "../shared/thread-motion";
import { ConversationRecoverySurface } from "../shared/conversation-recovery-surface";
import { useConversationRecoveryActions } from "../conversation-recovery-actions";
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
import { cn } from "../../../../lib/utils";
import { DEFAULT_CODEX_HOST_ID } from "../../../../../shared/codex-host";
import { resolveCompletedMcpServerElicitationView } from "../../projection/mcp-server-elicitation-view";
import { buildHookFeedbackSettingsHref } from "../../projection/hook-feedback-settings";
import { resolveHookFeedbackSettingsTarget } from "../../../../lib/codex-hooks-route";
import { formatThreadAgentActivityCompletedSummaryPart } from "../../projection/agent-activity-v2-summary";
import type {
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
import { formatThoughtLabel, sumThoughtDurations } from "../../thread-thought-label";
import { useHookFeedbackSettingsNavigation } from "../hook-feedback-settings-navigation";
import { useLocalConversationUserTurnEditDraft } from "../local-conversation-thread-view-state";
import { resolveComposerSubmitIntentFromKeyDown } from "../shared/composer-action";
import { composerEnterBehaviorAtom } from "@/lib/composer-enter-behavior-atom";
import { useScopedAtomValue } from "@/lib/maitai";
import {
  useCodexTranscriptBlock,
  useCodexTranscriptDelegatedTaskEntries,
  CodexTranscriptReasoningSummary,
} from "../../normalized-transcript-hooks";

export interface ThreadLeafBlockProps {
  hostId?: string;
  block: ThreadTranscriptBlockModel;
  isLatestTurn: boolean;
  isStreamingTurn: boolean;
  isSearchMatch?: boolean;
  isActiveSearchMatch?: boolean;
  projectWorkspacePath?: string | null;
  projectlessOutputDirectory?: string | null;
  childMemberships?: readonly CodexConversationChildMembership[];
  parentModel?: string | null;
  threadCwd?: string | null;
  onEditUserTurn?: (input: {
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
  onOpenSubagentsPanel?: ThreadStageActions["onOpenSubagentsPanel"];
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
  hideUserMessageActions?: boolean;
  alwaysShowUserMessageActions?: boolean;
}

export interface ThreadSpecialBlockProps {
  block: ThreadBlockModel;
  isLatestTurn: boolean;
  isStreamingTurn: boolean;
  projectWorkspacePath?: string | null;
  projectlessOutputDirectory?: string | null;
  childMemberships?: readonly CodexConversationChildMembership[];
  parentModel?: string | null;
  threadCwd?: string | null;
  onOpenTurnDiffReview?: (intent: ReviewOpenIntent) => void | Promise<void>;
  onOpenTurnDiffFileInSidePanel?: ThreadStageActions["onOpenTurnDiffFileInSidePanel"];
  onOpenSideChat?: ThreadStageActions["onOpenSideChat"];
  onOpenThread?: ThreadStageActions["onOpenThread"];
  onOpenSubagentsPanel?: ThreadStageActions["onOpenSubagentsPanel"];
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
      <span className="text-token-description-foreground text-xs">
        {footerText("Sent as goal")}
      </span>
    </div>
  );
}

function UserMessageHookStatus({
  href,
  onOpen,
  blocked = false,
}: {
  href: string;
  onOpen?: () => void;
  blocked?: boolean;
}) {
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
      {blocked ? (
        <QueuePendingInfoIcon aria-hidden className="icon-2xs shrink-0" />
      ) : (
        <HooksIcon aria-hidden className="icon-2xs shrink-0" />
      )}
      <span>{footerText(blocked ? "Hook blocked this message" : "Hook feedback")}</span>
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
      return "Context compaction";
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
    case "delegatedTask":
      return "Subagent";
    case "runtimeNotice":
      return "Notice";
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

/** Opens the editor ready to continue typing at the end of the message. */
function focusEditMessageTextareaOnMount(element: HTMLTextAreaElement | null): void {
  if (!element || element.ownerDocument.activeElement === element) return;
  resizeEditMessageTextarea(element);
  element.focus();
  element.setSelectionRange(element.value.length, element.value.length);
}

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
  if (entry.type === "streamError" || entry.type === "systemError")
    return <ThreadRecoveryBlock block={entry as ThreadTranscriptBlockModel} {...sharedProps} />;
  if (entry.type === "contextCompaction")
    return (
      <ThreadContextCompactionBlock block={entry as ThreadTranscriptBlockModel} {...sharedProps} />
    );
  if (entry.type === "reasoning")
    return <ThreadThoughtRowBlock block={entry as ThreadTranscriptBlockModel} {...sharedProps} />;
  if (
    entry.type === "exec" ||
    entry.type === "fileChange" ||
    entry.type === "mcpToolCall" ||
    entry.type === "toolCall" ||
    entry.type === "dynamicToolCall" ||
    entry.type === "webSearch"
  ) {
    return <ThreadToolSurfaceBlock block={entry as ThreadTranscriptBlockModel} {...sharedProps} />;
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
            <DynamicToolCallSummary
              call={{ ...call, completed: true }}
              isLeadingSummaryPart={index === 0}
              variant="summary-text"
            />
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
  const isThoughtOnly = block.entries.every((entry) => entry.type === "reasoning");
  const latestThought = block.entries.findLast((entry) => entry.type === "reasoning") ?? null;
  const summaryText =
    block.header.kind === "summary" ? (
      isThoughtOnly && block.completedHeader.parts.length === 0 ? (
        formatThoughtLabel(
          sumThoughtDurations(block.entries.map((entry) => entry.entry.thought?.durationMs)),
        )
      ) : (
        <CompletedActivitySummaryText parts={block.completedHeader.parts} />
      )
    ) : block.header.kind === "active" ? (
      <ActiveActivitySummaryText header={block.header} />
    ) : (
      <CodexShimmerText>
        <CodexTranscriptReasoningSummary item={latestThought} fallback={block.header.message} />
      </CodexShimmerText>
    );
  const summary = (
    <span className="inline-flex max-w-full min-w-0 items-center gap-1.5 overflow-hidden">
      {icon ? <ToolActivityIcon descriptor={icon} /> : null}
      <ThreadActivitySummaryLabel interactive={block.canExpand}>
        {summaryText}
      </ThreadActivitySummaryLabel>
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
      preview={
        latestThought ? (
          <ThreadThoughtLivePreview
            block={latestThought as ThreadTranscriptBlockModel}
            active={block.header.kind === "thinking" && block.entries.at(-1) === latestThought}
            isLatestTurn={isLatestTurn}
            isStreamingTurn={isStreamingTurn}
            projectWorkspacePath={projectWorkspacePath}
            threadCwd={threadCwd}
          />
        ) : null
      }
    >
      {body}
    </ThreadActivityDisclosure>
  );
}

export function ThreadToolSurfaceBlock({
  block: inputBlock,
  isStreamingTurn,
  projectWorkspacePath,
  threadCwd,
  onOpenTurnDiffFileInSidePanel,
  onOpenThread,
  onOpenSummaryScheduledAutomation,
  onOpenMcpAppSidePanel,
}: ThreadLeafBlockProps) {
  const block = useCodexTranscriptBlock(inputBlock);
  const { settings } = useCodexThreadSettings();
  const item = block.entry;
  const threadDetailLevel = resolveCodexThreadDetailLevel(settings.detailLevel);
  if (
    item.semanticKind === "mcpToolCall" &&
    threadDetailLevel === "STEPS_PROSE" &&
    item.automationUpdate?.source !== "nativeMcp"
  ) {
    return null;
  }

  const ToolComponent = getToolComponent(item);
  if (!ToolComponent) return null;

  return (
    <>
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
      {item.toolOutputReference ? (
        <LazyToolOutput
          key={`${item.toolOutputReference.sessionId}:${item.toolOutputReference.nativeMessageId}:${item.toolOutputReference.toolUseId}`}
          reference={item.toolOutputReference}
        />
      ) : null}
    </>
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
  parentModel,
}: ThreadLeafBlockProps) {
  if (block.type !== "multiAgentAction") return null;
  return (
    <MultiAgentActionSurface
      childMemberships={childMemberships}
      items={[block.entry]}
      parentModel={parentModel}
      onOpenThread={onOpenThread}
    />
  );
}

export function ThreadDelegatedTaskBlock({
  block,
  childMemberships,
  onOpenThread,
  onOpenSubagentsPanel,
}: ThreadLeafBlockProps) {
  const entries = useCodexTranscriptDelegatedTaskEntries(
    block.delegatedTaskEntries ?? [block.entry],
  );
  if (block.type !== "delegatedTask") return null;
  const tasks = entries.flatMap((entry) => (entry.delegatedTask ? [entry.delegatedTask] : []));
  return (
    <DelegatedTaskGroup
      tasks={tasks}
      parentThreadId={block.entry.threadId}
      childMemberships={childMemberships}
      onOpenThread={onOpenThread}
      onOpenSubagentsPanel={onOpenSubagentsPanel}
    />
  );
}

export function ThreadRuntimeNoticeBlock({ block, onOpenThread }: ThreadLeafBlockProps) {
  if (block.type !== "runtimeNotice") return null;
  const notice = block.entry.runtimeNotice;
  if (notice?.kind === "agentHandoff") return <AgentHandoffDivider notice={notice} />;
  if (notice?.kind === "contextCleared") return <ContextClearedDivider />;
  if (!block.entry.markdownText?.trim()) return null;
  return (
    <RuntimeNoticeRow
      message={block.entry.markdownText}
      notice={block.entry.runtimeNotice}
      onOpenThread={onOpenThread}
    />
  );
}

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

export function ThreadSubagentActivityInlineGroupBlock({
  block,
  onOpenThread,
  onOpenSubagentsPanel,
  hostId,
}: ThreadLeafBlockProps) {
  const rows =
    block.type === "subagentActivityInlineGroup"
      ? (block.subagentActivityRows ?? EMPTY_SUBAGENT_ACTIVITY_ROWS)
      : EMPTY_SUBAGENT_ACTIVITY_ROWS;
  if (block.type !== "subagentActivityInlineGroup") return null;
  if (block.entry.subagentActivity?.isMessage)
    return (
      <div className="flex items-center gap-1.5 text-size-chat text-token-text-secondary select-none">
        <SendIcon className="icon-xs shrink-0" aria-hidden="true" />
        <span>{`Sent message to ${block.entry.subagentActivity.displayName ?? "parent"}`}</span>
      </div>
    );
  return (
    <SubagentActivityInlineRows
      rows={rows}
      statusLabel={block.subagentActivityStatusLabel}
      onOpenThread={onOpenThread}
      onOpenSubagentsPanel={onOpenSubagentsPanel}
      sourceRoot={hostId ? { hostId, threadId: block.entry.threadId } : undefined}
    />
  );
}

export function SubagentActivityInlineRows({
  rows,
  statusLabel: suppliedStatusLabel,
  onOpenThread,
  onOpenSubagentsPanel,
  sourceRoot,
}: {
  readonly rows: readonly ThreadSubagentActivityInlineRowModel[];
  readonly statusLabel?: string;
  readonly onOpenThread?: ThreadStageActions["onOpenThread"];
  readonly onOpenSubagentsPanel?: ThreadStageActions["onOpenSubagentsPanel"];
  readonly sourceRoot?: { readonly hostId: string; readonly threadId: string };
}) {
  const statusLabel = suppliedStatusLabel ?? resolveSubagentActivityStatusLabel(rows);
  const sentenceStatus =
    statusLabel === "interrupted"
      ? rows.length === 1
        ? "was interrupted"
        : "were interrupted"
      : statusLabel;
  const items = rows.map((row) => ({
    id: row.conversationId,
    name: row.displayName,
    seed: row.identityThreadId,
    details: (
      <SubagentActivityDetails
        name={row.displayName}
        status={
          row.status === "done" && row.activityStatus === "interrupted"
            ? "Interrupted"
            : row.status === "active"
              ? "Working"
              : row.status === "waiting"
                ? "Waiting"
                : "Done"
        }
        description={
          row.statusSummary ? (
            <p className="line-clamp-4 break-words">{row.statusSummary}</p>
          ) : undefined
        }
        metadata={[row.agentRole, row.spawnModel].filter(Boolean).join(" · ") || null}
      />
    ),
    onOpen:
      onOpenThread && row.canOpen
        ? () => {
            void onOpenThread(row.conversationId, {
              ...(sourceRoot ? { hostId: sourceRoot.hostId, sourceRoot } : {}),
              subagent: {
                agentRole: row.agentRole,
                conversationId: row.conversationId,
                diffStats: row.diffStats,
                displayName: row.displayName,
                showInlineActivity: true,
                spawnModel: row.spawnModel,
                status: row.status,
                statusSummary: row.statusSummary,
                ...(row.canInteract === true ? { canInteract: true } : {}),
              },
            });
          }
        : undefined,
  }));
  return (
    <SubagentActivityInline
      items={items}
      statusLabel={sentenceStatus}
      onOpenAll={onOpenSubagentsPanel}
    />
  );
}

/**
 * Rewrites a sent message in place of its bubble. Sending rewinds the conversation to just
 * before this message and continues from the rewritten one; keys follow the Composer.
 */
function UserMessageEditForm({
  draft,
  onDraftChange,
  onCancel,
  onSubmit,
}: {
  readonly draft: string;
  readonly onDraftChange: (draft: string) => void;
  readonly onCancel: () => void;
  /** Rejects when the edit failed, so the draft stays open to retry. */
  readonly onSubmit: (message: string) => Promise<void>;
}) {
  const enterBehavior = useScopedAtomValue(composerEnterBehaviorAtom);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const canSubmit = draft.trim().length > 0 && !isSubmitting;

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canSubmit) return;
    setIsSubmitting(true);
    try {
      await onSubmit(draft.trim());
    } catch {
      // The conversation surface reports the failure; the draft stays for another try.
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <form
      className="flex w-full flex-col gap-4 rounded-2xl bg-token-foreground/5 px-3 py-2.5"
      onSubmit={(event) => {
        void submit(event);
      }}
    >
      <textarea
        aria-label={footerText("Edit message")}
        className="w-full resize-none bg-transparent p-0 font-content text-size-chat leading-5 text-token-foreground outline-none placeholder:text-token-description-foreground"
        placeholder={footerText("Edit message")}
        rows={EDIT_MESSAGE_MIN_ROWS}
        value={draft}
        onChange={(event) => {
          resizeEditMessageTextarea(event.currentTarget);
          onDraftChange(event.currentTarget.value);
        }}
        // Programmatic value writes such as dictation bypass React's change tracking.
        onInput={(event) => {
          resizeEditMessageTextarea(event.currentTarget);
          onDraftChange(event.currentTarget.value);
        }}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            onCancel();
            return;
          }
          const intent = resolveComposerSubmitIntentFromKeyDown({
            enterBehavior,
            hasMultilinePrompt: draft.includes("\n"),
            isThreadRunning: false,
            primarySubmitAction: "send",
            alternateSubmitAction: null,
            key: event.key,
            ctrlKey: event.ctrlKey,
            metaKey: event.metaKey,
            shiftKey: event.shiftKey,
            altKey: event.altKey,
          });
          if (!intent) return;
          event.preventDefault();
          event.currentTarget.form?.requestSubmit();
        }}
        ref={focusEditMessageTextareaOnMount}
      />
      <div className="flex justify-end gap-1.5">
        <button
          type="button"
          disabled={isSubmitting}
          className="border-token-border user-select-none no-drag cursor-interaction flex items-center gap-1 border focus:outline-none disabled:cursor-not-allowed disabled:opacity-40 rounded-lg border-token-border text-token-button-tertiary-foreground bg-token-bg-fog enabled:hover:bg-token-list-hover-background data-[state=open]:bg-token-list-hover-background border h-token-button-composer px-2 py-0 text-base leading-[18px]"
          onClick={onCancel}
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={!canSubmit}
          aria-busy={isSubmitting}
          className="border-token-border user-select-none no-drag cursor-interaction flex items-center gap-1 border focus:outline-none disabled:cursor-not-allowed disabled:opacity-40 rounded-lg bg-token-foreground enabled:hover:bg-token-foreground/80 data-[state=open]:bg-token-foreground/80 text-token-dropdown-background h-token-button-composer px-2 py-0 text-base leading-[18px]"
        >
          Send
        </button>
      </div>
    </form>
  );
}

/** Attribute messages sent by another source and input delivered from the queue. */
function UserMessageDeliveryMarkers({
  entry,
  onOpenThread,
}: {
  entry: ThreadLeafBlockProps["block"]["entry"];
  onOpenThread?: ThreadLeafBlockProps["onOpenThread"];
}) {
  const origin = entry.userMessageOrigin;
  const queued = entry.userInputIntent === "queued";
  if (!origin && !queued) return null;
  const senderThreadId = origin?.kind === "agent" ? origin.senderThreadId : null;
  const originLabel =
    origin?.kind === "agent"
      ? "Sent by another agent"
      : origin?.kind === "automation"
        ? "Sent by automation"
        : origin?.kind === "nodex"
          ? "Sent by Nodex"
          : null;
  return (
    <div
      className="me-1 flex items-center justify-end gap-2 text-xs text-token-text-tertiary"
      data-user-message-origin={origin?.kind}
      data-user-message-intent={entry.userInputIntent}
    >
      {originLabel ? (
        senderThreadId && onOpenThread ? (
          <button
            type="button"
            aria-label="Open sending conversation"
            className="cursor-interaction rounded-sm hover:text-token-foreground hover:underline focus-visible:outline-2 focus-visible:outline-offset-2"
            onClick={() => void onOpenThread(senderThreadId)}
          >
            {originLabel}
          </button>
        ) : (
          <span>{originLabel}</span>
        )
      ) : null}
      {queued ? (
        <NodexTooltip tooltipContent="Queued behind the active turn">
          <span>Queued</span>
        </NodexTooltip>
      ) : null}
    </div>
  );
}

export function UserMessageBubble({
  block,
  isSearchMatch = false,
  isActiveSearchMatch = false,
  onEditUserTurn,
  onOpenThread,
  projectWorkspacePath,
  threadCwd,
  compactUserMessageActions = false,
  hideUserMessageActions = false,
  alwaysShowUserMessageActions = false,
}: ThreadLeafBlockProps) {
  const content = block.entry.markdownText ?? "";
  const userActions = block.userMessageActions;
  const canEdit = userActions?.canEdit ?? false;
  const isNotSent = block.entry.deliveryStatus === "not-sent";
  const deliveryLabel =
    block.entry.deliveryStatus === "unknown"
      ? "Delivery unconfirmed"
      : block.entry.deliveryStatus === "pending"
        ? "Sending"
        : null;
  // Launch failures never ran a submit hook and must not point users at hook settings.
  const isHookBlocked = isNotSent && block.entry.status !== "failed";
  const isGoalMessage = block.entry.goal === true;
  const isHookFeedback = block.entry.hookFeedback === true;
  const hookSettingsNavigation = useHookFeedbackSettingsNavigation();
  const hookSources = isNotSent
    ? userActions?.hookStats?.blockedSources
    : block.hookFeedbackSources;
  const hookFeedbackSettingsTarget = resolveHookFeedbackSettingsTarget({
    hostId: hookSettingsNavigation?.hostId ?? DEFAULT_CODEX_HOST_ID,
    cwd: threadCwd,
    sources: hookSources,
  });
  const hookFeedbackSettingsHref = buildHookFeedbackSettingsHref({
    hostId: hookFeedbackSettingsTarget.hostId,
    cwd: threadCwd,
    sources: hookSources,
  });
  const hasMessageContent = content.trim().length > 0;
  const shouldRenderFooter =
    deliveryLabel !== null ||
    isNotSent ||
    isGoalMessage ||
    isHookFeedback ||
    ((hasMessageContent || canEdit) && !compactUserMessageActions && !hideUserMessageActions);
  const [editDraft, setEditDraft] = useLocalConversationUserTurnEditDraft(
    block.entry.threadId,
    block.turnId,
  );
  // A draft outlives a moment when the message cannot be edited, such as a Turn running.
  const isEditing = canEdit && editDraft !== null;
  const clientUserMessageId =
    block.entry.rawItem && typeof block.entry.rawItem === "object"
      ? ((block.entry.rawItem as { readonly clientId?: unknown }).clientId ?? null)
      : null;
  // The opening prompt can reuse its render identity for a different native input.
  // Leave unknown prefixes ineligible rather than anchoring their changing search ordinal.
  const userMessageAnchorIdentity =
    typeof clientUserMessageId === "string"
      ? ["client", clientUserMessageId]
      : block.entry.rawItemId
        ? ["native", block.entry.rawItemId]
        : null;

  const submitEdit = useCallback(
    async (message: string) => {
      if (!onEditUserTurn || block.turnId === null) return;
      await onEditUserTurn({ threadId: block.entry.threadId, turnId: block.turnId, message });
      setEditDraft(null);
    },
    [block.entry.threadId, block.turnId, onEditUserTurn, setEditDraft],
  );
  const messageBubble = hasMessageContent ? (
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
              <MessageText
                text={reply.answer}
                cwd={threadCwd}
                projectWorkspacePath={projectWorkspacePath}
              />
            </div>
          ))}
        </div>
      ) : (
        <MessageText text={content} cwd={threadCwd} projectWorkspacePath={projectWorkspacePath} />
      )}
    </div>
  ) : null;

  return (
    <div
      className={cn(
        "flex flex-col items-end gap-2",
        isSearchMatch && THREAD_VISUAL_TOKENS.searchUnitMatched,
        isActiveSearchMatch && THREAD_VISUAL_TOKENS.searchUnitActive,
      )}
      data-conversation-item-key={
        userMessageAnchorIdentity
          ? JSON.stringify([block.entry.threadId, block.turnId, ...userMessageAnchorIdentity])
          : ""
      }
      data-content-search-unit-key={block.searchUnitKey}
    >
      {block.entry.textSelections ? (
        <div className="flex gap-2">
          <ThreadTextSelectionAttachments context={block.entry.textSelections} />
        </div>
      ) : null}
      <UserAttachmentStrip
        attachments={block.entry.userAttachments ?? []}
        unavailableImages={block.entry.unavailableImages ?? []}
      />
      <div className="group flex w-full flex-col items-end justify-end gap-1">
        <UserMessageDeliveryMarkers entry={block.entry} onOpenThread={onOpenThread} />
        {isEditing ? (
          <UserMessageEditForm
            draft={editDraft}
            onDraftChange={setEditDraft}
            onCancel={() => setEditDraft(null)}
            onSubmit={submitEdit}
          />
        ) : compactUserMessageActions && hasMessageContent && !hideUserMessageActions ? (
          <div className="flex w-full items-center justify-end gap-1">
            <div
              className={cn(
                "opacity-0 group-focus-within:opacity-100 group-hover:opacity-100",
                alwaysShowUserMessageActions && "opacity-100",
              )}
            >
              <CopyMessageActionButton text={content} feedbackMs={USER_COPY_FEEDBACK_MS} />
            </div>
            {messageBubble}
          </div>
        ) : (
          messageBubble
        )}
        {shouldRenderFooter ? (
          <div className="flex flex-row-reverse items-center gap-1">
            {deliveryLabel ? (
              <span className="mr-1 text-xs text-token-description-foreground" role="status">
                {footerText(deliveryLabel)}
              </span>
            ) : null}
            {!isNotSent && isGoalMessage ? <UserMessageGoalStatus /> : null}
            {isNotSent && !isHookBlocked ? (
              <span className="mr-1 text-xs text-danger" role="status">
                {footerText("Not sent")}
              </span>
            ) : null}
            {isHookBlocked || (!isNotSent && !isGoalMessage && isHookFeedback) ? (
              <UserMessageHookStatus
                blocked={isHookBlocked}
                href={hookFeedbackSettingsHref}
                onOpen={
                  hookSettingsNavigation?.onOpenHooksSettings
                    ? () => hookSettingsNavigation.onOpenHooksSettings?.(hookFeedbackSettingsTarget)
                    : undefined
                }
              />
            ) : null}
            {isEditing ||
            (!hasMessageContent && !canEdit) ||
            compactUserMessageActions ||
            hideUserMessageActions ? null : (
              <ThreadMessageActionRow
                align="end"
                className={alwaysShowUserMessageActions ? "opacity-100" : undefined}
              >
                <MessageTimestamp sentAtMs={userActions?.sentAtMs ?? null} variant="user" />
                <div className="flex items-center gap-0.5">
                  {isNotSent && userActions?.hookStats ? (
                    <HookStatsIndicator stats={userActions.hookStats} />
                  ) : null}
                  {hasMessageContent ? (
                    <CopyMessageActionButton text={content} feedbackMs={USER_COPY_FEEDBACK_MS} />
                  ) : null}
                  {canEdit ? (
                    <ThreadActionIconButton
                      label={footerText("Edit message")}
                      tooltip={footerText("Edit")}
                      onClick={() => setEditDraft(content)}
                    >
                      <EditMessageIcon />
                    </ThreadActionIconButton>
                  ) : null}
                </div>
              </ThreadMessageActionRow>
            )}
          </div>
        ) : null}
        {isNotSent
          ? userActions?.hookStats?.blockedMessages.map((message, index) => (
              <div
                key={`${index}:${message}`}
                className="flex max-w-[77%] items-start gap-2 rounded-lg border border-[var(--color-text-warning)]/30 px-3 py-2 text-sm text-token-foreground"
              >
                <HooksIcon
                  aria-hidden
                  className="mt-0.5 icon-2xs shrink-0 text-[var(--color-text-warning)]"
                />
                <span className="min-w-0 break-words whitespace-pre-wrap">{message}</span>
              </div>
            ))
          : null}
      </div>
    </div>
  );
}

export function ThreadUserBubbleBlock(props: ThreadLeafBlockProps) {
  return <UserMessageBubble {...props} />;
}

/** A settled Thought standing on its own between replies and work. */
export function ThreadReasoningBlock({
  block: inputBlock,
  projectWorkspacePath,
  threadCwd,
}: ThreadLeafBlockProps) {
  const block = useCodexTranscriptBlock(inputBlock);
  return (
    <ThoughtDisclosure
      item={block.entry}
      cwd={threadCwd}
      projectWorkspacePath={projectWorkspacePath}
    />
  );
}

/** A Thought among the work of an expanded activity group. */
function ThreadThoughtRowBlock({
  block: inputBlock,
  projectWorkspacePath,
  threadCwd,
}: ThreadLeafBlockProps) {
  const block = useCodexTranscriptBlock(inputBlock);
  return (
    <ThoughtRow item={block.entry} cwd={threadCwd} projectWorkspacePath={projectWorkspacePath} />
  );
}

/** The streaming Thought of a thinking activity group, read as it is written. */
function ThreadThoughtLivePreview({
  block: inputBlock,
  active,
  projectWorkspacePath,
  threadCwd,
}: ThreadLeafBlockProps & { readonly active: boolean }) {
  const block = useCodexTranscriptBlock(inputBlock);
  return (
    <ThoughtLivePreview
      item={block.entry}
      active={active}
      cwd={threadCwd}
      projectWorkspacePath={projectWorkspacePath}
    />
  );
}

export function ThreadPlanCardBlock({
  block: inputBlock,
  isLatestTurn,
  isStreamingTurn,
  projectWorkspacePath,
  threadCwd,
  onOpenPlanInSidePanel,
  onClosePlanSidePanel,
  planSidePanelState,
}: ThreadLeafBlockProps) {
  const block = useCodexTranscriptBlock(inputBlock);
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

export function ThreadAssistantBodyBlock({
  block: inputBlock,
  hostId,
  isLatestTurn,
  isStreamingTurn,
  isSearchMatch = false,
  isActiveSearchMatch = false,
  projectWorkspacePath,
  projectlessOutputDirectory,
  threadCwd,
  onForkFromTurn,
  onOpenThread,
  assistantAfter,
  alwaysShowAssistantMessageActions = false,
}: ThreadLeafBlockProps) {
  const block = useCodexTranscriptBlock(inputBlock);
  const entityKey = useContext(CodexTranscriptTurnEntityContext);
  const markdownText = block.entry.markdownText ?? "";
  const isAssistantItemStreaming = isStreamingTurn && block.entry.status === "inProgress";
  const aeon = useCreatedThreadSourceAeon(hostId ?? null, block.entry.threadId);
  const createdThreads = readAssistantCreatedThreadResults({
    source: markdownText,
    completed: block.entry.status === "completed",
    aeon,
  });
  const visualizationContext = useConversationVisualizationContext(
    block.entry.threadId,
    block.turnId,
    isAssistantItemStreaming,
  );
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
      data-message-copy-root={JSON.stringify([
        block.entry.threadId,
        block.turnId,
        block.entry.itemId,
      ])}
      data-conversation-item-key={JSON.stringify([
        block.entry.threadId,
        block.turnId,
        block.entry.itemId,
      ])}
      data-content-search-unit-key={block.searchUnitKey}
    >
      <div className="group flex min-w-0 flex-col">
        <div
          className={THREAD_VISUAL_TOKENS.assistantBody}
          data-thread-selected-text-target="true"
          data-response-annotation-target={block.entry.rawItemId ?? block.entry.itemId}
          data-response-annotation-thread={block.entry.threadId}
        >
          <ResponseAnnotationContext
            value={block.entry.textSelections?.responseTextAnnotations ?? []}
          >
            <ImportedMarkdownImagesProvider images={block.entry.importedImages}>
              <MarkdownRenderer
                content={markdownText}
                dialect="conversation"
                nativeSource={
                  entityKey
                    ? {
                        kind: "item",
                        entityKey,
                        itemId: block.entry.rawItemId ?? block.entry.itemId,
                      }
                    : undefined
                }
                preserveLineBreaks
                parseIncompleteMarkdown={isAssistantItemStreaming}
                animateStreamingText={isAssistantItemStreaming}
                adaptiveBuffering={{
                  streamId: `${block.entry.threadId}:${block.searchUnitKey ?? block.entry.rawItemId ?? block.entry.itemId}`,
                  // Commentary stays unbuffered; a reply whose phase settles keeps its renderer.
                  enabled: block.entry.assistantPhase !== "commentary",
                }}
                cwd={threadCwd}
                projectWorkspacePath={projectWorkspacePath}
                visualizationContext={visualizationContext}
              />
            </ImportedMarkdownImagesProvider>
          </ResponseAnnotationContext>
        </div>
        {createdThreads.length > 0 ? (
          <div className="mt-3">
            <LocalConversationCreatedThreadCards
              sourceRoot={hostId ? { hostId, threadId: block.entry.threadId } : undefined}
              results={createdThreads}
              onOpenThread={onOpenThread}
            />
          </div>
        ) : null}
        {assistantAfter ? <div className="mt-3">{assistantAfter}</div> : null}
        {assistantActions ? (
          <AssistantMessageActionsRow
            actions={assistantActions}
            copySource={block.entry}
            cwd={threadCwd}
            projectlessOutputDirectory={projectlessOutputDirectory}
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
  threadCwd,
  projectlessOutputDirectory,
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
    <div
      className="group flex min-w-0 flex-col"
      data-assistant-actions-anchor={block.entry.itemId}
      data-message-copy-source={JSON.stringify([
        block.entry.threadId,
        block.turnId,
        block.entry.itemId,
      ])}
    >
      <AssistantMessageActionsRow
        actions={block.actions}
        copySource={block.entry}
        cwd={threadCwd}
        projectlessOutputDirectory={projectlessOutputDirectory}
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
  return (
    <ImageViewSurface
      imagePaths={block.imageViewPaths ?? []}
      unavailableImages={block.unavailableImages ?? []}
    />
  );
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

export function ThreadContextCompactionBlock({ block }: ThreadLeafBlockProps) {
  const compaction = block.entry.contextCompaction;
  if (block.type !== "contextCompaction" || !compaction) return null;

  return <ContextCompactionSurface compaction={compaction} />;
}

export function ThreadRecoveryBlock({
  block,
  isLatestTurn,
  isStreamingTurn,
}: ThreadLeafBlockProps) {
  const { onContinueAfterFailure, onManageFailedProvider, continuationState } =
    useConversationRecoveryActions();
  const turnId = block.turnId;
  return (
    <ConversationRecoverySurface
      entry={block.entry}
      isLatestTurn={isLatestTurn}
      isStreamingTurn={isStreamingTurn}
      onManageProvider={
        onManageFailedProvider && turnId ? () => onManageFailedProvider(turnId) : undefined
      }
      continuationState={continuationState?.turnId === turnId ? continuationState : undefined}
      onContinue={
        onContinueAfterFailure && turnId ? () => onContinueAfterFailure(turnId) : undefined
      }
    />
  );
}

export function ThreadForkedFromConversationBlock({ block }: ThreadLeafBlockProps) {
  if (block.type !== "forkedFromConversation") return null;

  const sourceTitle = asRecord(block.entry.rawItem)?.sourceConversationTitle;
  const sourceLabel = typeof sourceTitle === "string" ? sourceTitle.trim() : "";

  return (
    <TranscriptDivider>
      <ForkIcon className="icon-2xs shrink-0" />
      <span className="truncate">Forked from {sourceLabel || "another chat"}</span>
    </TranscriptDivider>
  );
}

export function ThreadSystemBannerBlock({ block }: ThreadLeafBlockProps) {
  const item = block.entry;
  const label = humanizeBlockType(block.type);

  if (item.markdownText) {
    return (
      <div className="flex flex-col gap-1.5">
        <div className="font-sans text-xs font-medium tracking-wide text-token-description-foreground uppercase">
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
      <div className="font-sans text-xs font-medium tracking-wide text-token-description-foreground uppercase">
        {label}
      </div>
      <div>
        <JsonBlock value={item.rawItem} />
      </div>
    </div>
  );
}
