import { AnimatePresence, motion } from "motion/react";
import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { useResolvedReducedMotion } from "@/lib/use-reduced-motion";
import type { ReviewOpenIntent } from "@/features/review/model/review-view-state";
import type {
  ThreadBlockModel,
  ThreadPlanSidePanelState,
  ThreadStageActions,
  ThreadTranscriptBlockModel,
} from "../thread-stage-types";
import { parseTodoSteps, TodoListCompactPillContent } from "./shared/todo-list-surface";
import { buildTurnDiffModel, extractTurnDiffPayload } from "./shared/turn-diff-model";
import { TurnDiffInProgressInlineSummary } from "./shared/turn-diff-surface";
import { usePortalHost } from "./use-portal-host";

export const LOCAL_CONVERSATION_FIXED_ABOVE_COMPOSER_PORTAL_ID = "above-composer-portal";
export const LOCAL_CONVERSATION_FIXED_ABOVE_COMPOSER_QUEUE_PORTAL_ID =
  "above-composer-queue-portal";
export const LOCAL_CONVERSATION_FIXED_ABOVE_COMPOSER_PORTAL_ATTRIBUTE =
  "data-above-composer-portal";
export const LOCAL_CONVERSATION_FIXED_ABOVE_COMPOSER_QUEUE_PORTAL_ATTRIBUTE =
  "data-above-composer-queue-portal";

type AboveComposerFixedBlock = ThreadTranscriptBlockModel & {
  type: "todoList" | "turnDiff";
};

const ABOVE_COMPOSER_FIXED_CONTENT_TRANSITION = {
  duration: 0.15,
  ease: "easeOut",
} as const;

const ABOVE_COMPOSER_PILL_WIDTH_TRANSITION = {
  duration: 0.2,
  ease: "easeOut",
} as const;

function isAboveComposerFixedBlock(block: ThreadBlockModel): block is AboveComposerFixedBlock {
  if (!("entry" in block)) return false;
  return block.type === "todoList" || block.type === "turnDiff";
}

function useMeasuredElementWidth() {
  const [element, setElement] = useState<HTMLDivElement | null>(null);
  const [elementWidthPx, setElementWidthPx] = useState<number | null>(null);

  const elementRef = useCallback((node: HTMLDivElement | null) => {
    setElement(node);
  }, []);

  useLayoutEffect(() => {
    if (element === null) {
      setElementWidthPx(null);
      return;
    }

    const updateWidth = () => {
      const nextWidth = Math.ceil(element.getBoundingClientRect().width);
      setElementWidthPx((currentWidth) => (currentWidth === nextWidth ? currentWidth : nextWidth));
    };

    updateWidth();

    if (typeof ResizeObserver === "undefined") return;

    const resizeObserver = new ResizeObserver(updateWidth);
    resizeObserver.observe(element);
    return () => {
      resizeObserver.disconnect();
    };
  }, [element]);

  return {
    elementRef,
    elementWidthPx,
  };
}

function measureIntrinsicElementWidth(element: HTMLElement): number {
  const previousMaxWidth = element.style.maxWidth;
  element.style.maxWidth = "none";

  try {
    const borderWidth = Math.max(0, element.offsetWidth - element.clientWidth);
    return Math.ceil(element.scrollWidth + borderWidth);
  } finally {
    element.style.maxWidth = previousMaxWidth;
  }
}

export function LocalConversationAboveComposerPortalHost({
  conversationId,
}: {
  conversationId?: string | null;
}) {
  return (
    <div
      id={LOCAL_CONVERSATION_FIXED_ABOVE_COMPOSER_PORTAL_ID}
      data-above-composer-portal="true"
      data-above-composer-conversation-id={conversationId ?? undefined}
      className="relative px-5 empty:hidden"
    />
  );
}

export function LocalConversationAboveComposerQueuePortalHost({
  conversationId,
}: {
  conversationId?: string | null;
}) {
  return (
    <div
      id={LOCAL_CONVERSATION_FIXED_ABOVE_COMPOSER_QUEUE_PORTAL_ID}
      data-above-composer-queue-portal="true"
      data-above-composer-conversation-id={conversationId ?? undefined}
      className="relative px-5 empty:hidden"
    />
  );
}

