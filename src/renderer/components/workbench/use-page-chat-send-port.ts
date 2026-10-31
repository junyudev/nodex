import { useCallback } from "react";
import type { WorkbenchSubmitPresentation } from "../../../shared/nodex-app-tools/workbench";
import type { ContentRoutingContext } from "../../../shared/content-routing-context";
import { prepareAgentMessage } from "../../../shared/agent-prompt";
import { createUuidV7 } from "../../../shared/uuid-v7";
import { sessionFirstSubmissionOwner } from "@/features/conversation-launch/session-first-submission-owner";
import { agentRuntimePromptImages } from "@/lib/agent-runtime-prompt";
import { agentRuntimeRuntime } from "@/lib/agent-runtime-runtime";
import { readPastedTextAttachment } from "@/lib/api";
import {
  captureCodexTurnPresentation,
  readCodexSubmissionPresentation,
} from "@/lib/codex-turn-presentation";
import { materializePromptFileImages } from "@/lib/prompt-file-images";
import { useScopedAtomValue } from "@/lib/maitai";
import { threadQueueFollowUpsEnabledAtom } from "@/lib/thread-queue-follow-ups-atom";
import type { CodexPromptInput } from "@/lib/types";
import { useAgentRuntimeSessionLaunch } from "@/lib/use-agent-runtime-session-launch";
import { useWorkbenchWindowOwner } from "@/lib/use-workbench-window-state";
import type { WorkbenchSessionRenderProjection } from "@/lib/workbench-session-presentation";
import type { PageChatSendResult } from "@/lib/page-chat-send";

export interface PageChatSendPortInput {
  /** The Page's own route; Library File images are read through it. */
  readonly routingContext: ContentRoutingContext;
  readonly pageId: string;
  readonly onEnsureDefaultDraftSessionForProject: (
    projectId: string,
    options?: { select?: boolean },
  ) => Promise<WorkbenchSessionRenderProjection>;
  readonly onRefreshSessions: (projectId: string) => Promise<unknown>;
  readonly onResolveChatSessionForThread: (threadId: string) => Promise<{
    readonly id: string;
    readonly projectId: string | null;
    readonly executionRef?: { readonly runtimeId: string; readonly threadId: string } | null;
  }>;
  readonly onLinkPageToChat: (input: {
    readonly pageId: string;
    readonly sessionId: string;
  }) => Promise<void>;
  /** Present when the Page is shown beside a chat whose draft can take Page content. */
  readonly onAddToChatComposer?: (promptInput: CodexPromptInput) => void;
}

/**
 * The one way a Page's content reaches a chat, whatever route presents the Page: start a new
 * chat with it, send it to an existing chat, or add it to the beside chat's draft.
 */
