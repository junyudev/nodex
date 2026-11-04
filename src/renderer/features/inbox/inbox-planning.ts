import type { AgentBackendBinding } from "../../../shared/agent-backend";
import {
  inboxOfferedModels,
  isInboxChatCandidate,
  type InboxSettings,
} from "../../../shared/inbox";
import { INBOX_MODEL_GUIDE, inboxModelGuideEntry } from "../../../shared/inbox-model-guide";
import type { InboxSuggestionPolicy } from "../../../shared/inbox-suggestion-policy";
import { agentRuntimeProviderBackendKind } from "@/lib/agent-runtime-model-selection";
import {
  describeUsageMeter,
  formatUsageAge,
  runtimeUsageReading,
  type UsageMeterView,
  type UsageSeverity,
  type UsageWindowView,
} from "@/lib/usage-meter";
import {
  describeInboxAgent,
  inboxAgentIdentity,
  type InboxAgentCatalog,
  type InboxAgentPresentation,
} from "./inbox-agent-model";

/** What is left of the budget a model spends, as the Inbox plans with it. */
export type InboxPlanningBudget =
  /** The model costs nothing to run. */
  | { readonly kind: "free" }
  | {
      readonly kind: "left";
      readonly percent: number;
      readonly severity: UsageSeverity;
      /** Names the window when it is not the weekly one, such as `Monthly`. */
      readonly window: string | null;
      /** How long ago it was read, once that is long enough for use elsewhere to have moved it. */
      readonly readAgo: string | null;
    }
  | { readonly kind: "spent"; readonly window: string | null }
  /** The window reset after it was read, so what is left now is not known. */
  | { readonly kind: "reset" }
  /** The Agent reports no budget. */
  | { readonly kind: "unknown" };

/** One line of what a suggestion chooses among: a guide family on one Agent, or an Agent. */
export interface InboxPlanningModel {
  readonly key: string;
  /** The Agent's mark. */
  readonly kind: AgentBackendBinding["kind"];
  /** The guide's family, with its Agent when that says more than the mark; else the Agent. */
  readonly title: string;
  /** What the guide says the family does well, in one line. */
  readonly summary: string | null;
  readonly budget: InboxPlanningBudget;
  /** The Agent's whole usage, as its rail meter's card shows it; null for free models. */
  readonly usage: UsageMeterView | null;
}

export type InboxPlanningModels =
  /** Each suggestion chooses its chat's model, weighing these. */
  | {
      readonly kind: "chosen";
      readonly guide: boolean;
      readonly catalog: InboxAgentCatalog["state"];
      readonly models: readonly InboxPlanningModel[];
    }
  /** Suggestions only route; every new chat runs on this. */
  | { readonly kind: "fixed"; readonly chat: InboxAgentPresentation };

/** How the Inbox will plan the next messages, read from the same settings, catalog and budgets. */
export type InboxPlanning =
  | { readonly kind: "off"; readonly chat: InboxAgentPresentation }
  | {
      readonly kind: "suggests";
      /** `paused` and `on_request` suggest only when asked. */
      readonly when: Exclude<InboxSuggestionPolicy["kind"], "off">;
      readonly suggestedBy: InboxAgentPresentation;
      readonly models: InboxPlanningModels;
      /** The user's routing preferences, empty when there are none. */
      readonly preferences: string;
    };

const WEEK_MINS = 7 * 24 * 60;

const isWeekly = (window: UsageWindowView) =>
  window.durationMins === WEEK_MINS || window.label === "Weekly";

/**
 * The weekly window suggestions weigh most, else the Agent's longest one. Windows that limit
 * one model only, such as a Claude model's own week, show in the Agent's card instead.
 */
export function inboxPlanningBudget(usage: UsageMeterView, now: number): InboxPlanningBudget {
  const account = usage.windows.filter((window) => window.scope === "account");
  const window =
    account.find(isWeekly) ??
    account.toSorted((left, right) => (right.durationMins ?? 0) - (left.durationMins ?? 0))[0];
  if (usage.status === "unmetered" || !window) return { kind: "unknown" };
  if (window.state === "elapsed") return { kind: "reset" };
  const named = isWeekly(window) ? null : window.label;
  if (window.severity === "exhausted") return { kind: "spent", window: named };
  return {
    kind: "left",
    percent: window.remainingPercent,
    severity: window.severity,
    window: named,
    readAgo:
      usage.stale && usage.reading.observedAt !== null
        ? formatUsageAge(usage.reading.observedAt, now)
        : null,
  };
}

/**
 * Every Agent a suggestion may start a chat on, as the guide describes it: one line per guide
 * family the Agent offers, else one for the Agent itself. Without the guide, one per Agent.
 */
export function inboxPlanningModels(
  catalog: InboxAgentCatalog,
  useModelGuide: boolean,
  now: number,
): readonly InboxPlanningModel[] {
  return catalog.providers
    .filter(isInboxChatCandidate)
    .flatMap((provider): InboxPlanningModel[] => {
      const { agent, named } = inboxAgentIdentity(catalog, provider.instanceId);
      const kind = agentRuntimeProviderBackendKind(provider);
      const usage = describeUsageMeter(runtimeUsageReading(provider, false), now);
      const budget = inboxPlanningBudget(usage, now);
      // Only the models a suggestion is actually offered speak for the Agent.
      const offered = new Set(
        inboxOfferedModels(provider, useModelGuide).map(inboxModelGuideEntry),
      );
      const families = useModelGuide ? INBOX_MODEL_GUIDE.filter((entry) => offered.has(entry)) : [];
      if (families.length === 0)
        return [{ key: provider.instanceId, kind, title: agent, summary: null, budget, usage }];
      return families.map((entry) => ({
        key: `${provider.instanceId}:${entry.family}`,
        kind,
        title: named && !entry.family.includes(agent) ? `${entry.family} · ${agent}` : entry.family,
        summary: entry.summary,
        budget: entry.free ? { kind: "free" } : budget,
        usage: entry.free ? null : usage,
      }));
    });
}

export function describeInboxPlanning(
  catalog: InboxAgentCatalog,
  settings: InboxSettings,
  policy: InboxSuggestionPolicy,
  now: number,
): InboxPlanning {
  const chat = describeInboxAgent(catalog, settings.chatAgent, "chat");
  if (policy.kind === "off") return { kind: "off", chat };
  return {
    kind: "suggests",
    when: policy.kind,
    suggestedBy: describeInboxAgent(catalog, settings.suggestionAgent, "suggestion"),
    models: settings.suggestionsChooseModels
      ? {
          kind: "chosen",
          guide: settings.useModelGuide,
          catalog: catalog.state,
          models: inboxPlanningModels(catalog, settings.useModelGuide, now),
        }
      : { kind: "fixed", chat },
    preferences: settings.instructions.trim(),
  };
}

/** The next moment the plan changes without new data: a budget resetting or its reading aging. */
export function inboxPlanningNextChange(planning: InboxPlanning): number | null {
  if (planning.kind === "off" || planning.models.kind === "fixed") return null;
  const moments = planning.models.models.flatMap((model) =>
    model.usage?.nextChangeAt == null ? [] : [model.usage.nextChangeAt],
  );
  return moments.length > 0 ? Math.min(...moments) : null;
}
