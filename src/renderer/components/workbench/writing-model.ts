import { CODEX_AGENT_BACKEND_BINDING } from "../../../shared/agent-backend";
import { defineMessage } from "@/lib/i18n";
import { getIntl } from "@/lib/i18n";
import type { AgentRuntimeOperations } from "@nodex/agent-runtime/contracts";
import type { AgentBackendBinding } from "../../../shared/agent-backend";
import type { AgentModelSelection } from "../../../shared/agent-model-catalog";
import type { AgentRuntimeWritingModel } from "../../../shared/agent-runtime-settings";
import { isWritingProviderUsable } from "../../../shared/agent-runtime-utility-model";
import { modelIsOn } from "../../../shared/model-policy";
import { agentRuntimeQualifier } from "@/lib/agent-model-selection";
import {
  agentRuntimeBinding,
  agentRuntimePickerEntries,
  agentRuntimeProviderLabel,
} from "@/lib/agent-runtime-model-selection";
import { formatAgentModelName } from "@/lib/codex-thread-settings";

type Provider = AgentRuntimeOperations["providers.read"]["output"][number];

export const writingModelDefaultLabelMessage = defineMessage({
  id: "settings.writingModel.inherit",
  defaultMessage: "Automatic",
});

export interface WritingModelCatalog {
  readonly providers: readonly Provider[];
  /** `loading` until the first catalog read lands; a failed read keeps what it had. */
  readonly state: "loading" | "ready" | "error";
  readonly instances: readonly {
    readonly binding: AgentBackendBinding;
    readonly label: string;
  }[];
}

export interface WritingModelPresentation {
  readonly status: "ready" | "checking" | "unavailable";
  /** The Agent's mark; automatic selection has no single Agent. */
  readonly kind: AgentBackendBinding["driver"] | null;
  readonly line: string;
}

/** Keep the saved choice visible when generation needs to fall back. */
export function describeWritingModel(
  catalog: WritingModelCatalog,
  choice: AgentRuntimeWritingModel | null,
): WritingModelPresentation {
  if (!choice)
    return {
      status: "ready",
      kind: null,
      line: getIntl().formatMessage(writingModelDefaultLabelMessage),
    };
  if (catalog.state === "loading")
    return {
      status: "checking",
      kind: null,
      line: getIntl().formatMessage({
        id: "settings.writingModel.loading",
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
            { id: "settings.writingModel.unavailable", defaultMessage: "{name} · Unavailable" },
            { name: choice.model },
          ),
        };
  const kind = provider.driver;
  const model = provider.models.find((entry) => entry.slug === choice.model);
  const name = [
    agentRuntimeQualifier({ driver: kind }, agentRuntimeProviderLabel(provider, catalog.instances)),
    model ? formatAgentModelName(model.name) : choice.model,
  ]
    .filter(Boolean)
    .join(" · ");
  if (model && !modelIsOn(model))
    return {
      status: "unavailable",
      kind,
      line: getIntl().formatMessage(
        { id: "settings.writingModel.off", defaultMessage: "{name} · Off" },
        { name },
      ),
    };
  // A cold boot snapshot is enabled but not yet installed or probed. Refresh owns the probe.
  if (
    provider.enabled &&
    provider.availability !== "unavailable" &&
    provider.status !== "error" &&
    provider.models.length === 0
  )
    return {
      status: "checking",
      kind,
      line: getIntl().formatMessage(
        { id: "settings.writingModel.checking", defaultMessage: "{name} · Checking…" },
        { name },
      ),
    };
  return model && isWritingProviderUsable(provider)
    ? { status: "ready", kind, line: name }
    : {
        status: "unavailable",
        kind,
        line: getIntl().formatMessage(
          { id: "settings.writingModel.unavailable", defaultMessage: "{name} · Unavailable" },
          { name },
        ),
      };
}

/** Projects the choice onto the shared model picker; every Agent that supports structured text is eligible. */
export function writingModelPicker(
  catalog: WritingModelCatalog,
  choice: AgentRuntimeWritingModel | null,
) {
  const provider = catalog.providers.find((entry) => entry.instanceId === choice?.instanceId);
  const binding = provider && agentRuntimeBinding(provider);
  const selected: AgentModelSelection =
    binding && choice
      ? { binding, model: choice.model }
      : { binding: CODEX_AGENT_BACKEND_BINDING, model: "" };
  return { entries: agentRuntimePickerEntries(catalog, choice, isWritingProviderUsable), selected };
}
