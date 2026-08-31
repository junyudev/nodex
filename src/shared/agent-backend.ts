export const CODEX_AGENT_BACKEND_BINDING = { kind: "codex" } as const;

/** Durable runtime identity. Backend-specific settings remain in their owning stores. */
export type AgentBackendBinding =
  | typeof CODEX_AGENT_BACKEND_BINDING
  | {
      readonly kind: "acp";
      readonly agentDefinitionId: string;
      readonly instanceConfigId: string | null;
    };

export const isCodexAgentBackendBinding = (
  binding: AgentBackendBinding,
): binding is typeof CODEX_AGENT_BACKEND_BINDING => binding.kind === "codex";
