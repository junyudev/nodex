import type { AgentWire, ProviderInstanceRef } from "@nodex/agent-runtime/contracts";
import { CODEX_BINDING } from "./agents/codex";

export { CODEX_BINDING as CODEX_AGENT_BACKEND_BINDING };

/** Durable Agent identity shared with Agent Runtime. */
export type AgentBackendBinding = AgentWire<ProviderInstanceRef>;

/** Native Codex owns existing app-server Threads at the default instance. */
export const isCodexAgentBackendBinding = (binding: AgentBackendBinding): boolean =>
  binding.driver === CODEX_BINDING.driver && binding.instanceId === CODEX_BINDING.instanceId;
