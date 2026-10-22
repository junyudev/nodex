import type { AgentRuntimeOperations } from "@nodex/agent-runtime/contracts";
import type { AgentBackendBinding } from "../../shared/agent-backend";
import type { AgentRuntimeLaunch } from "../../shared/agent-runtime-api";
import { applyAgentRuntimeOptionIntent } from "../../shared/agent-runtime-provider";

type Provider = AgentRuntimeOperations["providers.read"]["output"][number];
type ModelSelection = AgentRuntimeLaunch["modelSelection"];

export interface AgentRuntimeCodexDefaults {
  readonly model?: string;
  readonly reasoningEffort?: string;
  readonly serviceTier?: string | null;
}

export const isAgentRuntimeProviderAvailable = (provider: Provider): boolean =>
  provider.enabled &&
  provider.installed &&
  provider.status !== "error" &&
  provider.status !== "disabled";

/** A new chat without its own choice uses saved Codex preferences, then an available Agent. */
export function defaultAgentRuntimeModelSelection(
  providers: readonly Provider[],
  saved: AgentRuntimeCodexDefaults = {},
): ModelSelection | null {
  const available = providers.filter(
    (provider) => isAgentRuntimeProviderAvailable(provider) && provider.models.length > 0,
  );
  const provider = available.find((entry) => entry.instanceId === "codex") ?? available[0];
  if (!provider) return null;
  const model =
    (provider.instanceId === "codex"
      ? provider.models.find((entry) => entry.slug === saved.model)
      : undefined) ??
    provider.models.find((entry) => entry.isDefault) ??
    provider.models[0]!;
  const options =
    provider.instanceId === "codex"
      ? applyAgentRuntimeOptionIntent(model.capabilities?.optionDescriptors ?? [], undefined, {
          ...(saved.reasoningEffort ? { reasoningEffort: saved.reasoningEffort } : {}),
          ...(saved.serviceTier !== undefined ? { serviceTier: saved.serviceTier } : {}),
        })
      : [];
  return {
    instanceId: provider.instanceId,
    model: model.slug,
    ...(options.length ? { options } : {}),
  };
}

/** An explicit choice keeps its exact identity and options, or fails without choosing another. */
export function requireAgentRuntimeModelSelection(
  providers: readonly Provider[],
  selection: ModelSelection | null,
) {
  if (!selection) throw new Error("Choose an available Agent model before starting this chat");
  const provider = providers.find((entry) => entry.instanceId === selection.instanceId);
  const model = provider?.models.find((entry) => entry.slug === selection.model);
  if (!provider || !isAgentRuntimeProviderAvailable(provider) || !model)
    throw new Error("The selected Agent or model is unavailable. Choose an available Agent model.");
  return { provider, model, selection };
}

/** Runtime drivers use the same backend family as their configured desktop Agent. */
export function agentRuntimeProviderBackendKind(provider: Provider): AgentBackendBinding["kind"] {
  if (provider.driver === "codex") return "codex";
  if (provider.driver === "claudeAgent") return "claude";
  if (provider.driver === "opencode" || provider.driver === "opencode2") return "opencode";
  return "acp";
}
