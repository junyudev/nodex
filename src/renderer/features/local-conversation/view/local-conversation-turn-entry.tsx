import { useCodexConversationValue } from "../local-conversation-store";
import { memo, useMemo } from "react";
import type { CodexConversationChildMembership } from "../../../lib/types";
import type { ReviewOpenIntent } from "@/features/review/model/review-view-state";
import { selectTurnRenderModel } from "../projection/build-turn-render-model";
import {
  isNormalizedConversationTurnEntry,
  type ConversationTurnListEntry,
  type VisibleConversationTurnEntry,
} from "../selectors";
import {
  CodexTranscriptTurnEntityContext,
  CodexTranscriptTurnStatusContext,
  useCodexTranscriptTurn,
} from "../normalized-transcript-hooks";
import { isCodexTimelineTurnEntry } from "../projection/normalized-timeline-entries";
import { LocalConversationTimelinePromotion } from "./local-conversation-timeline-promotion";
import { LocalConversationTimelineImage } from "./local-conversation-timeline-image";
import type {
  ThreadComposerShellBackgroundAgentRowModel,
  ThreadPlanSidePanelState,
  ThreadStageActions,
} from "../thread-stage-types";
import { ThreadTurn } from "./local-conversation-thread-turn";
import { LocalConversationAboveComposerPortal } from "./local-conversation-above-composer-portal";
import { useMcpServerStatuses } from "../../../lib/use-mcp-queries";
import { useCodexMcpApps } from "../use-codex-mcp-apps";
import { ThreadTimestampSeparator } from "./shared/thread-timestamp-separator";
import { useTurnEndResources } from "../use-turn-end-resources";
import { LocalConversationEndResources } from "./local-conversation-end-resources";

