import { AnimatePresence, motion } from "motion/react";
import { Fragment, useLayoutEffect, useRef, type ReactNode, type RefCallback } from "react";
import { AutomaticApprovalReviewIcon, ChevronRightIcon } from "@/components/shared/icons";
import { NodexTooltip } from "@/components/ui/tooltip";
import { useResolvedReducedMotion } from "@/lib/use-reduced-motion";
import type { CodexConversationChildMembership, ProtocolAppInfo } from "../../../lib/types";
import type { ReviewOpenIntent } from "@/features/review/model/review-view-state";
import { cn } from "../../../lib/utils";
import type {
  ThreadAgentRenderUnit,
  ThreadBlockModel,
  ThreadPlanSidePanelState,
  ThreadStageActions,
  ThreadTurnModel,
} from "../thread-stage-types";
import { resolveCodexThreadAgentBodyMotion } from "./shared/thread-motion";
import { useWorkedForLabelText } from "./shared/use-worked-for-label";
import { CodexShimmerText } from "./shared/codex-shimmer-text";
import { ThreadBlockRenderer } from "./blocks/local-conversation-block-renderer";
import { ThreadMcpAppsProvider } from "./shared/tools/mcp-apps-context";
import {
  isDeniedAgentBodyUnit,
  projectAgentBodyCollapsePresentation,
} from "../projection/agent-body-collapse-presentation";
import { CodexFirstResponseVisibilityMarker } from "../codex-turn-first-response-view";
import { CodexTranscriptReasoningSummary } from "../normalized-transcript-hooks";
import { LocalConversationEndResources } from "./local-conversation-end-resources";
import type { ThreadSummaryPanelOutputRow } from "../projection/thread-summary-panel-output-model";

const EMPTY_END_RESOURCES: readonly ThreadSummaryPanelOutputRow[] = [];

const EMPTY_THREAD_LIVE_ACTIVITY: ThreadTurnModel["liveActivity"] = {
  global: {
    state: { type: "none" },
    reason: "turn-settled",
  },
  mainSlice: {
    kind: "main",
    state: { kind: "closed", reason: "turn-settled" },
    latestVisibleUnit: null,
  },
  fallback: {
    owner: "none",
    reason: "global-state-suppressed",
    message: null,
    isVisible: false,
  },
  reasoningSummary: null,
};

function normalizeThreadLiveActivity(turn: ThreadTurnModel): ThreadTurnModel {
  if (turn.liveActivity) return turn;
  return {
    ...turn,
    liveActivity: EMPTY_THREAD_LIVE_ACTIVITY,
  };
}

interface ThreadTurnProps {
  hostId?: string;
  endResources?: readonly ThreadSummaryPanelOutputRow[];
  turn: ThreadTurnModel;
  mcpApps?: readonly ProtocolAppInfo[];
  agentBodyCollapsed: boolean;
  onAgentBodyCollapsedChange: (turnId: string, collapsed: boolean) => void;
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
  turnDiffHoverPreviewDisabled?: boolean;
  latestTurnFollowContentRef?: RefCallback<HTMLDivElement>;
}

function ThreadGap() {
  return (
    <div
      aria-hidden="true"
      className="w-full"
      style={{ height: "var(--conversation-tool-assistant-gap, 8px)" }}
    />
  );
}

