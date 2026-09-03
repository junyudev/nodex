import type {
  CodexConversationSnapshot,
  CodexConversationTurn,
  PageRunInTarget,
} from "../../../lib/types";
import type { ThreadBodyModel } from "../thread-stage-types";
import type { LocalConversationAttachmentState } from "../conversation-attachment-state";
import { selectVisibleConversationTurnEntries } from "../selectors";

export interface ThreadBodyModelInput {
  activeThreadId: string | null;
  conversation: CodexConversationSnapshot | null;
  attachmentState?: LocalConversationAttachmentState;
  activeThreadArchived: boolean;
  parentTurns: readonly CodexConversationTurn[];
  isNewThreadTab: boolean;
  newThreadTarget: {
    projectId: string | null;
    projectName: string;
    sessionId: string;
    threadTitle?: string;
    runInTarget?: "localProject" | "newWorktree" | "cloud";
  } | null;
  isCloudNewThreadTarget: boolean;
  threadStartProgress: {
    runInTarget: PageRunInTarget;
    threadId?: string | null;
    phase: "creatingWorktree" | "runningSetup" | "startingThread" | "ready" | "failed";
    message: string;
    outputText: string;
    updatedAt: number;
  } | null;
  firstSubmissionActive?: boolean;
}

export type ThreadStartProgressPresentation = "hidden" | "panel";

export interface ThreadStartProgressPresentationInput {
  runInTarget: PageRunInTarget;
  phase: "creatingWorktree" | "runningSetup" | "startingThread" | "ready" | "failed";
}

export function resolveThreadStartProgressPresentation(
  progress: ThreadStartProgressPresentationInput | null,
): ThreadStartProgressPresentation {
  if (!progress) {
    return "hidden";
  }

  if (progress.phase === "failed") {
    return "panel";
  }

  if (progress.runInTarget !== "newWorktree") {
    return "hidden";
  }

  if (progress.phase === "ready") {
    return "hidden";
  }

  return "panel";
}

