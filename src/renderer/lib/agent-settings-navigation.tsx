import { createContext, useContext, type ReactNode } from "react";
import type { AgentBackendBinding } from "../../shared/agent-backend";
import { providerKeyConnectionIdOfInstanceId } from "../../shared/provider-keys";
import { acpAgentAnchor, isAcpAgentsAnchor } from "@/features/acp-agents/acp-agent-model";
import {
  isProviderKeyAnchor,
  providerKeyAnchor,
} from "@/features/provider-keys/provider-key-anchor";

/** A section of Settings > Agents: one per backend, and API keys. */
export type AgentSettingsKind = AgentBackendBinding["kind"] | "keys";
/** Opens Settings > Agents at a section or one item in it; no section opens the page. */
type OpenAgentSettings = (kind?: AgentSettingsKind, instanceId?: string) => void;

/** The Agents page sections in page order; each one's anchor is its kind. */
export const AGENT_SETTINGS_KINDS = [
  "codex",
  "claude",
  "antigravity",
  "keys",
  "opencode",
  "acp",
] as const satisfies readonly AgentSettingsKind[];

export const antigravityAgentAnchor = (instanceId: string) => `antigravity-agent-${instanceId}`;

/** The Settings > Agents anchor for a section or one of its configured profiles. */
export const agentSettingsAnchor = (kind: AgentSettingsKind, instanceId?: string) =>
  kind === "acp" && instanceId
    ? acpAgentAnchor(instanceId)
    : kind === "keys" && instanceId
      ? providerKeyAnchor(instanceId)
      : kind === "antigravity" && instanceId
        ? antigravityAgentAnchor(instanceId)
        : kind;

/** Where an Agent's settings live: an API key's connection, an ACP instance or its backend. */
export function agentSettingsTarget(binding: AgentBackendBinding): {
  readonly kind: AgentSettingsKind;
  readonly instanceId?: string;
} {
  const connectionId = binding.runtimeInstanceId
    ? providerKeyConnectionIdOfInstanceId(binding.runtimeInstanceId)
    : null;
  if (connectionId) return { kind: "keys", instanceId: connectionId };
  if (binding.kind === "acp" && binding.instanceConfigId)
    return { kind: "acp", instanceId: binding.instanceConfigId };
  if (binding.kind === "antigravity" && !binding.runtimeInstanceId && binding.instanceConfigId)
    return { kind: "antigravity", instanceId: binding.instanceConfigId };
  return { kind: binding.kind };
}

/** The section a deep link or search result opens: the one it names or the one containing it. */
export function agentSettingsKindForAnchor(
  anchor: string | null | undefined,
): AgentSettingsKind | null {
  if (!anchor) return null;
  if (isAcpAgentsAnchor(anchor)) return "acp";
  if (isProviderKeyAnchor(anchor)) return "keys";
  if (anchor.startsWith(antigravityAgentAnchor(""))) return "antigravity";
  return AGENT_SETTINGS_KINDS.find((kind) => kind === anchor) ?? null;
}

const AgentSettingsNavigationContext = createContext<OpenAgentSettings | null>(null);

/** The current Workbench window owns settings navigation. */
export function AgentSettingsNavigationProvider({
  openAgentSettings,
  children,
}: {
  openAgentSettings: OpenAgentSettings;
  children: ReactNode;
}) {
  return (
    <AgentSettingsNavigationContext value={openAgentSettings}>
      {children}
    </AgentSettingsNavigationContext>
  );
}

export const useAgentSettingsNavigation = () => useContext(AgentSettingsNavigationContext);
