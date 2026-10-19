import { AnimatePresence, motion } from "motion/react";
import type { ReactNode } from "react";
import { ChevronRightIcon } from "@/components/shared/icons";
import { cn } from "@/lib/utils";
import type { ReviewOpenIntent } from "@/features/review/model/review-view-state";
import type {
  ThreadPlanSidePanelState,
  ThreadStageActions,
  ThreadTurnModel,
} from "../thread-stage-types";
import { ThreadBlockRenderer } from "./blocks/local-conversation-block-renderer";
import { useWorkedForLabelText } from "./shared/use-worked-for-label";
import {
  RIGHT_PANEL_COMPOSER_ACCESSORY_FROSTED_SURFACE_CLASS,
  RIGHT_PANEL_COMPOSER_ACCESSORY_INLINE_INSET_CLASS,
  useRightPanelComposerPresentation,
} from "./right-panel-composer-presentation";

interface RightPanelComposerLatestTurnPreviewProps {
  turn: ThreadTurnModel | null;
  expanded: boolean;
  contextRailLeadingContent?: ReactNode;
  projectWorkspacePath?: string | null;
  threadCwd?: string | null;
  onExpandedChange: (expanded: boolean) => void;
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
  onOpenMcpAppSidePanel?: ThreadStageActions["onOpenMcpAppSidePanel"];
  onOpenPlanInSidePanel?: ThreadStageActions["onOpenPlanInSidePanel"];
  onClosePlanSidePanel?: ThreadStageActions["onClosePlanSidePanel"];
  planSidePanelState?: ThreadPlanSidePanelState | null;
  turnDiffHoverPreviewDisabled?: boolean;
}

export function RightPanelComposerLatestTurnPreview({
  turn,
  expanded,
  contextRailLeadingContent,
  projectWorkspacePath,
  threadCwd,
  onExpandedChange,
  onEditUserTurn,
  onForkFromTurn,
  onOpenTurnDiffReview,
  onOpenTurnDiffFileInSidePanel,
  onOpenSideChat,
  onOpenThread,
  onOpenMcpAppSidePanel,
  onOpenPlanInSidePanel,
  onClosePlanSidePanel,
  planSidePanelState,
  turnDiffHoverPreviewDisabled = false,
}: RightPanelComposerLatestTurnPreviewProps) {
  const { presentation } = useRightPanelComposerPresentation();
  const workedForLabel = useWorkedForLabelText({
    timing: turn?.workedForTiming ?? null,
    durationMs: turn?.workedDurationMs ?? null,
  });

  if (!turn || turn.blocks.length === 0) return null;

  const previousMessagesLabel =
    turn.collapsedMessageCount > 0
      ? `${turn.collapsedMessageCount} previous ${
          turn.collapsedMessageCount === 1 ? "message" : "messages"
        }`
      : null;
  const headerText =
    workedForLabel ?? previousMessagesLabel ?? (turn.isStreamingTurn ? "Working" : "Latest turn");
  const isCompactPresentation = presentation !== "default";
  const floatingTrayVisible =
    presentation === "expanded" || presentation === "compact-hovered" || turn.isStreamingTurn;

  return (
    <div
      data-right-panel-latest-turn-preview="true"
      data-composer-context-rail="true"
      className={cn(
        "min-w-0 overflow-clip rounded-t-2xl border-x border-t border-token-border/80 text-token-foreground",
        isCompactPresentation
          ? "bg-token-input-background"
          : RIGHT_PANEL_COMPOSER_ACCESSORY_FROSTED_SURFACE_CLASS,
        isCompactPresentation
          ? "absolute inset-x-10 bottom-0 z-0 mx-0 transition-[opacity,translate] duration-150 ease-out motion-reduce:transition-none"
          : cn("relative", RIGHT_PANEL_COMPOSER_ACCESSORY_INLINE_INSET_CLASS),
        isCompactPresentation &&
          (floatingTrayVisible
            ? "pointer-events-auto -translate-y-11 opacity-100"
            : "pointer-events-none translate-y-0 opacity-0"),
        isCompactPresentation && presentation === "compact-hovered" && "delay-150",
        isCompactPresentation && !floatingTrayVisible && "delay-75",
      )}
    >
      <div
        className={cn(
          contextRailLeadingContent ? "flex min-w-0 items-center gap-1 px-1.5 py-0.5" : "contents",
        )}
      >
        {contextRailLeadingContent}
        <button
          type="button"
          aria-expanded={expanded}
          className={cn(
            "flex cursor-interaction items-center gap-1 rounded-[inherit] text-left focus:outline-none focus-visible:ring-1 focus-visible:ring-token-focus-border focus-visible:ring-inset",
            contextRailLeadingContent
              ? "order-2 ml-auto h-7 min-w-0 px-2"
              : "w-full justify-between gap-2 px-3 py-row-y",
          )}
          onClick={() => onExpandedChange(!expanded)}
        >
          <span className="text-size-chat min-w-0 truncate leading-4 text-token-description-foreground">
            {headerText}
          </span>
          <span className="no-drag flex size-6 shrink-0 items-center justify-center rounded-full text-token-description-foreground select-none electron:rounded-md">
            <ChevronRightIcon
              className={cn("icon-2xs transition-transform duration-300", expanded && "rotate-90")}
            />
          </span>
        </button>
      </div>
      <AnimatePresence initial={false}>
        {expanded ? (
          <motion.div
            tabIndex={-1}
            initial={{ maxHeight: 0, opacity: 0 }}
            animate={{ maxHeight: "22.5rem", opacity: 1 }}
            exit={{ maxHeight: 0, opacity: 0, pointerEvents: "none" }}
            transition={{ duration: 0.3, ease: [0.19, 1, 0.22, 1] }}
            className="overflow-hidden"
          >
            <div className="vertical-scroll-fade-mask flex max-h-[22.5rem] flex-col-reverse overflow-x-hidden overflow-y-auto px-3 pt-0.5 pb-3 [--edge-fade-distance:1rem] [animation-direction:reverse]">
              <div className="flex flex-col">
                {turn.blocks.map((block) => (
                  <ThreadBlockRenderer
                    key={block.id}
                    block={block}
                    isLatestTurn={turn.isLatestTurn}
                    isStreamingTurn={turn.isStreamingTurn}
                    projectWorkspacePath={projectWorkspacePath}
                    threadCwd={threadCwd}
                    onEditUserTurn={onEditUserTurn}
                    onForkFromTurn={onForkFromTurn}
                    onOpenTurnDiffReview={onOpenTurnDiffReview}
                    onOpenTurnDiffFileInSidePanel={onOpenTurnDiffFileInSidePanel}
                    onOpenSideChat={onOpenSideChat}
                    onOpenThread={onOpenThread}
                    onOpenMcpAppSidePanel={onOpenMcpAppSidePanel}
                    onOpenPlanInSidePanel={onOpenPlanInSidePanel}
                    onClosePlanSidePanel={onClosePlanSidePanel}
                    planSidePanelState={planSidePanelState}
                    allowInProgressTurnDiff={true}
                    turnDiffHoverPreviewDisabled={turnDiffHoverPreviewDisabled}
                    alwaysShowAssistantMessageActions={true}
                  />
                ))}
              </div>
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}
