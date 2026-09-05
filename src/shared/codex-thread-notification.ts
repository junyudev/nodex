import type { RequestId as CodexAppServerRequestId } from "@nodex/codex-app-server-protocol";
import {
  normalizeDesktopNotificationText,
  type CodexHeartbeatAssistantMessage,
  type CodexHeartbeatDecision,
} from "./codex-turn-notification";
import { extractCodexThreadSpawnMetadata } from "./codex-subagent-metadata";

export const DEFAULT_CODEX_NOTIFICATION_HOST_ID = "default";

export type CodexNotificationTurnStatus = "completed" | "failed" | "interrupted";
export type CodexNotificationApprovalKind = "commandExecution" | "fileChange" | "permissionRequest";

export interface CodexNotificationConversationFacts {
  conversationId: string;
  title: string | null;
  threadSource: string | null;
  parentThreadId: string | null;
  source: unknown;
  sideConversationParentNavigationPath: string | null;
}

export interface CodexTurnCompletedNotificationEvent {
  type: "turn-completed";
  hostId: string;
  conversation: CodexNotificationConversationFacts;
  turnId: string;
  status: CodexNotificationTurnStatus;
  lastAgentMessage: string | null;
  heartbeatAssistantMessage: CodexHeartbeatAssistantMessage | null;
  automationNotificationDecision: CodexHeartbeatDecision | null;
  hasPendingContinuation: boolean;
}

export interface CodexApprovalRequestedNotificationEvent {
  type: "approval-requested";
  hostId: string;
  conversation: CodexNotificationConversationFacts;
  requestId: CodexAppServerRequestId;
  turnId: string;
  approvalKind: CodexNotificationApprovalKind;
  reason: string | null;
}

export interface CodexUserInputRequestedNotificationEvent {
  type: "user-input-requested";
  hostId: string;
  conversation: CodexNotificationConversationFacts;
  requestId: CodexAppServerRequestId;
  turnId: string;
  questionCount: number;
}

export interface CodexRequestResolvedNotificationEvent {
  type: "request-resolved";
  hostId: string;
  conversationId: string;
  requestId: CodexAppServerRequestId;
}

export interface CodexAsyncQuestionNotificationEvent {
  type: "async-question-requested";
  hostId: string;
  conversation: CodexNotificationConversationFacts;
  turnId: string;
  questionId: string;
}

export interface CodexAsyncQuestionResolvedNotificationEvent {
  type: "async-question-resolved";
  hostId: string;
  conversationId: string;
  turnId: string;
  questionId: string;
}

export function buildCodexAsyncQuestionNotificationId(
  hostId: string,
  threadId: string,
  turnId: string,
  questionId: string,
): string {
  return JSON.stringify(["async-question", hostId, threadId, turnId, questionId]);
}

export type CodexThreadNotificationEvent =
  | CodexAsyncQuestionNotificationEvent
  | CodexAsyncQuestionResolvedNotificationEvent
  | CodexTurnCompletedNotificationEvent
  | CodexApprovalRequestedNotificationEvent
  | CodexUserInputRequestedNotificationEvent
  | CodexRequestResolvedNotificationEvent;

export type CodexNotificationSuppressionReason =
  | "app-focused"
  | "automation-dont-notify"
  | "child-conversation"
  | "conversation-presented"
  | "heartbeat-dont-notify"
  | "pending-continuation"
  | "realtime-voice"
  | "remote-host-turn"
  | "setting-disabled";

export type CodexNotificationDecision =
  | { type: "show" }
  | { type: "suppress"; reason: CodexNotificationSuppressionReason };

export interface CodexTurnNotificationPolicyFacts {
  turnMode: "off" | "unfocused" | "always";
  isAppForegrounded: boolean;
  includeTurnNotifications: boolean;
}

export interface CodexRequestNotificationPolicyFacts {
  enabled: boolean;
  isConversationPresentedInForeground: boolean;
}

export function isCodexNotificationChildConversation(
  conversation: Pick<CodexNotificationConversationFacts, "parentThreadId" | "source">,
): boolean {
  if ((conversation.parentThreadId?.trim() ?? "").length > 0) return true;
  return (extractCodexThreadSpawnMetadata(conversation.source).parentThreadId ?? "").length > 0;
}

