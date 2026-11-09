import type {
  DesktopNotificationActionInvocation,
  DesktopNotificationActionPayload,
  DesktopNotificationHideSelector,
  DesktopNotificationPayload,
  ThreadNotificationSettings,
} from "../../shared/types";
import { nativeSideChatTabId, runtimeSideChatTabId } from "../../shared/side-chat-tab";
import {
  buildCodexApprovalNotificationId,
  buildCodexAsyncQuestionNotificationId,
  buildCodexQuestionNotificationId,
  buildCodexRequestNotificationOccurrenceId,
  buildCodexTurnNotificationId,
  buildCodexTurnNotificationOccurrenceId,
  decideCodexRequestNotification,
  decideCodexTurnNotification,
  resolveCodexApprovalNotificationBody,
  resolveCodexApprovalNotificationTitle,
  resolveCodexQuestionNotificationBody,
  resolveCodexQuestionNotificationTitle,
  resolveCodexTurnNotificationBody,
  resolveCodexTurnNotificationTitle,
  type CodexNotificationConversationFacts,
  type CodexThreadNotificationEvent,
} from "../../shared/codex-thread-notification";

export interface CodexThreadNotificationHandlerOptions {
  getSettings: () => ThreadNotificationSettings;
  isAppForegrounded: () => boolean;
  /** The conversation is in front of the person, in a focused window or on a phone. */
  isConversationSeen: (hostId: string, conversation: CodexNotificationConversationFacts) => boolean;
  resolveTargetClientId: (conversationId: string) => string | null;
  showNotification: (
    notification: DesktopNotificationPayload,
    targetClientId: string,
    onAction: (action: DesktopNotificationActionPayload) => void,
  ) => void;
  dismissNotification: (selector: DesktopNotificationHideSelector) => void;
  dispatchAction: (targetClientId: string, action: DesktopNotificationActionInvocation) => boolean;
  focusTargetClient: (targetClientId: string) => void;
  logger?: Pick<Console, "debug" | "warn">;
}

function resolveNavigation(
  event: Exclude<
    CodexThreadNotificationEvent,
    { type: "request-resolved" | "async-question-resolved" }
  >,
): {
  navigationPath: string;
  activateTabId: string | null;
} {
  const parentPath = event.conversation.sideConversationParentNavigationPath?.trim() ?? "";
  const sessionId = event.conversation.runtimeSessionId?.trim() ?? "";
  if (parentPath.length > 0) {
    return {
      navigationPath: parentPath,
      activateTabId: sessionId
        ? runtimeSideChatTabId(sessionId)
        : nativeSideChatTabId(event.conversation.conversationId),
    };
  }
  if (sessionId && event.conversation.conversationId === `session:${sessionId}`)
    return { navigationPath: `session:${encodeURIComponent(sessionId)}`, activateTabId: null };
  const threadPath = `thread:${encodeURIComponent(event.conversation.conversationId)}`;
  return {
    navigationPath:
      sessionId.length > 0 ? `session:${encodeURIComponent(sessionId)}/${threadPath}` : threadPath,
    activateTabId: null,
  };
}

function showNotification(
  options: CodexThreadNotificationHandlerOptions,
  event: Exclude<
    CodexThreadNotificationEvent,
    { type: "request-resolved" | "async-question-resolved" }
  >,
  copy: Pick<
    DesktopNotificationPayload,
    "id" | "occurrenceId" | "kind" | "title" | "body" | "actions" | "replyPlaceholder"
  >,
): void {
  const conversationId = event.conversation.conversationId;
  const targetClientId = options.resolveTargetClientId(conversationId);
  if (!targetClientId) {
    options.logger?.warn("[desktop-notifications] dropped", {
      conversationId,
      reason: "no-live-target",
      type: event.type,
    });
    return;
  }
  const navigation = resolveNavigation(event);
  const notification: DesktopNotificationPayload = {
    ...copy,
    ...(event.type === "async-question-requested"
      ? { asyncQuestion: { turnId: event.turnId, questionId: event.questionId } }
      : {}),
    hostId: event.hostId,
    conversationId,
    navigationPath: navigation.navigationPath,
    activateTabId: navigation.activateTabId,
    ...(event.type === "user-input-requested" || event.type === "approval-requested"
      ? { requestId: event.requestId }
      : {}),
  };

  options.showNotification(notification, targetClientId, (action) => {
    if (action.actionType === "open") {
      options.focusTargetClient(targetClientId);
    }
    const dispatched = options.dispatchAction(targetClientId, {
      ...action,
      ...(event.type === "async-question-requested"
        ? { asyncQuestion: { turnId: event.turnId, questionId: event.questionId } }
        : {}),
      hostId: event.hostId,
      conversationId,
      navigationPath: navigation.navigationPath,
      activateTabId: navigation.activateTabId,
      requestId:
        event.type === "user-input-requested" || event.type === "approval-requested"
          ? event.requestId
          : null,
    });
    if (!dispatched) {
      options.dismissNotification(
        notification.occurrenceId
          ? { occurrenceId: notification.occurrenceId }
          : { notificationId: notification.id },
      );
    }
  });
}

