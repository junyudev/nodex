import { useEffect, useState } from "react";
import { agentRuntimeRuntime } from "@/lib/agent-runtime-runtime";
import type { AgentBackendBinding } from "../../../shared/agent-backend";
import { agentRuntimeProviderId } from "../../../shared/agent-runtime-provider";
import { projectAgentRuntimeModel } from "@/lib/agent-runtime-model-selection";
import type { AgentRuntimeProvider } from "../local-conversation/agent-runtime-conversation-adapter";

/**
 * An ACP instance's advertised models for a scheduled run, read from what the Runtime already
 * knows. Nothing is listed until a real connection reported them, and nothing is started here.
 */
export const useAcpAutomationModels = (binding: AgentBackendBinding) => {
  const providerId = binding.kind === "acp" ? agentRuntimeProviderId(binding) : null;
  const [state, setState] = useState<{
    readonly providerId: string;
    readonly provider: AgentRuntimeProvider | null;
  } | null>(null);
  useEffect(() => {
    if (!providerId) return;
    let active = true;
    void agentRuntimeRuntime.catalog({ instanceIds: [providerId] }).then(
      (providers) => {
        if (active)
          setState({
            providerId,
            provider: providers.find((entry) => entry.instanceId === providerId) ?? null,
          });
      },
      () => {
        if (active) setState({ providerId, provider: null });
      },
    );
    return () => {
      active = false;
    };
  }, [providerId]);
  const provider = state?.providerId === providerId ? state.provider : null;
  return {
    loading: providerId !== null && state?.providerId !== providerId,
    discovered: provider?.discovery?.status === "ready",
    models:
      provider?.discovery?.status === "ready"
        ? provider.models.map((model) => projectAgentRuntimeModel(provider, model))
        : [],
  };
};
