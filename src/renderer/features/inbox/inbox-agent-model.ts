import { getIntl, type IntlShape } from "@/lib/i18n";
import type { AgentRuntimeOperations } from "@nodex/agent-runtime/contracts";
import type { AgentBackendBinding } from "../../../shared/agent-backend";
import type { AgentSessionConfigOption } from "../../../shared/agent-conversation";
import type { AgentModelSelection } from "../../../shared/agent-model-catalog";
import type { AgentRuntimeLaunch } from "../../../shared/agent-runtime-api";
import {
  agentRuntimeProviderId,
  isAgentRuntimeEffortOption,
  fitAgentRuntimeServiceTier,
} from "../../../shared/agent-runtime-provider";
import {
  inboxDefaultChatModel,
  inboxDefaultSuggestionModel,
  inboxModelEffort,
  inboxRequestedEffort,
  resolveInboxAgentChoice,
  resolveInboxModel,
  supportsInboxStructuredGeneration,
  type InboxAgentChoice,
} from "../../../shared/inbox";
import type { AgentModelOption, CodexReasoningEffort } from "../../../shared/types";
import { normalizeCodexServiceTier } from "../../../shared/codex-service-tier";
import { agentRuntimeQualifier } from "@/lib/agent-model-selection";
import { formatAgentModelName } from "@/lib/codex-thread-settings";
import {
  agentEffortLabel,
  agentRuntimeBinding,
  agentRuntimePickerEntries,
  agentRuntimeProviderBackendKind,
  agentRuntimeProviderLabel,
  isAgentRuntimeProviderAvailable,
  projectAgentRuntimeModel,
} from "@/lib/agent-runtime-model-selection";

type Provider = AgentRuntimeOperations["providers.read"]["output"][number];
type ProviderModel = Provider["models"][number];
type Instance = { readonly binding: AgentBackendBinding; readonly label: string };

/** The suggestion Agent writes advice for every message; the chat Agent runs chats it starts. */
export type InboxAgentPurpose = "chat" | "suggestion";

/** The Runtime catalog and configured Agents an Inbox choice is read against. */
export interface InboxAgentCatalog {
  readonly providers: readonly Provider[];
  /** `loading` until the first catalog read lands; a failed read keeps what it had. */
  readonly state: "loading" | "ready" | "error";
  readonly instances: readonly Instance[];
}

/** What an Inbox Agent will run on, as the Inbox says it before anything runs. */
export interface InboxAgentPresentation {
  readonly status: "ready" | "checking" | "unavailable";
  readonly kind: AgentBackendBinding["kind"] | null;
  /** The Agent's name, such as `Codex` or a Claude account's name. */
  readonly agent: string;
  /** Whether the name says more than the Agent's mark, as a second account's name does. */
  readonly named: boolean;
  /** Model, effort and speed, such as `GPT-6 Astra · Medium`, or why it cannot run. */
  readonly detail: string;
  readonly serviceTier: string | null;
  readonly serviceTierName: string | null;
}

/** An Agent the catalog cannot name keeps its real identity rather than reading as another. */
const agentName = (catalog: InboxAgentCatalog, instanceId: string) => {
  const provider = catalog.providers.find((candidate) => candidate.instanceId === instanceId);
  return provider
    ? agentRuntimeProviderLabel(provider, catalog.instances)
    : (catalog.instances.find((entry) => agentRuntimeProviderId(entry.binding) === instanceId)
        ?.label ?? (instanceId === "codex" ? "Codex" : instanceId));
};

/** How the Inbox names an Agent: its name, its mark, and whether the name says more than the mark. */
export function inboxAgentIdentity(
  catalog: InboxAgentCatalog,
  instanceId: string,
): Pick<InboxAgentPresentation, "agent" | "kind" | "named"> {
  const agent = agentName(catalog, instanceId);
  const provider = catalog.providers.find((candidate) => candidate.instanceId === instanceId);
  const kind = provider ? agentRuntimeProviderBackendKind(provider) : null;
  return { agent, kind, named: !kind || agentRuntimeQualifier({ kind }, agent) !== null };
}

const effortDescriptor = (model: ProviderModel | undefined) =>
  model?.capabilities?.optionDescriptors?.find(isAgentRuntimeEffortOption);

const selectedEffort = (
  model: ProviderModel,
  selection: AgentRuntimeLaunch["modelSelection"],
): string | null => {
  const id = effortDescriptor(model)?.id;
  const value = selection.options?.find((option) => option.id === id)?.value;
  return inboxModelEffort(model, typeof value === "string" ? value : null);
};