export function decideCodexTurnNotification(
  event: CodexTurnCompletedNotificationEvent,
  policy: CodexTurnNotificationPolicyFacts,
): CodexNotificationDecision {
  if (!policy.includeTurnNotifications) {
    return { type: "suppress", reason: "remote-host-turn" };
  }
  if (event.automationNotificationDecision === "DONT_NOTIFY") {
    return { type: "suppress", reason: "automation-dont-notify" };
  }
  if (
    event.automationNotificationDecision === null &&
    event.heartbeatAssistantMessage?.decision === "DONT_NOTIFY"
  ) {
    return { type: "suppress", reason: "heartbeat-dont-notify" };
  }
  if (isCodexNotificationChildConversation(event.conversation)) {
    return { type: "suppress", reason: "child-conversation" };
  }
  if (event.conversation.threadSource === "realtime_voice") {
    return { type: "suppress", reason: "realtime-voice" };
  }
  if (event.hasPendingContinuation) {
    return { type: "suppress", reason: "pending-continuation" };
  }
  if (policy.turnMode === "off") {
    return { type: "suppress", reason: "setting-disabled" };
  }
  if (policy.turnMode === "unfocused" && policy.isAppForegrounded) {
    return { type: "suppress", reason: "app-focused" };
  }
  return { type: "show" };
}

export function decideCodexRequestNotification(
  conversation: Pick<CodexNotificationConversationFacts, "parentThreadId" | "source">,
  policy: CodexRequestNotificationPolicyFacts,
): CodexNotificationDecision {
  if (!policy.enabled) {
    return { type: "suppress", reason: "setting-disabled" };
  }
  if (isCodexNotificationChildConversation(conversation)) {
    return { type: "suppress", reason: "child-conversation" };
  }
  if (policy.isConversationPresentedInForeground) {
    return { type: "suppress", reason: "conversation-presented" };
  }
  return { type: "show" };
}

export function resolveCodexTurnNotificationBody(
  event: Pick<
    CodexTurnCompletedNotificationEvent,
    "heartbeatAssistantMessage" | "lastAgentMessage"
  >,
): string {
  const heartbeat = event.heartbeatAssistantMessage;
  return (
    normalizeDesktopNotificationText(
      heartbeat?.notificationMessage ?? heartbeat?.visibleText ?? event.lastAgentMessage,
    ) ?? "Nodex finished a turn."
  );
}

export function resolveCodexTurnNotificationTitle(title: string | null): string {
  return normalizeDesktopNotificationText(title) ?? "Turn complete";
}

export function resolveCodexApprovalNotificationCopy(input: {
  approvalKind: CodexNotificationApprovalKind;
  reason: string | null;
}): { title: string; body: string; hasActions: boolean } {
  const titles: Record<CodexNotificationApprovalKind, string> = {
    commandExecution: "Command approval",
    fileChange: "File edit approval",
    permissionRequest: "Permission approval",
  };
  return {
    title: titles[input.approvalKind],
    body: normalizeDesktopNotificationText(input.reason) ?? "Approval required",
    hasActions: input.approvalKind !== "permissionRequest",
  };
}

export function resolveCodexQuestionNotificationTitle(title: string | null): string {
  return normalizeDesktopNotificationText(title) ?? "Need your input";
}

export function resolveCodexQuestionNotificationBody(questionCount: number): string {
  if (questionCount > 1) return `Answer ${questionCount} questions to proceed.`;
  if (questionCount === 1) return "Answer 1 question to proceed.";
  return "Answer a question to proceed.";
}

export function buildCodexTurnNotificationId(turnId: string): string {
  return `turn-${turnId}`;
}

export function buildCodexTurnNotificationOccurrenceId(
  hostId: string,
  conversationId: string,
  turnId: string,
): string {
  return JSON.stringify(["turn", hostId, conversationId, turnId]);
}

export function buildCodexApprovalNotificationId(
  hostId: string,
  requestId: CodexAppServerRequestId,
): string {
  return `approval-${hostId}-${requestId}`;
}

export function buildCodexQuestionNotificationId(
  hostId: string,
  requestId: CodexAppServerRequestId,
): string {
  return `question-${hostId}-${requestId}`;
}

export function buildCodexRequestNotificationOccurrenceId(
  family: "approval" | "question",
  hostId: string,
  conversationId: string,
  requestId: CodexAppServerRequestId,
): string {
  return JSON.stringify([family, hostId, conversationId, requestId]);
}