function AgentBodyToggleRow({
  collapsedMessageCount,
  deniedActionCount,
  workedForLabel,
  collapsed,
  onToggle,
}: {
  collapsedMessageCount: number;
  deniedActionCount: number;
  workedForLabel: string | null;
  collapsed: boolean;
  onToggle: (revealDeniedAction: boolean) => void;
}) {
  const label =
    workedForLabel ??
    `${collapsedMessageCount} previous ${collapsedMessageCount === 1 ? "message" : "messages"}`;

  return (
    <div className="flex flex-col">
      <div className="flex items-center gap-2 text-size-chat text-token-text-secondary">
        <button
          type="button"
          className="text-size-chat inline-flex max-w-full items-center gap-1 rounded-md border border-transparent text-left focus-visible:ring-2 focus-visible:ring-token-focus-border focus-visible:outline-none"
          aria-expanded={!collapsed}
          data-agent-body-toggle="true"
          onClick={() => onToggle(false)}
        >
          <span>
            <span className="text-token-foreground/60">{label}</span>
          </span>
          <ChevronRightIcon
            className={cn(
              "icon-2xs text-token-foreground/40 transition-transform duration-basic",
              collapsed ? "rotate-0" : "rotate-90",
            )}
          />
        </button>
        {deniedActionCount > 0 ? (
          <NodexTooltip tooltipContent="View denied actions">
            <button
              type="button"
              aria-label={`View ${deniedActionCount} denied ${deniedActionCount === 1 ? "action" : "actions"}`}
              className="ms-auto inline-flex shrink-0 items-center gap-1 rounded-md border border-transparent text-token-text-secondary focus-visible:ring-2 focus-visible:ring-token-focus-border focus-visible:outline-none"
              data-denied-action-count="true"
              onClick={() => onToggle(true)}
            >
              <AutomaticApprovalReviewIcon aria-hidden className="icon-xs" />
              {deniedActionCount} denied {deniedActionCount === 1 ? "action" : "actions"}
            </button>
          </NodexTooltip>
        ) : null}
      </div>
      <div className="text-size-chat pt-1 text-token-text-secondary">
        <div className="w-full border-t border-token-border-light" />
      </div>
    </div>
  );
}

function renderSpacedBlocks<TBlock extends { id: string }>(
  blocks: TBlock[],
  renderBlock: (block: TBlock, index: number) => ReactNode,
) {
  return blocks.map((block, index) => (
    <Fragment key={resolveThreadBlockRenderKey(block)}>
      {index > 0 ? <ThreadGap /> : null}
      {renderBlock(block, index)}
    </Fragment>
  ));
}

/** One agent-body unit's target frame; its leading gap disappears with a unit that renders nothing. */
function AgentBodyUnitFrame({
  unit,
  leadingGap,
  animateGap,
  followContentRef,
  children,
}: {
  unit: ThreadAgentRenderUnit;
  leadingGap: "toggle" | "item" | null;
  animateGap: boolean;
  followContentRef?: RefCallback<HTMLDivElement>;
  children: ReactNode;
}) {
  const hasTargets = unit.targetAttributes !== undefined;
  return (
    <div
      ref={followContentRef}
      className={cn(
        "empty:hidden",
        hasTargets && "outline-none",
        leadingGap === "toggle" && "mt-[var(--conversation-tool-assistant-gap,8px)]",
        leadingGap === "item" && "mt-[var(--conversation-item-gap,16px)]",
        animateGap && "transition-[margin] duration-basic",
      )}
      tabIndex={hasTargets ? -1 : undefined}
      {...unit.targetAttributes}
      data-auto-review-denied={isDeniedAgentBodyUnit(unit) || undefined}
    >
      {children}
    </div>
  );
}

function ThreadLiveActivityFallbackForTurn({ turn }: { turn: ThreadTurnModel }) {
  if (turn.liveActivity.fallback.owner !== "standalone") return null;
  const reasoning = turn.turn?.items.findLast(
    (item) => item.kind === "reasoning" || item.semanticKind === "reasoning",
  );
  return (
    <ThreadLiveActivityFallback
      message={
        <CodexTranscriptReasoningSummary
          item={
            reasoning
              ? {
                  id: reasoning.itemId,
                  turnId: reasoning.turnId,
                  createdAt: reasoning.createdAt,
                  updatedAt: reasoning.updatedAt,
                  searchableText: "",
                  type: "reasoning",
                  entry: reasoning,
                }
              : null
          }
          fallback={turn.liveActivity.fallback.message}
        />
      }
    />
  );
}

export function resolveThreadBlockRenderKey(block: { id: string; renderKey?: unknown }): string {
  const renderKey = (block as { renderKey?: unknown }).renderKey;
  return typeof renderKey === "string" && renderKey.length > 0 ? renderKey : block.id;
}

