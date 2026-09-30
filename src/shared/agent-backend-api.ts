import type {
  AgentBackendSessionPresentation,
  AgentConversationDelta,
  AgentConversationSnapshot,
  AgentSessionConfigOption,
} from "./agent-conversation";
import type { ProjectSessionThreadLink } from "./types";
import type { ConversationFirstSubmissionIdentity } from "./types";
import type { ClaudeEffortSelection, ClaudeModelSelection } from "./claude-models";
import type { PageRunInTarget } from "./types";
import type { CodexPendingWorktreeStartingState } from "./codex-pending-worktree";

export type NativePermissionMode = Exclude<import("./types").CodexPermissionMode, "custom">;

export interface AgentBackendSessionOpenInput {
  readonly threadId: string;
}

export interface AgentBackendThreadStartInput {
  readonly sessionId: string;
  readonly instanceConfigId: string;
  readonly backendKind: "acp" | "claude";
  readonly model?: string;
  readonly effort?: ClaudeEffortSelection;
  readonly selection?: ClaudeModelSelection;
  readonly mode?: "default" | "plan";
  readonly runInTarget?: Exclude<PageRunInTarget, "cloud">;
  readonly runInEnvironmentPath?: string | null;
  readonly worktreeStartingState?: CodexPendingWorktreeStartingState;
  readonly prompt: string;
  readonly images?: readonly import("./types").CodexPromptImageInput[];
  readonly firstSubmission: ConversationFirstSubmissionIdentity;
}

export interface AgentBackendThreadStartResult {
  readonly thread: ProjectSessionThreadLink;
  readonly presentation: AgentBackendSessionPresentation;
}

export interface AgentBackendPromptInput {
  readonly threadId: string;
  readonly prompt: string;
  readonly images?: readonly import("./types").CodexPromptImageInput[];
  readonly clientUserMessageId?: string;
}

export interface AgentBackendModeInput {
  readonly threadId: string;
  readonly modeId: string;
}

export interface AgentBackendIntelligenceInput {
  readonly threadId: string;
  readonly selection: ClaudeModelSelection;
}

export type AgentBackendControlInput = { readonly threadId: string } & (
  | {
      readonly kind: "steer";
      readonly prompt: string;
      readonly images?: readonly import("./types").CodexPromptImageInput[];
      readonly clientUserMessageId: string;
    }
  | { readonly kind: "stop-task"; readonly taskId: string }
  | { readonly kind: "rollback"; readonly numTurns: number }
  | { readonly kind: "compact" }
  | { readonly kind: "permission-mode"; readonly mode: import("./types").CodexPermissionMode }
  | { readonly kind: "load-older"; readonly before?: string; readonly limit?: number }
);
type WithoutThreadId<T> = T extends { readonly threadId: string } ? Omit<T, "threadId"> : never;
export type AgentBackendControlCommand = WithoutThreadId<AgentBackendControlInput>;

export interface AgentBackendForkInput {
  readonly threadId: string;
  readonly nativeMessageId: string;
}

export interface AgentBackendHistoryImageInput {
  readonly threadId: string;
  readonly expectedSessionId: string;
  readonly nativeMessageId: string;
  readonly index: number;
}

export interface AgentBackendToolOutputInput {
  readonly threadId: string;
  readonly expectedSessionId: string;
  readonly nativeMessageId: string;
  readonly toolUseId: string;
}

export interface AgentBackendConfigOptionInput {
  readonly threadId: string;
  readonly configId: string;
  readonly value: string | boolean;
}

export interface AgentBackendAuthenticateInput {
  readonly threadId: string;
  readonly methodId: string;
}

export interface AgentBackendSessionChangedEvent {
  readonly threadId: string;
  readonly delta: AgentConversationDelta;
}

export interface AgentBackendPromptResult {
  readonly stopReason: string;
  readonly snapshot: AgentConversationSnapshot;
}

export interface AgentBackendConfigOptionResult {
  readonly configOptions: readonly AgentSessionConfigOption[];
  readonly snapshot: AgentConversationSnapshot;
}

export interface AgentBackendAuthenticateResult {
  readonly snapshot: AgentConversationSnapshot;
}

export type { AgentBackendSessionPresentation };
