import type * as Effect from "effect/Effect";
import type * as SubscriptionRef from "effect/SubscriptionRef";
import type {
  AgentBackendCapabilityProfile,
  AgentConversationSnapshot,
  AgentInteractionResponse,
  AgentSessionModeState,
  AgentSessionConfigOption,
  AgentPromptImage,
} from "../../shared/agent-conversation";
import type { AgentRuntimeError } from "./AgentRuntimeError";
import type {
  ClaudeHistoryPage,
  ClaudeModelSelection,
  ClaudeRuntimeDiagnostics,
} from "../../shared/claude-models";

export type AgentSessionPermissionPolicy = "ask" | "approve-for-me" | "full-access";

export interface NativeAgentExecutionLocation {
  readonly workspaceRoot: string;
  readonly workspaceEnvironment?:
    | import("../codex/codex-worktree-shell-environment").CodexStoredShellEnvironment
    | null;
}

/** Conversation controls shared by native Claude and ACP, independent of either wire protocol. */
export interface AgentSessionHandle {
  readonly threadId: string;
  readonly sessionId: string | null;
  readonly capabilities: AgentBackendCapabilityProfile;
  readonly modes: AgentSessionModeState | null;
  readonly configOptions: readonly AgentSessionConfigOption[];
  readonly snapshot: SubscriptionRef.SubscriptionRef<AgentConversationSnapshot>;
  readonly prompt: (
    text: string,
    options?: {
      readonly clientUserMessageId?: string;
      readonly images?: readonly AgentPromptImage[];
    },
  ) => Effect.Effect<{ readonly stopReason: string }, AgentRuntimeError>;
  readonly cancel: Effect.Effect<void, AgentRuntimeError>;
  /** Suspends an idle native runtime inside a handoff; the handoff restores it after cleanup. */
  readonly suspendExecution?: Effect.Effect<void, AgentRuntimeError>;
  /** Seals new input and mutating controls through file preparation, commit, and cleanup. */
  readonly withExecutionHandoff?: <A, E, R>(
    use: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | AgentRuntimeError, R>;
  readonly setExecutionRecoveryRequired?: (
    required: boolean,
  ) => Effect.Effect<void, AgentRuntimeError>;
  /** Holds turn admission while the same native conversation moves and its durable location commits. */
  readonly withExecutionLocation?: <A, E, R>(
    location: NativeAgentExecutionLocation,
    use: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | AgentRuntimeError, R>;
  readonly setIntelligence?: (
    selection: ClaudeModelSelection,
  ) => Effect.Effect<void, AgentRuntimeError>;
  readonly setPermissionPolicy?: (
    policy: AgentSessionPermissionPolicy,
  ) => Effect.Effect<void, AgentRuntimeError>;
  readonly steer?: (
    text: string,
    options?: {
      readonly clientUserMessageId?: string;
      readonly images?: readonly AgentPromptImage[];
    },
  ) => Effect.Effect<void, AgentRuntimeError>;
  readonly readHistoryImage?: (
    nativeMessageId: string,
    index: number,
  ) => Effect.Effect<AgentPromptImage, AgentRuntimeError>;
  readonly readHistoryToolOutput?: (
    nativeMessageId: string,
    toolUseId: string,
  ) => Effect.Effect<import("../../shared/agent-tool-output").AgentToolOutput, AgentRuntimeError>;
  readonly stopTask?: (taskId: string) => Effect.Effect<void, AgentRuntimeError>;
  readonly loadHistory?: (input?: {
    readonly before?: string;
    readonly limit?: number;
  }) => Effect.Effect<ClaudeHistoryPage, AgentRuntimeError>;
  readonly forkAt?: (
    nativeMessageId: string,
  ) => Effect.Effect<
    { readonly sessionId: string; readonly messageIdMap?: Readonly<Record<string, string>> },
    AgentRuntimeError
  >;
  readonly rollback?: (numTurns: number) => Effect.Effect<void, AgentRuntimeError>;
  readonly compact?: Effect.Effect<void, AgentRuntimeError>;
  readonly inspectRuntime?: Effect.Effect<ClaudeRuntimeDiagnostics, AgentRuntimeError>;
  readonly setMode: (id: string) => Effect.Effect<void, AgentRuntimeError>;
  readonly setConfigOption: (
    id: string,
    value: string | boolean,
  ) => Effect.Effect<readonly AgentSessionConfigOption[], AgentRuntimeError>;
  readonly authenticate?: (id: string) => Effect.Effect<unknown, AgentRuntimeError>;
  readonly deferInitialPrompt?: (prompt: {
    readonly prompt: string;
    readonly clientUserMessageId: string;
    readonly images?: readonly AgentPromptImage[];
  }) => Effect.Effect<void>;
  readonly takeDeferredInitialPrompt?: Effect.Effect<{
    readonly prompt: string;
    readonly clientUserMessageId: string;
    readonly images?: readonly AgentPromptImage[];
  } | null>;
  readonly respond?: (
    requestId: string,
    response: AgentInteractionResponse,
  ) => Effect.Effect<void, AgentRuntimeError>;
}
