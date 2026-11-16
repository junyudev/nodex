import { defineMessage } from "@/lib/i18n";
import { getIntl } from "@/lib/i18n";
import type { AgentRuntimeOperations } from "@nodex/agent-runtime/contracts";
import type { AgentBackendBinding } from "../../../shared/agent-backend";
import type { AgentModelSelection } from "../../../shared/agent-model-catalog";
import type { AgentRuntimeTitleModel } from "../../../shared/agent-runtime-settings";
import { modelIsOn } from "../../../shared/model-policy";
import { agentRuntimeQualifier } from "@/lib/agent-model-selection";
import {
  agentRuntimeBinding,
  agentRuntimePickerEntries,
  agentRuntimeProviderBackendKind,
  agentRuntimeProviderLabel,
  isAgentRuntimeProviderAvailable,
} from "@/lib/agent-runtime-model-selection";
import { formatAgentModelName } from "@/lib/codex-thread-settings";

type Provider = AgentRuntimeOperations["providers.read"]["output"][number];

export const chatTitleModelDefaultLabelMessage = defineMessage({
  id: "settings.chatTitleModel.inherit",
  defaultMessage: "Light model, same Agent",
});
const DEFAULT_TITLE_MODEL_MESSAGE = {
  id: "workbench.chatTitleModel.defaultChoice",
  defaultMessage: "Light model, same Agent",
};

export interface ChatTitleModelCatalog {
  readonly providers: readonly Provider[];
  /** `loading` until the first catalog read lands; a failed read keeps what it had. */
  readonly state: "loading" | "ready" | "error";
  readonly instances: readonly {
    readonly binding: AgentBackendBinding;
    readonly label: string;
  }[];
}

export interface ChatTitleModelPresentation {
  readonly status: "ready" | "checking" | "unavailable";
  /** The Agent's mark; the default follows each chat, so it has no single Agent. */
  readonly kind: AgentBackendBinding["kind"] | null;
  readonly line: string;
}

const canGenerateTitles = (provider: Provider) => provider.supportsTextGeneration !== false;

/**
 * What titles chats, as Settings says it before anything runs. A choice that cannot run reads as
 * such, because it is never replaced: those chats keep their provisional titles.
 */
export function describeChatTitleModel(
  catalog: ChatTitleModelCatalog,
  choice: AgentRuntimeTitleModel | null,
): ChatTitleModelPresentation {
  if (!choice)
    return {
      status: "ready",
      kind: null,
      line: getIntl().formatMessage(DEFAULT_TITLE_MODEL_MESSAGE),
    };
  if (catalog.state === "loading")
    return {
      status: "checking",
      kind: null,
      line: getIntl().formatMessage({
        id: "workbench.chatTitleModel.loading",
        defaultMessage: "Loading…",
      }),
    };
  const provider = catalog.providers.find((entry) => entry.instanceId === choice.instanceId);
  // A failed first read cannot tell whether the choice still exists, so it shows it as chosen.
  if (!provider)
    return catalog.state === "error"
      ? { status: "checking", kind: null, line: choice.model }
      : {
          status: "unavailable",
          kind: null,
          line: getIntl().formatMessage(
            { id: "workbench.chatTitleModel.unavailable", defaultMessage: "{name} · Unavailable" },
            { name: choice.model },
          ),
        };
  const kind = agentRuntimeProviderBackendKind(provider);
  const model = provider.models.find((entry) => entry.slug === choice.model);
  const name = [
    agentRuntimeQualifier({ kind }, agentRuntimeProviderLabel(provider, catalog.instances)),
    model ? formatAgentModelName(model.name) : choice.model,
  ]
    .filter(Boolean)
    .join(" · ");
  if (model && !modelIsOn(model))
    return {
      status: "unavailable",
      kind,
      line: getIntl().formatMessage(
        { id: "workbench.chatTitleModel.off", defaultMessage: "{name} · Off" },
        { name },
      ),
    };
  // A cold boot snapshot is enabled but not yet installed or probed. Refresh owns the probe.
  if (provider.enabled && provider.status !== "error" && provider.models.length === 0)
    return {
      status: "checking",
      kind,
      line: getIntl().formatMessage(
        { id: "workbench.chatTitleModel.checking", defaultMessage: "{name} · Checking…" },
        { name },
      ),
    };
  return model && isAgentRuntimeProviderAvailable(provider) && canGenerateTitles(provider)
    ? { status: "ready", kind, line: name }
    : {
        status: "unavailable",
        kind,
        line: getIntl().formatMessage(
          { id: "workbench.chatTitleModel.unavailable", defaultMessage: "{name} · Unavailable" },
          { name },
        ),
      };
}

/** Projects the choice onto the shared model picker; every Agent that generates text can title. */
export function chatTitleModelPicker(
  catalog: ChatTitleModelCatalog,
  choice: AgentRuntimeTitleModel | null,
) {
  const binding = choice && agentRuntimeBinding(choice.instanceId, catalog.instances);
  const selected: AgentModelSelection =
    binding && choice
      ? { binding, model: choice.model }
      : { binding: { kind: "codex" }, model: "" };
  return { entries: agentRuntimePickerEntries(catalog, choice, canGenerateTitles), selected };
}
