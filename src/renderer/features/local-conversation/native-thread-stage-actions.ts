import type { ThreadStageActions, ThreadStageHostActions } from "./thread-stage-types";

const unavailable = async (): Promise<never> => {
  throw new Error("This action is unavailable for the selected Agent");
};

/** Keep shared presentation actions explicit; a missing native handler never falls through to Codex. */
export function composeNativeThreadStageActions(
  host: ThreadStageHostActions,
  native: Partial<ThreadStageActions>,
): ThreadStageActions {
  return {
    onQueueingEnabledChange: host.onQueueingEnabledChange,
    onNewThreadProjectChange: host.onNewThreadProjectChange,
    onRequestNewChatProjectCreate: host.onRequestNewChatProjectCreate,
    onNewThreadStartInTargetChange: host.onNewThreadStartInTargetChange,
    onNewThreadStartInEnvironmentChange: host.onNewThreadStartInEnvironmentChange,
    onRefreshNewThreadStartInEnvironments: host.onRefreshNewThreadStartInEnvironments,
    onOpenNewThreadLocalEnvironmentsSettings: host.onOpenNewThreadLocalEnvironmentsSettings,
    onOpenVoiceSettings: host.onOpenVoiceSettings,
    onOpenSummaryBrowserRow: host.onOpenSummaryBrowserRow,
    onOpenSummaryScheduledAutomation: host.onOpenSummaryScheduledAutomation,
    onOpenSummaryOutputInSidePanel: host.onOpenSummaryOutputInSidePanel,
    onOpenSummaryGitReview: host.onOpenSummaryGitReview,
    onOpenProcessManager: host.onOpenProcessManager,
    onOpenBackgroundTerminalOutput: host.onOpenBackgroundTerminalOutput,
    onRequestRenameThread: host.onRequestRenameThread,
    onArchiveThread: host.onArchiveThread,
    onToggleThreadPin: host.onToggleThreadPin,
    onConsumeNewThreadComposerIntent: host.onConsumeNewThreadComposerIntent,
    onOpenThread: host.onOpenThread,
    onOpenTurnDiffReview: host.onOpenTurnDiffReview,
    onOpenTurnDiffFileInSidePanel: host.onOpenTurnDiffFileInSidePanel,
    onCollaborationModeChange: unavailable,
    onModelChange: unavailable,
    onReasoningEffortChange: unavailable,
    onPermissionModeChange: unavailable,
    onSendPrompt: unavailable,
    onSteerPrompt: unavailable,
    onInterruptTurn: unavailable,
    onRespondApproval: unavailable,
    onRespondUserInput: unavailable,
    onRespondMcpElicitation: unavailable,
    onResolvePlanImplementationRequest: unavailable,
    onEnqueueQueuedFollowUp: unavailable,
    onRemoveQueuedFollowUp: unavailable,
    onReorderQueuedFollowUps: unavailable,
    onSendQueuedFollowUpNow: unavailable,
    onEditQueuedFollowUp: unavailable,
    onEditLastUserTurn: unavailable,
    onForkFromTurn: unavailable,
    onUnarchiveThread: unavailable,
    onConsumeComposerIntent: () => undefined,
    onCleanBackgroundTerminals: unavailable,
    ...native,
  };
}
