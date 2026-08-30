import { createContext, useContext, type ReactNode } from "react";
import type { AgentIntelligenceSelection } from "@/components/shared/agent-runtime/agent-intelligence-dropdown";
import type { CodexModelOption, CodexPermissionState } from "@/lib/types";

export interface AgentConfigRuntimeValue {
  readonly projectId: string | null;
  readonly availableModels: readonly CodexModelOption[];
  readonly availableModelsLoading: boolean;
  readonly defaultIntelligence: AgentIntelligenceSelection | null;
  readonly permissionState: CodexPermissionState;
}

const AgentConfigRuntimeContext = createContext<AgentConfigRuntimeValue | null>(null);

export function AgentConfigRuntimeProvider({
  value,
  children,
}: {
  value: AgentConfigRuntimeValue;
  children: ReactNode;
}) {
  return (
    <AgentConfigRuntimeContext.Provider value={value}>
      {children}
    </AgentConfigRuntimeContext.Provider>
  );
}

export function useAgentConfigRuntime(): AgentConfigRuntimeValue | null {
  return useContext(AgentConfigRuntimeContext);
}