export function buildThreadBodyModel(input: ThreadBodyModelInput): ThreadBodyModel {
  const conversation =
    input.conversation?.threadId === input.activeThreadId ? input.conversation : null;
  const resumeState = conversation?.resumeState ?? (input.activeThreadId ? "needs_resume" : null);
  const attachmentState: LocalConversationAttachmentState =
    input.attachmentState ??
    (resumeState === "resuming" ? { status: "attaching" } : { status: "idle" });
  const isArchivedThread = Boolean(
    input.activeThreadId && (input.activeThreadArchived || conversation?.archived),
  );
  const threadStartProgressPresentation = resolveThreadStartProgressPresentation(
    input.threadStartProgress,
  );
  const hasThreadStartProgress = Boolean(input.threadStartProgress);
  const showThreadStartProgressPanel = threadStartProgressPresentation === "panel";
  const hasSilentThreadStartProgress = hasThreadStartProgress && !showThreadStartProgressPanel;
  const showDetachedThreadStartProgressPanel = Boolean(
    input.isNewThreadTab && !conversation && input.newThreadTarget && showThreadStartProgressPanel,
  );

  if (isArchivedThread) {
    return {
      threadId: input.activeThreadId,
      turnCount: 0,
      isThreadRunning: false,
      activeTurnId: null,
      latestTurnId: null,
      showThreadStartProgressPanel: false,
      emptyState: {
        type: "archivedThread",
        title: "Archived thread",
        description: "Restore this thread before continuing.",
      },
    };
  }

  if (!conversation) {
    if (input.firstSubmissionActive) {
      return {
        threadId: input.activeThreadId,
        turnCount: 1,
        isThreadRunning: true,
        activeTurnId: null,
        latestTurnId: null,
        showThreadStartProgressPanel: false,
        emptyState: { type: "none" },
      };
    }
    if (input.activeThreadId && resumeState) {
      if (attachmentState.status === "failed") {
        return {
          threadId: input.activeThreadId,
          turnCount: 0,
          isThreadRunning: false,
          activeTurnId: null,
          latestTurnId: null,
          showThreadStartProgressPanel: false,
          emptyState: {
            type: "threadAttachmentFailed",
            title: "Thread could not be restored",
            description: attachmentState.message,
          },
        };
      }
      if (hasThreadStartProgress) {
        return {
          threadId: input.activeThreadId,
          turnCount: 0,
          isThreadRunning: false,
          activeTurnId: null,
          latestTurnId: null,
          showThreadStartProgressPanel,
          emptyState: {
            type: "resumingThread",
            title: "Preparing thread",
            description:
              "Waiting for the first visible turn before presenting the attached thread.",
            status: resumeState,
          },
        };
      }

      return {
        threadId: input.activeThreadId,
        turnCount: 0,
        isThreadRunning: false,
        activeTurnId: null,
        latestTurnId: null,
        showThreadStartProgressPanel: false,
        emptyState: {
          type: "resumingThread",
          title: resumeState === "resuming" ? "Restoring thread" : "Preparing thread",
          description:
            resumeState === "resuming"
              ? "Loading the latest conversation state before rendering the thread."
              : "This thread needs to resume before the mounted conversation view can render.",
          status: resumeState,
        },
      };
    }

    if (input.isNewThreadTab) {
      if (hasSilentThreadStartProgress) {
        return {
          threadId: null,
          turnCount: 0,
          isThreadRunning: false,
          activeTurnId: null,
          latestTurnId: null,
          showThreadStartProgressPanel: false,
          emptyState: { type: "none" },
        };
      }

      return {
        threadId: null,
        turnCount: 0,
        isThreadRunning: false,
        activeTurnId: null,
        latestTurnId: null,
        showThreadStartProgressPanel: showDetachedThreadStartProgressPanel,
        emptyState: {
          type: "newThread",
          title: "Start a new thread",
          description: input.newThreadTarget
            ? input.isCloudNewThreadTarget
              ? "Cloud run target is mock-only right now. Change the start target to Local project or New worktree."
              : "Write the first prompt and send to create a new session thread."
            : "Select a project session to start a new thread.",
        },
      };
    }

    if (hasSilentThreadStartProgress) {
      return {
        threadId: null,
        turnCount: 0,
        isThreadRunning: false,
        activeTurnId: null,
        latestTurnId: null,
        showThreadStartProgressPanel: false,
        emptyState: { type: "none" },
      };
    }

    return {
      threadId: null,
      turnCount: 0,
      isThreadRunning: false,
      activeTurnId: null,
      latestTurnId: null,
      showThreadStartProgressPanel: showDetachedThreadStartProgressPanel,
      emptyState: {
        type: "noThread",
        title: "No thread selected",
        description: "Select a thread from the sidebar to view the conversation.",
      },
    };
  }

  if (conversation.resumeState !== "resumed" && attachmentState.status !== "failed") {
    if (hasThreadStartProgress) {
      return {
        threadId: conversation.threadId,
        turnCount: 0,
        isThreadRunning: false,
        activeTurnId: null,
        latestTurnId: null,
        showThreadStartProgressPanel,
        emptyState: { type: "none" },
      };
    }

    return {
      threadId: conversation.threadId,
      turnCount: 0,
      isThreadRunning: false,
      activeTurnId: null,
      latestTurnId: null,
      showThreadStartProgressPanel: false,
      emptyState: {
        type: "resumingThread",
        title: conversation.resumeState === "resuming" ? "Restoring thread" : "Preparing thread",
        description:
          conversation.resumeState === "resuming"
            ? "Loading the latest conversation state before rendering the thread."
            : "This thread needs to resume before the mounted conversation view can render.",
        status: conversation.resumeState,
      },
    };
  }

  const visibleEntries = selectVisibleConversationTurnEntries({
    conversation,
    parentTurns: input.parentTurns,
  });
  const activeTurnId =
    [...visibleEntries].reverse().find((entry) => entry.turn.status === "inProgress")?.turnId ??
    null;
  const latestTurnId = visibleEntries[visibleEntries.length - 1]?.turnId ?? null;
  const visibleTurnCount = visibleEntries.length;
  const isThreadRunning = conversation.statusType === "active" || activeTurnId !== null;

  if (visibleTurnCount === 0 && attachmentState.status === "failed") {
    return {
      threadId: conversation.threadId,
      turnCount: 0,
      isThreadRunning,
      activeTurnId,
      latestTurnId,
      showThreadStartProgressPanel: false,
      emptyState: {
        type: "threadAttachmentFailed",
        title: "Thread could not be restored",
        description: attachmentState.message,
      },
    };
  }

  if (visibleTurnCount === 0) {
    if (hasThreadStartProgress) {
      return {
        threadId: conversation.threadId,
        turnCount: 0,
        isThreadRunning,
        activeTurnId,
        latestTurnId,
        showThreadStartProgressPanel,
        emptyState: { type: "none" },
      };
    }

    return {
      threadId: conversation.threadId,
      turnCount: 0,
      isThreadRunning,
      activeTurnId,
      latestTurnId,
      showThreadStartProgressPanel: false,
      emptyState: {
        type: "emptyThread",
        title: "No messages yet",
        description: "Send a prompt to begin.",
      },
    };
  }

  return {
    threadId: conversation.threadId,
    turnCount: visibleTurnCount,
    isThreadRunning,
    activeTurnId,
    latestTurnId,
    showThreadStartProgressPanel: false,
    emptyState: { type: "none" },
  };
}
