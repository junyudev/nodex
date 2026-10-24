import { createContext, useContext, type ReactNode } from "react";
import type { AgentBackendBinding } from "../../shared/agent-backend";

export type AgentSettingsKind = Exclude<AgentBackendBinding["kind"], "codex">;
/** Opens Settings > Agent, at a backend's section or one ACP instance; no kind opens the page. */
type OpenAgentSettings = (kind?: AgentSettingsKind, instanceId?: string) => void;

const AgentSettingsNavigationContext = createContext<OpenAgentSettings | null>(null);

/** The current Workbench window owns settings navigation; native Codex accounts stay separate. */
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
