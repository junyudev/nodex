import type {
  QueuedSubmission,
  TurnStartParams,
  UserInput,
} from "@nodex/codex-app-server-protocol/v2";
import type { CodexTurnDelivery } from "./codex-conversation-state/codex-turn-delivery";
import type {
  CodexPromptInput,
  CodexLiveFileAttachment,
  CodexReviewDiffCommentAttachment,
  CodexQueuedFollowUp,
  CodexTurnStartOptions,
} from "./types";

import { CODEX_INTERRUPTED_STEER_REASON } from "./codex-queued-follow-up-state";
import type { QueuedMessageState } from "./codex-queued-message-coordinator";
import {
  parseCodexAppModelContextAttachments,
  parseUntrustedAppMessage,
} from "./codex-untrusted-app-input";

export interface CodexQueuedMessageContext {
  readonly untrustedAppMessage?: unknown;
  readonly mcpAppModelContextAttachments?: unknown;
  readonly prompt: string;
  readonly fileAttachments: readonly CodexLiveFileAttachment[];
  readonly addedFiles: readonly CodexLiveFileAttachment[];
  readonly commentAttachments: readonly CodexReviewDiffCommentAttachment[];
  readonly imageAttachments: readonly NonNullable<CodexPromptInput["images"]>[number][];
  readonly pastedTextAttachments?: CodexPromptInput["textAttachments"];
  readonly workspaceRoots?: readonly string[];
  readonly [key: string]: unknown;
}

/** Runtime queue preparation is recomputed per attempt and is never persisted with the message. */
export interface CodexQueuedNativePreparationContext {
  readonly runtimeWorkspaceRoots: readonly string[];

  readonly clientUserMessageId?: string;
  /** Actual native row; preparation binds its stored input before owner transfer. */
  readonly serverQueuedSubmission?: QueuedSubmission;
}

/** Queue capture accepts the ordinary Turn options plus queue-only frozen execution intent. */
export type CodexQueuedMessagePrepareOptions = CodexTurnStartOptions & {
  readonly workspaceRoots?: readonly string[];
};

/** The persisted queue contains whole captured submissions, independently of transcript residency. */
export interface CodexQueuedMessage {
  readonly id: string;
  readonly cwd: string | null;
  readonly context: CodexQueuedMessageContext;
  readonly pausedReason?: string | null;
  readonly submissionOptions?: {
    readonly executionHostId?: string;
    readonly collaborationMode?: TurnStartParams["collaborationMode"];
    readonly serviceTier?: TurnStartParams["serviceTier"];
    readonly summary?: TurnStartParams["summary"];

    readonly [key: string]: unknown;
  };
  readonly writingBlockAdditionalContext?: TurnStartParams["additionalContext"];
  readonly createdAt?: number;
  readonly [key: string]: unknown;
}
export type CodexQueuedMessageState = QueuedMessageState<CodexQueuedMessage>;

export interface CodexQueuedMessageDeliveryReceipt {
  readonly status: "outcome-unknown";
  readonly hostId: string;
  readonly method: "thread/queue/add" | "turn/start" | "turn/steer";
  readonly requestId: CodexTurnDelivery["requestId"];
  readonly captured: CodexQueuedMessage;
  /** Persisted data must match both the generated native acceptance and the current compiler. */
  readonly input: readonly unknown[];
}

/** Delivery bookkeeping never changes the captured user input or execution settings. */
export function captureCodexQueuedMessage(message: CodexQueuedMessage): CodexQueuedMessage {
  const { submission: _submission, pausedReason: _pausedReason, ...captured } = message;
  return captured;
}

export function createCodexQueuedMessageDeliveryReceipt(
  hostId: string,
  message: CodexQueuedMessage,
  input: readonly UserInput[],
  delivery: CodexTurnDelivery,
): CodexQueuedMessageDeliveryReceipt | null {
  if (
    delivery.method !== "thread/queue/add" &&
    delivery.method !== "turn/start" &&
    delivery.method !== "turn/steer"
  )
    return null;
  return {
    status: "outcome-unknown",
    hostId,
    method: delivery.method,
    requestId: delivery.requestId,
    captured: structuredClone(captureCodexQueuedMessage(message)),
    input: structuredClone(input),
  };
}