/** Pure notification policy; listener and action admission belong to the host runtime Scope. */
export const makeCodexThreadNotificationHandler =
  (
    options: CodexThreadNotificationHandlerOptions,
  ): ((event: CodexThreadNotificationEvent, facts?: { managed: boolean }) => void) =>
  (event, facts = { managed: false }) => {
    if (event.type === "async-question-resolved") {
      options.dismissNotification({
        notificationId: buildCodexAsyncQuestionNotificationId(
          event.hostId,
          event.conversationId,
          event.turnId,
          event.questionId,
        ),
      });
      return;
    }
    if (event.type === "request-resolved") {
      options.dismissNotification({
        occurrenceId: buildCodexRequestNotificationOccurrenceId(
          event.family ?? "question",
          event.hostId,
          event.conversationId,
          event.requestId,
        ),
      });
      return;
    }

    const settings = options.getSettings();
    if (event.type === "session-reminder") {
      if (
        settings.turnMode === "off" ||
        (settings.turnMode === "unfocused" && options.isAppForegrounded()) ||
        options.isConversationSeen(event.hostId, event.conversation)
      )
        return;
      const id = JSON.stringify([
        "session-reminder",
        event.conversation.runtimeSessionId,
        event.remindAt,
      ]);
      showNotification(options, event, {
        id,
        occurrenceId: id,
        kind: "reminder",
        title: event.conversation.title?.trim() || "Chat",
        body: "You asked to come back to this chat.",
      });
      return;
    }
    if (event.type === "turn-completed") {
      const decision = decideCodexTurnNotification(event, {
        managed: facts.managed,
        turnMode: settings.turnMode,
        isAppForegrounded: options.isAppForegrounded(),
        isConversationSeen: options.isConversationSeen(event.hostId, event.conversation),
      });
      if (decision.type === "suppress") {
        options.logger?.debug("[desktop-notifications] suppressed", {
          type: event.type,
          conversationId: event.conversation.conversationId,
          reason: decision.reason,
        });
        return;
      }
      showNotification(options, event, {
        id: buildCodexTurnNotificationId(event.turnId),
        occurrenceId: buildCodexTurnNotificationOccurrenceId(
          event.hostId,
          event.conversation.conversationId,
          event.turnId,
        ),
        kind: "turn-complete",
        title: resolveCodexTurnNotificationTitle(event.conversation.title),
        body: resolveCodexTurnNotificationBody(event),
        replyPlaceholder: "Reply to Nodex",
      });
      return;
    }

    const decision = decideCodexRequestNotification(event.conversation, {
      enabled: settings.questionsEnabled,
      isConversationSeen: options.isConversationSeen(event.hostId, event.conversation),
    });
    if (decision.type === "suppress") {
      options.logger?.debug("[desktop-notifications] suppressed", {
        type: event.type,
        conversationId: event.conversation.conversationId,
        reason: decision.reason,
      });
      return;
    }

    if (event.type === "async-question-requested") {
      const id = buildCodexAsyncQuestionNotificationId(
        event.hostId,
        event.conversation.conversationId,
        event.turnId,
        event.questionId,
      );
      showNotification(options, event, {
        id,
        occurrenceId: id,
        kind: "question",
        title: resolveCodexQuestionNotificationTitle(event.conversation.title),
        body: "Nodex has a question",
      });
      return;
    }

    if (event.type === "approval-requested") {
      showNotification(options, event, {
        id: buildCodexApprovalNotificationId(event.hostId, event.requestId),
        occurrenceId: buildCodexRequestNotificationOccurrenceId(
          "approval",
          event.hostId,
          event.conversation.conversationId,
          event.requestId,
        ),
        kind: "question",
        title: resolveCodexApprovalNotificationTitle(event.conversation.title),
        body: resolveCodexApprovalNotificationBody(event.prompt),
      });
      return;
    }

    showNotification(options, event, {
      id: buildCodexQuestionNotificationId(event.hostId, event.requestId),
      occurrenceId: buildCodexRequestNotificationOccurrenceId(
        "question",
        event.hostId,
        event.conversation.conversationId,
        event.requestId,
      ),
      kind: "question",
      title: resolveCodexQuestionNotificationTitle(event.conversation.title),
      body: resolveCodexQuestionNotificationBody(event.questionCount),
    });
  };
