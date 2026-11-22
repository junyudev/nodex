import {
  agentDefinition,
  agentSettingsSections,
  type AgentSettingsAnchor,
} from "../../shared/agents/registry";
import { createContext, useContext, type ReactNode } from "react";
import type { AgentBackendBinding } from "../../shared/agent-backend";
import { providerKeyConnectionIdOfInstanceId } from "../../shared/provider-keys";
import { isAcpAgentsAnchor } from "@/features/acp-agents/acp-agent-model";
import {
  isProviderKeyAnchor,
  providerKeyAnchor,
} from "@/features/provider-keys/provider-key-anchor";

export type AgentSettingsKind = AgentSettingsAnchor;

/** Opens Settings > Agents at a section or one item in it. */
type OpenAgentSettings = (kind?: AgentSettingsKind, instanceId?: string) => void;

export function agentSettingsAnchor(kind: AgentSettingsKind, instanceId?: string) {
  if (!instanceId) return kind;
  if (kind === "keys") return providerKeyAnchor(instanceId);
  const section = agentSettingsSections.find((section) => section.settingsAnchor === kind);
  return section && "profileAnchorPrefix" in section
    ? `${section.profileAnchorPrefix}${instanceId}`
    : kind;
}

/** A setup entry may precede the creation of a configured instance. */
export type AgentSetupTarget = Pick<AgentBackendBinding, "driver"> &
  Partial<Pick<AgentBackendBinding, "instanceId">>;

/** Where an Agent's settings live: an API key's connection, an ACP instance or its backend. */
export function agentSettingsTarget(binding: AgentSetupTarget): {
  readonly kind: AgentSettingsKind | undefined;
  readonly instanceId?: string;
} {
  const connectionId =
    binding.instanceId && providerKeyConnectionIdOfInstanceId(binding.instanceId);
  if (connectionId) return { kind: "keys", instanceId: connectionId };
  const definition = agentDefinition(binding.driver);
  const kind = agentSettingsSections.find(
    (section) => section.settingsAnchor === definition.settingsAnchor,
  )?.settingsAnchor;
  return {
    kind,
    ...(definition.profileAnchorPrefix ? { instanceId: binding.instanceId } : {}),
  };
}
/** The section a deep link or search result opens: the one it names or the one containing it. */
export function agentSettingsKindForAnchor(
  anchor: string | null | undefined,
): AgentSettingsKind | null {
  if (!anchor) return null;
  if (isAcpAgentsAnchor(anchor)) return "acp";
  if (isProviderKeyAnchor(anchor)) return "keys";
  return (
    agentSettingsSections.find(
      (section) =>
        section.settingsAnchor === anchor ||
        ("profileAnchorPrefix" in section && anchor.startsWith(section.profileAnchorPrefix)),
    )?.settingsAnchor ?? null
  );
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