interface LocalConversationTurnEntryProps {
  conversationId: string;
  childMemberships?: readonly CodexConversationChildMembership[];
  parentModel?: string | null;
  backgroundAgentRows?: readonly ThreadComposerShellBackgroundAgentRowModel[];
  entry: ConversationTurnListEntry;
  cwd: string | null;
  persistedCollapsed?: boolean;
  onSetCollapsed?: (collapsed: boolean) => void;
  canEditTurnUserPrefix: boolean;
  canForkTurn: boolean;
  projectWorkspacePath?: string | null;
  projectlessOutputDirectory?: string | null;
  threadCwd?: string | null;
  onEditLastTurnMessage?: (input: {
    threadId: string;
    turnId: string;
    message: string;
  }) => void | Promise<void>;
  onForkTurnMessage?: (input: {
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
  turnDiffHoverPreviewDisabled?: boolean;
  onRendered?: (turnId: string) => void;
  latestTurnFollowContentRef?: (element: HTMLDivElement | null) => void;
}

function LocalConversationTurnEntryComponent({
  conversationId,
  childMemberships,
  parentModel,
  backgroundAgentRows,
  entry,
  persistedCollapsed,
  onSetCollapsed,
  canEditTurnUserPrefix,
  canForkTurn,
  projectWorkspacePath,
  projectlessOutputDirectory,
  threadCwd,
  onEditLastTurnMessage,
  onForkTurnMessage,
  onOpenTurnDiffReview,
  onOpenTurnDiffFileInSidePanel,
  onOpenSideChat,
  onOpenThread,
  onOpenSummaryScheduledAutomation,
  onOpenMcpAppSidePanel,
  onOpenPlanInSidePanel,
  onClosePlanSidePanel,
  planSidePanelState,
  turnDiffHoverPreviewDisabled = false,
  onRendered,
  latestTurnFollowContentRef,
}: LocalConversationTurnEntryProps) {
  const entityKey = isNormalizedConversationTurnEntry(entry) ? entry.historyEntityKey : null;
  const turn = useCodexTranscriptTurn(
    entityKey,
    isNormalizedConversationTurnEntry(entry) ? null : entry.turn,
    isCodexTimelineTurnEntry(entry) ? entry.timelineSlice : undefined,
  );
  const materializedEntry = useMemo<VisibleConversationTurnEntry | null>(
    () => (turn ? { ...entry, turn } : null),
    [entry, turn],
  );
  const isTimelineEntry = isCodexTimelineTurnEntry(entry);
  const allowUserActions = !isTimelineEntry || entry.timelineUserActions;
  const includeTurnExtras = !isTimelineEntry || entry.timelineSlice.includeTurnExtras;
  const resourceTurn = useCodexTranscriptTurn(
    isTimelineEntry && includeTurnExtras ? entityKey : null,
    turn,
  );
  const goalTimeUsedSeconds = useCodexConversationValue(conversationId, (conversation) =>
    includeTurnExtras &&
    conversation?.canonicalState?.completedThreadGoalTurnId === entry.turnId &&
    entry.turnId != null
      ? conversation.completedThreadGoal?.timeUsedSeconds
      : undefined,
  );
  const hostId = useCodexConversationValue(
    conversationId,
    (conversation) => conversation?.canonicalState?.hostId ?? "local",
  );
  const { resources, endResourcePaths } = useTurnEndResources({
    turn: resourceTurn,
    hostId,
    cwd: threadCwd,
    projectlessOutputDirectory,
    includeResources: includeTurnExtras,
  });
  onRendered?.(entry.turnKey);
  const { data: mcpApps } = useCodexMcpApps();
  const { data: mcpServerStatuses } = useMcpServerStatuses();
  const turnModel = useMemo(
    () =>
      materializedEntry
        ? selectTurnRenderModel({
            entry: materializedEntry,
            goalTimeUsedSeconds,
            hostId,
            canEditTurnUserPrefix: allowUserActions && canEditTurnUserPrefix,
            canForkTurn: allowUserActions && canForkTurn,
            canOpenSubagents: Boolean(onOpenThread),
            backgroundAgents: backgroundAgentRows,
            cwd: threadCwd,
            projectlessOutputDirectory,
            mcpApps: mcpApps ?? [],
            mcpServerStatuses: mcpServerStatuses ?? null,
            endResourcePaths,
            workSegment: isTimelineEntry ? entry.timelineSlice.work : undefined,
          })
        : null,
    [
      goalTimeUsedSeconds,
      hostId,
      allowUserActions,
      canEditTurnUserPrefix,
      canForkTurn,
      onOpenThread,
      backgroundAgentRows,
      materializedEntry,
      mcpApps,
      mcpServerStatuses,
      projectlessOutputDirectory,
      threadCwd,
      endResourcePaths,
      isTimelineEntry,
      entry,
    ],
  );

  if (!turn || !turnModel) return null;
  return (
    <CodexTranscriptTurnEntityContext.Provider value={entityKey}>
      <CodexTranscriptTurnStatusContext.Provider
        value={isCodexTimelineTurnEntry(entry) ? entry.timelineSlice.presentationStatus : undefined}
      >
        <LocalConversationAboveComposerPortal
          blocks={turnModel.aboveComposerBlocks ?? []}
          conversationId={conversationId}
          isLatestTurn={entry.isMostRecentTurn}
          isStreamingTurn={turn.status === "inProgress"}
          projectWorkspacePath={projectWorkspacePath}
          projectlessOutputDirectory={projectlessOutputDirectory}
          threadCwd={threadCwd}
          onOpenTurnDiffReview={onOpenTurnDiffReview}
          onOpenTurnDiffFileInSidePanel={onOpenTurnDiffFileInSidePanel}
          onOpenSideChat={onOpenSideChat}
          onOpenThread={onOpenThread}
          onOpenSummaryScheduledAutomation={onOpenSummaryScheduledAutomation}
          onOpenMcpAppSidePanel={onOpenMcpAppSidePanel}
          onOpenPlanInSidePanel={onOpenPlanInSidePanel}
          onClosePlanSidePanel={onClosePlanSidePanel}
          planSidePanelState={planSidePanelState}
          turnDiffHoverPreviewDisabled={turnDiffHoverPreviewDisabled}
        />
        {entry.timestampSeparatorAtMs == null ? null : (
          <ThreadTimestampSeparator sentAtMs={entry.timestampSeparatorAtMs} />
        )}
        <div
          data-content-search-turn-key={entry.turnSearchKey}
          data-virtualized-turn-content="true"
        >
          <ThreadTurn
            turn={turnModel}
            endResources={isTimelineEntry ? undefined : resources}
            hostId={hostId}
            mcpApps={mcpApps ?? []}
            agentBodyCollapsed={persistedCollapsed ?? turnModel.defaultAgentBodyCollapsed}
            onAgentBodyCollapsedChange={(turnKey, collapsed) => {
              if (turnKey !== entry.turnKey) return;
              onSetCollapsed?.(collapsed);
            }}
            projectWorkspacePath={projectWorkspacePath}
            projectlessOutputDirectory={projectlessOutputDirectory}
            childMemberships={childMemberships}
            parentModel={parentModel}
            threadCwd={threadCwd}
            onEditLastUserTurn={onEditLastTurnMessage}
            onForkFromTurn={onForkTurnMessage}
            onOpenTurnDiffReview={onOpenTurnDiffReview}
            onOpenTurnDiffFileInSidePanel={onOpenTurnDiffFileInSidePanel}
            onOpenSideChat={onOpenSideChat}
            onOpenThread={onOpenThread}
            onOpenSummaryScheduledAutomation={onOpenSummaryScheduledAutomation}
            onOpenMcpAppSidePanel={onOpenMcpAppSidePanel}
            onOpenPlanInSidePanel={onOpenPlanInSidePanel}
            onClosePlanSidePanel={onClosePlanSidePanel}
            planSidePanelState={planSidePanelState}
            turnDiffHoverPreviewDisabled={turnDiffHoverPreviewDisabled}
            latestTurnFollowContentRef={latestTurnFollowContentRef}
          />
        </div>
      </CodexTranscriptTurnStatusContext.Provider>
    </CodexTranscriptTurnEntityContext.Provider>
  );
}

/** Inline presentations subscribe to their native item before any Turn materialization. */
function LocalConversationEndResourcesEntry(props: LocalConversationTurnEntryProps) {
  const { entry } = props;
  const turn = useCodexTranscriptTurn(
    isNormalizedConversationTurnEntry(entry) ? entry.historyEntityKey : null,
    isNormalizedConversationTurnEntry(entry) ? null : entry.turn,
  );
  const hostId = useCodexConversationValue(
    props.conversationId,
    (conversation) => conversation?.canonicalState?.hostId ?? "local",
  );
  const { resources } = useTurnEndResources({
    turn,
    hostId,
    cwd: props.threadCwd,
    projectlessOutputDirectory: props.projectlessOutputDirectory,
    includeResources: true,
  });
  props.onRendered?.(entry.turnKey);
  return (
    <div data-content-search-skip="true" data-virtualized-turn-content="true">
      <LocalConversationEndResources
        resources={resources}
        hostId={hostId}
        cwd={props.threadCwd}
        workspaceRoot={props.projectlessOutputDirectory}
      />
    </div>
  );
}

function LocalConversationTurnEntrySurface(props: LocalConversationTurnEntryProps) {
  const { entry } = props;
  if (isCodexTimelineTurnEntry(entry) && entry.timelineEndResources)
    return <LocalConversationEndResourcesEntry {...props} />;
  if (isCodexTimelineTurnEntry(entry) && entry.timelineWholeItem?.type === "generatedImage") {
    props.onRendered?.(entry.turnKey);
    return <LocalConversationTimelineImage entry={entry} />;
  }
  if (
    isCodexTimelineTurnEntry(entry) &&
    entry.timelinePresentation &&
    entry.timelinePresentation.type !== "wholeItem"
  ) {
    props.onRendered?.(entry.turnKey);
    return <LocalConversationTimelinePromotion entry={entry} cwd={props.threadCwd ?? props.cwd} />;
  }
  return <LocalConversationTurnEntryComponent {...props} />;
}

export const LocalConversationTurnEntry = memo(
  LocalConversationTurnEntrySurface,
  (left, right) =>
    left.conversationId === right.conversationId &&
    left.childMemberships === right.childMemberships &&
    left.parentModel === right.parentModel &&
    left.backgroundAgentRows === right.backgroundAgentRows &&
    (isNormalizedConversationTurnEntry(left.entry)
      ? left.entry === right.entry
      : !isNormalizedConversationTurnEntry(right.entry) && left.entry.turn === right.entry.turn) &&
    left.entry.requests === right.entry.requests &&
    left.entry.turnKey === right.entry.turnKey &&
    left.entry.turnSearchKey === right.entry.turnSearchKey &&
    left.entry.timestampSeparatorAtMs === right.entry.timestampSeparatorAtMs &&
    left.entry.isMostRecentTurn === right.entry.isMostRecentTurn &&
    left.cwd === right.cwd &&
    left.persistedCollapsed === right.persistedCollapsed &&
    left.onSetCollapsed === right.onSetCollapsed &&
    left.canEditTurnUserPrefix === right.canEditTurnUserPrefix &&
    left.canForkTurn === right.canForkTurn &&
    left.projectWorkspacePath === right.projectWorkspacePath &&
    left.projectlessOutputDirectory === right.projectlessOutputDirectory &&
    left.threadCwd === right.threadCwd &&
    left.onEditLastTurnMessage === right.onEditLastTurnMessage &&
    left.onForkTurnMessage === right.onForkTurnMessage &&
    left.onOpenTurnDiffReview === right.onOpenTurnDiffReview &&
    left.onOpenTurnDiffFileInSidePanel === right.onOpenTurnDiffFileInSidePanel &&
    left.onOpenSideChat === right.onOpenSideChat &&
    left.onOpenThread === right.onOpenThread &&
    left.onOpenMcpAppSidePanel === right.onOpenMcpAppSidePanel &&
    left.onOpenPlanInSidePanel === right.onOpenPlanInSidePanel &&
    left.onClosePlanSidePanel === right.onClosePlanSidePanel &&
    left.planSidePanelState === right.planSidePanelState &&
    left.turnDiffHoverPreviewDisabled === right.turnDiffHoverPreviewDisabled &&
    left.onRendered === right.onRendered &&
    left.latestTurnFollowContentRef === right.latestTurnFollowContentRef,
);
