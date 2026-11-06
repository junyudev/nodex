import { modelIsOn, spendsNodexCredit } from "../../shared/model-policy";
import type { AgentRuntimeOperations } from "@nodex/agent-runtime/contracts";
import type { AgentRuntimeLaunch } from "../../shared/agent-runtime-api";
import {
  inboxDefaultSuggestionModel,
  isInboxProviderUsable,
  supportsInboxStructuredGeneration,
  type InboxSettings,
} from "../../shared/inbox";
import { lightUtilityModelSelection } from "../../shared/agent-runtime-utility-model";

type Providers = AgentRuntimeOperations["providers.read"]["output"];
type Preference = Pick<InboxSettings, "suggestionAgent">;

/** Reuse the utility Agent preference, with an economical model and the lightest offered effort. */
export const selectPageTextRewriteModel = (
  providers: Providers,
  preference: Preference,
): AgentRuntimeLaunch["modelSelection"] | null => {
  const configuredProvider = providers.find(
    (provider) => provider.instanceId === preference.suggestionAgent.instanceId,
  );
  if (
    preference.suggestionAgent.model &&
    configuredProvider?.models.some(
      (model) => model.slug === preference.suggestionAgent.model && !modelIsOn(model),
    )
  )
    return { instanceId: configuredProvider.instanceId, model: preference.suggestionAgent.model };
  const usable = providers
    .map((provider) => ({ ...provider, models: provider.models.filter(modelIsOn) }))
    .filter(
      (provider) =>
        isInboxProviderUsable(provider) &&
        provider.installed &&
        provider.auth.status !== "unauthenticated" &&
        supportsInboxStructuredGeneration(provider) &&
        provider.supportsTextGeneration !== false &&
        provider.models.length > 0,
    );
  const preferred = usable.find(
    (provider) => provider.instanceId === preference.suggestionAgent.instanceId,
  );
  const provider = preferred ?? usable.find((candidate) => !spendsNodexCredit(candidate));
  if (!provider) return null;
  const configured =
    preferred && preference.suggestionAgent.model
      ? provider.models.find((model) => model.slug === preference.suggestionAgent.model)
      : undefined;
  const economical =
    provider.driver === "codex"
      ? provider.models.find((model) => model.slug === "gpt-6-luna")
      : (provider.models.find((model) => /haiku/i.test(model.slug)) ??
        provider.models.find((model) => /sonnet/i.test(model.slug)));
  if (!configured && spendsNodexCredit(provider)) return null;
  const model = configured ?? economical ?? inboxDefaultSuggestionModel(provider);
  if (!model) return null;
  return lightUtilityModelSelection(
    { instanceId: provider.instanceId, model: model.slug },
    providers,
  );
};
