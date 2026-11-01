export const CODEX_AGENT_BACKEND_BINDING = { kind: "codex" } as const;

/** Durable runtime identity. Backend-specific settings remain in their owning stores. */
export type AgentBackendBinding = (
  | typeof CODEX_AGENT_BACKEND_BINDING
  | { readonly kind: "claude"; readonly instanceConfigId: string }
  | { readonly kind: "opencode"; readonly instanceConfigId: string }
  | {
      readonly kind: "acp";
      readonly agentDefinitionId: string;
      readonly instanceConfigId: string | null;
    }
) & { readonly runtimeInstanceId?: string };

export const isCodexAgentBackendBinding = (
  binding: AgentBackendBinding,
): binding is typeof CODEX_AGENT_BACKEND_BINDING => binding.kind === "codex";

export type NativeAgentBackendKind = "claude" | "opencode";

export const isNativeAgentBackendKind = (
  kind: AgentBackendBinding["kind"] | undefined,
): kind is NativeAgentBackendKind => kind === "claude" || kind === "opencode";

/** The backend family behind an Agent Runtime driver, or null for a driver Nodex does not know. */
export const agentBackendKindOfRuntimeDriver = (
  driver: string | undefined,
): AgentBackendBinding["kind"] | null => {
  if (driver === "codex") return "codex";
  if (driver === "claudeAgent") return "claude";
  if (driver === "opencode" || driver === "opencode2") return "opencode";
  if (driver === "acpRegistry") return "acp";
  return null;
};
