import { CODEX_BINDING } from "../../shared/agents/codex";
import { agentReadiness } from "../../shared/agents/readiness";
import { agentDefinition } from "../../shared/agents/registry";
import { getIntl, type IntlShape } from "@/lib/i18n";
import { agentReadinessView } from "@/lib/agent-readiness-view";
import { modelIsOn, spendsNodexCredit } from "../../shared/model-policy";
import {
  ANTIGRAVITY_DEFAULT_MODEL,
  type AgentRuntimeOperations,
} from "@nodex/agent-runtime/contracts";
import type { AgentBackendBinding } from "../../shared/agent-backend";
import type { AgentModelSelection } from "../../shared/agent-model-catalog";
import type { AgentRuntimeLaunch } from "../../shared/agent-runtime-api";
import type { AgentModelOption } from "../../shared/types";
import { formatAgentModelName, formatCodexReasoningEffortLabel } from "./codex-thread-settings";
import {
  agentRuntimeModelSelection,
  applyAgentRuntimeOptionIntent,
  isAgentRuntimeEffortOption,
} from "../../shared/agent-runtime-provider";

type Provider = AgentRuntimeOperations["providers.read"]["output"][number];
type ModelSelection = AgentRuntimeLaunch["modelSelection"];

/** What a new chat without its own choice starts from. */
export interface AgentRuntimeNewChatDefaults {
  /** The last choice made in an unstarted chat's Composer. */
  readonly remembered?: AgentModelSelection | null;
  /** The global Fast preference, which owns native Codex's speed. */
  readonly codexServiceTier?: string | null;
  /** The person sees the model before sending, so a remembered credit model may start the chat. */
  readonly attended?: boolean;
}

export function isAgentRuntimeProviderAvailable(provider: Provider): boolean {
  if (!provider.enabled || !provider.installed || provider.status === "error") return false;
  const definition = agentDefinition(provider.driver);
  const readiness = agentReadiness({ definition, provider });
  return (
    !readiness || (readiness.problem.kind === "signed-out" && definition.setup?.models !== "choose")
  );
}

/**
 * A new chat without its own choice starts on the remembered one while its Agent offers it; a
 * switched-off model stays chosen so the Composer can say so. Otherwise it starts on that Agent's
 * default model, then Codex's, then another available Agent's. Falling back never spends credit.
 */
export function defaultAgentRuntimeModelSelection(
  providers: readonly Provider[],
  { remembered: choice, codexServiceTier, attended = false }: AgentRuntimeNewChatDefaults = {},
): ModelSelection | null {
  const remembered =
    choice && agentRuntimeModelSelection(choice.binding, choice.model, choice.options);
  const starting = (
    provider: Provider,
    model: Provider["models"][number],
    options?: ModelSelection["options"],
  ): ModelSelection => {
    const fitted = applyAgentRuntimeOptionIntent(
      model.capabilities?.optionDescriptors ?? [],
      options,
      provider.instanceId === CODEX_BINDING.instanceId && codexServiceTier !== undefined
        ? { serviceTier: codexServiceTier }
        : {},
    );
    return {
      instanceId: provider.instanceId,
      model: model.slug,
      ...(fitted.length ? { options: fitted } : {}),
    };
  };
  const canChoose = (provider: Provider) =>
    isAgentRuntimeProviderAvailable(provider) ||
    (attended &&
      provider.installationSource?.kind === "component" &&
      provider.enabled &&
      agentReadiness({ definition: agentDefinition(provider.driver), provider })?.problem.kind ===
        "installing");
  const rememberedProvider = providers.find(
    (provider) => provider.instanceId === remembered?.instanceId,
  );
  const rememberedModel = rememberedProvider?.models.find(
    (model) => model.slug === remembered?.model,
  );
  if (
    rememberedProvider &&
    rememberedModel &&
    (attended || !spendsNodexCredit(rememberedProvider)) &&
    (canChoose(rememberedProvider) ||
      (rememberedModel.policy?.on === false && rememberedProvider.availability !== "unavailable"))
  )
    return starting(rememberedProvider, rememberedModel, remembered?.options);
  const available = providers
    .map((provider) => ({ ...provider, models: provider.models.filter(modelIsOn) }))
    .filter(
      (provider) =>
        !spendsNodexCredit(provider) && canChoose(provider) && provider.models.length > 0,
    );
  const provider =
    available.find((entry) => entry.instanceId === remembered?.instanceId) ??
    available.find((entry) => entry.instanceId === CODEX_BINDING.instanceId) ??
    available[0];
  if (!provider) return null;
  return starting(
    provider,
    provider.models.find((entry) => entry.isDefault) ?? provider.models[0]!,
  );
}

