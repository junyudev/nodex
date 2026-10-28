import { memo, useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { DownArrowIcon } from "@/components/shared/icons";
import { AnimatePresence, motion } from "motion/react";
import { selectTurnRenderModel } from "../projection/build-turn-render-model";
import { selectVisibleConversationTurnEntries } from "../selectors";
import {
  CodexTranscriptReadOwnerContext,
  CodexTranscriptTurnEntityContext,
  useCodexTranscriptTurnFromOwner,
} from "../normalized-transcript-hooks";
import type { ConversationLatestTurnPreview } from "../use-conversation-body-presentation";
import type {
  ThreadFooterModel,
  ThreadPlanSidePanelState,
  ThreadStageActions,
} from "../thread-stage-types";
import { shouldShowThreadScrollToBottomControl } from "./local-conversation-turn-virtualization";
import { LocalConversationComposerShell } from "./composer/local-conversation-composer-shell";
import { ComposerContextRail, ComposerContextRailSlot } from "./composer-context-rail";
import {
  LocalConversationAboveComposerPortalHost,
  LocalConversationAboveComposerQueuePortalHost,
} from "./local-conversation-above-composer-portal";
import { useLocalConversationThreadScrollController } from "./local-conversation-thread-scroll-controller";
import {
  FloatingConversationCompletionPreview,
  FloatingConversationTranscript,
  resolveFloatingConversationAnswerPreview,
} from "./floating-conversation-turn";
import {
  FloatingComposer,
  type FloatingComposerPlacement,
} from "@/features/floating-composer/floating-composer";

interface LocalConversationFooterProps {
  model: ThreadFooterModel;
  actions: ThreadStageActions;
  errorMessage: string | null;
  onErrorMessage: (message: string | null) => void;
  variant?: "thread" | "newThreadHome";
  rightPanelComposerOverlay?: {
    enabled: boolean;
    target: HTMLElement | null;
    placement?: FloatingComposerPlacement;
    leadingContent?: ReactNode;
  };
  planSidePanelState?: ThreadPlanSidePanelState | null;
  worktreeRuntimeAvailable?: boolean;
  normalizedPreview?: ConversationLatestTurnPreview | null;
  /** Marks the conversation read once a floating composer shows its latest response. */
  onMarkConversationRead?: () => void;
}

function LocalConversationFooterChrome({
  model,
  actions,
  errorMessage,
  onErrorMessage,
  catchUpControl,
  contextRailLeadingContent,
  showComposer = true,
}: {
  model: ThreadFooterModel;
  actions: ThreadStageActions;
  errorMessage: string | null;
  onErrorMessage: (message: string | null) => void;
  catchUpControl: ReactNode;
  contextRailLeadingContent?: ReactNode;
  showComposer?: boolean;
}) {
  return (
    <div className="flex flex-col" data-thread-find-composer="true">
      {catchUpControl}
      <div className="relative flex flex-col" data-thread-footer-stack="true">
        <LocalConversationAboveComposerPortalHost conversationId={model.threadId} />
        <LocalConversationAboveComposerQueuePortalHost conversationId={model.threadId} />
        {showComposer ? (
          <LocalConversationComposerShell
            model={model}
            actions={actions}
            errorMessage={errorMessage}
            onErrorMessage={onErrorMessage}
            contextRailLeadingContent={contextRailLeadingContent}
          />
        ) : contextRailLeadingContent ? (
          <ComposerContextRailSlot visible>
            <ComposerContextRail>
              {contextRailLeadingContent}
              <span aria-hidden="true" className="order-2 min-w-0 flex-1" />
            </ComposerContextRail>
          </ComposerContextRailSlot>
        ) : null}
      </div>
    </div>
  );
}

function LocalConversationFooterComponent({
  model,
  actions,
  errorMessage,
  onErrorMessage,
  variant = "thread",
  rightPanelComposerOverlay,
  planSidePanelState,
  worktreeRuntimeAvailable = true,
  normalizedPreview = null,
  onMarkConversationRead,
}: LocalConversationFooterProps) {
  const {
    addScrollListener,
    clearPendingLatestTurnSubmitPlacement,
    getLastScrollDistanceFromBottomPx,
    isScrolledFromBottom,
    prepareLatestTurnSubmitPlacement,
    responseSpacerState,
    scrollToBottom,
  } = useLocalConversationThreadScrollController();
  const [scrollDistanceFromBottomPx, setScrollDistanceFromBottomPx] = useState(() =>
    getLastScrollDistanceFromBottomPx(),
  );
  // The owner whose floating composer shows its conversation; any other owner starts compact.
  const [expandedOwnerKey, setExpandedOwnerKey] = useState<string | null>(null);
  const isResumingActiveThread =
    !model.isNewThreadTab &&
    (model.attachmentState?.status === "attaching" ||
      model.attachmentState?.status === "failed" ||
      (model.resumeState !== null && model.resumeState !== "resumed"));
  const controlledOverlay = rightPanelComposerOverlay?.placement?.control !== undefined;
  const rightPanelOverlayEnabled =
    rightPanelComposerOverlay?.enabled === true && (!isResumingActiveThread || controlledOverlay);
  const previewEntry = rightPanelOverlayEnabled ? normalizedPreview?.entry : null;
  const normalizedTurn = useCodexTranscriptTurnFromOwner(
    rightPanelOverlayEnabled ? (normalizedPreview?.owner ?? null) : null,
    previewEntry?.historyEntityKey ?? null,
    null,
  );
  const legacyPreviewConversation = normalizedPreview ? null : model.conversation;
  const previewConversationAvailable = model.conversation !== null;
  const completedGoalTurnId = model.conversation?.canonicalState?.completedThreadGoalTurnId;
  const completedGoalTimeUsedSeconds = model.conversation?.completedThreadGoal?.timeUsedSeconds;
  const previewCwd = model.conversation?.cwd;
  const previewOutputDirectory = model.conversation?.projectlessOutputDirectory;
  const latestTurn = useMemo(() => {
    if (!rightPanelOverlayEnabled || !previewConversationAvailable) return null;

    const visibleTurns = normalizedPreview
      ? []
      : selectVisibleConversationTurnEntries({
          conversation: legacyPreviewConversation,
        });
    const latestVisibleTurn = normalizedPreview
      ? previewEntry && normalizedTurn
        ? { ...previewEntry, turn: normalizedTurn }
        : null
      : (visibleTurns[visibleTurns.length - 1] ?? null);
    if (!latestVisibleTurn) return null;

    return selectTurnRenderModel({
      entry: latestVisibleTurn,
      surface: "preview",
      hostId: model.hostId,
      goalTimeUsedSeconds:
        completedGoalTurnId === latestVisibleTurn.turn.turnId
          ? completedGoalTimeUsedSeconds
          : undefined,
      canEditTurnUserPrefix: false,
      canForkTurn: false,
      cwd: previewCwd,
      projectlessOutputDirectory: previewOutputDirectory,
    });
  }, [
    normalizedPreview,
    normalizedTurn,
    previewEntry,
    legacyPreviewConversation,
    completedGoalTurnId,
    completedGoalTimeUsedSeconds,
    previewCwd,
    previewOutputDirectory,
    model.hostId,
    rightPanelOverlayEnabled,
    previewConversationAvailable,
  ]);
  const latestTurnKey = latestTurn?.turnKey ?? null;
  const latestTurnOwnerKey = model.composerScopeIdentity?.trim() || model.threadId;
  const hasFloatingTranscript = Boolean(latestTurn && latestTurn.blocks.length > 0);
  const floatingExpanded = Boolean(
    rightPanelOverlayEnabled &&
    hasFloatingTranscript &&
    latestTurnOwnerKey &&
    expandedOwnerKey === latestTurnOwnerKey,
  );
  // The conversation is read while a floating composer shows it.
  const conversationUnread = model.conversation?.hasUnreadTurn === true;
  useEffect(() => {
    if (floatingExpanded && conversationUnread) onMarkConversationRead?.();
  }, [conversationUnread, floatingExpanded, onMarkConversationRead]);
  useEffect(() => addScrollListener(setScrollDistanceFromBottomPx), [addScrollListener]);

  const actionsWithSubmitPlacement = useMemo<ThreadStageActions>(() => {
    const prepareExistingThreadPlacement = () => {
      if (model.threadId === null || model.conversation === null) return false;
      prepareLatestTurnSubmitPlacement();
      return true;
    };

    return {
      ...actions,
      onSendPrompt: async (...args) => {
        const prepared = prepareExistingThreadPlacement();
        try {
          await actions.onSendPrompt(...args);
        } catch (error) {
          if (prepared) {
            clearPendingLatestTurnSubmitPlacement();
          }
          throw error;
        }
      },
      onSteerPrompt: async (...args) => {
        const prepared = prepareExistingThreadPlacement();
        try {
          await actions.onSteerPrompt(...args);
        } catch (error) {
          if (prepared) {
            clearPendingLatestTurnSubmitPlacement();
          }
          throw error;
        }
      },
      ...(actions.onResumeInterruptedTurn
        ? {
            onResumeInterruptedTurn: async () => {
              const prepared = prepareExistingThreadPlacement();
              try {
                await actions.onResumeInterruptedTurn?.();
              } catch (error) {
                if (prepared) {
                  clearPendingLatestTurnSubmitPlacement();
                }
                throw error;
              }
            },
          }
        : {}),
      onEnqueueQueuedFollowUp: async (...args) => {
        const prepared = prepareExistingThreadPlacement();
        try {
          await actions.onEnqueueQueuedFollowUp(...args);
          if (prepared) {
            clearPendingLatestTurnSubmitPlacement();
          }
        } catch (error) {
          if (prepared) {
            clearPendingLatestTurnSubmitPlacement();
          }
          throw error;
        }
      },
      onSendQueuedFollowUpNow: async (...args) => {
        const prepared = prepareExistingThreadPlacement();
        try {
          await actions.onSendQueuedFollowUpNow(...args);
        } catch (error) {
          if (prepared) {
            clearPendingLatestTurnSubmitPlacement();
          }
          throw error;
        }
      },
    };
  }, [
    actions,
    clearPendingLatestTurnSubmitPlacement,
    model.conversation,
    model.threadId,
    prepareLatestTurnSubmitPlacement,
  ]);

  const responseSpacerHeightPx = responseSpacerState?.getHeightPx() ?? null;
  const showCatchUpControl =
    model.threadId !== null &&
    model.body.turnCount > 0 &&
    shouldShowThreadScrollToBottomControl({
      isScrollToTopEnabled: responseSpacerState !== null,
      isScrolledFromBottom,
      responseSpacerHeightPx,
      scrollDistanceFromBottomPx,
    });
  const handleCatchUpClick = useCallback(() => {
    if (responseSpacerState) {
      responseSpacerState.scrollToBottom();
      return;
    }
    scrollToBottom();
  }, [responseSpacerState, scrollToBottom]);
  const catchUpControl = (
    <div className="relative h-0" data-thread-catch-up-control="true">
      <AnimatePresence initial={false}>
        {showCatchUpControl ? (
          <motion.div
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            initial={{ opacity: 0 }}
            transition={{ duration: 0.15, ease: "easeInOut" }}
            className="pointer-events-none absolute inset-x-0 bottom-[calc(100%+6*var(--spacing))] z-30 flex justify-center print:hidden"
          >
            <button
              type="button"
              aria-label="Scroll to latest message"
              onClick={handleCatchUpClick}
              // Keep this floating surface opaque in every interaction state.
              className="pointer-events-auto inline-flex size-8 cursor-interaction items-center justify-center rounded-full border border-token-border bg-token-editor-background bg-clip-padding text-token-foreground"
            >
              <DownArrowIcon className="size-5" />
            </button>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
  const contextRailLeadingContent = rightPanelComposerOverlay?.leadingContent;
  const floatingTranscript =
    rightPanelOverlayEnabled && hasFloatingTranscript && latestTurn ? (
      <CodexTranscriptReadOwnerContext.Provider value={normalizedPreview?.owner ?? null}>
        <CodexTranscriptTurnEntityContext.Provider value={previewEntry?.historyEntityKey ?? null}>
          <FloatingConversationTranscript
            key={latestTurnKey ?? "floating-transcript"}
            turn={latestTurn}
            projectWorkspacePath={model.projectWorkspacePath}
            threadCwd={model.cwd}
            onEditUserTurn={actions.onEditUserTurn}
            onForkFromTurn={actions.onForkFromTurn}
            onOpenTurnDiffReview={actions.onOpenTurnDiffReview}
            onOpenTurnDiffFileInSidePanel={actions.onOpenTurnDiffFileInSidePanel}
            onOpenSideChat={actions.onOpenSideChat}
            onOpenThread={actions.onOpenThread}
            onOpenMcpAppSidePanel={actions.onOpenMcpAppSidePanel}
            onOpenPlanInSidePanel={actions.onOpenPlanInSidePanel}
            onClosePlanSidePanel={actions.onClosePlanSidePanel}
            planSidePanelState={planSidePanelState}
            turnDiffHoverPreviewDisabled={true}
          />
        </CodexTranscriptTurnEntityContext.Provider>
      </CodexTranscriptReadOwnerContext.Provider>
    ) : null;
  // A completed, unread response is announced beside the compact composer.
  const floatingCompletionPreview =
    floatingTranscript && latestTurn && !latestTurn.isStreamingTurn && conversationUnread ? (
      <FloatingConversationCompletionPreview
        title={
          rightPanelComposerOverlay?.placement?.title ||
          model.conversation?.threadName?.trim() ||
          "Chat"
        }
        preview={resolveFloatingConversationAnswerPreview(latestTurn)}
        onOpen={() => {
          if (latestTurnOwnerKey) setExpandedOwnerKey(latestTurnOwnerKey);
        }}
        onDismiss={() => onMarkConversationRead?.()}
      />
    ) : null;

  if (rightPanelOverlayEnabled) {
    const showComposer = !isResumingActiveThread && worktreeRuntimeAvailable;
    return (
      <FloatingComposer
        target={rightPanelComposerOverlay?.target ?? null}
        {...rightPanelComposerOverlay?.placement}
        attention={model.isThreadRunning ? "activity" : "none"}
        headerPinned={!showComposer}
        transcript={floatingTranscript}
        expanded={floatingExpanded}
        onExpandedChange={(expanded) =>
          setExpandedOwnerKey(expanded ? (latestTurnOwnerKey ?? null) : null)
        }
        previews={floatingCompletionPreview}
      >
        <LocalConversationFooterChrome
          model={model}
          actions={actionsWithSubmitPlacement}
          errorMessage={errorMessage}
          onErrorMessage={onErrorMessage}
          catchUpControl={catchUpControl}
          contextRailLeadingContent={contextRailLeadingContent}
          showComposer={showComposer}
        />
      </FloatingComposer>
    );
  }

  if (isResumingActiveThread || !worktreeRuntimeAvailable) {
    return (
      <div
        className={
          variant === "newThreadHome"
            ? "min-w-0 w-full"
            : "mx-auto flex w-full max-w-(--thread-content-max-width) flex-col px-toolbar"
        }
      >
        <LocalConversationFooterChrome
          model={model}
          actions={actionsWithSubmitPlacement}
          errorMessage={errorMessage}
          onErrorMessage={onErrorMessage}
          catchUpControl={catchUpControl}
          showComposer={false}
        />
      </div>
    );
  }

  return (
    <div
      className={
        variant === "newThreadHome"
          ? "min-w-0 w-full"
          : "mx-auto flex w-full max-w-(--thread-content-max-width) flex-col px-toolbar"
      }
    >
      <LocalConversationFooterChrome
        model={model}
        actions={actionsWithSubmitPlacement}
        errorMessage={errorMessage}
        onErrorMessage={onErrorMessage}
        catchUpControl={catchUpControl}
      />
    </div>
  );
}

export const LocalConversationFooter = memo(LocalConversationFooterComponent);
