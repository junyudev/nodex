import type { AgentRuntimeOperations } from "@nodex/agent-runtime/contracts";
import { isAgentRuntimeEffortOption } from "../../shared/agent-runtime-provider";
import {
  inboxDefaultChatModel,
  isInboxProviderUsable,
  resolveInboxModel,
  type InboxChatAgent,
} from "../../shared/inbox";
import { inboxModelGuideNote } from "../../shared/inbox-model-guide";
import { inboxUsageReading, type InboxBudgetPace } from "../../shared/inbox-suggestion-policy";

type Provider = AgentRuntimeOperations["providers.read"]["output"][number];
type ProviderModel = Provider["models"][number];

export interface InboxBudgetWindow {
  readonly label: string;
  readonly kind: string;
  readonly left_percent: number;
  readonly resets_in_hours: number | null;
  readonly pace: InboxBudgetPace;
  /** Present when the reading is old enough that the window may have moved since. */
  readonly read_hours_ago?: number;
}

export interface InboxCandidateModel {
  readonly model: string;
  readonly name: string;
  readonly efforts: readonly string[];
  readonly default_effort: string | null;
  /** Speed tiers beyond the standard one, such as `fast`. */
  readonly speeds?: readonly string[];
  readonly guide?: string;
}

/** One Agent a suggestion may start a chat on or delegate to, as the suggestion reads it. */
export interface InboxAgentCandidate {
  readonly instance_id: string;
  readonly agent: string;
  readonly harness: string;
  /** Usage windows the Agent reports; `unknown` when it reports none. */
  readonly budget: readonly InboxBudgetWindow[] | "unknown";
  readonly models: readonly InboxCandidateModel[];
}

/** Bounds each Agent's list so a large catalog cannot crowd out the messages themselves. */
const MAX_MODELS_PER_AGENT = 12;
const HOUR_MS = 3_600_000;
const round = (value: number) => Math.round(value * 10) / 10;

const budgetOf = (provider: Provider, now: number): InboxAgentCandidate["budget"] => {
  const limits = provider.usageLimits;
  if (!limits || limits.windows.length === 0) return "unknown";
  const readAt = Date.parse(limits.checkedAt);
  const age = Number.isFinite(readAt) ? (now - readAt) / HOUR_MS : null;
  return limits.windows.map((window) => {
    const reading = inboxUsageReading(window, now);
    return {
      label: window.label,
      kind: window.kind,
      left_percent: Math.round(reading.leftPercent),
      resets_in_hours: reading.resetsInHours === null ? null : round(reading.resetsInHours),
      pace: reading.pace,
      ...(age !== null && age >= 1 ? { read_hours_ago: round(age) } : {}),
    };
  });
};

const candidateModel = (model: ProviderModel, useModelGuide: boolean): InboxCandidateModel => {
  const descriptors = model.capabilities?.optionDescriptors ?? [];
  const effort = descriptors.find(isAgentRuntimeEffortOption);
  const speed = descriptors.find((option) => option.id === "serviceTier");
  const guide = useModelGuide ? inboxModelGuideNote(model) : null;
  const speeds =
    speed?.type === "select"
      ? speed.options.map((option) => option.id).filter((id) => id !== "default")
      : [];
  return {
    model: model.slug,
    name: model.name,
    efforts: effort?.type === "select" ? effort.options.map((option) => option.id) : [],
    default_effort:
      effort?.type === "select"
        ? (effort.currentValue ?? effort.options.find((option) => option.isDefault)?.id ?? null)
        : null,
    ...(speeds.length ? { speeds } : {}),
    ...(guide ? { guide } : {}),
  };
};

/** The catalog default first, then the models the guide speaks for, then catalog order. */
const listedModels = (provider: Provider, useModelGuide: boolean) => {
  const fallback = inboxDefaultChatModel(provider);
  const rank = (model: ProviderModel) =>
    model === fallback ? 0 : useModelGuide && inboxModelGuideNote(model) ? 1 : 2;
  return provider.models
    .map((model, index) => ({ model, index }))
    .sort((left, right) => rank(left.model) - rank(right.model) || left.index - right.index)
    .slice(0, MAX_MODELS_PER_AGENT)
    .map(({ model }) => candidateModel(model, useModelGuide));
};

/** Every Agent that can take a chat right now, with what each of its models is good at. */
export function inboxAgentCandidates(
  providers: readonly Provider[],
  options: { readonly now: number; readonly useModelGuide: boolean },
): readonly InboxAgentCandidate[] {
  return providers
    .filter(
      (provider) =>
        isInboxProviderUsable(provider) && provider.installed && provider.models.length > 0,
    )
    .map((provider) => ({
      instance_id: provider.instanceId,
      agent: provider.displayName ?? provider.instanceId,
      harness: provider.driver,
      budget: budgetOf(provider, options.now),
      models: listedModels(provider, options.useModelGuide),
    }));
}

/** The Inbox's own choice as the suggestion reads it, so null visibly means something. */
export function inboxDefaultChatCandidate(
  providers: readonly Provider[],
  chatAgent: InboxChatAgent,
): { readonly instance_id: string; readonly model: string; readonly effort: string | null } | null {
  const resolution = resolveInboxModel(providers, chatAgent, "chat");
  if (resolution.kind !== "ready") return null;
  const effortId = resolution.model.capabilities?.optionDescriptors?.find(
    isAgentRuntimeEffortOption,
  )?.id;
  const effort = resolution.selection.options?.find((option) => option.id === effortId)?.value;
  return {
    instance_id: resolution.selection.instanceId,
    model: resolution.selection.model,
    effort:
      typeof effort === "string" ? effort : candidateModel(resolution.model, false).default_effort,
  };
}

/** Whether a named Agent, model and effort is one the suggestion was offered. */
export function isOfferedInboxChoice(
  candidates: readonly InboxAgentCandidate[],
  choice: {
    readonly instanceId: string;
    readonly model: string | null;
    readonly reasoningEffort: string | null;
  },
): boolean {
  const agent = candidates.find((candidate) => candidate.instance_id === choice.instanceId);
  if (!agent) return false;
  if (choice.model === null) return choice.reasoningEffort === null;
  const model = agent.models.find((candidate) => candidate.model === choice.model);
  return Boolean(
    model && (choice.reasoningEffort === null || model.efforts.includes(choice.reasoningEffort)),
  );
}
