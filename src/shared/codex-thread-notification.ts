import type { RequestId as CodexAppServerRequestId } from "@nodex/codex-app-server-protocol";
import {
  normalizeDesktopNotificationText,
  type CodexHeartbeatAssistantMessage,
  type CodexHeartbeatDecision,
} from "./codex-turn-notification";
import { DEFAULT_CODEX_HOST_ID } from "./codex-host";
import { extractCodexThreadSpawnMetadata } from "./codex-subagent-metadata";

export type CodexNotificationTurnStatus = "completed" | "failed" | "interrupted";

export interface CodexNotificationConversationFacts {
  conversationId: string;
  title: string | null;
  threadSource: string | null;
  parentThreadId: string | null;
  source: unknown;
  sideConversationParentNavigationPath: string | null;
  /** A Session notification opens through its product Session instead of native Thread lookup. */
  runtimeSessionId?: string | null;
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

export interface CodexUserInputRequestedNotificationEvent {
  type: "user-input-requested";
  hostId: string;
  conversation: CodexNotificationConversationFacts;
  requestId: CodexAppServerRequestId;
  turnId: string;
  questionCount: number;
}

export interface CodexApprovalRequestedNotificationEvent {
  type: "approval-requested";
  hostId: string;
  conversation: CodexNotificationConversationFacts;
  requestId: CodexAppServerRequestId;
  turnId: string;
  prompt: string | null;
}

export interface CodexRequestResolvedNotificationEvent {
  type: "request-resolved";
  hostId: string;
  conversationId: string;
  requestId: CodexAppServerRequestId;
  family?: "question" | "approval";
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

export interface SessionReminderNotificationEvent {
  type: "session-reminder";
  hostId: string;
  conversation: CodexNotificationConversationFacts;
  remindAt: string;
  /** The Member who asked to come back to the chat; only they hear about it. */
  memberId: string;
}

export type CodexThreadNotificationEvent =
  | SessionReminderNotificationEvent
  | CodexAsyncQuestionNotificationEvent
  | CodexAsyncQuestionResolvedNotificationEvent
  | CodexTurnCompletedNotificationEvent
  | CodexApprovalRequestedNotificationEvent
  | CodexUserInputRequestedNotificationEvent
  | CodexRequestResolvedNotificationEvent;

export type CodexNotificationSuppressionReason =
  | "managed"
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

export interface CodexTurnNotificationPolicyFacts extends CodexTurnOccurrenceFacts {
  turnMode: "off" | "unfocused" | "always";
  isAppForegrounded: boolean;
  /** The conversation is in front of the person, in a focused window or on a phone. */
  isConversationSeen: boolean;
}

export interface CodexRequestNotificationPolicyFacts {
  enabled: boolean;
  isConversationSeen: boolean;
}

export function isCodexNotificationChildConversation(
  conversation: Pick<CodexNotificationConversationFacts, "parentThreadId" | "source">,
): boolean {
  if ((conversation.parentThreadId?.trim() ?? "").length > 0) return true;
  return (extractCodexThreadSpawnMetadata(conversation.source).parentThreadId ?? "").length > 0;
}

/** What the occurrence's chat is, as Core knows it, before any channel decides how to tell it. */
export interface CodexTurnOccurrenceFacts {
  /** Nodex speaks for this chat through its posts, so its turns stay quiet everywhere. */
  managed: boolean;
}

/** Whether the Automation or heartbeat asked for the turn to finish quietly. */
export function quietAutomationTurnReason(
  event: Pick<
    CodexTurnCompletedNotificationEvent,
    "status" | "automationNotificationDecision" | "heartbeatAssistantMessage"
  >,
): "automation-dont-notify" | "heartbeat-dont-notify" | null {
  if (event.status === "failed") return null;
  if (event.automationNotificationDecision === "DONT_NOTIFY") return "automation-dont-notify";
  if (
    event.automationNotificationDecision === null &&
    event.heartbeatAssistantMessage?.decision === "DONT_NOTIFY"
  )
    return "heartbeat-dont-notify";
  return null;
}

/**
 * Whether a finished turn is worth telling the person at all, before any channel applies its own
 * settings or presence. Desktop notifications and phone pushes share this decision.
 */
export function decideCodexTurnOccurrence(
  event: CodexTurnCompletedNotificationEvent,
  facts: CodexTurnOccurrenceFacts,
): CodexNotificationDecision {
  if (facts.managed) return { type: "suppress", reason: "managed" };
  if (event.hostId !== DEFAULT_CODEX_HOST_ID) {
    return { type: "suppress", reason: "remote-host-turn" };
  }
  const quiet = quietAutomationTurnReason(event);
  if (quiet) return { type: "suppress", reason: quiet };
  if (isCodexNotificationChildConversation(event.conversation)) {
    return { type: "suppress", reason: "child-conversation" };
  }
  if (event.conversation.threadSource === "realtime_voice") {
    return { type: "suppress", reason: "realtime-voice" };
  }
  if (event.hasPendingContinuation) {
    return { type: "suppress", reason: "pending-continuation" };
  }
  return { type: "show" };
}

export function decideCodexTurnNotification(
  event: CodexTurnCompletedNotificationEvent,
  policy: CodexTurnNotificationPolicyFacts,
): CodexNotificationDecision {
  const occurrence = decideCodexTurnOccurrence(event, policy);
  if (occurrence.type === "suppress") return occurrence;
  if (policy.turnMode === "off") {
    return { type: "suppress", reason: "setting-disabled" };
  }
  if (policy.turnMode === "unfocused" && policy.isAppForegrounded) {
    return { type: "suppress", reason: "app-focused" };
  }
  if (policy.turnMode === "unfocused" && policy.isConversationSeen) {
    return { type: "suppress", reason: "conversation-presented" };
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
  if (policy.isConversationSeen) {
    return { type: "suppress", reason: "conversation-presented" };
  }
  return { type: "show" };
}

/** What the turn has to say for itself: heartbeat copy first, then the final reply. */
export function resolveCodexTurnNotificationReply(
  event: Pick<
    CodexTurnCompletedNotificationEvent,
    "heartbeatAssistantMessage" | "lastAgentMessage"
  >,
): string | null {
  const heartbeat = event.heartbeatAssistantMessage;
  return (
    (heartbeat?.notificationMessage ?? heartbeat?.visibleText ?? event.lastAgentMessage)?.trim() ||
    null
  );
}

export function resolveCodexTurnNotificationBody(
  event: Pick<
    CodexTurnCompletedNotificationEvent,
    "heartbeatAssistantMessage" | "lastAgentMessage"
  >,
): string {
  return resolveCodexTurnNotificationReply(event) ?? "Nodex finished a turn.";
}

export function resolveCodexTurnNotificationTitle(title: string | null): string {
  return normalizeDesktopNotificationText(title) ?? "Turn complete";
}

export function resolveCodexQuestionNotificationTitle(title: string | null): string {
  return normalizeDesktopNotificationText(title) ?? "Need your input";
}

export function resolveCodexQuestionNotificationBody(questionCount: number): string {
  if (questionCount > 1) return `Answer ${questionCount} questions to proceed.`;
  if (questionCount === 1) return "Answer 1 question to proceed.";
  return "Answer a question to proceed.";
}

export function resolveCodexApprovalNotificationTitle(title: string | null): string {
  const normalized = normalizeDesktopNotificationText(title);
  return normalized ? `${normalized} needs approval` : "Nodex needs approval";
}

export function resolveCodexApprovalNotificationBody(prompt: string | null): string {
  return prompt?.trim() || "Approve the requested action to proceed.";
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

export function buildCodexQuestionNotificationId(
  hostId: string,
  requestId: CodexAppServerRequestId,
): string {
  return `question-${hostId}-${requestId}`;
}

export function buildCodexApprovalNotificationId(
  hostId: string,
  requestId: CodexAppServerRequestId,
): string {
  return `approval-${hostId}-${requestId}`;
}

export function buildCodexRequestNotificationOccurrenceId(
  family: "question" | "approval",
  hostId: string,
  conversationId: string,
  requestId: CodexAppServerRequestId,
): string {
  return JSON.stringify([family, hostId, conversationId, requestId]);
}