function AboveComposerMeasuredPill({ children }: { children: ReactNode }) {
  const reducedMotion = useResolvedReducedMotion();
  const contentRef = useRef<HTMLDivElement | null>(null);
  const [contentWidthPx, setContentWidthPx] = useState<number | null>(null);
  const { elementRef: boundaryRef, elementWidthPx: availableWidthPx } = useMeasuredElementWidth();

  useLayoutEffect(() => {
    const contentElement = contentRef.current;
    if (contentElement === null) return;

    const updateContentWidth = () => {
      const nextWidth = measureIntrinsicElementWidth(contentElement);
      setContentWidthPx((currentWidth) => (currentWidth === nextWidth ? currentWidth : nextWidth));
    };

    updateContentWidth();

    if (typeof MutationObserver === "undefined") return;
    const mutationObserver = new MutationObserver(updateContentWidth);
    mutationObserver.observe(contentElement, {
      characterData: true,
      childList: true,
      subtree: true,
    });
    return () => {
      mutationObserver.disconnect();
    };
  }, []);

  const targetWidthPx =
    contentWidthPx === null || availableWidthPx === null
      ? contentWidthPx
      : Math.min(contentWidthPx, availableWidthPx);
  const animateWidth =
    !reducedMotion && targetWidthPx !== null ? { width: targetWidthPx } : undefined;
  const instantWidthStyle: CSSProperties | undefined =
    reducedMotion && targetWidthPx !== null ? { width: targetWidthPx } : undefined;

  return (
    <div
      ref={boundaryRef}
      className="flex w-full max-w-(--thread-content-max-width) min-w-0 justify-center"
    >
      <motion.div
        animate={animateWidth}
        transition={reducedMotion ? { duration: 0 } : ABOVE_COMPOSER_PILL_WIDTH_TRANSITION}
        className="relative z-10 max-w-full min-w-0 overflow-hidden rounded-3xl"
        data-above-composer-fixed-pill="true"
        style={instantWidthStyle}
      >
        <div
          ref={contentRef}
          className="flex w-max max-w-full min-w-0 items-center gap-2 rounded-3xl border border-token-border/80 bg-token-input-background/70 px-3 py-1.5 text-token-foreground backdrop-blur-sm"
          data-above-composer-fixed-pill-inner="true"
        >
          {children}
        </div>
      </motion.div>
    </div>
  );
}

