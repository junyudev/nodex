import type { TurnStartParams } from "@nodex/codex-app-server-protocol/v2";
import type {
  CodexPromptInput,
  CodexLiveFileAttachment,
  CodexReviewDiffCommentAttachment,
  CodexQueuedFollowUp,
  CodexAgentMode,
  CodexTurnStartOptions,
} from "./types";
import type { CodexPermissionSelection } from "./codex-permission-selection";
import { CODEX_INTERRUPTED_STEER_REASON } from "./codex-queued-follow-up-state";
import type { QueuedMessageState } from "./codex-queued-message-coordinator";

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
  readonly usePermissionSelection: boolean;
  readonly clientUserMessageId?: string;
}

/** Queue capture accepts the ordinary Turn options plus queue-only frozen execution intent. */
export type CodexQueuedMessagePrepareOptions = CodexTurnStartOptions & {
  readonly workspaceRoots?: readonly string[];
  readonly permissionSelection?: CodexPermissionSelection;
  readonly permissionProfileId?: string;
  readonly usePermissionSelection?: boolean;
  readonly shouldSendPermissionOverrides?: boolean;
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
    readonly agentMode?: CodexAgentMode;
    readonly permissionSelection?: CodexPermissionSelection;
    readonly permissionProfileId?: string;
    /** Captured execution-assignment readiness. False is distinct from absence. */
    readonly usePermissionSelection?: boolean;
    /** A displayed mode alone is not a request to change execution permissions. */
    readonly shouldSendPermissionOverrides?: boolean;
    readonly [key: string]: unknown;
  };
  readonly writingBlockAdditionalContext?: TurnStartParams["additionalContext"];
  readonly createdAt?: number;
  readonly [key: string]: unknown;
}
export type CodexQueuedMessageState = QueuedMessageState<CodexQueuedMessage>;

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
  const { prompt, imageAttachments, pastedTextAttachments, ...context } = message.context;
  return {
    ...context,
    text: prompt,
    fileAttachments: [...message.context.fileAttachments],
    addedFiles: [...message.context.addedFiles],
    commentAttachments: [...message.context.commentAttachments],
    images: [...imageAttachments],
    ...(pastedTextAttachments ? { textAttachments: [...pastedTextAttachments] } : {}),
  };
}
/** Composer rows are a local view; revision and payload bookkeeping never cross the peer. */
export function projectCodexQueuedMessage(
  threadId: string,
  message: CodexQueuedMessage,
): CodexQueuedFollowUp {
  return {
    followUpId: message.id,
    clientUserMessageId: message.id,
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
