import {
  ChatImageAttachment,
  ChatFileAttachment,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
} from "./chatAttachment.ts";
import * as Schema from "effect/Schema";

import { MessageId, ThreadId, RunId, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const ProviderApprovalPolicy = Schema.Literals([
  "untrusted",
  "on-failure",
  "on-request",
  "never",
]);
export type ProviderApprovalPolicy = typeof ProviderApprovalPolicy.Type;

export const ProviderSandboxMode = Schema.Literals([
  "read-only",
  "workspace-write",
  "danger-full-access",
]);
export type ProviderSandboxMode = typeof ProviderSandboxMode.Type;

/**
 * Native execution access, ordered from narrowest to broadest. Content access through Nodex
 * tools is independent of this mode.
 * - `approval-required`: works in its workspace and asks before going beyond it.
 * - `auto`: a native reviewer approves routine requests and asks about risky ones.
 * - `full-access`: unrestricted native execution without prompts.
 */
export const RuntimeMode = Schema.Literals(["approval-required", "auto", "full-access"]);
export type RuntimeMode = typeof RuntimeMode.Type;
/** New Sessions run with full access unless the Profile chooses otherwise. */
export const DEFAULT_RUNTIME_MODE: RuntimeMode = "full-access";
/** The fallback wherever an unknown or unsupported mode must never widen access. */
export const NARROWEST_RUNTIME_MODE: RuntimeMode = "approval-required";
export const RUNTIME_MODE_RANK: Record<RuntimeMode, number> = {
  "approval-required": 0,
  auto: 1,
  "full-access": 2,
};

export const ProviderInteractionMode = Schema.Literals(["default", "plan"]);
export type ProviderInteractionMode = typeof ProviderInteractionMode.Type;
export const DEFAULT_PROVIDER_INTERACTION_MODE: ProviderInteractionMode = "default";

export const ProviderRequestKind = Schema.Literals([
  "command",
  "file-read",
  "file-change",
  "mcp-elicitation",
  "permission",
]);
export type ProviderRequestKind = typeof ProviderRequestKind.Type;

export const AssistantDeliveryMode = Schema.Literals(["buffered", "streaming"]);
export type AssistantDeliveryMode = typeof AssistantDeliveryMode.Type;

export const ProviderApprovalDecision = Schema.Literals([
  "accept",
  "acceptForSession",
  "decline",
  "cancel",
]);
export type ProviderApprovalDecision = typeof ProviderApprovalDecision.Type;

export const ProviderApprovalOption = Schema.Struct({
  optionId: Schema.optional(TrimmedNonEmptyString),
  decision: ProviderApprovalDecision,
  label: TrimmedNonEmptyString,
  /** Provider-supplied caution shown next to the option, such as a prompt injection warning. */
  warning: Schema.optional(TrimmedNonEmptyString),
});
export type ProviderApprovalOption = typeof ProviderApprovalOption.Type;

/**
 * Why a Full access request still reached the user: the Agent's own ask rule, or a native
 * safety check that no execution setting can skip.
 */
export const ProviderApprovalFullAccessOverride = Schema.Literals(["ask_rule", "provider_check"]);
export type ProviderApprovalFullAccessOverride = typeof ProviderApprovalFullAccessOverride.Type;

export const ProviderUserInputAnswers = Schema.Record(Schema.String, Schema.Unknown);
export type ProviderUserInputAnswers = typeof ProviderUserInputAnswers.Type;

export const UserInputAttachments = Schema.Record(
  Schema.String,
  Schema.Array(Schema.Union([ChatImageAttachment, ChatFileAttachment])).pipe(
    Schema.check(Schema.isMaxLength(PROVIDER_SEND_TURN_MAX_ATTACHMENTS)),
  ),
);
export type UserInputAttachments = typeof UserInputAttachments.Type;

export const UserInputResponder = Schema.Struct({
  kind: Schema.Literal("agent"),
  senderThreadId: ThreadId,
  senderRunId: Schema.optional(Schema.NullOr(RunId)),
  senderSessionId: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
});
export type UserInputResponder = typeof UserInputResponder.Type;

export const UserInputAttachmentAnswerPayload = Schema.Struct({
  requestId: TrimmedNonEmptyString,
  respondedBy: Schema.optional(UserInputResponder),
  /** Separate answer messages rendered as part of this question's history. */
  messageIds: Schema.optional(Schema.Array(MessageId)),
  questionTextById: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  answers: ProviderUserInputAnswers,
  attachmentsByQuestionId: UserInputAttachments,
});
export type UserInputAttachmentAnswerPayload = typeof UserInputAttachmentAnswerPayload.Type;
