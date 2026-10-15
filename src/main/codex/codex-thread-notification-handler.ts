import type {
  DesktopNotificationActionInvocation,
  DesktopNotificationActionPayload,
  DesktopNotificationHideSelector,
  DesktopNotificationPayload,
  ThreadNotificationSettings,
} from "../../shared/types";
import { DEFAULT_CODEX_HOST_ID } from "../../shared/codex-host";
import {
  buildCodexAsyncQuestionNotificationId,
  buildCodexQuestionNotificationId,
  buildCodexRequestNotificationOccurrenceId,
  buildCodexTurnNotificationId,
  buildCodexTurnNotificationOccurrenceId,
  decideCodexRequestNotification,
  decideCodexTurnNotification,
  resolveCodexQuestionNotificationBody,
  resolveCodexQuestionNotificationTitle,
  resolveCodexTurnNotificationBody,
  resolveCodexTurnNotificationTitle,
  type CodexThreadNotificationEvent,
} from "../../shared/codex-thread-notification";

export interface CodexThreadNotificationHandlerOptions {
  getSettings: () => ThreadNotificationSettings;
  isAppForegrounded: () => boolean;
  isConversationPresentedInForeground: (conversationId: string) => boolean;
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
  if (parentPath.length > 0) {
    return {
      navigationPath: parentPath,
      activateTabId: `sidechat:${event.conversation.conversationId}`,
    };
  }
  const sessionId = event.conversation.runtimeSessionId?.trim() ?? "";
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
    ...(event.type === "user-input-requested" ? { requestId: event.requestId } : {}),
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
      requestId: event.type === "user-input-requested" ? event.requestId : null,
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
  ): ((event: CodexThreadNotificationEvent) => void) =>
  (event) => {
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
          "question",
          event.hostId,
          event.conversationId,
          event.requestId,
        ),
      });
      return;
    }

    const settings = options.getSettings();
    if (event.type === "turn-completed") {
      const decision = decideCodexTurnNotification(event, {
        turnMode: settings.turnMode,
        isAppForegrounded: options.isAppForegrounded(),
        includeTurnNotifications: event.hostId === DEFAULT_CODEX_HOST_ID,
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
      isConversationPresentedInForeground: options.isConversationPresentedInForeground(
        event.conversation.conversationId,
      ),
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
