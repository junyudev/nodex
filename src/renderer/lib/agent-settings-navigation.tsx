import { createContext, useContext, type ReactNode } from "react";
import type { AgentBackendBinding } from "../../shared/agent-backend";
import { acpAgentAnchor, isAcpAgentsAnchor } from "@/features/acp-agents/acp-agent-model";

export type AgentSettingsKind = AgentBackendBinding["kind"];
/** Opens Settings > Agents at a backend's section or one ACP instance; no kind opens the page. */
type OpenAgentSettings = (kind?: AgentSettingsKind, instanceId?: string) => void;

/** The Agents page sections in page order; each one's anchor is its kind. */
export const AGENT_SETTINGS_KINDS = [
  "codex",
  "claude",
  "opencode",
  "acp",
] as const satisfies readonly AgentSettingsKind[];

/** The Settings > Agents anchor for a backend's section, or for one ACP instance in it. */
export const agentSettingsAnchor = (kind: AgentSettingsKind, instanceId?: string) =>
  kind === "acp" && instanceId ? acpAgentAnchor(instanceId) : kind;

/** The section a deep link or search result opens: the one it names or the one containing it. */
export function agentSettingsKindForAnchor(
  anchor: string | null | undefined,
): AgentSettingsKind | null {
  if (!anchor) return null;
  if (isAcpAgentsAnchor(anchor)) return "acp";
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
