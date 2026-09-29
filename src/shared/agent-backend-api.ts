import type {
  AgentBackendSessionPresentation,
  AgentConversationDelta,
  AgentConversationSnapshot,
  AgentSessionConfigOption,
} from "./agent-conversation";
import type { ProjectSessionThreadLink } from "./types";
import type { ConversationFirstSubmissionIdentity } from "./types";
import type { ClaudeEffortSelection } from "./claude-models";

export interface AgentBackendSessionOpenInput {
  readonly threadId: string;
}

export interface AgentBackendThreadStartInput {
  readonly sessionId: string;
  readonly instanceConfigId: string;
  readonly backendKind: "acp" | "claude";
  readonly model?: string;
  readonly effort?: ClaudeEffortSelection;
  readonly mode?: "default" | "plan";
  readonly prompt: string;
  readonly firstSubmission: ConversationFirstSubmissionIdentity;
}

export interface AgentBackendThreadStartResult {
  readonly thread: ProjectSessionThreadLink;
  readonly presentation: AgentBackendSessionPresentation;
}

export interface AgentBackendPromptInput {
  readonly threadId: string;
  readonly prompt: string;
  readonly clientUserMessageId?: string;
}

export interface AgentBackendModeInput {
  readonly threadId: string;
  readonly modeId: string;
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