export function readCodexQueuedMessageDeliveryReceipt(
  message: CodexQueuedMessage,
): CodexQueuedMessageDeliveryReceipt | null {
  const receipt = message.submission;
  if (!receipt || typeof receipt !== "object") return null;
  const status: unknown = Reflect.get(receipt, "status");
  const hostId: unknown = Reflect.get(receipt, "hostId");
  const method: unknown = Reflect.get(receipt, "method");
  const requestId: unknown = Reflect.get(receipt, "requestId");
  const captured: unknown = Reflect.get(receipt, "captured");
  const input: unknown = Reflect.get(receipt, "input");
  if (
    status !== "outcome-unknown" ||
    typeof hostId !== "string" ||
    !hostId ||
    (method !== "thread/queue/add" && method !== "turn/start" && method !== "turn/steer") ||
    (typeof requestId !== "string" &&
      (typeof requestId !== "number" || !Number.isFinite(requestId))) ||
    !isCodexQueuedMessage(captured) ||
    captured.submission !== undefined ||
    !Array.isArray(input)
  )
    return null;
  return { status, hostId, method, requestId, captured, input };
}

export function isCodexQueuedMessage(value: unknown): value is CodexQueuedMessage {
  if (value === null || typeof value !== "object") return false;
  const context: unknown = Reflect.get(value, "context");
  if (context === null || typeof context !== "object") return false;
  return (
    typeof Reflect.get(value, "id") === "string" &&
    typeof Reflect.get(context, "prompt") === "string" &&
    Array.isArray(Reflect.get(context, "fileAttachments")) &&
    Array.isArray(Reflect.get(context, "addedFiles")) &&
    Array.isArray(Reflect.get(context, "commentAttachments")) &&
    Array.isArray(Reflect.get(context, "imageAttachments"))
  );
}
export function parseCodexQueuedMessageState(value: unknown): CodexQueuedMessageState {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid queued message state");
  const result: Record<string, readonly CodexQueuedMessage[]> = {};
  for (const [id, messages] of Object.entries(value)) {
    if (!Array.isArray(messages) || !messages.every(isCodexQueuedMessage))
      throw new Error("Invalid queued message document");
    Object.defineProperty(result, id, {
      value: messages,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return result;
}
export function queuedMessagePromptInput(message: CodexQueuedMessage): CodexPromptInput {
  const {
    prompt,
    imageAttachments,
    pastedTextAttachments,
    untrustedAppMessage,
    mcpAppModelContextAttachments,
    ...context
  } = message.context;
  const attachments = parseCodexAppModelContextAttachments(mcpAppModelContextAttachments);
  return {
    ...context,
    text: prompt,
    fileAttachments: [...message.context.fileAttachments],
    addedFiles: [...message.context.addedFiles],
    commentAttachments: [...message.context.commentAttachments],
    images: [...imageAttachments],
    ...(attachments ? { mcpAppModelContextAttachments: attachments } : {}),
    ...(untrustedAppMessage == null
      ? {}
      : { untrustedAppMessage: parseUntrustedAppMessage(untrustedAppMessage) }),
    ...(pastedTextAttachments ? { textAttachments: [...pastedTextAttachments] } : {}),
  };
}
/** Composer rows are a local view; revision and payload bookkeeping never cross the peer. */
export function projectCodexQueuedMessage(
  threadId: string,
  message: CodexQueuedMessage,
  delivery?: {
    readonly owner: "local" | "server";
    readonly clientUserMessageId: string;
    readonly canSendNow?: boolean;
  },
): CodexQueuedFollowUp {
  return {
    ...(delivery ? { deliveryOwner: delivery.owner, canSendNow: delivery.canSendNow } : {}),
    followUpId: message.id,
    clientUserMessageId: delivery?.clientUserMessageId ?? message.id,
    threadId,
    prompt: message.context.prompt,
    promptInput: queuedMessagePromptInput(message),
    createdAtMs: message.createdAt ?? 0,
    collaborationMode: message.submissionOptions?.collaborationMode?.mode ?? null,
    serviceTier: message.submissionOptions?.serviceTier ?? null,
    summary: message.submissionOptions?.summary ?? null,
    pause:
      message.pausedReason === CODEX_INTERRUPTED_STEER_REASON
        ? { kind: "interrupted", reason: CODEX_INTERRUPTED_STEER_REASON }
        : message.pausedReason
          ? { kind: "failed", reason: message.pausedReason }
          : null,
  };
}
