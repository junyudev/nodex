import { agentDefinition } from "../../../shared/agents/registry";
import { useEffect, useState } from "react";
import { agentRuntimeRuntime } from "@/lib/agent-runtime-runtime";
import type { AgentBackendBinding } from "../../../shared/agent-backend";
import { projectAgentRuntimeModel } from "@/lib/agent-runtime-model-selection";
import type { AgentRuntimeProvider } from "../local-conversation/agent-runtime-conversation-adapter";

/**
 * An Agent profile's advertised models for a scheduled run, read from what the Runtime already
 * knows. Nothing is listed until a real connection reported them, and nothing is started here.
 */
export const useAcpAutomationModels = (binding: AgentBackendBinding) => {
  const modelSource = agentDefinition(binding.driver).capabilities.automation?.modelSource;
  const providerId =
    modelSource === "discovery" || modelSource === "account" ? binding.instanceId : null;
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
  const discovered =
    modelSource === "account"
      ? Boolean(provider?.models.length && provider.auth.status !== "unauthenticated")
      : provider?.discovery?.status === "ready";
  return {
    loading: providerId !== null && state?.providerId !== providerId,
    discovered,
    models:
      provider && discovered
        ? provider.models.map((model) => projectAgentRuntimeModel(provider, model))
        : [],
  };
};
