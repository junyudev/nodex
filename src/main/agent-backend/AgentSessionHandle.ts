import type * as Effect from "effect/Effect";
import type * as SubscriptionRef from "effect/SubscriptionRef";
import type {
  AgentBackendCapabilityProfile,
  AgentConversationSnapshot,
  AgentInteractionResponse,
  AgentSessionModeState,
  AgentSessionConfigOption,
} from "../../shared/agent-conversation";
import type { AgentRuntimeError } from "./AgentRuntimeError";

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
    options?: { readonly clientUserMessageId?: string },
  ) => Effect.Effect<{ readonly stopReason: string }, AgentRuntimeError>;
  readonly cancel: Effect.Effect<void, AgentRuntimeError>;
  readonly setMode: (id: string) => Effect.Effect<void, AgentRuntimeError>;
  readonly setConfigOption: (
    id: string,
    value: string | boolean,
  ) => Effect.Effect<readonly AgentSessionConfigOption[], AgentRuntimeError>;
  readonly authenticate: (id: string) => Effect.Effect<unknown, AgentRuntimeError>;
  readonly deferInitialPrompt: (prompt: {
    readonly prompt: string;
    readonly clientUserMessageId: string;
  }) => Effect.Effect<void>;
  readonly takeDeferredInitialPrompt: Effect.Effect<{
    readonly prompt: string;
    readonly clientUserMessageId: string;
  } | null>;
  readonly respond?: (
    requestId: string,
    response: AgentInteractionResponse,
  ) => Effect.Effect<void, AgentRuntimeError>;
}