const inboxServiceTier = (model: ProviderModel | undefined, requested: string | null) => {
  const descriptors = model?.capabilities?.optionDescriptors ?? [];
  const id = fitAgentRuntimeServiceTier(descriptors, requested);
  const descriptor = descriptors.find((option) => option.id === "serviceTier");
  return {
    serviceTier: normalizeCodexServiceTier(id),
    serviceTierName:
      id !== null && descriptor?.type === "select"
        ? (descriptor.options.find((option) => option.id === id)?.label ?? null)
        : null,
  };
};

/**
 * Reads a choice against the same catalog and rules Main resolves it with, so what the Inbox
 * shows is the Agent, model, effort and speed that will actually run.
 */
export function describeInboxAgent(
  catalog: InboxAgentCatalog,
  requested: InboxAgentChoice,
  purpose: InboxAgentPurpose = "chat",
  intl: IntlShape = getIntl(),
): InboxAgentPresentation {
  const choice = resolveInboxAgentChoice(catalog.providers, requested, purpose);
  const { agent, kind, named } = inboxAgentIdentity(catalog, choice.instanceId);
  const provider = catalog.providers.find(
    (candidate) => candidate.instanceId === choice.instanceId,
  );
  const present = (
    status: InboxAgentPresentation["status"],
    detail: string,
    speed = inboxServiceTier(undefined, null),
  ): InboxAgentPresentation => ({
    status,
    kind,
    agent,
    named,
    detail,
    ...speed,
  });
  if (catalog.state === "loading")
    return present(
      "checking",
      intl.formatMessage({ id: "inbox.inboxAgentModel.loading", defaultMessage: "Loading…" }),
    );
  // A failed first read cannot tell whether the choice still exists, so it shows it as chosen.
  if (catalog.state === "error" && !provider)
    return present(
      "checking",
      choice.model ??
        intl.formatMessage({
          id: "inbox.inboxAgentModel.defaultModel",
          defaultMessage: "Default model",
        }),
    );
  const resolution = resolveInboxModel(catalog.providers, choice, purpose);
  if (resolution.kind === "unavailable")
    return present(
      "unavailable",
      provider && isAgentRuntimeProviderAvailable(provider) && choice.model
        ? intl.formatMessage({
            id: "inbox.inboxAgentModel.modelUnavailable",
            defaultMessage: "Model unavailable",
          })
        : intl.formatMessage({
            id: "inbox.inboxAgentModel.unavailable",
            defaultMessage: "Unavailable",
          }),
    );
  if (resolution.kind === "pending")
    return present(
      "checking",
      intl.formatMessage({
        id: "inbox.inboxAgentModel.checkingModels",
        defaultMessage: "Checking models…",
      }),
    );
  const { model, selection } = resolution;
  const effort = selectedEffort(model, selection);
  const speed = inboxServiceTier(model, choice.serviceTier);
  return present(
    "ready",
    [
      formatAgentModelName(model.name),
      effort ? agentEffortLabel(kind ?? "codex", effort) : null,
      speed.serviceTier === "fast"
        ? intl.formatMessage({ id: "inbox.inboxAgentModel.fast", defaultMessage: "Fast" })
        : speed.serviceTier === "ultrafast"
          ? intl.formatMessage({
              id: "inbox.inboxAgentModel.ultrafast",
              defaultMessage: "Ultrafast",
            })
          : speed.serviceTierName,
    ]
      .filter(Boolean)
      .join(" · "),
    speed,
  );
}

/** The whole line, for a tooltip or an accessible name: `Codex · GPT-6 Astra · Medium`. */
export const inboxAgentLine = (presentation: InboxAgentPresentation): string =>
  `${presentation.agent} · ${presentation.detail}`;

/**
 * Beside the Agent's mark, a trigger names the Agent only when that says more, as the
 * composer's model menu does: `GPT-6 Astra · Medium`, but `Work · Opus 5.5 · High`. A choice
 * that cannot run always names its Agent.
 */
export const inboxAgentShortLine = (presentation: InboxAgentPresentation): string =>
  presentation.named || presentation.status === "unavailable"
    ? inboxAgentLine(presentation)
    : presentation.detail;

/** Whether two choices run the same way; unset and explicit defaults are not merged. */
export const sameInboxAgentChoice = (left: InboxAgentChoice, right: InboxAgentChoice): boolean =>
  left.instanceId === right.instanceId &&
  left.model === right.model &&
  left.reasoningEffort === right.reasoningEffort &&
  left.serviceTier === right.serviceTier;

