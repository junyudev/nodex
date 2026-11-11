import { runWithCleanup } from "@/lib/run-with-cleanup";
import { memo, useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { DownArrowIcon } from "@/components/shared/icons";
import { AnimatePresence, motion } from "motion/react";
import { selectTurnRenderModel } from "../projection/build-turn-render-model";
import { selectVisibleConversationTurnEntries } from "../selectors";
import { useCodexTranscriptTurnFromOwner } from "../normalized-transcript-hooks";
import type { ConversationLatestTurnPreview } from "../use-conversation-body-presentation";
import type { ThreadFooterModel, ThreadStageActions } from "../thread-stage-types";
import { shouldShowThreadScrollToBottomControl } from "./local-conversation-turn-virtualization";
import { LocalConversationComposerShell } from "./composer/local-conversation-composer-shell";
import {
  LocalConversationAboveComposerPortalHost,
  LocalConversationAboveComposerQueuePortalHost,
} from "./local-conversation-above-composer-portal";
import { useLocalConversationThreadScrollController } from "./local-conversation-thread-scroll-controller";
import {
  FloatingConversationCompletionPreview,
  resolveFloatingConversationAnswerPreview,
} from "./floating-conversation-completion-preview";
import {
  FloatingComposer,
  type FloatingComposerPlacement,
} from "@/features/floating-composer/floating-composer";

interface LocalConversationFooterProps {
  model: ThreadFooterModel;
  actions: ThreadStageActions;
  variant?: "thread" | "newThreadHome";
  rightPanelComposerOverlay?: {
    enabled: boolean;
    target: HTMLElement | null;
    placement?: FloatingComposerPlacement;
    leadingContent?: ReactNode;
    /** The chat shown when the floating composer expands; without one it stays compact. */
    transcript?: ReactNode;
  };
  normalizedPreview?: ConversationLatestTurnPreview | null;
  /** Dismisses a floating composer's completed-response preview. */
  onMarkConversationRead?: () => void;
}

function LocalConversationFooterChrome({
  model,
  actions,
  catchUpControl,
  contextRailLeadingContent,
}: {
  model: ThreadFooterModel;
  actions: ThreadStageActions;
  catchUpControl: ReactNode;
  contextRailLeadingContent?: ReactNode;
}) {
  return (
    <div className="flex flex-col" data-thread-find-composer="true">
      {catchUpControl}
      <div className="relative flex flex-col" data-thread-footer-stack="true">
        <LocalConversationAboveComposerPortalHost conversationId={model.threadId} />
        <LocalConversationAboveComposerQueuePortalHost conversationId={model.threadId} />
        <LocalConversationComposerShell
          model={model}
          actions={actions}
          contextRailLeadingContent={contextRailLeadingContent}
        />
      </div>
    </div>
  );
}

function LocalConversationFooterComponent({
  rightPanelComposerOverlay,
  ...props
}: LocalConversationFooterProps) {
  // The owner whose floating composer shows its conversation; any other owner starts compact.
  // Held here so switching between floating and docked presentations keeps it.
  const [expandedOwnerKey, setExpandedOwnerKey] = useState<string | null>(null);
  if (rightPanelComposerOverlay?.enabled === true) {
    return (
      <FloatingLocalConversationFooter
        {...props}
        overlay={rightPanelComposerOverlay}
        expandedOwnerKey={expandedOwnerKey}
        onExpandedOwnerKeyChange={setExpandedOwnerKey}
      />
    );
  }
  return <DockedLocalConversationFooter {...props} />;
}

type LocalConversationFooterBranchProps = Omit<
  LocalConversationFooterProps,
  "rightPanelComposerOverlay"
>;

/**
 * The composer floating over full-width content. It expands into its own view of the thread, so
 * it keeps no catch-up control and never lifts a sent prompt to the top of the hidden
 * Conversation.
 */
function FloatingLocalConversationFooter({
  model,
  actions,
  normalizedPreview = null,
  onMarkConversationRead,
  overlay,
  expandedOwnerKey,
  onExpandedOwnerKeyChange,
}: LocalConversationFooterBranchProps & {
  overlay: NonNullable<LocalConversationFooterProps["rightPanelComposerOverlay"]>;
  expandedOwnerKey: string | null;
  onExpandedOwnerKeyChange: (ownerKey: string | null) => void;
}) {
  const transcriptOwnerKey = model.composerScopeIdentity?.trim() || model.threadId;
  const hasTranscript = Boolean(overlay.transcript);
  const expanded = Boolean(
    hasTranscript && transcriptOwnerKey && expandedOwnerKey === transcriptOwnerKey,
  );
  // A completed, unread response is announced beside the compact composer.
  const announceCompletion = hasTranscript && model.conversation?.hasUnreadTurn === true;
  const previewEntry = announceCompletion ? normalizedPreview?.entry : null;
  const normalizedTurn = useCodexTranscriptTurnFromOwner(
    announceCompletion ? (normalizedPreview?.owner ?? null) : null,
    previewEntry?.historyEntityKey ?? null,
    null,
  );
  const legacyPreviewConversation = normalizedPreview ? null : model.conversation;
  const previewCwd = model.conversation?.cwd;
  const previewOutputDirectory = model.conversation?.projectlessOutputDirectory;
  const completedTurn = useMemo(() => {
    if (!announceCompletion) return null;

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

    const turn = selectTurnRenderModel({
      entry: latestVisibleTurn,
      surface: "preview",
      hostId: model.hostId,
      canEditTurnUserPrefix: false,
      canForkTurn: false,
      cwd: previewCwd,
      projectlessOutputDirectory: previewOutputDirectory,
    });
    return turn.isStreamingTurn ? null : turn;
  }, [
    announceCompletion,
    normalizedPreview,
    normalizedTurn,
    previewEntry,
    legacyPreviewConversation,
    previewCwd,
    previewOutputDirectory,
    model.hostId,
  ]);
  return (
    <FloatingComposer
      target={overlay.target}
      {...overlay.placement}
      attention={model.isThreadRunning ? "activity" : "none"}
      transcript={hasTranscript ? overlay.transcript : null}
      expanded={expanded}
      onExpandedChange={(next) => onExpandedOwnerKeyChange(next ? transcriptOwnerKey : null)}
      previews={
        completedTurn ? (
          <FloatingConversationCompletionPreview
            title={overlay.placement?.title || model.conversation?.threadName?.trim() || "Chat"}
            preview={resolveFloatingConversationAnswerPreview(completedTurn)}
            onOpen={() => onExpandedOwnerKeyChange(transcriptOwnerKey)}
            onDismiss={() => onMarkConversationRead?.()}
          />
        ) : null
      }
    >
      <LocalConversationFooterChrome
        model={model}
        actions={actions}
        catchUpControl={null}
        contextRailLeadingContent={overlay.leadingContent}
      />
    </FloatingComposer>
  );
}

/**
 * The composer below the Conversation; each sent prompt lifts its turn to the top. A started
 * chat always shows it: what holds sending is the model's send gate, said beside the composer.
 */
function DockedLocalConversationFooter({
  model,
  actions,
  variant = "thread",
}: LocalConversationFooterBranchProps) {
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
  useEffect(() => addScrollListener(setScrollDistanceFromBottomPx), [addScrollListener]);

  const actionsWithSubmitPlacement = useMemo<ThreadStageActions>(() => {
    const prepareExistingThreadPlacement = () => {
      if (model.threadId === null || model.conversation === null) return false;
      prepareLatestTurnSubmitPlacement();
      return true;
    };

    // Accepted sends retain placement until the transcript commits; queue-only writes release it.
    const runWithSubmitPlacement = async (
      operation: () => Promise<unknown>,
      clearAfter = false,
    ) => {
      const prepared = prepareExistingThreadPlacement();
      await runWithCleanup(operation, {
        onError: (error) => {
          if (prepared && !clearAfter) clearPendingLatestTurnSubmitPlacement();
          throw error;
        },
        cleanup: () => {
          if (prepared && clearAfter) clearPendingLatestTurnSubmitPlacement();
        },
      });
    };
    const resumeInterruptedTurn = actions.onResumeInterruptedTurn;
    return {
      ...actions,
      onSendPrompt: (...args) => runWithSubmitPlacement(() => actions.onSendPrompt(...args)),
      onSteerPrompt: (...args) => runWithSubmitPlacement(() => actions.onSteerPrompt(...args)),
      ...(resumeInterruptedTurn
        ? {
            onResumeInterruptedTurn: () => runWithSubmitPlacement(resumeInterruptedTurn),
          }
        : {}),
      onEnqueueQueuedFollowUp: (...args) =>
        runWithSubmitPlacement(() => actions.onEnqueueQueuedFollowUp(...args), true),
      onSendQueuedFollowUpNow: (...args) =>
        runWithSubmitPlacement(() => actions.onSendQueuedFollowUpNow(...args)),
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
        catchUpControl={catchUpControl}
      />
    </div>
  );
}

export const LocalConversationFooter = memo(LocalConversationFooterComponent);