/** The session default is the one alias that may resolve to a different model ID in chat. */
export function resolveAgentRuntimeChatModel(
  kind: AgentBackendBinding["driver"],
  model: string,
  provider: Provider | undefined,
): string {
  if (kind !== "antigravity" || model !== ANTIGRAVITY_DEFAULT_MODEL) return model;
  return (
    provider?.models.find(
      (entry) =>
        entry.slug !== ANTIGRAVITY_DEFAULT_MODEL &&
        (entry.aliases?.includes(ANTIGRAVITY_DEFAULT_MODEL) || entry.isDefault) &&
        modelIsOn(entry),
    )?.slug ?? ""
  );
}

/** An explicit choice keeps its exact identity and options, or fails without choosing another. */
export function requireAgentRuntimeModelSelection(
  providers: readonly Provider[],
  selection: ModelSelection | null,
) {
  if (!selection)
    throw new Error(
      getIntl().formatMessage({
        id: "lib.agentRuntimeModelSelection.chooseModel",
        defaultMessage: "Choose an available Agent model before starting this chat",
      }),
    );
  const provider = providers.find((entry) => entry.instanceId === selection.instanceId);
  const model = provider?.models.find((entry) => entry.slug === selection.model);
  if (model?.policy?.on === false)
    throw Object.assign(
      new Error(
        getIntl().formatMessage(
          {
            id: "lib.agentRuntimeModelSelection.modelOff",
            defaultMessage:
              "{model} on {provider} is off in Settings → Agents. Choose another model.",
          },
          {
            model: model.name,
            provider:
              provider?.source === "nodex"
                ? "Nodex"
                : (provider?.displayName ?? provider?.instanceId),
          },
        ),
      ),
      { code: "model_off", retryable: false },
    );
  if (!provider || !isAgentRuntimeProviderAvailable(provider) || !model) {
    const intl = getIntl();
    const definition = agentDefinition(provider?.driver);
    const readiness = provider && agentReadiness({ definition, provider, model: selection.model });
    if (readiness && readiness.problem.kind !== "checking") {
      const { title } = agentReadinessView(
        provider?.displayName ?? definition.label,
        readiness,
        intl,
      );
      throw new Error(
        intl.formatMessage(
          {
            id: "lib.agentRuntimeModelSelection.agentUnavailable",
            defaultMessage: "The selected Agent is unavailable. {reason}",
          },
          { reason: title },
        ),
      );
    }
    throw new Error(
      intl.formatMessage({
        id: "lib.agentRuntimeModelSelection.modelUnavailable",
        defaultMessage:
          "The selected Agent or model is unavailable. Choose an available Agent model.",
      }),
    );
  }
  return { provider, model, selection };
}

/** Every Agent's levels read alike, except an Agent that calls its lowest level Light. */
export const agentEffortLabel = (
  kind: AgentBackendBinding["driver"],
  effort: string,
  intl: IntlShape = getIntl(),
): string =>
  effort === "low" && !agentDefinition(kind).lightLowEffort
    ? intl.formatMessage({ id: "lib.agentRuntimeModelSelection.low", defaultMessage: "Low" })
    : formatCodexReasoningEffortLabel(effort, intl);

/** The catalog already names the same instance the product stores. */
export const agentRuntimeBinding = ({
  driver,
  instanceId,
}: Pick<Provider, "driver" | "instanceId">): AgentBackendBinding => ({ driver, instanceId });

/** The configured Agent name the user chose, then the provider's own name. */
export function agentRuntimeProviderLabel(
  provider: Pick<Provider, "instanceId" | "displayName" | "driver">,
  instances: readonly { readonly binding: AgentBackendBinding; readonly label: string }[],
): string {
  return (
    instances.find((entry) => entry.binding.instanceId === provider.instanceId)?.label ??
    provider.displayName ??
    agentDefinition(provider.driver).label
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
    const binding = agentRuntimeBinding(provider);
    if (!isAgentRuntimeProviderAvailable(provider) || !canServe(provider)) return [];
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
      description: option.description ?? "",
    })),
    defaultReasoningEffort:
      effort?.type === "select"
        ? (effort.currentValue ?? choices.find((option) => option.isDefault)?.id ?? "default")
        : "default",
    inputModalities: [...(model.capabilities?.inputModalities ?? [])],
    isDefault: model.isDefault ?? false,
    ...projectServiceTiers(model),
  };
}

/** Codex speed tiers beyond Standard, whose own option is `default`. */
function projectServiceTiers(
  model: Provider["models"][number],
): Pick<AgentModelOption, "serviceTiers" | "defaultServiceTier"> {
  const tier = model.capabilities?.optionDescriptors?.find(
    (descriptor) => descriptor.id === "serviceTier",
  );
  if (tier?.type !== "select") return {};
  const chosen = tier.currentValue ?? tier.options.find((option) => option.isDefault)?.id;
  return {
    serviceTiers: tier.options
      .filter((option) => option.id !== "default")
      .map((option) => ({
        id: option.id,
        name: option.label,
        description: option.description ?? "",
      })),
    defaultServiceTier: chosen === undefined || chosen === "default" ? null : chosen,
  };
}