export interface InboxAgentPickerModel {
  /** Every Agent that can serve the purpose, with its models as the composer's picker lists them. */
  readonly entries: readonly {
    readonly binding: AgentBackendBinding;
    readonly label: string;
    readonly model: AgentModelOption;
    readonly selection: AgentModelSelection;
  }[];
  readonly selected: AgentModelSelection;
  readonly kind: AgentBackendBinding["kind"];
  /** The chosen Agent's models, which carry its effort levels. */
  readonly models: readonly AgentModelOption[];
  readonly reasoningEffort: string;
  readonly serviceTier: string | null;
  readonly serviceTierName: string | null;
  /** An effort control for Agents whose picker reads model options rather than effort levels. */
  readonly configOptions: readonly AgentSessionConfigOption[];
}

/** Projects a choice onto the shared model picker, which lists concrete models only. */
export function inboxAgentPickerModel(
  catalog: InboxAgentCatalog,
  requested: InboxAgentChoice,
  purpose: InboxAgentPurpose = "chat",
): InboxAgentPickerModel {
  const choice = resolveInboxAgentChoice(catalog.providers, requested, purpose);
  const entries = agentRuntimePickerEntries(
    catalog,
    choice,
    (provider) => purpose !== "suggestion" || supportsInboxStructuredGeneration(provider),
  );
  const provider = catalog.providers.find(
    (candidate) => candidate.instanceId === choice.instanceId,
  );
  const kind = provider ? agentRuntimeProviderBackendKind(provider) : "codex";
  const binding = agentRuntimeBinding(choice.instanceId, catalog.instances);
  const model = provider
    ? choice.model
      ? provider.models.find((candidate) => candidate.slug === choice.model)
      : purpose === "suggestion"
        ? inboxDefaultSuggestionModel(provider)
        : inboxDefaultChatModel(provider)
    : undefined;
  const effort =
    provider && model
      ? inboxModelEffort(model, inboxRequestedEffort(provider, choice, purpose))
      : null;
  const descriptor = effortDescriptor(model);
  const speed = inboxServiceTier(model, choice.serviceTier);
  return {
    entries,
    // An Agent the configured instances cannot name yet matches no listed model.
    selected: binding
      ? { binding, model: model?.slug ?? choice.model ?? "" }
      : { binding: { kind: "codex" }, model: "" },
    kind,
    models: provider
      ? provider.models.map((entry) => projectAgentRuntimeModel(provider, entry))
      : [],
    reasoningEffort: effort ?? "default",
    ...speed,
    configOptions:
      kind !== "codex" && kind !== "claude" && descriptor?.type === "select" && effort
        ? [
            {
              id: descriptor.id,
              name: descriptor.label,
              description: descriptor.description ?? null,
              category: "thought_level",
              type: "select",
              currentValue: effort,
              options: descriptor.options.map((option) => ({
                value: option.id,
                name: option.label,
                description: option.description ?? null,
              })),
            },
          ]
        : [],
  };
}

/**
 * Choosing another model keeps a supported effort and fits the speed to its offered ladder.
 */
export function chooseInboxModel(
  catalog: InboxAgentCatalog,
  choice: InboxAgentChoice,
  next: AgentModelSelection,
): InboxAgentChoice {
  const instanceId = agentRuntimeProviderId(next.binding);
  if (!instanceId) return choice;
  const model = catalog.providers
    .find((candidate) => candidate.instanceId === instanceId)
    ?.models.find((candidate) => candidate.slug === next.model);
  const effort = effortDescriptor(model);
  return {
    instanceId,
    model: next.model,
    reasoningEffort:
      choice.reasoningEffort &&
      effort?.type === "select" &&
      effort.options.some((option) => option.id === choice.reasoningEffort)
        ? choice.reasoningEffort
        : null,
    serviceTier: inboxServiceTier(model, choice.serviceTier).serviceTier,
  };
}

/** An effort or speed change keeps the chosen Agent and model. */
export const chooseInboxChatOptions = (
  choice: InboxAgentChoice,
  change: {
    readonly reasoningEffort?: CodexReasoningEffort | string;
    /** Codex speed by Nodex name; `null` is Standard. */
    readonly serviceTier?: string | null;
  },
): InboxAgentChoice => ({
  ...choice,
  ...(change.reasoningEffort !== undefined ? { reasoningEffort: change.reasoningEffort } : {}),
  ...(change.serviceTier !== undefined ? { serviceTier: change.serviceTier } : {}),
});
