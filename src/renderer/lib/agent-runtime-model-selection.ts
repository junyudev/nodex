import { modelIsOn } from "../../shared/model-policy";
import { isNodexProviderId } from "../../shared/nodex-models";
import type { AgentRuntimeOperations } from "@nodex/agent-runtime/contracts";
import type { AgentBackendBinding } from "../../shared/agent-backend";
import type { AgentRuntimeLaunch } from "../../shared/agent-runtime-api";
import type { AgentModelOption } from "../../shared/types";
import { formatAgentModelName, formatCodexReasoningEffortLabel } from "./codex-thread-settings";
import {
  agentRuntimeProviderId,
  applyAgentRuntimeOptionIntent,
  isAgentRuntimeEffortOption,
} from "../../shared/agent-runtime-provider";

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
  const savedProvider = providers.find((provider) => provider.instanceId === "codex");
  const savedModel = savedProvider?.models.find((model) => model.slug === saved.model);
  if (savedModel?.policy?.on === false) return { instanceId: "codex", model: savedModel.slug };
  const available = providers
    .map((provider) => ({ ...provider, models: provider.models.filter(modelIsOn) }))
    .filter(
      (provider) =>
        provider.source !== "nodex" &&
        !isNodexProviderId(provider.instanceId) &&
        isAgentRuntimeProviderAvailable(provider) &&
        provider.models.length > 0,
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
  if (model?.policy?.on === false)
    throw Object.assign(
      new Error(
        `${model.name} on ${provider?.source === "nodex" ? "Nodex" : (provider?.displayName ?? provider?.instanceId)} is off in Settings → Models. Choose another model.`,
      ),
      { code: "model_off", retryable: false },
    );
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

export const agentEffortLabel = (kind: AgentBackendBinding["kind"], effort: string): string =>
  kind === "claude" && effort === "low" ? "Low" : formatCodexReasoningEffortLabel(effort);

/** The configured Agent behind a Runtime provider instance; Codex needs no configuration. */
export function agentRuntimeBinding(
  instanceId: string,
  instances: readonly { readonly binding: AgentBackendBinding }[],
): AgentBackendBinding | undefined {
  if (isNodexProviderId(instanceId))
    return instanceId.startsWith("nodex_codex_")
      ? { kind: "codex", runtimeInstanceId: instanceId }
      : { kind: "claude", instanceConfigId: instanceId, runtimeInstanceId: instanceId };
  return instanceId === "codex"
    ? { kind: "codex" }
    : instances.find((entry) => agentRuntimeProviderId(entry.binding) === instanceId)?.binding;
}

/** The configured Agent name the user chose, then the provider's own name. */
export function agentRuntimeProviderLabel(
  provider: Pick<Provider, "instanceId" | "displayName">,
  instances: readonly { readonly binding: AgentBackendBinding; readonly label: string }[],
): string {
  return (
    instances.find((entry) => agentRuntimeProviderId(entry.binding) === provider.instanceId)
      ?.label ??
    provider.displayName ??
    (provider.instanceId === "codex" ? "Codex" : "Agent")
  );
}

/**
 * What a model picker lists for one use: the on models of every available Agent that can serve it.
 * A saved choice stays listed, so turning it off never changes it silently.
 */
export function agentRuntimePickerEntries(
  catalog: {
    readonly providers: readonly Provider[];
    readonly instances: readonly {
      readonly binding: AgentBackendBinding;
      readonly label: string;
    }[];
  },
  saved: { readonly instanceId: string; readonly model: string | null } | null,
  canServe: (provider: Provider) => boolean,
) {
  return catalog.providers.flatMap((provider) => {
    const binding = agentRuntimeBinding(provider.instanceId, catalog.instances);
    if (!binding || !isAgentRuntimeProviderAvailable(provider) || !canServe(provider)) return [];
    const label = agentRuntimeProviderLabel(provider, catalog.instances);
    return provider.models
      .filter(
        (model) =>
          modelIsOn(model) ||
          (provider.instanceId === saved?.instanceId && model.slug === saved.model),
      )
      .map((model) => ({
        binding,
        label,
        model: projectAgentRuntimeModel(provider, model),
        selection: { binding, model: model.slug },
      }));
  });
}

/** A Runtime model as the shared model picker lists it, with its effort choices. */
export function projectAgentRuntimeModel(
  provider: Provider,
  model: Provider["models"][number],
): AgentModelOption {
  const effort = model.capabilities?.optionDescriptors?.find(isAgentRuntimeEffortOption);
  const choices = effort?.type === "select" ? effort.options : [];
  const name = formatAgentModelName(model.name);
  return {
    id: model.slug,
    model: model.slug,
    displayName: name,
    description: name,
    hidden: false,
    supportedReasoningEfforts: choices.map((option) => ({
      reasoningEffort: option.id,
      description: option.description ?? option.label,
    })),
    defaultReasoningEffort:
      effort?.type === "select"
        ? (effort.currentValue ?? choices.find((option) => option.isDefault)?.id ?? "default")
        : "default",
    inputModalities: [...(model.capabilities?.inputModalities ?? [])],
    isDefault: model.isDefault ?? false,
  };
}
