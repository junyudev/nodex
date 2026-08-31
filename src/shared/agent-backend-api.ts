import type {
  AcpBackendSessionPresentation,
  AcpConversationDelta,
  AcpConversationSnapshot,
  AcpSessionConfigOption,
} from "./acp-conversation";
import type { ProjectSessionThreadLink } from "./types";

export interface AcpBackendSessionOpenInput {
  readonly threadId: string;
}

export interface AcpBackendThreadStartInput {
  readonly sessionId: string;
  readonly instanceConfigId: string;
  readonly prompt: string;
}

export interface AcpBackendThreadStartResult {
  readonly thread: ProjectSessionThreadLink;
  readonly presentation: AcpBackendSessionPresentation;
}

export interface AcpBackendPromptInput {
  readonly threadId: string;
  readonly prompt: string;
}

export interface AcpBackendModeInput {
  readonly threadId: string;
  readonly modeId: string;
}

export interface AcpBackendConfigOptionInput {
  readonly threadId: string;
  readonly configId: string;
  readonly value: string | boolean;
}

export interface AcpBackendAuthenticateInput {
  readonly threadId: string;
  readonly methodId: string;
}

export interface AcpBackendSessionChangedEvent {
  readonly threadId: string;
  readonly delta: AcpConversationDelta;
}

export interface AcpBackendPromptResult {
  readonly stopReason: string;
  readonly snapshot: AcpConversationSnapshot;
}

export interface AcpBackendConfigOptionResult {
  readonly configOptions: readonly AcpSessionConfigOption[];
  readonly snapshot: AcpConversationSnapshot;
}

export interface AcpBackendAuthenticateResult {
  readonly snapshot: AcpConversationSnapshot;
}

export type { AcpBackendSessionPresentation };