function AboveComposerFixedContentLayer({
  blocks,
  projectWorkspacePath,
  threadCwd,
  projectlessOutputDirectory,
  onOpenTurnDiffReview,
}: {
  blocks: AboveComposerFixedBlock[];
  projectWorkspacePath?: string | null;
  threadCwd?: string | null;
  projectlessOutputDirectory?: string | null;
  onOpenTurnDiffReview?: (intent: ReviewOpenIntent) => void | Promise<void>;
}) {
  const reducedMotion = useResolvedReducedMotion();
  const todoCandidate = blocks.find((block) => block.type === "todoList") ?? null;
  const todoBlock =
    todoCandidate && parseTodoSteps(todoCandidate.entry).length > 0 ? todoCandidate : null;
  const turnDiffCandidate = blocks.find((block) => block.type === "turnDiff") ?? null;
  const turnDiffModel = useMemo(
    () =>
      turnDiffCandidate
        ? buildTurnDiffModel(
            turnDiffCandidate.entry,
            threadCwd ?? undefined,
            projectWorkspacePath ?? undefined,
            { cwd: threadCwd, projectlessOutputDirectory },
          )
        : null,
    [projectlessOutputDirectory, projectWorkspacePath, threadCwd, turnDiffCandidate],
  );
  const turnDiffBlock =
    turnDiffCandidate &&
    extractTurnDiffPayload(turnDiffCandidate.entry, {
      cwd: threadCwd,
      projectlessOutputDirectory,
    }) &&
    turnDiffModel?.kind !== "empty"
      ? turnDiffCandidate
      : null;
  const hasFixedContent = todoBlock !== null || turnDiffBlock !== null;
  if (!hasFixedContent) return null;
  const motionState = reducedMotion
    ? {
        initial: { opacity: 0 },
        animate: { opacity: 1 },
        exit: { opacity: 0 },
      }
    : {
        initial: { opacity: 0, y: 4 },
        animate: { opacity: 1, y: 0 },
        exit: { opacity: 0, y: 4 },
      };
  const transition = reducedMotion ? { duration: 0 } : ABOVE_COMPOSER_FIXED_CONTENT_TRANSITION;

  return (
    <>
      <div aria-hidden="true" className="h-8" data-above-composer-fixed-spacer="true" />
      <AnimatePresence initial={false}>
        {hasFixedContent ? (
          <motion.div
            key="fixed-content"
            className="absolute inset-x-5 bottom-1 flex min-h-7 items-center justify-center gap-2 pb-1"
            data-above-composer-fixed-content="true"
            initial={motionState.initial}
            animate={motionState.animate}
            exit={motionState.exit}
            transition={transition}
          >
            <div
              className="pointer-events-none absolute inset-x-0 -bottom-1 h-7 bg-gradient-to-t from-token-main-surface-primary to-transparent"
              data-above-composer-fixed-fade="true"
            />
            <AboveComposerMeasuredPill>
              <AnimatePresence initial={false}>
                {todoBlock ? (
                  <motion.div
                    key="todo"
                    className="max-w-full min-w-0 shrink-0"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={transition}
                  >
                    <TodoListCompactPillContent item={todoBlock.entry} />
                  </motion.div>
                ) : null}
                {turnDiffBlock ? (
                  <motion.div
                    key="diff"
                    className="min-w-0"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={transition}
                  >
                    <TurnDiffInProgressInlineSummary
                      item={turnDiffBlock.entry}
                      model={turnDiffModel ?? undefined}
                      projectWorkspacePath={projectWorkspacePath ?? undefined}
                      threadCwd={threadCwd ?? undefined}
                      projectlessOutputDirectory={projectlessOutputDirectory}
                      onOpenReview={onOpenTurnDiffReview}
                      showLeadingSeparator={todoBlock !== null}
                    />
                  </motion.div>
                ) : null}
              </AnimatePresence>
            </AboveComposerMeasuredPill>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </>
  );
}

interface LocalConversationAboveComposerPortalProps {
  blocks: ThreadBlockModel[];
  conversationId?: string | null;
  isLatestTurn: boolean;
  isStreamingTurn: boolean;
  projectWorkspacePath?: string | null;
  threadCwd?: string | null;
  projectlessOutputDirectory?: string | null;
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

export function LocalConversationAboveComposerPortal({
  blocks,
  conversationId,
  isLatestTurn,
  isStreamingTurn,
  projectWorkspacePath,
  threadCwd,
  projectlessOutputDirectory,
  onOpenTurnDiffReview,
}: LocalConversationAboveComposerPortalProps) {
  const host = usePortalHost({
    attribute: LOCAL_CONVERSATION_FIXED_ABOVE_COMPOSER_PORTAL_ATTRIBUTE,
    fallbackId: LOCAL_CONVERSATION_FIXED_ABOVE_COMPOSER_PORTAL_ID,
    conversationId,
  });
  const fixedBlocks = blocks.filter(isAboveComposerFixedBlock);
  if (blocks.length === 0) return null;
  if (!isLatestTurn) return null;
  if (!isStreamingTurn) return null;
  if (fixedBlocks.length === 0) return null;
  if (!host) return null;

  return createPortal(
    <AboveComposerFixedContentLayer
      blocks={fixedBlocks}
      projectWorkspacePath={projectWorkspacePath}
      threadCwd={threadCwd}
      projectlessOutputDirectory={projectlessOutputDirectory}
      onOpenTurnDiffReview={onOpenTurnDiffReview}
    />,
    host,
  );
}
