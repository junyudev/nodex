import type { AgentBackendBinding } from "./agent-backend";
import type { AgentSessionConfigOption, AgentSessionModeState } from "./agent-conversation";
import type { ClaudeDiscovery } from "./claude-models";
import type { AgentModelOption } from "./types";

export type ExternalAgentBinding = Exclude<AgentBackendBinding, { kind: "codex" }>;
export interface AgentModelCatalogInput {
  readonly scope:
    | {
        readonly kind: "project";
        readonly projectId: string | null;
        readonly binding: ExternalAgentBinding;
      }
    | { readonly kind: "thread"; readonly threadId: string };
  readonly requestId?: string;
  readonly forceReload?: boolean;
}
export interface AgentModelCatalog {
  readonly binding: ExternalAgentBinding;
  readonly models: readonly AgentModelOption[];
  readonly configOptions: readonly AgentSessionConfigOption[];
  /** Exact model-scoped controls override the runtime's common configuration. */
  readonly modelConfigOptions?: Readonly<Record<string, readonly AgentSessionConfigOption[]>>;
  readonly modes: AgentSessionModeState | null;
  readonly health: {
    readonly status: "ready" | "unavailable" | "authentication-required";
    readonly error: string | null;
  };
  readonly defaultModel: string | null;
  readonly claudeDiscovery?: ClaudeDiscovery;
}
/** Choosing a model also chooses its configured runtime; model IDs alone never route execution. */
export interface AgentModelSelection {
  readonly binding: AgentBackendBinding;
  readonly model: string;
  readonly options?: readonly { readonly id: string; readonly value: string | boolean }[];
  readonly modeId?: string;
}