function ThreadTurnBody({
  hostId = "local",
  endResources = EMPTY_END_RESOURCES,
  agentBodyUnits,
  turn,
  agentBodyCollapsed,
  onAgentBodyCollapsedChange,
  projectWorkspacePath,
  projectlessOutputDirectory,
  threadCwd,
  onEditUserTurn,
  onForkFromTurn,
  onOpenTurnDiffReview,
  onOpenTurnDiffFileInSidePanel,
  onOpenSideChat,
  onOpenThread,
  onOpenSubagentsPanel,
  onOpenSummaryScheduledAutomation,
  onOpenMcpAppSidePanel,
  onOpenPlanInSidePanel,
  onClosePlanSidePanel,
  planSidePanelState,
  childMemberships,
  parentModel,
  turnDiffHoverPreviewDisabled = false,
  latestTurnFollowContentRef,
}: ThreadTurnProps & { agentBodyUnits: ThreadAgentRenderUnit[] }) {
  const agentBodyCollapsePresentation = projectAgentBodyCollapsePresentation(agentBodyUnits, {
    extractWorkedFor: turn.hasRenderableAgentBodyUnits,
    replyBlockId: turn.agentBodyReplyBlockId,
  });
  const shouldAllowAgentBodyCollapse =
    !turn.voiceWorkActivity &&
    turn.hasRenderableAgentBodyUnits &&
    agentBodyCollapsePresentation.canCollapse;
  const effectiveAgentBodyCollapsed = shouldAllowAgentBodyCollapse ? agentBodyCollapsed : false;
  const { bodyUnits } = agentBodyCollapsePresentation;
  const agentBodyRef = useRef<HTMLDivElement>(null);
  const pendingDeniedActionRef = useRef<{ turnKey: string; blockKey: string } | null>(null);
  const deniedActionFrameRef = useRef<number | null>(null);
  useLayoutEffect(() => {
    const turnKey = turn.turnKey;
    return () => {
      if (pendingDeniedActionRef.current?.turnKey !== turnKey) return;
      pendingDeniedActionRef.current = null;
      if (deniedActionFrameRef.current !== null) cancelAnimationFrame(deniedActionFrameRef.current);
    };
  }, [turn.turnKey]);
  const firstVisibleBodyUnitIndex = effectiveAgentBodyCollapsed
    ? bodyUnits.findIndex(({ persistent }) => persistent)
    : 0;
  const latestFollowBodyUnit = bodyUnits.findLast(
    ({ unit, persistent }) =>
      (!effectiveAgentBodyCollapsed || persistent) && unit.block.type !== "userMessage",
  )?.unit;
  const reducedMotion = useResolvedReducedMotion();
  const agentBodyMotion = resolveCodexThreadAgentBodyMotion(reducedMotion);
  const toggleAgentBody = (revealDeniedAction: boolean) => {
    const target = revealDeniedAction
      ? bodyUnits.find(({ unit }) => isDeniedAgentBodyUnit(unit))?.unit
      : undefined;
    pendingDeniedActionRef.current = target
      ? { turnKey: turn.turnKey, blockKey: resolveThreadBlockRenderKey(target.block) }
      : null;
    if (deniedActionFrameRef.current !== null) {
      cancelAnimationFrame(deniedActionFrameRef.current);
      deniedActionFrameRef.current = null;
    }
    if (revealDeniedAction && !effectiveAgentBodyCollapsed) {
      if (target) revealDeniedActionAfterExpansion(target);
      return;
    }
    onAgentBodyCollapsedChange(
      turn.turnKey,
      revealDeniedAction ? false : !effectiveAgentBodyCollapsed,
    );
  };
  const revealDeniedActionAfterExpansion = (unit: ThreadAgentRenderUnit) => {
    const targetKey = resolveThreadBlockRenderKey(unit.block);
    const request = pendingDeniedActionRef.current;
    if (
      effectiveAgentBodyCollapsed ||
      request?.turnKey !== turn.turnKey ||
      request.blockKey !== targetKey ||
      deniedActionFrameRef.current !== null
    )
      return;
    deniedActionFrameRef.current = requestAnimationFrame(() => {
      deniedActionFrameRef.current = null;
      if (pendingDeniedActionRef.current !== request) return;
      pendingDeniedActionRef.current = null;
      agentBodyRef.current
        ?.querySelector<HTMLElement>("[data-auto-review-denied]")
        ?.scrollIntoView({ block: "center", behavior: reducedMotion ? "instant" : "smooth" });
    });
  };
  const workedForItem = turn.workedForItem ?? agentBodyCollapsePresentation.workedForItem;
  const workedForLabel = useWorkedForLabelText({
    timing: workedForItem
      ? {
          status: workedForItem.status,
          startedAtMs: workedForItem.startedAtMs,
          completedAtMs: workedForItem.completedAtMs,
        }
      : null,
    durationMs: turn.workedDurationMs,
  });
  const clientUserMessageId = turn.turn?.clientUserMessageId?.trim() || null;
  const firstResponseSection =
    agentBodyUnits.length > 0
      ? "agent"
      : turn.trailingBlocks.length > 0
        ? "trailing"
        : turn.liveActivity.fallback.owner === "standalone"
          ? "fallback"
          : null;
  const firstResponseMarker =
    clientUserMessageId === null ? null : (
      <CodexFirstResponseVisibilityMarker clientUserMessageId={clientUserMessageId} />
    );

  const renderBlock = (block: ThreadBlockModel) => (
    <div
      ref={block.type === "userMessage" ? undefined : latestTurnFollowContentRef}
      className="flex flex-col"
    >
      <ThreadBlockRenderer
        block={block}
        hostId={hostId}
        isLatestTurn={turn.isLatestTurn}
        isStreamingTurn={turn.isStreamingTurn}
        projectWorkspacePath={projectWorkspacePath}
        projectlessOutputDirectory={projectlessOutputDirectory}
        childMemberships={childMemberships}
        parentModel={parentModel}
        threadCwd={threadCwd}
        onEditUserTurn={onEditUserTurn}
        onForkFromTurn={onForkFromTurn}
        onOpenTurnDiffReview={onOpenTurnDiffReview}
        onOpenTurnDiffFileInSidePanel={onOpenTurnDiffFileInSidePanel}
        onOpenSideChat={onOpenSideChat}
        onOpenThread={onOpenThread}
        onOpenSubagentsPanel={onOpenSubagentsPanel}
        onOpenSummaryScheduledAutomation={onOpenSummaryScheduledAutomation}
        onOpenMcpAppSidePanel={onOpenMcpAppSidePanel}
        onOpenPlanInSidePanel={onOpenPlanInSidePanel}
        onClosePlanSidePanel={onClosePlanSidePanel}
        planSidePanelState={planSidePanelState}
        turnDiffHoverPreviewDisabled={turnDiffHoverPreviewDisabled}
      />
    </div>
  );

  const renderAgentUnit = (unit: ThreadAgentRenderUnit, compactUserMessageActions = false) => (
    <ThreadBlockRenderer
      block={unit.block}
      hostId={hostId}
      isLatestTurn={turn.isLatestTurn}
      isStreamingTurn={turn.isStreamingTurn}
      projectWorkspacePath={projectWorkspacePath}
      projectlessOutputDirectory={projectlessOutputDirectory}
      childMemberships={childMemberships}
      parentModel={parentModel}
      threadCwd={threadCwd}
      onEditUserTurn={onEditUserTurn}
      onForkFromTurn={onForkFromTurn}
      onOpenTurnDiffReview={onOpenTurnDiffReview}
      onOpenTurnDiffFileInSidePanel={onOpenTurnDiffFileInSidePanel}
      onOpenSideChat={onOpenSideChat}
      onOpenThread={onOpenThread}
      onOpenSubagentsPanel={onOpenSubagentsPanel}
      onOpenSummaryScheduledAutomation={onOpenSummaryScheduledAutomation}
      onOpenMcpAppSidePanel={onOpenMcpAppSidePanel}
      onOpenPlanInSidePanel={onOpenPlanInSidePanel}
      onClosePlanSidePanel={onClosePlanSidePanel}
      planSidePanelState={planSidePanelState}
      turnDiffHoverPreviewDisabled={turnDiffHoverPreviewDisabled}
      compactUserMessageActions={compactUserMessageActions}
    />
  );

  return (
    <div>
      <div className="flex flex-col gap-0">
        <div className="flex flex-col">{renderSpacedBlocks(turn.leadingBlocks, renderBlock)}</div>

        {agentBodyUnits.length > 0 ? (
          <>
            {turn.leadingBlocks.length > 0 ? <ThreadGap /> : null}
            {firstResponseSection === "agent" ? firstResponseMarker : null}
            <div className="flex flex-col">
              {shouldAllowAgentBodyCollapse ? (
                <AgentBodyToggleRow
                  collapsedMessageCount={turn.collapsedMessageCount}
                  deniedActionCount={turn.deniedActionCount}
                  workedForLabel={workedForLabel}
                  collapsed={effectiveAgentBodyCollapsed}
                  onToggle={toggleAgentBody}
                />
              ) : null}
              <div ref={agentBodyRef} className="flex flex-col">
                {bodyUnits.map(({ unit, persistent }, index) => (
                  // A keyed slot per unit: work folds in place, and what stays visible never moves.
                  <AnimatePresence key={resolveThreadBlockRenderKey(unit.block)} initial={false}>
                    {effectiveAgentBodyCollapsed && !persistent ? null : (
                      <motion.div
                        key="agent-body-unit"
                        className="-ms-2 ps-2"
                        initial={agentBodyMotion.initial}
                        animate={agentBodyMotion.animate}
                        exit={agentBodyMotion.exit}
                        transition={agentBodyMotion.transition}
                        onAnimationComplete={() => revealDeniedActionAfterExpansion(unit)}
                      >
                        <AgentBodyUnitFrame
                          unit={unit}
                          leadingGap={
                            index !== firstVisibleBodyUnitIndex
                              ? "item"
                              : shouldAllowAgentBodyCollapse
                                ? "toggle"
                                : null
                          }
                          animateGap={!reducedMotion}
                          followContentRef={
                            unit === latestFollowBodyUnit ? latestTurnFollowContentRef : undefined
                          }
                        >
                          {renderAgentUnit(unit, persistent && effectiveAgentBodyCollapsed)}
                        </AgentBodyUnitFrame>
                      </motion.div>
                    )}
                  </AnimatePresence>
                ))}
              </div>
            </div>
          </>
        ) : null}

        {turn.trailingBlocks.length > 0 ? (
          <>
            {turn.leadingBlocks.length > 0 || agentBodyUnits.length > 0 ? <ThreadGap /> : null}
            {firstResponseSection === "trailing" ? firstResponseMarker : null}
            <div className="flex flex-col">
              {renderSpacedBlocks(turn.trailingBlocks, renderBlock)}
            </div>
          </>
        ) : null}

        {endResources.length > 0 ? (
          <>
            <ThreadGap />
            <div ref={latestTurnFollowContentRef}>
              <LocalConversationEndResources
                resources={endResources}
                hostId={hostId}
                cwd={threadCwd}
                workspaceRoot={projectWorkspacePath}
              />
            </div>
          </>
        ) : null}

        {turn.liveActivity.fallback.owner === "standalone" ? (
          <>
            {turn.leadingBlocks.length > 0 ||
            agentBodyUnits.length > 0 ||
            turn.trailingBlocks.length > 0 ? (
              <ThreadGap />
            ) : null}
            {firstResponseSection === "fallback" ? firstResponseMarker : null}
            <div ref={latestTurnFollowContentRef}>
              <ThreadLiveActivityFallbackForTurn turn={turn} />
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}

/** The Turn's thinking status: always one line, truncated at the Thread's width. */
export function ThreadLiveActivityFallback({ message }: { message?: ReactNode }) {
  return (
    <div className="min-w-0 py-0">
      <CodexShimmerText className="block font-sans text-size-chat leading-[calc(var(--codex-chat-font-size)_+_8px)] truncate text-token-foreground/30">
        {message ?? "Thinking"}
      </CodexShimmerText>
    </div>
  );
}

export function ThreadTurn(props: ThreadTurnProps) {
  const turn = normalizeThreadLiveActivity(props.turn);
  return (
    <ThreadMcpAppsProvider apps={props.mcpApps ?? []}>
      <ThreadTurnBody {...props} turn={turn} agentBodyUnits={turn.agentBodyUnits} />
    </ThreadMcpAppsProvider>
  );
}
