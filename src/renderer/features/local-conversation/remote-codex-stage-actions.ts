import type { useCodexAppServerControl } from "./local-conversation-store";
import { composeNativeThreadStageActions } from "./native-thread-stage-actions";
import type { ThreadStageActions, ThreadStageHostActions } from "./thread-stage-types";

/** An attached remote owner controls its own native conversation; it cannot launch a local Session. */
export function createRemoteCodexStageActions(input: {
  readonly hostId: string;
  readonly threadId: string;
  readonly projectId: string | null;
  readonly control: ReturnType<typeof useCodexAppServerControl>;
  readonly host: ThreadStageHostActions;
  readonly onModeChanged?: ThreadStageActions["onCollaborationModeChange"];
}): ThreadStageActions {
  if (!input.hostId.trim() || input.hostId === "local" || !input.threadId.trim())
    throw new Error("Remote conversation controls require an attached remote owner");
  const { control, threadId, projectId } = input;
  const requireThread = (requested: string) => {
    if (requested !== threadId) throw new Error("Remote conversation identity changed");
    return threadId;
  };
  const project = projectId === null ? {} : { projectId };
  return composeNativeThreadStageActions(input.host, {
    onCaptureSubmissionPresentation: control.captureSubmissionPresentation,
    onCollaborationModeChange: async (collaborationMode) => {
      await control.setConversationThreadSettings(threadId, { collaborationMode });
      await input.onModeChanged?.(collaborationMode);
    },
    onModelChange: async (model) => {
      await control.setConversationThreadSettings(threadId, { model });
    },
    onReasoningEffortChange: async (reasoningEffort) => {
      await control.setConversationThreadSettings(threadId, { reasoningEffort });
    },
    onIntelligenceSelectionChange: async (selection, options) => {
      await control.setConversationThreadSettings(threadId, {
        ...options,
        model: selection.model,
        reasoningEffort: selection.reasoningEffort,
        serviceTier: selection.serviceTier,
      });
    },
    onSendPrompt: async (prompt, options) => {
      await control.startTurn(
        threadId,
        prompt,
        { ...project, ...options },
        options?.submittedPresentation,
      );
    },
    onSteerPrompt: async (request) => {
      await control.steerTurn({ ...request, threadId });
    },
    onInterruptTurn: async (turnId) => {
      await control.interruptTurn(threadId, turnId);
    },
    onContinueAfterFailure: async (turnId) => {
      await control.continueFailedTurn(threadId, turnId, control.captureSubmissionPresentation());
    },
    onResumeInterruptedTurn: async () => {
      await control.resumeInterruptedTurn(
        threadId,
        project,
        control.captureSubmissionPresentation(),
      );
    },
    onRespondUserInput: async (requestId, answers) => {
      await control.respondUserInput(requestId, answers, threadId);
    },
    onRespondMcpElicitation: async (requestId, response) => {
      await control.respondMcpElicitation(requestId, response, threadId);
    },
    onRespondOptionPicker: async (requestId, response) => {
      await control.respondOptionPicker(threadId, requestId, response);
    },
    onRespondSetupCodexStep: async (requestId, response) => {
      await control.respondSetupCodexStep(threadId, requestId, response);
    },
    onResolvePlanImplementationRequest: async (requested, turnId) => {
      await control.removePlanImplementationRequest(requireThread(requested), turnId);
    },
    onEnqueueQueuedFollowUp: async (requested, prompt, options) => {
      await control.enqueueQueuedFollowUp(requireThread(requested), prompt, {
        ...project,
        ...options,
      });
    },
    onSendCapturedFollowUp: async (requested, prompt, options) => {
      await control.sendCapturedFollowUp(requireThread(requested), prompt, {
        ...project,
        ...options,
      });
    },
    onRemoveQueuedFollowUp: async (requested, id) => {
      await control.removeQueuedFollowUp(requireThread(requested), id);
    },
    onReplaceQueuedFollowUp: async (requested, id, revision, prompt, options) => {
      return await control.replaceQueuedFollowUp(requireThread(requested), id, revision, prompt, {
        collaborationMode: options?.collaborationMode ?? undefined,
        promptInput: options?.promptInput,
      });
    },
    onReorderQueuedFollowUps: async (requested, ids) => {
      await control.reorderQueuedFollowUps(requireThread(requested), ids);
    },
    onResumeQueuedFollowUps: async (requested) => {
      await control.resumeQueuedFollowUps(requireThread(requested));
    },
    onResolveQueuedFollowUpsAfterFreshStart: async (requested, revision, resolution) => {
      return await control.resolveQueuedFollowUpsAfterFreshStart(
        requireThread(requested),
        revision,
        resolution,
      );
    },
    onSendQueuedFollowUpNow: async (requested, id) => {
      await control.sendQueuedFollowUpNow(requireThread(requested), id);
    },
    onEditQueuedFollowUp: async ({
      threadId: requested,
      followUpId,
      prompt,
      promptInput,
      ledgerRevision,
    }) => {
      control.setComposerIntent(requireThread(requested), {
        prompt,
        promptInput,
        queuedFollowUpEdit: { followUpId, ledgerRevision: ledgerRevision ?? 0 },
        focusNonce: Date.now(),
      });
    },
    onEditUserTurn: async ({ threadId: requested, turnId, message }) => {
      await control.editUserTurn(requireThread(requested), turnId, message);
    },
    onForkFromTurn: async ({ threadId: requested, turnId, message }) => {
      const result = await control.forkConversationFromTurn(
        requireThread(requested),
        turnId,
        message,
      );
      await control.requestThreadStreamSnapshot(result.threadId);
      if (result.composerIntent) control.setComposerIntent(result.threadId, result.composerIntent);
      await input.host.onOpenThread(result.threadId, { hostId: input.hostId });
    },
    onCompactThread: async (requested) => {
      await control.compactThread(requireThread(requested));
    },
    onGetThreadGoal: control.getThreadGoal,
    onSetThreadGoal: control.setThreadGoal,
    onClearThreadGoal: control.clearThreadGoal,
    onDismissThreadGoalResumeConfirmation: control.dismissThreadGoalResumeConfirmation,
    onSetThreadMemoryMode: control.setThreadMemoryMode,
    onUploadFeedback: control.uploadFeedback,
    onUnarchiveThread: async (requested, targetProject) => {
      await control.unarchiveThread(requireThread(requested), targetProject);
    },
    onConsumeComposerIntent: (requested, nonce) => {
      control.consumeComposerIntent(requireThread(requested), nonce);
    },
    onCleanBackgroundTerminals: async (requested) => {
      await control.cleanBackgroundTerminals(requireThread(requested));
    },
  });
}
