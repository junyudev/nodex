import { memo, useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { DownArrowIcon } from "@/components/shared/icons";
import { AnimatePresence, motion } from "motion/react";
import { selectTurnRenderModel } from "../projection/build-turn-render-model";
import { selectVisibleConversationTurnEntries } from "../selectors";
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
import { RightPanelComposerLatestTurnPreview } from "./right-panel-composer-latest-turn-preview";
import {
  RightPanelComposerOverlay,
  type RightPanelComposerOverlayVisibility,
} from "./right-panel-composer-overlay";

interface LocalConversationFooterProps {
  model: ThreadFooterModel;
  actions: ThreadStageActions;
  errorMessage: string | null;
  onErrorMessage: (message: string | null) => void;
  variant?: "thread" | "newThreadHome";
  rightPanelComposerOverlay?: {
    enabled: boolean;
    target: HTMLElement | null;
    compact?: boolean;
    documentBottomKey?: string | null;
    isAtDocumentBottom?: boolean;
    visibility?: RightPanelComposerOverlayVisibility;
    leadingContent?: ReactNode;
  };
  planSidePanelState?: ThreadPlanSidePanelState | null;
  turnDiffHoverPreviewDisabled?: boolean;
  worktreeRuntimeAvailable?: boolean;
}

function LocalConversationFooterChrome({
  model,
  actions,
  errorMessage,
  onErrorMessage,
  catchUpControl,
  latestTurnPreview,
  contextRailLeadingContent,
  showComposer = true,
}: {
  model: ThreadFooterModel;
  actions: ThreadStageActions;
  errorMessage: string | null;
  onErrorMessage: (message: string | null) => void;
  catchUpControl: ReactNode;
  latestTurnPreview?: ReactNode;
  contextRailLeadingContent?: ReactNode;
  showComposer?: boolean;
}) {
  const [hasFixedPortalContent, setHasFixedPortalContent] = useState(false);

  return (
    <div className="flex flex-col" data-thread-find-composer="true">
      {catchUpControl}
      <div className="relative flex flex-col" data-thread-footer-stack="true">
        <LocalConversationAboveComposerPortalHost
          conversationId={model.threadId}
          onContentPresenceChange={setHasFixedPortalContent}
        />
        <LocalConversationAboveComposerQueuePortalHost conversationId={model.threadId} />
        {latestTurnPreview}
        {showComposer ? (
          <LocalConversationComposerShell
            model={model}
            actions={actions}
            errorMessage={errorMessage}
            onErrorMessage={onErrorMessage}
            contextRailLeadingContent={contextRailLeadingContent}
            hasFixedPortalContent={hasFixedPortalContent}
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
  turnDiffHoverPreviewDisabled = false,
  worktreeRuntimeAvailable = true,
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
  const [latestTurnExpansion, setLatestTurnExpansion] = useState<{
    readonly ownerKey: string;
    readonly turnKey: string;
  } | null>(null);
  const isResumingActiveThread =
    !model.isNewThreadTab &&
    (model.attachmentState?.status === "attaching" ||
      model.attachmentState?.status === "failed" ||
      (model.resumeState !== null && model.resumeState !== "resumed"));
  const controlledOverlay = rightPanelComposerOverlay?.visibility?.kind === "controlled";
  const rightPanelOverlayEnabled =
    rightPanelComposerOverlay?.enabled === true && (!isResumingActiveThread || controlledOverlay);
  const latestTurn = useMemo(() => {
    if (!rightPanelOverlayEnabled || !model.conversation) return null;

    const visibleTurns = selectVisibleConversationTurnEntries({
      conversation: model.conversation,
    });
    const latestVisibleTurn = visibleTurns[visibleTurns.length - 1] ?? null;
    if (!latestVisibleTurn) return null;

    return selectTurnRenderModel({
      entry: latestVisibleTurn,
      surface: "preview",
      hostId: model.hostId,
      goalTimeUsedSeconds:
        model.conversation.canonicalState?.completedThreadGoalTurnId ===
        latestVisibleTurn.turn.turnId
          ? model.conversation.completedThreadGoal?.timeUsedSeconds
          : undefined,
      canEditTurnUserPrefix: false,
      canForkTurn: false,
      cwd: model.conversation.cwd,
      projectlessOutputDirectory: model.conversation.projectlessOutputDirectory,
    });
  }, [model.conversation, model.hostId, rightPanelOverlayEnabled]);
  const latestTurnKey = latestTurn?.turnKey ?? null;
  const latestTurnOwnerKey = model.composerScopeIdentity?.trim() || model.threadId;
  const latestTurnExpanded = Boolean(
    latestTurnOwnerKey &&
    latestTurnKey &&
    latestTurnExpansion?.ownerKey === latestTurnOwnerKey &&
    latestTurnExpansion.turnKey === latestTurnKey,
  );
  const handleLatestTurnExpandedChange = useCallback(
    (expanded: boolean) => {
      if (!expanded || !latestTurnOwnerKey || !latestTurnKey) {
        setLatestTurnExpansion(null);
        return;
      }
      setLatestTurnExpansion({
        ownerKey: latestTurnOwnerKey,
        turnKey: latestTurnKey,
      });
    },
    [latestTurnKey, latestTurnOwnerKey],
  );
  useEffect(() => {
    if (!latestTurnExpansion) return;
    if (
      rightPanelOverlayEnabled &&
      latestTurnExpansion.ownerKey === latestTurnOwnerKey &&
      latestTurnExpansion.turnKey === latestTurnKey
    ) {
      return;
    }
    setLatestTurnExpansion(null);
  }, [latestTurnExpansion, latestTurnKey, latestTurnOwnerKey, rightPanelOverlayEnabled]);
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
            className="pointer-events-none absolute inset-x-0 bottom-[calc(100%+6*var(--spacing))] flex justify-center"
          >
            <button
              type="button"
              aria-label="Scroll to latest message"
              onClick={handleCatchUpClick}
              className="pointer-events-auto inline-flex size-8 items-center justify-center rounded-full border border-token-border bg-token-background text-token-foreground shadow-card-md hover:bg-token-foreground/5"
            >
              <DownArrowIcon className="size-4" />
            </button>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
  const contextRailLeadingContent = rightPanelComposerOverlay?.leadingContent;
  const showLatestTurnPreview = Boolean(
    rightPanelOverlayEnabled && latestTurn && latestTurn.blocks.length > 0,
  );
  const latestTurnPreview =
    showLatestTurnPreview && latestTurn ? (
      <RightPanelComposerLatestTurnPreview
        key={latestTurnOwnerKey ?? "right-panel-latest-turn"}
        turn={latestTurn}
        expanded={latestTurnExpanded}
        contextRailLeadingContent={contextRailLeadingContent}
        projectWorkspacePath={model.projectWorkspacePath}
        threadCwd={model.cwd}
        onExpandedChange={handleLatestTurnExpandedChange}
        onEditLastUserTurn={actions.onEditLastUserTurn}
        onForkFromTurn={actions.onForkFromTurn}
        onOpenTurnDiffReview={actions.onOpenTurnDiffReview}
        onOpenTurnDiffFileInSidePanel={actions.onOpenTurnDiffFileInSidePanel}
        onOpenSideChat={actions.onOpenSideChat}
        onOpenThread={actions.onOpenThread}
        onOpenMcpAppSidePanel={actions.onOpenMcpAppSidePanel}
        onOpenPlanInSidePanel={actions.onOpenPlanInSidePanel}
        onClosePlanSidePanel={actions.onClosePlanSidePanel}
        planSidePanelState={planSidePanelState}
        turnDiffHoverPreviewDisabled={rightPanelOverlayEnabled || turnDiffHoverPreviewDisabled}
      />
    ) : null;

  if (rightPanelOverlayEnabled) {
    return (
      <RightPanelComposerOverlay
        target={rightPanelComposerOverlay?.target ?? null}
        compact={rightPanelComposerOverlay?.compact === true}
        visibility={
          rightPanelComposerOverlay?.visibility ??
          (rightPanelComposerOverlay?.compact
            ? {
                kind: "browser-auto",
                documentBottomKey: rightPanelComposerOverlay.documentBottomKey ?? null,
                isAtDocumentBottom: rightPanelComposerOverlay.isAtDocumentBottom === true,
              }
            : { kind: "always" })
        }
        onPointerDownOutside={() => {
          handleLatestTurnExpandedChange(false);
        }}
      >
        <LocalConversationFooterChrome
          model={model}
          actions={actionsWithSubmitPlacement}
          errorMessage={errorMessage}
          onErrorMessage={onErrorMessage}
          catchUpControl={catchUpControl}
          latestTurnPreview={latestTurnPreview}
          contextRailLeadingContent={showLatestTurnPreview ? undefined : contextRailLeadingContent}
          showComposer={!isResumingActiveThread && worktreeRuntimeAvailable}
        />
      </RightPanelComposerOverlay>
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