export function usePageChatSendPort({
  routingContext,
  pageId,
  onEnsureDefaultDraftSessionForProject,
  onRefreshSessions,
  onResolveChatSessionForThread,
  onLinkPageToChat,
  onAddToChatComposer,
}: PageChatSendPortInput) {
  const workbenchOwner = useWorkbenchWindowOwner();
  const launchAgentRuntimeSession = useAgentRuntimeSessionLaunch();
  const queueFollowUps = useScopedAtomValue(threadQueueFollowUpsEnabledAtom);

  const startNewSessionThread = useCallback(
    async (input: {
      projectId: string;
      targetSessionId?: string;
      prompt: string;
      promptInput?: CodexPromptInput;
      threadName?: string;
      submittedPresentation?: WorkbenchSubmitPresentation;
    }): Promise<PageChatSendResult> => {
      const submittedPresentation =
        input.submittedPresentation ?? readCodexSubmissionPresentation(workbenchOwner);
      const identity = {
        launchId: createUuidV7(),
        clientUserMessageId: createUuidV7(),
        acceptedAt: Date.now(),
      };
      const promptInput = await materializePromptFileImages(
        routingContext,
        { kind: "page", page_id: pageId },
        input.promptInput,
      );
      const targetSessionId =
        input.targetSessionId?.trim() ||
        (await onEnsureDefaultDraftSessionForProject(input.projectId, { select: false })).id;
      const presentationTicket = await captureCodexTurnPresentation(
        workbenchOwner,
        { kind: "session", sessionId: targetSessionId, launchId: identity.launchId },
        submittedPresentation,
      );
      // Launch links the Page in its binding transaction, so a rejected launch leaves no link.
      const submission = sessionFirstSubmissionOwner.begin({
        backend: "codex",
        originProjectId: input.projectId,
        originSessionId: targetSessionId,
        prompt: input.prompt,
        promptInput,
        identity,
      });
      sessionFirstSubmissionOwner.update(submission.launchId, { phase: "startingThread" });
      try {
        const result = await launchAgentRuntimeSession({
          projectId: input.projectId,
          sessionId: targetSessionId,
          prompt: input.prompt,
          promptInput,
          title: input.threadName,
          initialPageIds: [pageId],
          onSelectionResolved: (backend) =>
            sessionFirstSubmissionOwner.update(submission.launchId, { backend }),
          presentationTicket,
          launchIdentity: {
            launchId: submission.launchId,
            messageId: submission.clientUserMessageId,
            acceptedAt: submission.acceptedAt,
          },
        });
        sessionFirstSubmissionOwner.update(submission.launchId, {
          threadId: result.threadId,
          phase: "startingTurn",
        });
        await onRefreshSessions(input.projectId);
        return {
          threadId: result.threadId,
          sessionId: result.sessionId,
          messageId: submission.clientUserMessageId,
        };
      } catch (cause) {
        sessionFirstSubmissionOwner.fail(submission.launchId, {
          stage: "startingThread",
          message: cause instanceof Error ? cause.message : String(cause),
        });
        throw cause;
      }
    },
    [
      launchAgentRuntimeSession,
      onEnsureDefaultDraftSessionForProject,
      onRefreshSessions,
      pageId,
      routingContext,
      workbenchOwner,
    ],
  );

  const sendPagePrompt = useCallback(
    async ({
      threadId,
      prompt,
      promptInput,
      submittedPresentation: origin,
    }: {
      projectId: string;
      threadId: string;
      prompt: string;
      promptInput?: CodexPromptInput;
      submittedPresentation?: WorkbenchSubmitPresentation;
    }): Promise<PageChatSendResult> => {
      const submittedPresentation = origin ?? readCodexSubmissionPresentation(workbenchOwner);
      const materializedInput = await materializePromptFileImages(
        routingContext,
        { kind: "page", page_id: pageId },
        promptInput,
      );
      const targetSession = await onResolveChatSessionForThread(threadId);
      if (!targetSession.executionRef)
        throw new Error(
          "This imported conversation has no execution owner. Open a new chat to send.",
        );
      const target = { sessionId: targetSession.id, threadId };
      await agentRuntimeRuntime.inspect(target);
      const presentationTicket = await captureCodexTurnPresentation(
        workbenchOwner,
        { kind: "thread", threadId },
        submittedPresentation,
      );
      await onLinkPageToChat({ pageId, sessionId: targetSession.id });
      // A Page send into a running chat follows the Composer's own Queue/Steer default,
      // the same one its send controls describe.
      const deliver = queueFollowUps
        ? agentRuntimeRuntime.queueMessage
        : agentRuntimeRuntime.message;
      const messageId = createUuidV7();
      await deliver({
        ...target,
        presentationTicket,
        message: {
          messageId,
          ...(await prepareAgentMessage(
            prompt,
            materializedInput,
            (file) => readPastedTextAttachment({ file }),
            { images: true, agentConfigs: true },
          )),
          images: agentRuntimePromptImages(materializedInput),
          ...(materializedInput?.agentConfigs !== undefined
            ? { agentConfigs: materializedInput.agentConfigs }
            : {}),
        },
      });
      return { ...target, messageId };
    },
    [
      onLinkPageToChat,
      onResolveChatSessionForThread,
      pageId,
      queueFollowUps,
      routingContext,
      workbenchOwner,
    ],
  );

  const addPromptToChatComposer = useCallback(
    async (promptInput: CodexPromptInput) => {
      onAddToChatComposer?.(
        (await materializePromptFileImages(
          routingContext,
          { kind: "page", page_id: pageId },
          promptInput,
        )) ?? promptInput,
      );
    },
    [onAddToChatComposer, pageId, routingContext],
  );

  return {
    onStartNewSessionThreadFromEditor: startNewSessionThread,
    onSendPagePrompt: sendPagePrompt,
    ...(onAddToChatComposer ? { onAddPromptToChatComposer: addPromptToChatComposer } : {}),
  };
}
